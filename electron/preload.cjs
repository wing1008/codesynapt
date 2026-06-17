// Preload — safe IPC bridge between renderer (untrusted) and main (privileged)
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// ─── Plugin permission boundary ─────────────────────────────────
//
// Plugin code executes in the renderer's MAIN world, the same realm as the
// app — so it can reach window.codesynapt directly and call privileged IPC
// (writeFile/editFile) regardless of the advisory ctx.* gate in
// plugin-host.js. The only place we can enforce permissions in a way plugin
// code cannot tamper with is HERE, in the preload's ISOLATED world: the maps
// below are closure-private. We expose only functions via contextBridge;
// plugin code can call them but cannot read or replace the backing state.
//
// Model:
//   - The host (trusted app code) registers each plugin's GRANTED permissions
//     (as approved in the trust store) before activating it.
//   - The host runs plugin code (activate + any plugin-supplied callback)
//     inside runInPluginScope(id, fn), which marks "a plugin is the current
//     caller". Privileged IPC consults that marker.
//   - Defense in depth: if a privileged call's synchronous stack originates
//     from a blob: URL (how plugin modules are loaded) we treat it as
//     plugin-originated even if the host forgot to mark a scope.
//
// Default-deny: a privileged call attributed to a plugin without the matching
// permission is rejected; non-plugin (app) calls are unaffected.
const PRIVILEGED = {
  'write-file': 'write-files',
  'restore-history': 'write-files',
}

const _pluginPerms = new Map()   // pluginId -> Set<permission>
const _scopeStack = []           // active plugin ids (supports re-entrancy)

function _currentPluginId() {
  if (_scopeStack.length) return _scopeStack[_scopeStack.length - 1]
  // Defense in depth: detect plugin-origin async calls via stack inspection.
  // Plugin modules are imported from blob: URLs (see plugin-host.js); any
  // frame referencing one means a plugin is on the call path.
  try {
    const stack = new Error().stack || ''
    if (/blob:/.test(stack)) return '__plugin_blob_origin__'
  } catch { /* ignore */ }
  return null
}

function _enforce(channel) {
  const need = PRIVILEGED[channel]
  if (!need) return                       // not a gated channel
  const pid = _currentPluginId()
  if (pid == null) return                 // app-originated call: allowed
  const perms = _pluginPerms.get(pid)
  if (perms && perms.has(need)) return    // plugin holds the permission
  const who = pid === '__plugin_blob_origin__' ? 'a plugin' : `plugin "${pid}"`
  throw new Error(
    `Permission denied: ${who} attempted "${channel}" without the "${need}" permission. ` +
    `Declare it in manifest.json and have the user approve the plugin.`
  )
}

// A privileged ipcRenderer.invoke wrapper: enforce, then forward.
function guardedInvoke(channel, ...args) {
  _enforce(channel)
  return ipcRenderer.invoke(channel, ...args)
}

