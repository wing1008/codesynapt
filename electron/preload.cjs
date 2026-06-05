// Preload — safe IPC bridge between renderer (untrusted) and main (privileged)
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const csApi = {
  // Imperative
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadFolder: (path) => ipcRenderer.invoke('load-folder', path),
  closeFolder: () => ipcRenderer.invoke('close-folder'),
  getState: () => ipcRenderer.invoke('get-state'),
  readFile: (id) => ipcRenderer.invoke('read-file', id),
  writeFile: (id, content) => ipcRenderer.invoke('write-file', id, content),
  listHistory: (id) => ipcRenderer.invoke('list-history', id),
  readHistory: (id, ts) => ipcRenderer.invoke('read-history', id, ts),
  restoreHistory: (id, ts) => ipcRenderer.invoke('restore-history', id, ts),
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
  // Trace session — live AI activity log
  traceLog:      (opts) => ipcRenderer.invoke('trace:log', opts || {}),
  traceStats:    () => ipcRenderer.invoke('trace:stats'),
  traceSessions: () => ipcRenderer.invoke('trace:sessions'),
  traceSession:  (id) => ipcRenderer.invoke('trace:session', id),
  traceClear:    () => ipcRenderer.invoke('trace:clear'),
  traceExport:   (path) => ipcRenderer.invoke('trace:export', path),

  // Pinned projects (multi-folder workspace)
  listProjects:   () => ipcRenderer.invoke('list-projects'),
  pinProject:     (path, name, color) => ipcRenderer.invoke('pin-project', { path, name, color }),
  unpinProject:   (path) => ipcRenderer.invoke('unpin-project', path),
  renameProject:  (path, name) => ipcRenderer.invoke('rename-project', { path, name }),

  // Plugin system
  listPlugins: () => ipcRenderer.invoke('list-plugins'),
  openPluginDir: () => ipcRenderer.invoke('open-plugin-dir'),
  pluginDir: () => ipcRenderer.invoke('plugin-dir'),
}

// Expose under both names: 'codesynapt' is the canonical namespace from 0.14.6+;
// 'fg3d' is a legacy alias kept for backward compat (plugin authors, etc.).
// Both refer to the SAME object — no extra memory.
contextBridge.exposeInMainWorld('codesynapt', csApi)
contextBridge.exposeInMainWorld('fg3d', csApi)

// Platform info for renderer
contextBridge.exposeInMainWorld('platform', {
  os: process.platform,
  isMac: process.platform === 'darwin',
  isElectron: true,
})
