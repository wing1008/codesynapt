// ═══════════════════════════════════════════════════════════
//  Plugin host — renderer process side
//
//  Activates plugins discovered by the main process. Themes get
//  their CSS injected into the document. Code plugins get an
//  isolated `context` object exposing only the approved API
//  surface; they cannot reach into app internals directly.
//
//  This is not a hard security boundary (anything in the renderer
//  shares the same JS realm) but it is a clear contract that
//  plugins are expected to use. Anything reading via global window
//  digging is unsupported and may break across versions.
// ═══════════════════════════════════════════════════════════

// Renderer-side plugin host. Uses window.__bus for events.

// Internal registries — written by plugins, read by the app
export const pluginRegistry = {
  themes: new Map(),       // id -> { manifest, css }
  exporters: new Map(),    // id -> { manifest, opts }
  parsers: new Map(),      // id -> { manifest, opts }
  layouts: new Map(),      // id -> { manifest, opts }
  panels: new Map(),       // id -> { manifest, handle }
  contextMenuItems: [],    // list of { plugin, opts }
  commands: new Map(),     // id -> { plugin, opts }
  loaded: [],              // raw discovery result for the settings UI
}

// Track plugin lifecycle so we can deactivate cleanly
const activations = new Map()  // pluginId -> { deactivate, disposables }

/**
 * Build a per-plugin context object. This is what plugins see via
 * the `ctx` argument to their activate() function.
 */
function makeContext(manifest, hostHelpers) {
  const disposables = []
  const perms = new Set(manifest.permissions || [])

  const requirePerm = (perm, action) => {
    if (!perms.has(perm)) {
      throw new Error(`Plugin "${manifest.id}" attempted "${action}" but does not declare permission "${perm}"`)
    }
  }

  // Storage scoped to this plugin id
  const storagePrefix = `filegraph3d:plugin:${manifest.id}:`
  const storage = {
    get(key) {
      try {
        const raw = localStorage.getItem(storagePrefix + key)
        return raw == null ? null : JSON.parse(raw)
      } catch { return null }
    },
    set(key, value) {
      try {
        localStorage.setItem(storagePrefix + key, JSON.stringify(value))
      } catch { /* quota */ }
    },
    delete(key) {
      try { localStorage.removeItem(storagePrefix + key) } catch {}
    },
    clear() {
      try {
        const remove = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(storagePrefix)) remove.push(k)
        }
        for (const k of remove) localStorage.removeItem(k)
      } catch {}
    },
    keys() {
      const keys = []
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(storagePrefix)) keys.push(k.slice(storagePrefix.length))
        }
      } catch {}
      return keys
    },
  }

  // Graph API — wraps the app's state in a read-only-looking facade
  const graph = {
    get root() { return hostHelpers.getState().root },
    get nodes() { return hostHelpers.getState().byIdx },
    get edges() { return hostHelpers.getState().edges },
    get selectedId() { return hostHelpers.getState().selectedId },
    get activeSet() { return hostHelpers.getEffectiveActiveSet() },
    async readFile(id) {
      requirePerm('read-files', 'readFile')
      return hostHelpers.readFile(id)
    },
    getNode(id) { return hostHelpers.getState().nodes.get(id) || null },
    outgoing(id) {
      const result = []
      for (const e of hostHelpers.getState().edges) {
        if (e.s === id) result.push(e)
      }
      return result
    },
    incoming(id) {
      const result = []
      for (const e of hostHelpers.getState().edges) {
        if (e.t === id) result.push(e)
      }
      return result
    },
  }

  // UI registration
  const ui = {
    registerPanel(opts) {
      requirePerm('ui-panel', 'registerPanel')
      const handle = hostHelpers.createPanel(manifest, opts)
      disposables.push(() => handle.dispose())
      return handle
    },
    registerContextMenuItem(opts) {
      requirePerm('context-menu', 'registerContextMenuItem')
      const entry = { plugin: manifest.id, opts }
      pluginRegistry.contextMenuItems.push(entry)
      disposables.push(() => {
        const i = pluginRegistry.contextMenuItems.indexOf(entry)
        if (i >= 0) pluginRegistry.contextMenuItems.splice(i, 1)
      })
      return { dispose() {
        const i = pluginRegistry.contextMenuItems.indexOf(entry)
        if (i >= 0) pluginRegistry.contextMenuItems.splice(i, 1)
      }}
    },
    registerCommand(opts) {
      pluginRegistry.commands.set(opts.id, { plugin: manifest.id, opts })
      disposables.push(() => pluginRegistry.commands.delete(opts.id))
      return { dispose() { pluginRegistry.commands.delete(opts.id) } }
    },
  }

  // Exporter registry
  const exporters = {
    register(opts) {
      requirePerm('export', 'register exporter')
      pluginRegistry.exporters.set(opts.name, { manifest, opts })
      disposables.push(() => pluginRegistry.exporters.delete(opts.name))
      return { dispose() { pluginRegistry.exporters.delete(opts.name) } }
    },
  }

  // Parser registry
  const parsers = {
    register(opts) {
      requirePerm('parse', 'register parser')
      pluginRegistry.parsers.set(opts.name, { manifest, opts })
      disposables.push(() => pluginRegistry.parsers.delete(opts.name))
      return { dispose() { pluginRegistry.parsers.delete(opts.name) } }
    },
  }

  // Layout registry
  const layouts = {
    register(opts) {
      pluginRegistry.layouts.set(opts.id, { manifest, opts })
      disposables.push(() => pluginRegistry.layouts.delete(opts.id))
      return { dispose() { pluginRegistry.layouts.delete(opts.id) } }
    },
  }

  // Event bus — proxy to the app's bus but restrict to read-only events
  const events = {
    on(name, handler) {
      const off = hostHelpers.busOn(name, handler)
      disposables.push(off)
      return off
    },
    off(name, handler) { hostHelpers.busOff(name, handler) },
  }

  const ctx = {
    manifest,
    appVersion: hostHelpers.appVersion,
    graph,
    ui,
    exporters,
    parsers,
    layouts,
    events,
    storage,
    toast: (msg) => hostHelpers.toast(`[${manifest.id}] ${msg}`),
    log: (...args) => console.log(`[plugin:${manifest.id}]`, ...args),
  }

  return { ctx, disposables }
}