const csApi = {
  // Imperative
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadFolder: (path) => ipcRenderer.invoke('load-folder', path),
  closeFolder: () => ipcRenderer.invoke('close-folder'),
  getState: () => ipcRenderer.invoke('get-state'),
  readFile: (id) => ipcRenderer.invoke('read-file', id),
  writeFile: (id, content) => guardedInvoke('write-file', id, content),
  listHistory: (id) => ipcRenderer.invoke('list-history', id),
  readHistory: (id, ts) => ipcRenderer.invoke('read-history', id, ts),
  restoreHistory: (id, ts) => guardedInvoke('restore-history', id, ts),
  setHistoryEnabled: (enabled) => ipcRenderer.invoke('set-history-enabled', enabled),
  getHistoryEnabled: () => ipcRenderer.invoke('get-history-enabled'),
  controlPort: () => ipcRenderer.invoke('control-port'),
  onControl: (cb) => {
    const onFocus = (_e, data) => cb({ type: 'focus', ...data })
    const onOpen  = (_e, data) => cb({ type: 'open',  ...data })
    const onTrace = (_e, data) => cb({ type: 'trace', ...data })
    const onBlast = (_e, data) => cb({ type: 'blast', ...data })
    ipcRenderer.on('control:focus', onFocus)
    ipcRenderer.on('control:open',  onOpen)
    ipcRenderer.on('control:trace', onTrace)
    ipcRenderer.on('control:blast', onBlast)
    return () => {
      ipcRenderer.off('control:focus', onFocus)
      ipcRenderer.off('control:open',  onOpen)
      ipcRenderer.off('control:trace', onTrace)
      ipcRenderer.off('control:blast', onBlast)
    }
  },
  revealInOS: (id) => ipcRenderer.invoke('reveal-in-os', id),
  openInEditor: (id) => ipcRenderer.invoke('open-in-editor', id),

  // Resolve the absolute filesystem path of a dropped File. Electron 32+
  // (we ship 41) removed the non-standard `File.path` property, so a
  // drag-dropped folder/file no longer carries its path in the renderer.
  // webUtils.getPathForFile() is the supported replacement and is only
  // reachable from the preload context — expose it so the drop handler
  // can recover the path and loadFolder() it. Returns '' if unavailable.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  // Event subscriptions (main → renderer)
  onSnapshot: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('snapshot', handler)
    return () => ipcRenderer.off('snapshot', handler)
  },
  onFolderLoaded: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('folder-loaded', handler)
    return () => ipcRenderer.off('folder-loaded', handler)
  },
  // Runtime-observed call edges were merged into the live symbol graph
  // (cs trace run) — the 3D symbol layer should refetch so amber links
  // appear without a restart.
  onSymbolsUpdated: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('symbols-updated', handler)
    return () => ipcRenderer.off('symbols-updated', handler)
  },
  // Realtime potential-issue alerts (newly-unreachable symbols after an edit).
  onSymbolIssues: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('symbol-issues', handler)
    return () => ipcRenderer.off('symbol-issues', handler)
  },
  onNoFolder: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('no-folder', handler)
    return () => ipcRenderer.off('no-folder', handler)
  },
  onError: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('error', handler)
    return () => ipcRenderer.off('error', handler)
  },
  onWindowVisibility: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('window-visibility', handler)
    return () => ipcRenderer.off('window-visibility', handler)
  },
  onScanProgress: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('scan-progress', handler)
    return () => ipcRenderer.off('scan-progress', handler)
  },
  // L2 symbol/call-graph build progress (lazy first build feedback).
  onSymbolProgress: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('symbol-progress', handler)
    return () => ipcRenderer.off('symbol-progress', handler)
  },
  // Per-snapshot scanner stats (file count, edge count, scan timings).
  // main.cjs emits 'stats' on every scanner 'stats' event; previously
  // unbridged, so the renderer could never see it.
  onStats: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('stats', handler)
    return () => ipcRenderer.off('stats', handler)
  },

  // ─── Auto-updater ────────────────────────────────────────────
  // main.cjs's updater emits these events; the renderer subscribes here
  // and drives download/install via the invoke methods below. Without
  // this bridge the 'download / restart' toast could never receive the
  // updater:* events nor trigger a download — the flow was detect-only.
  onUpdaterAvailable: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('updater:available', handler)
    return () => ipcRenderer.off('updater:available', handler)
  },
  onUpdaterProgress: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('updater:progress', handler)
    return () => ipcRenderer.off('updater:progress', handler)
  },
  onUpdaterDownloaded: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('updater:downloaded', handler)
    return () => ipcRenderer.off('updater:downloaded', handler)
  },
  onUpdaterError: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('updater:error', handler)
    return () => ipcRenderer.off('updater:error', handler)
  },
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate:  () => ipcRenderer.invoke('updater:install'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),

  // Panel data — bypasses fetch/CSP for tour, timeline, changes
  getTour:       () => ipcRenderer.invoke('panel:tour'),
  getTimeline:   () => ipcRenderer.invoke('panel:timeline'),
  getChanges:    () => ipcRenderer.invoke('panel:changes'),
  getChangeDiff: (id) => ipcRenderer.invoke('panel:change-diff', id),
  getPackages:   () => ipcRenderer.invoke('panel:packages'),
  getPackage:    (name) => ipcRenderer.invoke('panel:package', name),
  getLegacy:     () => ipcRenderer.invoke('panel:legacy'),
  getSymbols:    () => ipcRenderer.invoke('panel:symbols'),
  // Trace session — live AI activity log
  traceLog:      (opts) => ipcRenderer.invoke('trace:log', opts || {}),
  traceStats:    () => ipcRenderer.invoke('trace:stats'),
  traceSessions: () => ipcRenderer.invoke('trace:sessions'),
  traceSession:  (id) => ipcRenderer.invoke('trace:session', id),
  traceClear:    () => ipcRenderer.invoke('trace:clear'),
  traceExport:   (path) => ipcRenderer.invoke('trace:export', path),

  // [④] Multi-session viewer (flag-gated CS_REGISTRY) — attach to another
  // Claude Code session's daemon and watch its graph/trace as a pure client.
  viewerEnabled:  () => ipcRenderer.invoke('viewer:enabled'),
  viewerSessions: () => ipcRenderer.invoke('viewer:list-sessions'),
  viewerAttach:   (sessionId) => ipcRenderer.invoke('viewer:attach', sessionId),
  viewerDetach:   () => ipcRenderer.invoke('viewer:detach'),
  onViewerStatus: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('viewer:status', handler)
    return () => ipcRenderer.off('viewer:status', handler)
  },

  // Pinned projects (multi-folder workspace)
  listProjects:   () => ipcRenderer.invoke('list-projects'),
  pinProject:     (path, name, color) => ipcRenderer.invoke('pin-project', { path, name, color }),
  unpinProject:   (path) => ipcRenderer.invoke('unpin-project', path),
  renameProject:  (path, name) => ipcRenderer.invoke('rename-project', { path, name }),

  // Plugin system
  listPlugins: () => ipcRenderer.invoke('list-plugins'),
  openPluginDir: () => ipcRenderer.invoke('open-plugin-dir'),
  pluginDir: () => ipcRenderer.invoke('plugin-dir'),
  approvePlugin: (id, opts) => ipcRenderer.invoke('approve-plugin', id, opts),
  revokePlugin: (id) => ipcRenderer.invoke('revoke-plugin', id),
  // Trust round-trip: the settings UI calls approvePlugin once the user
  // consents; the main process records the content hash + granted permissions
  // into the trust store. (Requires the matching ipcMain handlers — see the
  // couldNotFix note in this theme's report.)
  approvePlugin: (id, permissions) => ipcRenderer.invoke('approve-plugin', { id, permissions }),
  revokePlugin: (id) => ipcRenderer.invoke('revoke-plugin', { id }),
}

// Expose under both names: 'codesynapt' is the canonical namespace from 0.14.6+;
// 'fg3d' is a legacy alias kept for backward compat (plugin authors, etc.).
// Both refer to the SAME object — no extra memory.
contextBridge.exposeInMainWorld('codesynapt', csApi)
contextBridge.exposeInMainWorld('fg3d', csApi)

// Plugin guard control surface. The plugin HOST (trusted app code in
// plugin-host.js) uses this to register granted permissions and to run
// plugin code inside an attributed scope. The backing maps live in this
// isolated world; plugin code in the main world cannot reach them, only call
// these functions. Registering permissions is itself gated: it is a no-op if
// invoked from inside a plugin scope (a plugin cannot grant itself rights).
contextBridge.exposeInMainWorld('__pluginGuard', {
  // host: declare the permissions the trust store granted this plugin
  register(pluginId, permissions) {
    if (typeof pluginId !== 'string') return
    if (_scopeStack.length) return  // a plugin must not register/escalate perms
    const set = new Set()
    if (Array.isArray(permissions)) {
      for (const p of permissions) if (typeof p === 'string') set.add(p)
    }
    _pluginPerms.set(pluginId, set)
  },
  unregister(pluginId) {
    if (_scopeStack.length) return
    _pluginPerms.delete(pluginId)
  },
  // host: run fn (a plugin's activate or a plugin-supplied callback) attributed
  // to pluginId. Synchronous return is unwrapped; promises are awaited so the
  // scope spans the async activate(). Re-entrant safe.
  runInScope(pluginId, fn) {
    if (typeof fn !== 'function') return undefined
    _scopeStack.push(pluginId)
    let popped = false
    const pop = () => { if (!popped) { popped = true; _scopeStack.pop() } }
    try {
      const out = fn()
      if (out && typeof out.then === 'function') {
        return out.then(
          (v) => { pop(); return v },
          (e) => { pop(); throw e }
        )
      }
      pop()
      return out
    } catch (e) {
      pop()
      throw e
    }
  },
  // host: does a plugin currently hold a permission? (for the host's own
  // advisory ctx.* gate to mirror the hard boundary)
  has(pluginId, permission) {
    const perms = _pluginPerms.get(pluginId)
    return !!(perms && perms.has(permission))
  },
})

// Platform info for renderer
contextBridge.exposeInMainWorld('platform', {
  os: process.platform,
  isMac: process.platform === 'darwin',
  isElectron: true,
})