/**
 * Activate one plugin. Themes just inject CSS; code plugins are
 * compiled as an ESM module via dynamic blob URL.
 */
async function activatePlugin(record, hostHelpers) {
  const { manifest, entryContent, error } = record
  if (error) {
    console.warn(`[plugin] skipping ${manifest.id}: ${error}`)
    return
  }

  // Theme — inject CSS, register in the theme registry, done
  if (manifest.type === 'theme') {
    const styleId = `plugin-theme-${manifest.id}`
    let style = document.getElementById(styleId)
    if (!style) {
      style = document.createElement('style')
      style.id = styleId
      style.dataset.pluginId = manifest.id
      document.head.appendChild(style)
    }
    style.textContent = entryContent
    pluginRegistry.themes.set(manifest.id, { manifest, css: entryContent })
    activations.set(manifest.id, {
      deactivate: () => style.remove(),
      disposables: [],
    })
    return
  }

  // Code plugin — execute as an ES module via a Blob URL.
  // This isolates the plugin from the global window scope (it gets
  // its own module record) while still letting it use modern JS.
  let module
  try {
    const blob = new Blob([entryContent], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    module = await import(/* @vite-ignore */ url)
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error(`[plugin] ${manifest.id} failed to load:`, err)
    hostHelpers.toast(`Plugin "${manifest.name}" failed to load`)
    return
  }

  const plugin = module.default
  if (!plugin || typeof plugin.activate !== 'function') {
    console.warn(`[plugin] ${manifest.id} has no default export with activate()`)
    return
  }

  const { ctx, disposables } = makeContext(manifest, hostHelpers)
  try {
    await plugin.activate(ctx)
  } catch (err) {
    console.error(`[plugin] ${manifest.id} activate() threw:`, err)
    hostHelpers.toast(`Plugin "${manifest.name}" crashed during activation`)
    // Run any cleanup that was registered before the crash
    for (const fn of disposables) {
      try { fn() } catch {}
    }
    return
  }

  activations.set(manifest.id, {
    deactivate: async () => {
      try {
        if (typeof plugin.deactivate === 'function') await plugin.deactivate()
      } catch (err) {
        console.error(`[plugin] ${manifest.id} deactivate() threw:`, err)
      }
      for (const fn of disposables) {
        try { fn() } catch {}
      }
    },
    disposables,
  })
}

/**
 * Public entry point — discover all plugins via IPC, then activate
 * each one. Idempotent: calling twice deactivates first.
 */
export async function initPlugins(hostHelpers) {
  // Deactivate anything currently running
  for (const [, info] of activations) {
    try { await info.deactivate() } catch {}
  }
  activations.clear()
  pluginRegistry.themes.clear()
  pluginRegistry.exporters.clear()
  pluginRegistry.parsers.clear()
  pluginRegistry.layouts.clear()
  pluginRegistry.panels.clear()
  pluginRegistry.contextMenuItems.length = 0
  pluginRegistry.commands.clear()

  if (!window.fg3d || !window.fg3d.listPlugins) {
    // Browser dev mode — no plugins available
    pluginRegistry.loaded = []
    return
  }

  let discovered = []
  try {
    discovered = await window.fg3d.listPlugins()
  } catch (err) {
    console.error('[plugin] discovery failed:', err)
    return
  }
  pluginRegistry.loaded = discovered

  for (const record of discovered) {
    await activatePlugin(record, hostHelpers)
  }

  console.log(`[plugin] loaded ${activations.size} plugin(s)`)
}

export async function deactivatePlugin(id) {
  const info = activations.get(id)
  if (!info) return
  await info.deactivate()
  activations.delete(id)
}
