// Electron main process — desktop app shell for CodeSynapt
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } = require('electron')

// [GPU] Force ANGLE onto the D3D11 backend. On some newer NVIDIA cards/drivers
// (observed: RTX 50-series, driver 32.x) the bundled ANGLE falls back to the
// ancient Direct3D9Ex path and then fails outright ("BindToCurrentSequence
// failed" → "A WebGL context could not be created"), so the 3D scene + view
// cube never render. Pinning d3d11 (which every D3D11-class GPU supports)
// avoids the broken d3d9 fallback. Must be set before app is ready.
try { app.commandLine.appendSwitch('use-angle', 'd3d11') } catch {}

// Renderer loads over a custom app:// scheme (standard + secure) instead of
// file://. `<script type="module">` + importmap are blocked under file:// by
// CORS (origin 'null'), so app.js never loads in the packaged app. Registering
// app:// as a privileged standard scheme lets ES modules + importmap load.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])
const path = require('path')
const fs = require('fs')
const http = require('http')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const pExecFile = promisify(execFile)

// ─── Persistent state (window bounds, recent folders) ──────────
const STORE_PATH = path.join(app.getPath('userData'), 'state.json')
let store = {
  windowBounds: null,
  lastFolder: null,
  recentFolders: [],        // auto-tracked, capped at 8
  pinnedProjects: [],       // user-pinned: [{ path, name, pinnedAt, color? }]
}
try {
  store = { ...store, ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) }
} catch {}
function saveStore() {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)) } catch {}
}
function addRecent(folder) {
  store.recentFolders = [folder, ...store.recentFolders.filter((f) => f !== folder)]
    .slice(0, 8)
  store.lastFolder = folder
  saveStore()
  rebuildMenu()
}

// ─── Scanner (loaded dynamically because it's ESM) ─────────────
let Scanner = null
let scanner = null
let mainWindow = null
let currentRoot = null

async function loadScannerModule() {
  if (Scanner) return Scanner
  const mod = await import('../packages/core/scanner.js')
  Scanner = mod.Scanner
  return Scanner
}

// Symbol-mode graph (codegraph-equivalent layer). Lazy: built on the
// first /symbol/* request after a project loads. Reset on every
// project swap so it never returns stale symbols from a prior repo.
const { SymbolGraph, registerParser } = require('../packages/core/lib/symbol-graph.cjs')
const symbolViews = require('../packages/core/lib/symbol-views.cjs')   // shared /symbol/* views (dedup with control-server)
const { SUPPORTED_EXTS } = require('../packages/core/lib/symbol-parsers.cjs')   // symbol-covered exts (honest coverage)
const jsSymbolParser = require('../packages/core/lib/symbol-parser-js.cjs')
const pySymbolParser = require('../packages/core/lib/symbol-parser-py.cjs')
const miscSymbolParsers = require('../packages/core/lib/symbol-parser-misc.cjs')
// Stage 3 — tree-sitter exact parsers. Default ON; CS_SYMBOL_PARSER=regex
// falls back to the regex/Babel parsers above for comparison or when
// the WASM grammars aren't shipped (e.g. a stripped portable build).
let _tsParserModule = null
try { _tsParserModule = require('../packages/core/lib/symbol-parser-treesitter.cjs') } catch {}
// Stage 4 — TypeScript compiler API integration. Opt-in via
// CS_SYMBOL_PARSER=tsc, because building the TS Program loads every
// file in the repo and is slower than babel for medium projects.
// Worth it for accuracy on heavy-TS codebases where overloaded method
// names (`save()` on many classes) need real type-checker resolution.
let _tscParserModule = null
try { _tscParserModule = require('../packages/core/lib/symbol-parser-tsc.cjs') } catch {}
const SYMBOL_PARSER_MODE = process.env.CS_SYMBOL_PARSER || 'treesitter'

// Shared data-layer modules (single source of truth — the headless
// control-server uses the SAME ones, so trace/changes/tour/timeline/explore
// data can't drift between desktop and headless). The desktop keeps its OWN
// thin wrappers around these for its UI side-effects (IPC pulse / Live Trace
// overlay); only the DATA layer (persistence, format, computation) lives here.
const traceStore = require('../packages/core/lib/trace-store.cjs')
const changesViews = require('../packages/core/lib/changes-views.cjs')
const symbolExplore = require('../packages/core/lib/symbol-explore.cjs')

function registerSymbolParsers() {
  // Always register the Stage-1/2 parsers as the fallback set.
  registerParser(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'], jsSymbolParser)
  registerParser(['py'], pySymbolParser)
  registerParser(['go'],   miscSymbolParsers.go)
  registerParser(['rs'],   miscSymbolParsers.rust)
  registerParser(['java', 'kt'], miscSymbolParsers.javaKt)
  registerParser(['swift'], miscSymbolParsers.swift)
  if (SYMBOL_PARSER_MODE !== 'treesitter' || !_tsParserModule) return
  // Override per-extension with tree-sitter parsers where a grammar
  // is available. The fallback set above still answers for languages
  // without a shipped wasm.
  try {
    for (const ext of _tsParserModule.availableExtensions()) {
      // Keep these extensions on the VALIDATED babel parser, never the
      // tree-sitter grammar:
      //   - ts/tsx: our bundled tree-sitter JS grammar is missing
      //     `interface`, type aliases, generics, etc.
      //   - js/jsx/mjs/cjs: babel is the validated path for plain JS
      //     (the headless server uses babel for JS); the tree-sitter JS
      //     grammar produces wrong call edges, so do NOT downgrade here.
      if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) continue
      // Skip languages whose wasm grammar is broken (ABI mismatch throws
      // at parse time) — these are excluded from the validated headless
      // set too. Registering them only produces silently-failing parsers.
      if (ext === 'rb' || ext === 'dart') continue
      const tsP = _tsParserModule.makeParser(ext)
      if (tsP) registerParser([ext], tsP)
    }
  } catch (e) {
    console.error('[symbol] tree-sitter init failed, falling back to regex:', e.message)
  }
  // Stage 4 override — TypeScript compiler API for .ts/.tsx/.js/.jsx
  // when the user opts in. Provides true type-checker-resolved call
  // edges (no more random matches across same-named methods).
  if (SYMBOL_PARSER_MODE === 'tsc' && _tscParserModule?.isAvailable?.()) {
    const tscP = _tscParserModule.makeParser()
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
      registerParser([ext], tscP)
    }
  }
}
registerSymbolParsers()
let symbolGraph = null            // SymbolGraph instance; rebuilt per project
let _symbolBuilding = null        // in-flight build promise (avoid double work)

// Drop the cached L2 symbol graph so the next /symbol/* request rebuilds.
// Called on every watched-file add/change/remove. The symbol graph spans
// the whole project (cross-file call resolution, re-export chains, route
// edges), so a single-file edit can change edges anywhere — a targeted
// per-file patch isn't safe; a full rebuild on next query is. We only
// invalidate when a graph (or in-flight build) actually exists, so the
// common "no symbol query yet" path stays a no-op.
function invalidateSymbolGraph(id, reason) {
  if (!symbolGraph && !_symbolBuilding) return
  symbolGraph = null
  _symbolBuilding = null
  try { log.info('symbol graph invalidated', { file: id, reason }) } catch {}
}

// Fingerprint of a scanner's exact file set, as sorted "id:mtimeMs" pairs.
// Used by the opt-in symbol disk cache (CS_SYMBOL_CACHE=1) so cache validity
// also depends on the file set itself, not just the newest surviving mtime
// (which can't see deletions/renames/additions). Missing-stat files are
// included as id:0 so an unreadable file still perturbs the hash.
function symbolFileSetHash(sc) {
  const parts = []
  for (const f of sc.files.values()) {
    let m = 0
    try { m = fs.statSync(f.absPath).mtimeMs } catch {}
    parts.push(f.id + ':' + m)
  }
  parts.sort()
  return require('crypto').createHash('sha1').update(parts.join('\n')).digest('hex')
}

// The explore classification helpers (path/test/aux detection, camelCase split,
// Porter-style stemmer, deprecated/public-entry detection) now live ONCE in the
// shared lib/symbol-explore.cjs — the same module the headless control-server
// uses for /symbol/explore. Bind the few still referenced directly here:
//   - isPublicEntry: used below for g.computeReachability(isPublicEntry).
const isPublicEntry = symbolExplore.isPublicEntry


// ─── /symbol/explore classify view ────────────────────────────
// DATA layer lives ONCE in lib/symbol-explore.cjs (same as the headless
// control-server). The desktop wrapper keeps the original (g, query, budget)
// signature and injects:
//   - readSource: a root-scoped disk read (the snippet source). Mirrors the
//     desktop's original `path.join(currentRoot, file)` read; the shared
//     module slices [startLine-1, endLine] exactly like the old inline code.
//   - embedding: only when the graph already carries embeddings (g._embedded),
//     matching control-server — offline-safe, never triggers a model download.
function _exploreReadSource(file, startLine, endLine) {
  try {
    if (!currentRoot) return null
    const lines = fs.readFileSync(path.join(currentRoot, file), 'utf8').split('\n')
    return lines.slice(startLine - 1, endLine).join('\n')
  } catch { return null }
}
function buildClassifyResponse(g, query, budget = 8000) {
  let embeddingMod = null
  if (g._embedded) { try { embeddingMod = require('../packages/core/lib/embedding.cjs') } catch {} }
  return symbolExplore.buildClassifyResponse(g, query, budget, _exploreReadSource, embeddingMod)
}

// Legacy audit module — lazy-loaded ESM. Cached by snapshotVersion.
let _legacyAudit = null
let _legacyCache = { version: -1, data: null }
async function loadLegacyAudit() {
  if (_legacyAudit) return _legacyAudit
  const mod = await import('../packages/core/legacy.js')
  _legacyAudit = mod.auditLegacy
  return _legacyAudit
}
async function buildLegacyCached() {
  if (!scanner) return null
  const v = scanner.snapshotVersion || 0
  if (_legacyCache.version === v && _legacyCache.data) return _legacyCache.data
  const fn = await loadLegacyAudit()
  const data = fn(scanner)
  if (scanner.snapshotVersion === v) _legacyCache = { version: v, data }
  return data
}

async function startScanner(root) {
  // [gap#2] Pure-client mode has no local scanner — delegate to the daemon-attach
  // path. Every "load this project" entry point (did-finish-load, load-folder,
  // recent/pinned menu, pick-folder, second-instance) funnels through here, so
  // this single dispatch converts them all.
  if (PURE_CLIENT) return startPureClient(root)
  // Await teardown: scanner.stop() returns chokidar's close() promise. Not
  // awaiting leaks the old watcher's fs handles when we immediately attach a
  // new one (worst on Windows). clearParserCaches also runs inside stop().
  if (scanner) { try { await scanner.stop() } catch {} ; scanner = null }
  await loadScannerModule()

  if (!fs.existsSync(root)) {
    mainWindow?.webContents.send('error', { message: `Path does not exist: ${root}` })
    return
  }
  // If a file was dropped instead of a folder, automatically use its
  // parent directory. This is a common interaction — users drag a
  // representative source file rather than a whole folder.
  const stat = fs.statSync(root)
  if (!stat.isDirectory()) {
    if (stat.isFile()) {
      const parent = path.dirname(root)
      mainWindow?.webContents.send('error', {
        message: `Opened parent folder: ${path.basename(parent)}/`,
      })
      root = parent
    } else {
      mainWindow?.webContents.send('error', { message: `Not a directory: ${root}` })
      return
    }
  }

  // Stop any in-flight scanner cleanly before installing a new one
  currentRoot = root
  registerDesktopDaemon()   // (re)register this project in the daemon registry
  timelineCache = { root: null, data: null, building: false }   // invalidate
  // Drop every scanner-version-keyed cache so the next /summary, /packages,
  // /legacy call recomputes against the freshly-loaded project instead of
  // returning stale data from the previous project.
  _summaryCache  = { version: -1, data: null }
  _packagesCache = { version: -1, data: null }
  _legacyCache   = { version: -1, data: null }
  // Symbol-mode graph belongs to the previous project — drop it. The
  // next /symbol/* request will rebuild against the new file set.
  symbolGraph = null
  _symbolBuilding = null
  // tsc Program cache must also be cleared so we don't keep the old
  // project's SourceFiles around.
  try { _tscParserModule?.clearAllPrograms?.() } catch {}
  migrateLegacyHistoryDir(root)
  addRecent(root)
  scanner = new Scanner(root)

  scanner.on('snapshot', (data) => {
    // [④] While the desktop is attached to a remote session's daemon, that
    // session's graph owns the canvas — don't let the local scanner overwrite it.
    if (viewerAttached()) return
    mainWindow?.webContents.send('snapshot', { ...data, root })
  })
  scanner.on('stats', (s) => {
    mainWindow?.webContents.send('stats', s)
  })
  scanner.on('scan-progress', (p) => {
    mainWindow?.webContents.send('scan-progress', p)
  })
  scanner.on('file-changed', ({ id, absPath }) => {
    invalidateSymbolGraph(id, 'changed')
    try {
      const stat = fs.statSync(absPath)
      if (stat.size > 2_000_000) return
      const content = fs.readFileSync(absPath, 'utf8')
      snapshotHistory(currentRoot, id, content)
      trackChange(id, content)
    } catch {}
  })
  // The L2 symbol graph is built lazily and cached in-memory until the
  // next project swap. Without these hooks, adding/editing/deleting a
  // file left /symbol/* serving symbols + call edges from the pre-edit
  // source — e.g. a renamed function still resolved, a deleted file's
  // symbols still listed. Drop the cached graph (and its in-flight
  // build) so the next /symbol/* request rebuilds against the current
  // file set. Cheap: rebuild is amortised over the next query, and the
  // file-mode graph the scanner already maintains is untouched.
  scanner.on('file-added',   ({ id }) => invalidateSymbolGraph(id, 'added'))
  scanner.on('file-removed', ({ id }) => invalidateSymbolGraph(id, 'removed'))

  mainWindow?.webContents.send('folder-loaded', { root })
  startTraceSession()
  try {
    scanner.start()
  } catch (err) {
    mainWindow?.webContents.send('error', { message: `Failed to start scanner: ${err.message}` })
    scanner = null
    currentRoot = null
  }
}

function stopScanner() {
  if (scanner) { Promise.resolve(scanner.stop()).catch(() => {}); scanner = null }
  _trace._closeStream()
  currentRoot = null
  unregisterDesktopDaemon()   // project unloaded — drop its registry entry
}

// ─── Window ─────────────────────────────────────────────────────
function createWindow() {
  const bounds = store.windowBounds || { width: 1280, height: 820 }
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#07090F',
    show: false,   // shown on 'ready-to-show' so the renderer paints first (no white flash)
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'CodeSynapt',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox isolates the renderer from Node APIs entirely. Preload uses
      // only contextBridge + ipcRenderer (no fs/path/etc), so sandbox:true
      // is compatible. Reduces blast radius of any renderer-side compromise.
      sandbox: true,
    },
  })

  mainWindow.loadURL('app://bundle/index.html')
  mainWindow.once('ready-to-show', () => mainWindow.show())
  // Safety net: if the renderer never reports ready (load failure), show the
  // window anyway so it can't get stuck invisible.
  setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show() } catch {} }, 8000)

  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      store.windowBounds = mainWindow.getBounds()
      saveStore()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // ─── Visibility events for physics pause ─────────────────────
  //
  // We deliberately listen ONLY to minimize/restore/hide/show —
  // NOT to blur/focus. The simulation should keep running when
  // the user merely clicks into another app, even if our window
  // is fully obscured. We only pause when the OS no longer needs
  // to render us at all (minimized to taskbar, hidden via Cmd+H,
  // or moved to another virtual desktop and explicitly hidden).
  //
  // This matches user intuition: "I didn't tell it to stop, so it
  // shouldn't stop." It also lets the user keep CodeSynapt alive
  // on a second monitor while they work in another app.
  // ─────────────────────────────────────────────────────────────
  const sendVisibility = (visible) => {
    if (!mainWindow?.isDestroyed()) {
      mainWindow.webContents.send('window-visibility', { visible })
    }
  }
  mainWindow.on('minimize', () => sendVisibility(false))
  mainWindow.on('restore',  () => sendVisibility(true))
  mainWindow.on('hide',     () => sendVisibility(false))
  mainWindow.on('show',     () => sendVisibility(true))

  // Drag & drop folder onto window
  mainWindow.webContents.on('did-finish-load', () => {
    // Priority: CS_INITIAL_ROOT env (set by `cs ensure --launch`) > last folder
    const envRoot = process.env.CS_INITIAL_ROOT
    if (envRoot && fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) {
      startScanner(path.resolve(envRoot))
    } else if (store.lastFolder && fs.existsSync(store.lastFolder)) {
      startScanner(store.lastFolder)
    } else {
      mainWindow.webContents.send('no-folder')
    }
  })

  if (process.env.CS_DEVTOOLS === '1' || process.env.FG3D_DEVTOOLS === '1') mainWindow.webContents.openDevTools()
}

// ─── Native menu ────────────────────────────────────────────────
function rebuildMenu() {
  const isMac = process.platform === 'darwin'
  const pinnedItems = (store.pinnedProjects || []).map((p) => ({
    label: `★  ${p.name}`,
    sublabel: p.path,
    click: () => startScanner(p.path),
  }))
  const recentItems = (store.recentFolders || [])
    .filter((f) => !(store.pinnedProjects || []).some((p) => p.path === f))
    .map((f) => ({ label: f, click: () => startScanner(f) }))
  const recentSubmenu = (pinnedItems.length || recentItems.length)
    ? [
        ...(pinnedItems.length ? pinnedItems : []),
        ...(pinnedItems.length && recentItems.length ? [{ type: 'separator' }] : []),
        ...recentItems,
        { type: 'separator' },
        { label: 'Clear Recent', click: () => {
          store.recentFolders = []
          saveStore()
          rebuildMenu()
        }},
      ]
    : [{ label: 'No recent folders', enabled: false }]

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => pickAndLoadFolder(),
        },
        {
          label: 'Open Recent',
          submenu: recentSubmenu,
        },
        { type: 'separator' },
        {
          label: 'Close Folder',
          accelerator: 'CmdOrCtrl+W',
          enabled: !!currentRoot,
          click: () => {
            stopScanner()
            store.lastFolder = null
            saveStore()
            mainWindow?.webContents.send('no-folder')
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickAndLoadFolder() {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder to visualize',
    defaultPath: store.lastFolder || app.getPath('home'),
  })
  if (result.canceled || !result.filePaths[0]) return null
  await startScanner(result.filePaths[0])
  return result.filePaths[0]
}

// ─── IPC handlers ───────────────────────────────────────────────
ipcMain.handle('pick-folder', () => pickAndLoadFolder())
ipcMain.handle('load-folder', (_e, folder) => startScanner(folder))
ipcMain.handle('get-state', () => ({
  currentRoot,
  recentFolders: store.recentFolders,
}))
ipcMain.handle('close-folder', () => {
  if (PURE_CLIENT) { try { getViewer().detach() } catch {} ; _ownDaemonPort = null; currentRoot = null }
  else stopScanner()
  store.lastFolder = null
  saveStore()
  mainWindow?.webContents.send('no-folder')
})
// Path traversal guard. Resolves both paths to absolute, then checks
// that the requested file is INSIDE currentRoot (not just that its
// string starts with the same prefix, which fails on e.g.
// /home/user/proj vs /home/user/proj2 false positives).
function isInsideRoot(root, full) {
  const resolvedRoot = path.resolve(root)
  const resolvedFull = path.resolve(full)
  const rel = path.relative(resolvedRoot, resolvedFull)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

ipcMain.handle('read-file', (_e, id) => {
  if (!currentRoot || !id) return null
  try {
    const full = path.join(currentRoot, id)
    if (!isInsideRoot(currentRoot, full)) return null
    const stat = fs.statSync(full)
    if (!stat.isFile()) return null
    if (stat.size > 2_000_000) return { content: '[file too large to open]', truncated: true }
    const content = fs.readFileSync(full, 'utf8')
    return { content }
  } catch (e) {
    return { content: `[error: ${e.message}]`, error: true }
  }
})
// Shared write helper — used by IPC, HTTP /write, and HTTP /edit.
// All AI-issued writes flow through here so the audit trail (history
// snapshot + trace emission) is consistent regardless of entry point.
function writeFileToRoot(id, content, { source = 'ipc' } = {}) {
  if (!currentRoot || !id || typeof content !== 'string') return { ok: false, error: 'invalid args' }
  if (content.length > 2_000_000) return { ok: false, error: 'content too large (>2MB)' }
  try {
    const full = path.join(currentRoot, id)
    if (!isInsideRoot(currentRoot, full)) return { ok: false, error: 'outside root' }
    fs.writeFileSync(full, content, 'utf8')
    snapshotHistory(currentRoot, id, content)
    // Mark every external write with `tool: 'write'` so the renderer
    // can tint the node green instead of the read-pink.
    emitTrace('write', id)
    return { ok: true, size: Buffer.byteLength(content, 'utf8'), source }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

ipcMain.handle('write-file', (_e, id, content) => writeFileToRoot(id, content, { source: 'ipc' }))
ipcMain.handle('set-history-enabled', (_e, enabled) => {
  historyEnabled = !!enabled
  return { ok: true, enabled: historyEnabled }
})
ipcMain.handle('get-history-enabled', () => historyEnabled)
ipcMain.handle('list-history', (_e, id) => listHistory(currentRoot, id))
ipcMain.handle('read-history', (_e, id, ts) => readHistorySnap(currentRoot, id, ts))
ipcMain.handle('restore-history', (_e, id, ts) => {
  if (!currentRoot || !id || !ts) return { ok: false }
  const content = readHistorySnap(currentRoot, id, ts)
  if (content === null) return { ok: false, error: 'snapshot not found' }
  try {
    const full = path.join(currentRoot, id)
    if (!isInsideRoot(currentRoot, full)) return { ok: false, error: 'outside root' }
    fs.writeFileSync(full, content, 'utf8')
    snapshotHistory(currentRoot, id, content)
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── Session change log ────────────────────────────────────────
// Tracks every file modification detected by the scanner during this
// session — what AI editing agents (Claude Code, Cursor) write hits
// this list. Captures first-seen content on first detection so we can
// generate diffs for the "show all changes" view.
// DATA layer now lives in the shared lib/changes-views.cjs SessionChangeLog
// (same instance semantics the headless control-server uses). The desktop
// keeps thin wrappers with its original signatures so every caller (IPC +
// HTTP) is unchanged. `getChangeDiff` still root-scopes via currentRoot.
const _changes = new changesViews.SessionChangeLog()
function trackChange(id, content) { return _changes.track(id, content) }
function listSessionChanges() { return _changes.list() }
function getChangeDiff(id) { return _changes.diff(id, currentRoot) }

// ─── File history ──────────────────────────────────────────────
const HISTORY_DIR_NAME = '.codesynapt'
const LEGACY_HISTORY_DIR_NAME = '.filegraph3d'   // renamed in 0.14.6; migrate on first scan
const HISTORY_MAX_PER_FILE = 3
let historyEnabled = false  // default OFF — user toggles on in settings
function historyDirFor(root, id) {
  const safe = id.replace(/[\\/:]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(root, HISTORY_DIR_NAME, 'history', safe)
}
// One-time migration of the per-project data folder (history/ + traces/).
// If a user upgraded from <0.14.6, their backups live under .filegraph3d/.
// We rename the whole folder so both history/ and traces/ subdirs move together.
// Skipped if the new folder already exists (user has both somehow — leave them).
function migrateLegacyHistoryDir(root) {
  if (!root) return
  try {
    const oldPath = path.join(root, LEGACY_HISTORY_DIR_NAME)
    const newPath = path.join(root, HISTORY_DIR_NAME)
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath) && fs.statSync(oldPath).isDirectory()) {
      fs.renameSync(oldPath, newPath)
      log.info('migrated legacy history dir', { from: LEGACY_HISTORY_DIR_NAME, to: HISTORY_DIR_NAME, root })
    }
  } catch (e) {
    log.warn('history dir migration skipped', { error: e.message })
  }
}
function snapshotHistory(root, id, content) {
  if (!historyEnabled) return
  if (!root || !id) return
  try {
    const dir = historyDirFor(root, id)
    fs.mkdirSync(dir, { recursive: true })
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.snap'))
      .map((f) => ({ name: f, ts: parseInt(f, 10) }))
      .filter((f) => !isNaN(f.ts))
      .sort((a, b) => b.ts - a.ts)
    // Skip if newest snapshot is identical (avoid stutter from chokidar re-firing)
    if (files.length > 0) {
      try {
        const prev = fs.readFileSync(path.join(dir, files[0].name), 'utf8')
        if (prev === content) return
      } catch {}
    }
    fs.writeFileSync(path.join(dir, `${Date.now()}.snap`), content, 'utf8')
    // Prune to last HISTORY_MAX_PER_FILE
    const all = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.snap'))
      .map((f) => ({ name: f, ts: parseInt(f, 10) }))
      .filter((f) => !isNaN(f.ts))
      .sort((a, b) => b.ts - a.ts)
    for (const f of all.slice(HISTORY_MAX_PER_FILE)) {
      try { fs.unlinkSync(path.join(dir, f.name)) } catch {}
    }
  } catch {}
}
function listHistory(root, id) {
  if (!root || !id) return []
  try {
    const dir = historyDirFor(root, id)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.snap'))
      .map((f) => {
        const ts = parseInt(f, 10)
        if (isNaN(ts)) return null
        try {
          const stat = fs.statSync(path.join(dir, f))
          return { ts, size: stat.size }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts)
  } catch { return [] }
}
function readHistorySnap(root, id, ts) {
  if (!root || !id || !ts) return null
  try {
    const dir = historyDirFor(root, id)
    const file = path.join(dir, `${ts}.snap`)
    if (!fs.existsSync(file)) return null
    return fs.readFileSync(file, 'utf8')
  } catch { return null }
}
ipcMain.handle('reveal-in-os', (_e, id) => {
  if (!currentRoot || !id) return
  const full = path.join(currentRoot, id)
  if (isInsideRoot(currentRoot, full) && fs.existsSync(full)) {
    shell.showItemInFolder(full)
  }
})
ipcMain.handle('open-in-editor', (_e, id) => {
  if (!currentRoot || !id) return
  const full = path.join(currentRoot, id)
  if (isInsideRoot(currentRoot, full) && fs.existsSync(full)) {
    shell.openPath(full)
  }
})

// ─── Plugin system ──────────────────────────────────────────────
const pluginLoader = require('./plugin-loader.cjs')

ipcMain.handle('list-plugins', () => {
  try {
    return pluginLoader.discoverPlugins()
  } catch (err) {
    console.error('[main] plugin discovery failed:', err)
    return []
  }
})

ipcMain.handle('open-plugin-dir', () => {
  try {
    const dir = pluginLoader.ensurePluginDir()
    shell.openPath(dir)
    return dir
  } catch (err) {
    console.error('[main] cannot open plugin dir:', err)
    return null
  }
})

ipcMain.handle('plugin-dir', () => pluginLoader.getPluginDir())

// Approve / revoke a plugin's trust (the round-trip the permission model needs
// to be usable from the UI). approve-plugin grants the requested permissions
// and pins the content hash; revoke-plugin removes trust. Both return {ok,...}.
ipcMain.handle('approve-plugin', (_e, id, opts) => {
  try { return pluginLoader.approvePlugin(id, opts || {}) }
  catch (err) { console.error('[main] approve-plugin failed:', err); return { ok: false, reason: String(err && err.message || err) } }
})
ipcMain.handle('revoke-plugin', (_e, id) => {
  try { return pluginLoader.revokePlugin(id) }
  catch (err) { console.error('[main] revoke-plugin failed:', err); return { ok: false, reason: String(err && err.message || err) } }
})

// ─── Auto-updater control (renderer-driven) ────────────────────
// The updater is wired in app.whenReady() below; these handlers let the
// renderer toast drive download/install. `_autoUpdater` is null when the
// updater is disabled (CS_DISABLE_UPDATER=1) or electron-updater isn't
// installed (CLI/MCP-only builds) — handlers degrade gracefully then.
let _autoUpdater = null
let _updateAvailableInfo = null    // last 'update-available' info, if any
let _updateDownloaded = false      // true once 'update-downloaded' fired
// Renderer requests the actual download once the user clicks "download".
ipcMain.handle('updater:download', async () => {
  if (!_autoUpdater) return { ok: false, error: 'updater unavailable' }
  if (!_updateAvailableInfo) return { ok: false, error: 'no update available' }
  try {
    await _autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (e) {
    log.error('updater download failed', { message: e.message })
    return { ok: false, error: e.message }
  }
})
// Renderer requests install (quit + relaunch into the new version) once
// the user clicks "restart". quitAndInstall does not return.
ipcMain.handle('updater:install', () => {
  if (!_autoUpdater) return { ok: false, error: 'updater unavailable' }
  if (!_updateDownloaded) return { ok: false, error: 'no update downloaded' }
  try {
    setImmediate(() => { try { _autoUpdater.quitAndInstall() } catch (e) { log.error('quitAndInstall failed', { message: e.message }) } })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
// Manual "check now" trigger (e.g. a menu/settings button).
ipcMain.handle('updater:check', async () => {
  if (!_autoUpdater) return { ok: false, error: 'updater unavailable' }
  try {
    const r = await _autoUpdater.checkForUpdates()
    return { ok: true, updateInfo: r?.updateInfo ? { version: r.updateInfo.version } : null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── Pinned projects ──────────────────────────────────────────
function basenameOf(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || p
}
// ─── Panel data IPCs (renderer → main, bypasses HTTP/CSP) ─────
// These mirror the HTTP control API endpoints but are reached via the
// preload bridge instead of fetch(). The renderer can't fetch its own
// HTTP server from the file:// origin under the current CSP, so we
// expose the data through IPC. Same underlying functions are shared
// with the HTTP layer.
ipcMain.handle('panel:tour',       () => PURE_CLIENT ? daemonGet('/tour') : buildTour())
ipcMain.handle('panel:timeline',   () => PURE_CLIENT ? daemonGet('/timeline') : buildTimeline())
ipcMain.handle('panel:changes',    () => PURE_CLIENT ? daemonGet('/changes') : listSessionChanges())
ipcMain.handle('panel:change-diff', (_e, id) => PURE_CLIENT ? daemonGet('/changes/' + encodeURIComponent(id)) : getChangeDiff(id))
ipcMain.handle('panel:packages',   () => PURE_CLIENT ? daemonGet('/packages') : buildPackagesCached())
ipcMain.handle('panel:package',    (_e, name) => PURE_CLIENT ? daemonGet('/package/' + encodeURIComponent(name)) : buildPackageDetail(name))
ipcMain.handle('panel:legacy',     () => PURE_CLIENT ? daemonGet('/legacy') : buildLegacyCached())
// Symbol graph (Layer-2) — unlike the panels above, the renderer historically
// fetched this DIRECTLY over HTTP. From the app:// scheme that is a cross-origin
// request, and the backend's allowedOrigin reflects only loopback Origins (never
// app://), so the response carries no Access-Control-Allow-Origin and the browser
// blocks it — silently, because buildSymbolGraph()'s catch swallows the error.
// Proxy it through IPC like every other panel. Main-process HTTP has no CORS, so
// this works in both modes: pure-client → the project daemon, normal desktop →
// the local control-server.
ipcMain.handle('panel:symbols', () => {
  const port = (PURE_CLIENT && _ownDaemonPort) ? _ownDaemonPort : controlPort
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('symbol backend not ready'))
    const r = http.get({ host: '127.0.0.1', port, path: '/symbol/graph', timeout: 30000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    })
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
  })
})
ipcMain.handle('trace:log',        (_e, opts = {}) => {
  if (PURE_CLIENT) return daemonGet('/trace').then((r) => {
    let evs = (r && r.events) || []
    if (opts.tool) evs = evs.filter((e) => e.tool === opts.tool)
    if (opts.limit) evs = evs.slice(-opts.limit)
    return { sessionId: r && r.sessionId, events: evs, totalAvailable: (r && r.meta && r.meta.totalAvailable) || evs.length }
  })
  let evs = _trace.log
  if (opts.tool) evs = evs.filter((e) => e.tool === opts.tool)
  if (opts.limit) evs = evs.slice(-opts.limit)
  return { sessionId: _trace.sessionId, events: evs, totalAvailable: _trace.log.length }
})
ipcMain.handle('trace:stats',      () => PURE_CLIENT ? daemonGet('/trace/stats') : ({ sessionId: _trace.sessionId, ...computeTraceStats(_trace.log) }))
ipcMain.handle('trace:sessions',   () => PURE_CLIENT ? daemonGet('/trace/sessions') : ({
  sessions: listTraceSessions(currentRoot), currentSessionId: _trace.sessionId,
}))
ipcMain.handle('trace:session',    (_e, id) => {
  if (PURE_CLIENT) return daemonGet('/trace/session/' + encodeURIComponent(id))
  const data = readTraceSession(currentRoot, id)
  if (!data) return null
  return { ...data, stats: computeTraceStats(data.events) }
})
ipcMain.handle('trace:clear',      () => PURE_CLIENT ? daemonSend('POST', '/trace/clear') : (() => { _trace.log = []; startTraceSession(); return { newSessionId: _trace.sessionId } })())
ipcMain.handle('trace:export',     async (_e, exportPath) => {
  if (!exportPath) {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export AI trace session',
      defaultPath: `cs-trace-${_trace.sessionId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { canceled: true }
    exportPath = r.filePath
  }
  if (PURE_CLIENT) {
    try { const r = await daemonSend('POST', '/trace/export', { path: exportPath }); return r || { ok: true, path: exportPath } }
    catch (e) { return { error: e.message } }
  }
  try {
    const stats = computeTraceStats(_trace.log)
    const out = {
      sessionId: _trace.sessionId, root: currentRoot,
      startedAt: _trace.startedAt, exportedAt: Date.now(),
      stats, events: _trace.log,
    }
    fs.writeFileSync(exportPath, JSON.stringify(out, null, 2), 'utf8')
    return { ok: true, path: exportPath, eventCount: _trace.log.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('list-projects', () => ({
  pinned: store.pinnedProjects || [],
  recent: store.recentFolders || [],
  current: currentRoot,
}))
ipcMain.handle('pin-project', (_e, payload) => {
  const path = (payload && payload.path) || ''
  if (!path) return { ok: false, error: 'path required' }
  const name = (payload && payload.name) || basenameOf(path)
  const color = (payload && payload.color) || null
  store.pinnedProjects = (store.pinnedProjects || []).filter((p) => p.path !== path)
  store.pinnedProjects.unshift({ path, name, color, pinnedAt: Date.now() })
  saveStore()
  rebuildMenu()
  return { ok: true, pinned: store.pinnedProjects }
})
ipcMain.handle('unpin-project', (_e, path) => {
  store.pinnedProjects = (store.pinnedProjects || []).filter((p) => p.path !== path)
  saveStore()
  rebuildMenu()
  return { ok: true, pinned: store.pinnedProjects }
})
ipcMain.handle('rename-project', (_e, payload) => {
  const path = (payload && payload.path) || ''
  const name = (payload && payload.name) || ''
  if (!path || !name) return { ok: false, error: 'path and name required' }
  const list = store.pinnedProjects || []
  const item = list.find((p) => p.path === path)
  if (!item) return { ok: false, error: 'not pinned' }
  item.name = name
  saveStore()
  rebuildMenu()
  return { ok: true, pinned: list }
})

// ─── HTTP control server (for CLI + MCP) ───────────────────────
// Exposes read-only graph queries and UI control actions on
// http://127.0.0.1:PORT (default 7707). Local-only. Port and
// enable/disable are configurable via env vars and persistent settings.
const CONTROL_DEFAULT_PORT = parseInt(process.env.CS_PORT || process.env.FG3D_PORT || '7707', 10)
let controlServer = null
let controlPort = CONTROL_DEFAULT_PORT

function getGraphState() {
  if (!scanner) return null
  return { root: currentRoot, ...scanner.snapshot() }
}
// SHA-256 of a file's bytes, cached on the file object (O(1) on repeat).
// Mirrors the headless control-server so an AI can compare its own Read
// hash against this for freshness — previously desktop-only callers had no
// such hash, so freshness verification silently failed against the app.
function fileContentHash(f) {
  if (!f || !f.absPath) return null
  if (f._cachedHash && f._cachedHashAt === f.lastSeenAt) return f._cachedHash
  try {
    const buf = fs.readFileSync(f.absPath)
    const h = require('crypto').createHash('sha256').update(buf).digest('hex')
    f._cachedHash = h
    f._cachedHashAt = f.lastSeenAt
    return h
  } catch { return null }
}
function findNode(id) {
  if (!scanner) return null
  const f = scanner.files.get(id)
  if (!f) return null
  return {
    id: f.id, ext: f.ext, loc: f.loc, size: f.size,
    importCount: f.imports.length,
    hasDynamicResolution: (f.dynamicPatterns || []).length > 0,
    dynamicPatterns: f.dynamicPatterns || [],
    confidence: f.confidence || 'high',
    pkg: f.pkg || null,
    contentHash: fileContentHash(f),
    lastSeenAt: f.lastSeenAt,
  }
}

// Approximate token count — Anthropic's published rule of thumb is
// ~3.5–4 chars/token for code. Use 4 conservatively for budgeting.
function estimateTokens(obj) {
  try { return Math.ceil(JSON.stringify(obj).length / 4) } catch { return 0 }
}
function withMeta(payload, extra = {}) {
  const meta = {
    scannedAt: scanner?._lastSnapshotAt || Date.now(),
    serverTime: Date.now(),
    ...extra,
  }
  meta.tokenEstimate = estimateTokens({ ...payload, meta })
  return { ...payload, meta }
}

// Cached wrapper around buildSummary — recomputes only when the graph
// snapshot version changes. Lazy: cost paid only when summary is read.
let _summaryCache = { version: -1, data: null }
function buildSummaryCached() {
  if (!scanner) return null
  const v = scanner.snapshotVersion || 0
  if (_summaryCache.version === v && _summaryCache.data) return _summaryCache.data
  const data = buildSummary()
  // Race guard: only cache if version didn't shift during compute.
  if (scanner.snapshotVersion === v) _summaryCache = { version: v, data }
  return data
}

// Project summary — Layer-1 cheap overview for AI to read first
function buildSummary() {
  if (!scanner) return null
  const files = [...scanner.files.values()]
  const byExt = {}
  let dynamicCount = 0
  const incoming = new Map()
  const outgoing = new Map()
  for (const e of scanner.edges) {
    incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
  }
  for (const f of files) {
    byExt[f.ext || 'other'] = (byExt[f.ext || 'other'] || 0) + 1
    if ((f.dynamicPatterns || []).length > 0) dynamicCount++
  }
  // Top hubs
  const topHubs = files
    .map((f) => ({ id: f.id, incoming: incoming.get(f.id) || 0, ext: f.ext }))
    .filter((h) => h.incoming >= 2)
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 10)
  // Top folders by file count
  const folderCount = new Map()
  for (const f of files) {
    const p = f.id.includes('/') ? f.id.slice(0, f.id.lastIndexOf('/')) : '(root)'
    const top = p.split('/')[0] || '(root)'
    folderCount.set(top, (folderCount.get(top) || 0) + 1)
  }
  const topFolders = [...folderCount.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([path, files]) => ({ path, files }))
  // Orphans (no incoming AND no outgoing)
  let orphanCount = 0
  for (const f of files) {
    if ((incoming.get(f.id) || 0) === 0 && (outgoing.get(f.id) || 0) === 0) orphanCount++
  }
  // Ext breakdown (top 5)
  const extMix = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .reduce((o, [k, v]) => (o[k] = v, o), {})
  // External services (already aggregated)
  const ext = getExternalUrls()
  const topExternal = ext.domains.slice(0, 5).map((d) => d.domain)
  // `asset` edges are HTML/CSS/etc. referencing image/script/style files
  // (jQuery, jazzy.js, theme CSS, image tags). They're useful when you
  // ask "what assets does this page link to?" but they shouldn't dominate
  // the code-structure stats — a 300-page Jazzy-generated docs tree would
  // make `edgeCount` swing by thousands without representing any source
  // dependency. Split them into their own counter.
  let codeEdges = 0, assetEdges = 0
  for (const e of scanner.edges) {
    if (e.kind === 'asset' || e.k === 'asset') assetEdges++
    else codeEdges++
  }
  return {
    root: currentRoot,
    fileCount: files.length,
    edgeCount: codeEdges,
    assetEdgeCount: assetEdges,
    extMix,
    topFolders,
    topHubs,
    orphanCount,
    dynamicPatternFileCount: dynamicCount,
    externalDomainCount: ext.domains.length,
    externalDomainsTop: topExternal,
    historyEnabled,
  }
}
function getDeps(id) {
  if (!scanner) return []
  return scanner.edges.filter((e) => e.s === id)
}
function getUsers(id) {
  if (!scanner) return []
  return scanner.edges.filter((e) => e.t === id)
}
// Package-level overview. For each detected package compute file count,
// LOC total, edges in/out of the package (file-level), and dependents.
// Cached against snapshotVersion like buildSummary.
let _packagesCache = { version: -1, data: null }
function buildPackagesCached() {
  if (!scanner) return null
  const v = scanner.snapshotVersion || 0
  if (_packagesCache.version === v && _packagesCache.data) return _packagesCache.data
  const m = scanner.monorepo
  if (!m || m.kind === 'none' || !m.packages.length) {
    const empty = { kind: m?.kind || 'none', packages: [], pkgEdges: [], rootIsPackage: !!m?.rootIsPackage }
    _packagesCache = { version: v, data: empty }
    return empty
  }
  // Bucket files per package
  const filesByPkg = new Map()
  for (const f of scanner.files.values()) {
    if (!f.pkg) continue
    const arr = filesByPkg.get(f.pkg) || []
    arr.push(f)
    filesByPkg.set(f.pkg, arr)
  }
  // Incoming/outgoing edge counts per package (file-level)
  const edgesIn = new Map(), edgesOut = new Map()
  for (const e of scanner.edges) {
    const sf = scanner.files.get(e.s), tf = scanner.files.get(e.t)
    if (!sf || !tf) continue
    if (sf.pkg && sf.pkg !== tf.pkg) edgesOut.set(sf.pkg, (edgesOut.get(sf.pkg) || 0) + 1)
    if (tf.pkg && sf.pkg !== tf.pkg) edgesIn.set(tf.pkg,  (edgesIn.get(tf.pkg)  || 0) + 1)
  }
  const packages = m.packages.map((p) => {
    const files = filesByPkg.get(p.name) || []
    const loc = files.reduce((s, f) => s + (f.loc || 0), 0)
    const size = files.reduce((s, f) => s + (f.size || 0), 0)
    return {
      name: p.name,
      relRoot: p.relRoot,
      manifest: p.manifest,
      language: p.language,
      kind: p.kind,
      fileCount: files.length,
      loc, size,
      crossPackageImports: edgesOut.get(p.name) || 0,
      crossPackageDependents: edgesIn.get(p.name) || 0,
    }
  })
  const data = {
    kind: m.kind,
    rootIsPackage: m.rootIsPackage,
    packages,
    pkgEdges: scanner.pkgEdges || [],
  }
  if (scanner.snapshotVersion === v) _packagesCache = { version: v, data }
  return data
}

// Detail view for a single package: files (sorted by mass), declared
// dependencies (from manifest), incoming/outgoing cross-package edges
// with the specific file pairs that make up each edge.
function buildPackageDetail(name) {
  if (!scanner) return null
  const m = scanner.monorepo
  const pkg = m?.packages?.find((p) => p.name === name)
  if (!pkg) return null
  const files = []
  const incoming = new Map()  // for sorting by mass
  for (const e of scanner.edges) incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
  for (const f of scanner.files.values()) {
    if (f.pkg !== name) continue
    files.push({
      id: f.id, ext: f.ext, loc: f.loc, size: f.size,
      mass: incoming.get(f.id) || 0,
    })
  }
  files.sort((a, b) => b.mass - a.mass)
  // Cross-package edges involving this package
  const outgoingEdges = []  // edges from THIS package to others
  const incomingEdges = []  // edges from others into THIS package
  for (const e of scanner.edges) {
    const sf = scanner.files.get(e.s), tf = scanner.files.get(e.t)
    if (!sf || !tf || !sf.pkg || !tf.pkg || sf.pkg === tf.pkg) continue
    if (sf.pkg === name) outgoingEdges.push({ s: e.s, t: e.t, k: e.k, toPkg: tf.pkg })
    if (tf.pkg === name) incomingEdges.push({ s: e.s, t: e.t, k: e.k, fromPkg: sf.pkg })
  }
  // Declared deps from manifest
  let declared = []
  try {
    if (pkg.manifest === 'package.json') {
      const j = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'))
      const collect = (field) => {
        if (!j[field]) return
        for (const [k, v] of Object.entries(j[field])) declared.push({ name: k, spec: v, kind: field })
      }
      collect('dependencies'); collect('devDependencies'); collect('peerDependencies')
    }
  } catch {}
  return {
    name, relRoot: pkg.relRoot, manifest: pkg.manifest,
    language: pkg.language, kind: pkg.kind,
    fileCount: files.length, files,
    outgoingEdges, incomingEdges,
    declared,
  }
}

function searchFiles(q) {
  if (!scanner || !q) return []
  const needle = q.toLowerCase()
  const out = []
  for (const f of scanner.files.values()) {
    if (f.id.toLowerCase().includes(needle)) out.push(f.id)
    if (out.length >= 100) break
  }
  return out
}

// Predict the impact of editing a file: BFS through dependents (or
// dependencies), tally total size + LOC + categorize by path. Token
// estimate uses the ~4-chars-per-token heuristic Anthropic publishes.
function computeBlastRadius(id, depth = 3, direction = 'users') {
  if (!scanner || !scanner.files.has(id)) return null
  const visited = new Set([id])
  let frontier = new Set([id])
  const byDepth = [{ depth: 0, ids: [id] }]
  for (let d = 1; d <= depth; d++) {
    const next = new Set()
    for (const fid of frontier) {
      const edges = direction === 'users' ? getUsers(fid) : getDeps(fid)
      for (const e of edges) {
        const neighbor = direction === 'users' ? e.s : e.t
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        next.add(neighbor)
      }
    }
    if (next.size === 0) break
    byDepth.push({ depth: d, ids: [...next] })
    frontier = next
  }
  const files = [...visited].map((fid) => {
    const f = scanner.files.get(fid)
    return f ? { id: fid, ext: f.ext, loc: f.loc, size: f.size } : null
  }).filter(Boolean)
  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const totalLoc  = files.reduce((s, f) => s + f.loc, 0)
  // Anthropic publishes ~3.5–4 chars/token for code. Use 4 as a round
  // estimate; this is the same heuristic the SDK docs recommend.
  const tokenEstimate = Math.round(totalSize / 4)
  const categories = { tests: 0, source: 0, config: 0, docs: 0, other: 0 }
  for (const f of files) {
    if (/(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$/i.test(f.id)) categories.tests++
    else if (/\.(?:json|ya?ml|toml|env|config|conf|ini|lock)(?:\.\w+)?$|^\.[a-z]+rc/i.test(f.id)) categories.config++
    else if (/\.(?:md|mdx|txt|rst|adoc)$/i.test(f.id)) categories.docs++
    else if (f.ext) categories.source++
    else categories.other++
  }
  return {
    seed: id, direction, depth,
    totalFiles: files.length,
    totalSize, totalLoc, tokenEstimate, categories,
    files: files.sort((a, b) => b.size - a.size).slice(0, 200),
    byDepth,
  }
}

// Build a per-file "first introduced at" timeline from `git log`.
// Cached after first build because git log over a large repo is slow.
// Returns: { points: [{ ts, hash, subject, addedFiles: [...] }], firstAt, lastAt, isGit, error? }
// DATA layer now lives in the shared lib/changes-views.cjs (buildTimeline /
// buildTour) — the same code the headless control-server runs. The desktop
// keeps its no-arg wrappers (and its own module-level timelineCache + the
// desktop getExternalUrls below) so every caller is unchanged. git is invoked
// through the same pExecFile the desktop already uses (local tool, offline-safe).
let timelineCache = { root: null, data: null, building: false }
function buildTimeline() {
  return changesViews.buildTimeline(currentRoot, scanner, pExecFile, timelineCache)
}

// Heuristic-only onboarding tour. An MCP client can call cs_trace({action:'tour'})
// to get the same script for narrating. Delegates to the shared builder, passing
// the desktop's own getExternalUrls() so external-call concentrators are computed
// once (the shared module falls back to its own if not provided).
function buildTour() {
  if (!scanner) return null
  return changesViews.buildTour(scanner, getExternalUrls())
}

function getExternalUrls() {
  if (!scanner) return { domains: [], totalCalls: 0 }
  const byDomain = new Map()
  let total = 0
  // Helper: register one URL occurrence
  const add = (rawUrl, fileId, methodHint) => {
    const m = rawUrl.match(/^(https?|wss?):\/\/([^\/:?#]+)/i)
    if (!m) return
    const proto = m[1].toLowerCase()
    const domain = m[2].toLowerCase()
    let bucket = byDomain.get(domain)
    if (!bucket) { bucket = { domain, proto, callers: [] }; byDomain.set(domain, bucket) }
    bucket.callers.push({ file: fileId, url: rawUrl, method: methodHint || (proto.startsWith('ws') ? 'WS' : 'GET') })
    total++
  }
  for (const f of scanner.files.values()) {
    // 1. Structured apiCalls — known fetch/axios/requests patterns with method
    if (f.apiCalls && f.apiCalls.length) {
      for (const c of f.apiCalls) {
        if (/^https?:\/\//i.test(c.url)) add(c.url, f.id, c.method || 'GET')
      }
    }
    // 2. Generic URL grep — catches everything else
    if (f.externalUrls && f.externalUrls.length) {
      for (const u of f.externalUrls) add(u.url, f.id, null)
    }
  }
  // De-duplicate identical (file, url, method) triples within each domain
  for (const bucket of byDomain.values()) {
    const seen = new Set()
    bucket.callers = bucket.callers.filter((c) => {
      const k = c.file + '|' + c.url + '|' + c.method
      if (seen.has(k)) return false
      seen.add(k); return true
    })
  }
  // Recompute total after dedup
  total = 0
  for (const b of byDomain.values()) total += b.callers.length
  const domains = [...byDomain.values()].sort((a, b) => b.callers.length - a.callers.length)
  return { domains, totalCalls: total }
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

// ─── Trace store ───────────────────────────────────────────────
//
// Persistent record of every node access (tool, id, timestamp) the
// AI/CLI/MCP layer makes. Lets the user see exactly what an AI did
// during a coding session, export it for review, or replay it.
//
// Storage layout: `.codesynapt/traces/session-{startTs}.jsonl`
// One line per event. Each session ID is the unix-ms timestamp of
// when the scanner started on that root.
// DATA layer now lives in the shared lib/trace-store.cjs TraceStore — the SAME
// class the headless control-server uses, so the .jsonl format, session listing,
// stats, and the in-memory cap can't drift. The desktop keeps its OWN thin
// wrappers so:
//   1. every existing caller (IPC + HTTP) is unchanged, and
//   2. the desktop-only IPC side-effect (Live Trace overlay / 3D node pulse via
//      'control:trace') is preserved in emitTrace below.
// `getCurrentRoot` is a live callback (currentRoot is reassigned per project);
// the scanner ref is re-synced on every scan in startScanner so per-file trust
// meta (confidence / dynamicPatterns) tracks the active project.
const _trace = new traceStore.TraceStore({ getCurrentRoot: () => currentRoot, scanner })

// Stats over an event array — re-exported from the shared module unchanged.
const computeTraceStats = traceStore.computeTraceStats

// Session-listing / -reading delegate to the shared module (identical shape /
// .jsonl format). isCurrent is keyed off the live session id.
function listTraceSessions(root) { return traceStore.listTraceSessions(root, _trace.sessionId) }
function readTraceSession(root, sessionId) { return traceStore.readTraceSession(root, sessionId) }

// Start (or restart) the trace session on the current root. Preserves the
// desktop's "no root → no-op" guard (the shared startSession would otherwise
// assign a fileless session id).
function startTraceSession() {
  if (!currentRoot) return
  _trace.scanner = scanner   // keep trust-meta lookups on the active project
  _trace.startSession()
}

function emitTrace(tool, id, meta) {
  if (!id) return
  // DATA: append to the shared store (in-memory cap + best-effort .jsonl write +
  // auto trust-meta when the caller didn't pass richer meta). Returns the event.
  const ev = _trace.emit(tool, id, meta)
  // DESKTOP-ONLY SIDE EFFECT (must be preserved): drive the Live Trace overlay /
  // 3D node pulse in the renderer.
  if (ev) mainWindow?.webContents.send('control:trace', { ...ev })
  return ev
}

// ─── lib/control-server delegate (Stage 1+2 endpoints) ────────
// Lazily create a control-server instance from the shared lib module.
// Used as a fallthrough for new endpoints (safety/bundle/env/suggest/
// feature/preflight/schema/url/secrets) so the desktop app exposes
// them too, without duplicating their logic here. Existing endpoints
// remain handled by this file's own router below — append-only.
const { createControlServer: _libCreateControlServer } = require('../packages/core/lib/control-server.cjs')
const { createLogger } = require('../packages/core/lib/logger.cjs')

// Structured logger for the main process. Writes NDJSON to
// ~/.codesynapt/audit/main-YYYY-MM-DD.jsonl. Level info+ → file; warn+ → stderr.
const _logFile = path.join(app.getPath('home'), '.codesynapt', 'audit',
  `main-${new Date().toISOString().slice(0,10)}.jsonl`)
const log = createLogger({ file: _logFile, module: 'main', level: 'info', echoStderr: 'warn' })

// ─── Search worker (isolated from main event loop) ─────────────
// Persistent worker (reused across searches) so its in-memory mtime cache
// makes the 2nd+ search fast. The worker is rebuilt only when the scanner
// is swapped (different project root). Files > 5 MB are pre-skipped to
// avoid the libuv-thread-stall that previously plagued worker reuse.
const { Worker } = require('worker_threads')
let _searchWorker = null
let _searchWorkerReady = false
let _searchScannerRef = null
let _searchInFlight = null   // { reqId, resolve, reject, timer }
let _searchReqCounter = 0
// Named refs for the scanner cache-sync listeners so teardown can remove
// them. Previously these were anonymous closures re-added on every worker
// rebuild and never removed; on the timeout/crash recycle path (same
// long-lived Scanner instance) they accumulated linearly, eventually
// tripping Node's MaxListenersExceededWarning and leaking memory.
let _searchScannerListeners = null   // { scanner, onChanged, onRemoved }

function _detachSearchScannerListeners() {
  if (!_searchScannerListeners) return
  const { scanner: s, onChanged, onRemoved } = _searchScannerListeners
  try { s.off('file-changed', onChanged) } catch {}
  try { s.off('file-removed', onRemoved) } catch {}
  _searchScannerListeners = null
}

function _teardownSearchWorker() {
  if (_searchWorker) { try { _searchWorker.terminate() } catch {} }
  _searchWorker = null
  _searchWorkerReady = false
  // Remove the per-worker scanner listeners so a subsequent rebuild on the
  // same Scanner doesn't stack another pair (the leak fix).
  _detachSearchScannerListeners()
  if (_searchInFlight) {
    clearTimeout(_searchInFlight.timer)
    _searchInFlight.reject(new Error('worker recycled'))
    _searchInFlight = null
  }
}

function _ensureSearchWorker() {
  if (_searchWorker && _searchScannerRef === scanner) return _searchWorker
  _teardownSearchWorker()
  const workerPath = path.resolve(__dirname, '..', 'packages', 'core', 'lib', 'search-worker.cjs')
  const w = new Worker(workerPath)
  _searchScannerRef = scanner
  w.on('message', (msg) => {
    if (msg.type === 'ready') { _searchWorkerReady = true; return }
    if (!_searchInFlight) return
    const inflight = _searchInFlight
    _searchInFlight = null
    clearTimeout(inflight.timer)
    if (msg.type === 'result') inflight.resolve(msg.payload)
    else                       inflight.reject(new Error(msg.error || 'worker error'))
  })
  w.on('error', (e) => {
    if (_searchInFlight) { clearTimeout(_searchInFlight.timer); _searchInFlight.reject(e); _searchInFlight = null }
    _searchWorker = null
    _searchWorkerReady = false
  })
  w.on('exit', () => {
    _searchWorker = null
    _searchWorkerReady = false
    if (_searchInFlight) {
      clearTimeout(_searchInFlight.timer)
      _searchInFlight.reject(new Error('worker exited unexpectedly'))
      _searchInFlight = null
    }
  })
  // Keep worker's cache in sync with scanner. Register named listeners and
  // remember them so _teardownSearchWorker can detach them on recycle
  // (otherwise they leak — see _searchScannerListeners above). _teardown
  // already ran at the top of this function, so there is no live pair to
  // double up on here.
  if (scanner) {
    const onChanged = ({ id }) => { try { w.postMessage({ type: 'invalidate', id }) } catch {} }
    const onRemoved = ({ id }) => { try { w.postMessage({ type: 'invalidate', id }) } catch {} }
    scanner.on('file-changed', onChanged)
    scanner.on('file-removed', onRemoved)
    _searchScannerListeners = { scanner, onChanged, onRemoved }
  }
  _searchWorker = w
  return w
}

function _searchInWorker(opts, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (_searchInFlight) return reject(new Error('worker busy — another search is in flight'))
    if (!scanner) return reject(new Error('scanner not ready'))
    const w = _ensureSearchWorker()
    const reqId = ++_searchReqCounter
    const files = [...scanner.files.values()].map((f) => ({ id: f.id, absPath: f.absPath }))
    const timer = setTimeout(() => {
      if (!_searchInFlight || _searchInFlight.reqId !== reqId) return
      _searchInFlight = null
      // Worker may be stuck — recycle so future requests are clean
      _teardownSearchWorker()
      reject(new Error(`worker timeout ${timeoutMs}ms`))
    }, timeoutMs)
    _searchInFlight = { reqId, resolve, reject, timer }
    // If worker hasn't fired 'ready' yet, queue a one-shot send
    if (_searchWorkerReady) {
      w.postMessage({ type: 'search', id: reqId, files, ...opts })
    } else {
      const onReady = (msg) => {
        if (msg.type !== 'ready') return
        w.off('message', onReady)
        w.postMessage({ type: 'search', id: reqId, files, ...opts })
      }
      w.on('message', onReady)
    }
  })
}
let _libControlHandler = null
let _libScannerRef = null   // invalidate when scanner is swapped
function _ensureLibHandler() {
  if (!scanner) return null
  if (_libControlHandler && _libScannerRef === scanner) return _libControlHandler
  _libScannerRef = scanner
  const lib = _libCreateControlServer({
    scanner,
    getCurrentRoot: () => currentRoot,
    onBlast: (p) => mainWindow?.webContents.send('control:blast', p),
    onFocus: (id) => mainWindow?.webContents.send('control:focus', { id }),
    onOpen:  (id) => mainWindow?.webContents.send('control:open', { id }),
    authToken: process.env.CS_AUTH_TOKEN || null,
    auditLogDir: path.join(app.getPath('home'), '.codesynapt', 'audit'),
  })
  _libControlHandler = lib.handleControlRequest
  return _libControlHandler
}
const _LIB_ENDPOINTS = new Set([
  'safety', 'bundle', 'env', 'suggest', 'feature', 'preflight',
  'schema', 'url', 'secrets',
])

async function handleControlRequest(req, res) {
  // DNS-rebinding defense: reject Host headers that aren't loopback.
  const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase()
  if (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost' && hostHeader !== '[::1]') {
    return writeJson(res, 403, { error: 'forbidden host: ' + hostHeader })
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    return res.end()
  }

  const url = new URL(req.url, `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean)
  const [seg0, ...rest] = parts
  const idFromRest = () => decodeURIComponent(rest.join('/'))

  // Delegate new endpoints to lib/control-server (Stage 1+2 features)
  if (_LIB_ENDPOINTS.has(seg0)) {
    const lib = _ensureLibHandler()
    if (lib) return lib(req, res)
    // If scanner isn't ready yet, fall through to 503 below
  }
  const traceId = () => { const id = idFromRest(); emitTrace(seg0, id); return id }

  try {
    if (req.method === 'GET' && parts.length === 0) {
      return writeJson(res, 200, {
        name: 'codesynapt',
        endpoints: [
          'GET /health', 'GET /graph', 'GET /node/:id', 'GET /file/:id',
          'GET /deps/:id', 'GET /users/:id', 'GET /find?q=', 'GET /history/:id',
          'GET /packages', 'GET /package/:name', 'GET /package-graph',
          'GET /legacy?type=orphan|path|filename|duplicate',
          'GET /trace', 'GET /trace/stats', 'GET /trace/sessions', 'GET /trace/session/:id',
          'POST /trace/clear', 'POST /trace/export?path=',
          'POST /focus/:id', 'POST /open/:id', 'POST /restore/:id?ts=',
          'POST /write/:id', 'POST /edit/:id',
        ],
      })
    }

    if (req.method === 'GET' && seg0 === 'health') {
      // Edge count is split into code-structure edges and asset edges
      // (HTML→image/script/style links), so a docs-heavy repo can't
      // make health stats lie about the code graph size.
      let codeEdges = 0, assetEdges = 0
      if (scanner) for (const e of scanner.edges) {
        if (e.kind === 'asset' || e.k === 'asset') assetEdges++
        else codeEdges++
      }
      return writeJson(res, 200, {
        ok: true,
        root: currentRoot,
        fileCount: scanner ? scanner.files.size : 0,
        edgeCount: codeEdges,
        assetEdgeCount: assetEdges,
        historyEnabled,
        // Scan-completion signals so `cs ensure` (and any MCP caller) can tell a
        // half-built graph from a finished one. Mirrors the headless
        // control-server /health. scanPhase: 'scanning' | 'building' | 'ready'.
        initialScanComplete: scanner ? scanner.initialScanComplete === true : false,
        scanPhase: scanner ? (scanner.scanPhase || (scanner.initialScanComplete ? 'ready' : 'scanning')) : 'scanning',
      })
    }

    if (!scanner) {
      // POST /load boots the scanner from scratch — let it through
      // the 503 gate. Headless instances (CS_HEADLESS=1) never call
      // startScanner via did-finish-load, so /load is the only path
      // to get a scanner running.
      if (!(req.method === 'POST' && seg0 === 'load')) {
        return writeJson(res, 503, { error: 'no folder loaded' })
      }
    }

    // ─── Symbol mode (codegraph-equivalent layer) ────────────────
    // First call builds the symbol graph against the current file set;
    // subsequent calls hit the in-memory cache. POST /symbol/scan forces
    // a rebuild even if one exists.
    if (seg0 === 'symbol') {
      const sub = rest[0] || ''   // 'summary' | 'find' | 'callers' | …
      // Ensure the symbol graph is built before serving any query.
      const forceRebuild = (req.method === 'POST' && sub === 'scan')
      if (forceRebuild || !symbolGraph) {
        if (!_symbolBuilding) {
          _symbolBuilding = (async () => {
            // Optional disk cache for big projects. Opt-in via env var
            // CS_SYMBOL_CACHE=1; defaults off so the in-memory speed
            // moat stays the default. Cache key is sha-of-root-path +
            // newest-file-mtime. If anything in the repo has changed
            // since the cache was written, we rebuild.
            const cacheEnabled = !forceRebuild && process.env.CS_SYMBOL_CACHE === '1'
            const cacheDir = path.join(os.homedir(), '.codesynapt', 'symbol-cache')
            const cacheKey = require('crypto').createHash('sha1').update(currentRoot || '').digest('hex')
            const cachePath = path.join(cacheDir, cacheKey + '.json')
            // Fingerprint the WHOLE file set's identity — not just the
            // newest mtime. Newest-mtime alone is blind to deletes and
            // renames: removing or renaming a file leaves every remaining
            // file's mtime unchanged, so a newest-mtime check considers
            // the stale cache (which still lists the deleted file's
            // symbols, or lacks the renamed file) valid. Hashing sorted
            // id+mtime+size of every current file makes add/delete/rename/
            // edit all flip the fingerprint and force a rebuild.
            const fileSetFingerprint = () => {
              const h = require('crypto').createHash('sha1')
              const ids = [...scanner.files.values()].filter((f) => f.absPath && f.ext)
              ids.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              for (const f of ids) {
                let mt = 0, sz = 0
                try { const st = fs.statSync(f.absPath); mt = st.mtimeMs; sz = st.size } catch {}
                h.update(f.id); h.update('\0'); h.update(String(mt)); h.update('\0'); h.update(String(sz)); h.update('\n')
              }
              return h.digest('hex')
            }
            if (cacheEnabled) {
              try {
                if (fs.existsSync(cachePath)) {
                  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
                  // Two independent invalidation guards, both required:
                  //
                  // (1) Newest-mtime sanity check (pass-1): the cache file's
                  //     own mtime must be at least as new as the newest source
                  //     file. Cheap freshness floor.
                  // (2) File-set fingerprint (pass-2, stronger): the current
                  //     file set's identity must exactly match the one stored
                  //     when the cache was written. mtime alone is blind to
                  //     deletions/renames (removing/renaming a file never
                  //     lowers a surviving file's mtime, so a newest-mtime
                  //     check considers a stale cache valid). The fingerprint
                  //     hashes sorted id+mtime+size of every current file, so
                  //     add/delete/rename/edit all flip it and force a rebuild.
                  //     Legacy caches without a fingerprint are treated as
                  //     stale.
                  let newest = 0
                  for (const f of scanner.files.values()) {
                    try { const t = fs.statSync(f.absPath).mtimeMs; if (t > newest) newest = t } catch {}
                  }
                  const cacheMtime = fs.statSync(cachePath).mtimeMs
                  const fingerprint = fileSetFingerprint()
                  if (
                    newest > 0 && cacheMtime >= newest &&
                    cached.fingerprint && cached.fingerprint === fingerprint
                  ) {
                    const g = new SymbolGraph()
                    for (const n of cached.nodes) g.addNode(n)
                    for (const e of cached.edges) g.addEdge(e)
                    g.fileCount = cached.fileCount
                    g.builtAt = cached.builtAt
                    g.scanMs = 0
                    try { g.computeReachability(isPublicEntry) } catch {}
                    symbolGraph = g
                    _symbolBuilding = null
                    return g
                  }
                }
              } catch {}
            }
            const g = new SymbolGraph()
            const entries = [...scanner.files.values()]
              .filter((f) => f.absPath && f.ext)
              .map((f) => ({ id: f.id, absPath: f.absPath, ext: f.ext }))
            // tsc mode: build the TS Program once over every JS/TS
            // file in the project before the per-file parser loop
            // starts. Cached by rootAbs; cleared on project swap.
            // If loadProgramFor refuses (file count above the memory
            // cap, or typescript not installed), we re-register the
            // babel parser so .ts/.tsx files still get symbols.
            if (SYMBOL_PARSER_MODE === 'tsc' && _tscParserModule?.isAvailable?.()) {
              try {
                const prog = _tscParserModule.loadProgramFor(currentRoot, entries.map((e) => e.id))
                if (!prog) {
                  console.warn('[symbol] tsc Program refused — falling back to babel for ts/tsx/js/jsx')
                  for (const ext of ['ts','tsx','js','jsx','mjs','cjs']) {
                    registerParser([ext], jsSymbolParser)
                  }
                }
              } catch (e) {
                console.error('[symbol] tsc Program init failed:', e.message)
                for (const ext of ['ts','tsx','js','jsx','mjs','cjs']) {
                  registerParser([ext], jsSymbolParser)
                }
              }
            }
            // Feed file-mode imports to the symbol graph so call
            // resolution can prefer targets in files the caller
            // actually imports (Phase 2-B cross-file resolver).
            // Asset edges (HTML→jQuery etc) aren't real imports.
            const fileImports = new Map()
            const reexports = new Map()
            for (const e of scanner.edges) {
              const kind = e.k || e.kind
              if (kind === 'asset') continue
              if (!fileImports.has(e.s)) fileImports.set(e.s, new Set())
              fileImports.get(e.s).add(e.t)
              if (kind === 'reexport') {
                if (!reexports.has(e.s)) reexports.set(e.s, new Set())
                reexports.get(e.s).add(e.t)
              }
            }
            // Re-export chain: `import { X } from './barrel'` where
            // barrel does `export * from './foo'` should resolve X
            // against foo too. BFS-expand each file's imports through
            // the re-export graph so chains of any depth are reachable.
            const reachCache = new Map()
            function reExportReach(start) {
              if (reachCache.has(start)) return reachCache.get(start)
              const out = new Set()
              const stack = [start]
              const visited = new Set()
              while (stack.length) {
                const cur = stack.pop()
                if (visited.has(cur)) continue
                visited.add(cur)
                out.add(cur)
                const next = reexports.get(cur)
                if (next) for (const n of next) stack.push(n)
              }
              reachCache.set(start, out)
              return out
            }
            for (const [src, set] of fileImports) {
              for (const target of [...set]) {
                const reach = reExportReach(target)
                for (const r of reach) set.add(r)
              }
            }
            await g.build(entries, fileImports)
            // ─── DB schema models → symbol nodes ─────────────────
            // file-mode already extracts Prisma / Drizzle / Mongoose /
            // TypeORM / SQLAlchemy model declarations. We register
            // each model name as a `model` symbol so the normal
            // resolver picks up `prisma.user.findMany()`,
            // `db.User.create(...)`, etc., and surfaces them in
            // `cs_symbol_explore` answers.
            for (const f of scanner.files.values()) {
              if (!f.dbModels?.length) continue
              for (const model of f.dbModels) {
                const id = `${f.id}#${model.name}@0`
                if (g.nodes.has(id)) continue
                g.addNode({
                  id,
                  name: model.name,
                  qualifiedName: model.name,
                  kind: 'model',
                  file: f.id,
                  startLine: 1,
                  endLine: 1,
                  signature: `${model.kind} ${model.name}`
                    + (model.tableName ? ` (table=${model.tableName})` : ''),
                  doc: (model.fields || []).map((fld) => fld.name).join(', '),
                  exported: true,
                })
              }
            }
            // ─── Test ↔ source pairing ───────────────────────────
            // Detect common test-file naming conventions and emit
            // `tests` edges from test symbols to their target source
            // symbol (same name, or whose name is a substring).
            const findSourcePair = (fileId) => {
              let m
              // foo.test.ts → foo.ts   /   foo.spec.tsx → foo.tsx
              if ((m = fileId.match(/^(.*)\.(test|spec)\.(\w+)$/))) {
                return m[1] + '.' + m[3]
              }
              // src/foo/__tests__/Bar.test.ts → src/foo/Bar.ts
              if ((m = fileId.match(/^(.*?)\/__tests__\/(.+?)\.(test|spec)\.(\w+)$/))) {
                return m[1] + '/' + m[2] + '.' + m[4]
              }
              // tests/path/Bar.test.ts → src/path/Bar.ts  (best-effort)
              if ((m = fileId.match(/^tests?\/(.+?)\.(test|spec)\.(\w+)$/))) {
                const candidate = 'src/' + m[1] + '.' + m[3]
                return candidate
              }
              // Python: tests/test_foo.py → foo.py / src/foo.py
              if ((m = fileId.match(/^(.*?\/)?tests?\/test_(.+)\.py$/))) {
                return (m[1] || '') + m[2] + '.py'
              }
              if ((m = fileId.match(/^(.*\/)?test_(.+)\.py$/))) {
                return (m[1] || '') + m[2] + '.py'
              }
              // Go: foo_test.go → foo.go
              if ((m = fileId.match(/^(.+)_test\.go$/))) return m[1] + '.go'
              // Rust: tests/foo.rs → src/foo.rs
              if ((m = fileId.match(/^tests\/(.+)\.rs$/))) return 'src/' + m[1] + '.rs'
              return null
            }
            for (const f of scanner.files.values()) {
              const srcFileId = findSourcePair(f.id)
              if (!srcFileId || !scanner.files.has(srcFileId)) continue
              const testSyms = g.byFile.get(f.id)
              const srcSyms = g.byFile.get(srcFileId)
              if (!testSyms || !srcSyms) continue
              for (const testId of testSyms) {
                const testSym = g.nodes.get(testId)
                if (!testSym) continue
                const tn = testSym.name.toLowerCase()
                for (const srcId of srcSyms) {
                  const srcSym = g.nodes.get(srcId)
                  if (!srcSym) continue
                  const sn = srcSym.name.toLowerCase()
                  // Exact match wins; otherwise substring with a length
                  // floor to avoid `t` / `it` matching everything.
                  if (tn === sn || (sn.length >= 4 && tn.includes(sn))) {
                    g.addEdge({
                      source: testId, target: srcId, kind: 'tests',
                      line: testSym.startLine,
                    })
                    break    // one source-symbol target per test symbol is enough
                  }
                }
              }
            }
            // ─── Sub-engine enrichment (type-checker post-pass) ──
            // The desktop builds this symbolGraph inline (not via
            // scanner.buildSymbolGraph), so the sub-engines never ran for
            // the desktop graph. Apply them here with the SAME tier gates as
            // packages/core/scanner.js buildSymbolGraph so desktop and headless
            // resolve the identical extra call edges (generics / field-chains
            // the fast AST engine can't). Runs BEFORE the cache write so the
            // enriched edges are persisted (and the cache-load path above gets
            // them too) and BEFORE reachability so the BFS sees them.
            if (process.env.CS_SUBENGINE_OFF !== '1') {
              try {
                require('../packages/core/lib/subengines.cjs').enrich(g, {
                  files: [...scanner.files.values()].filter((f) => f.absPath).map((f) => f.absPath),
                  rootDir: currentRoot,
                  external: process.env.CS_SUBENGINE === '1',
                  heavy: process.env.CS_SUBENGINE_HEAVY === '1',
                })
              } catch (e) { if (process.env.CS_DBG) console.error('[cs] desktop enrich:', e && e.message) }
            }
            // ─── Persist symbol graph to cache (opt-in) ──────────
            if (cacheEnabled) {
              try {
                fs.mkdirSync(cacheDir, { recursive: true })
                const payload = {
                  nodes: [...g.nodes.values()],
                  edges: g.edges,
                  fileCount: g.fileCount,
                  builtAt: g.builtAt,
                  // Identity of the exact file set this graph was built
                  // from. Read-side validation rejects the cache if the live
                  // file set differs (deletion/rename/addition/edit), which
                  // the mtime check alone cannot detect.
                  //   fingerprint (pass-2): id+mtime+size hash — the value the
                  //     load path actually checks.
                  //   fileSetHash (pass-1): id+mtime hash — kept for
                  //     back-compat / diagnostics.
                  fingerprint: fileSetFingerprint(),
                  fileSetHash: symbolFileSetHash(scanner),
                }
                fs.writeFileSync(cachePath, JSON.stringify(payload))
              } catch {}
            }
            // ─── Route → handler edges ───────────────────────────
            // Walk every file's `routes` list (extracted by file
            // mode) and link the route to the named handler symbol.
            // codegraph doesn't do this — its index is method/class
            // only, with no notion of HTTP path. Ours does.
            for (const f of scanner.files.values()) {
              if (!f.routes?.length) continue
              for (const route of f.routes) {
                if (!route.handler) continue
                const handlerNode = g.resolveCall(f.id, route.handler, { allowAny: true })
                if (!handlerNode) continue
                g.addEdge({
                  source: 'route:' + (route.method || 'ANY') + ' ' + route.path,
                  target: handlerNode.id,
                  kind: 'route',
                  line: 0,
                  meta: { method: route.method, path: route.path, definedIn: f.id },
                })
              }
            }
            // Reachability pass — BFS from every detected public
            // entry. Lets explore tag `unreachable` results as a
            // weak dead-code hint without paying the BFS cost per
            // query. Cheap: O(V+E) over the symbol graph.
            try { g.computeReachability(isPublicEntry) } catch (e) {
              console.warn('[symbol] reachability pass failed:', e.message)
            }
            // Semantic embedding pass — fired without await. The
            // build returns immediately; embeddings populate in the
            // background. /symbol/explore checks `g._embedded`
            // before reranking, so early queries still get fast
            // keyword-only answers, and later queries get the
            // semantic upgrade once the index finishes (~1 ms per
            // symbol on MiniLM-L6, so ~10 s on a 10k-symbol repo
            // and ~45 s on django's 43k).
            //
            // Opt-out via CS_EMBEDDING=0 for users on memory-tight
            // boxes (the index adds ~200 MB to RSS).
            if (process.env.CS_EMBEDDING !== '0') {
              const embedding = require('../packages/core/lib/embedding.cjs')
              g.embedAllSymbols(embedding.embedBatch).then((ok) => {
                if (ok) console.log(`[symbol] embeddings ready: ${g.nodes.size} symbols in ${g.embedMs}ms`)
              }).catch((e) => {
                console.warn('[symbol] embedding pass failed:', e.message)
              })
            }
            symbolGraph = g
            _symbolBuilding = null
            return g
          })()
        }
        await _symbolBuilding
      }
      const g = symbolGraph

      // ── Shared symbol views (summary/graph/find/callers/callees/blast).
      //    Implemented ONCE in lib/symbol-views.cjs so the desktop and the
      //    headless control server stay in sync (mirrors control-server's
      //    dispatch). handleSymbolView returns {status, body} for the shared
      //    subs and null for the server-specific ones (node-with-source,
      //    explore, scan), which fall through to the handlers below.
      //
      //    Previously the desktop inlined these and:
      //      - summary returned bare g.stats() (missing topHubs + coverage)
      //      - node/callers/callees spread raw nodes, leaking the 384-float
      //        _embedding and omitting candidateCallers/candidateCallees.
      //    Routing through the shared module fixes all of the above.
      if (req.method === 'GET') {
        const params = {
          q: url.searchParams.get('q') || '',
          // id rides the path tail (/symbol/callers/<id>) or ?id=.
          id: (rest.length > 1
            ? (() => { try { return decodeURIComponent(rest.slice(1).join('/')) } catch { return '' } })()
            : '') || (() => { try { return decodeURIComponent(url.searchParams.get('id') || '') } catch { return '' } })(),
          limit: url.searchParams.get('limit'),
          depth: url.searchParams.get('depth'),
          direction: url.searchParams.get('direction'),
        }
        const r = symbolViews.handleSymbolView(g, sub, params,
          { files: scanner.files, supportedExts: SUPPORTED_EXTS })
        if (r) return writeJson(res, r.status, r.status === 200 ? withMeta(r.body) : r.body)
        if (sub === 'node') {
          const n = g.nodes.get(params.id)
          if (!n) return writeJson(res, 404, { error: 'symbol not found', id: params.id })
          // Desktop-specific: include the symbol's source (file lines
          // startLine..endLine, capped at 4000 chars) on top of the
          // allow-listed node shape (which does NOT leak _embedding).
          let source = ''
          try {
            const filePath = path.join(currentRoot, n.file)
            const lines = fs.readFileSync(filePath, 'utf8').split('\n')
            source = lines.slice(n.startLine - 1, n.endLine).join('\n')
            if (source.length > 4000) source = source.slice(0, 4000) + '\n…'
          } catch {}
          const refBy = (g.refCallersOf ? g.refCallersOf(params.id) : []).map((c) => symbolViews.symbolNodeView(g, c))
          return writeJson(res, 200, withMeta({
            ...symbolViews.symbolNodeView(g, n),
            source,
            callers: g.callersOf(params.id).map((c) => symbolViews.symbolNodeView(g, c)),
            callees: g.calleesOf(params.id).map((c) => symbolViews.symbolNodeView(g, c)),
            // Value-use refs (callback/arg/assignment) so a callback-only symbol
            // with 0 callers isn't read as dead. (mirrors the callers view)
            referencedBy: refBy.length ? refBy : undefined,
          }))
        }
      }
      if (req.method === 'GET' && sub === 'explore') {
        const q = url.searchParams.get('q') || ''
        const budget = parseInt(url.searchParams.get('budget') || '8000', 10)
        // /symbol/explore now returns a single response shape: the
        // classify (grouped) one. The older modes — default (ranked
        // list), structural, behavioral, dataflow — were retired
        // after a 99-measurement bench found zero scenarios where
        // they out-performed classify. Clients that still send a
        // `mode=...` parameter get a classify response with a `note`
        // so they can update without breaking.
        const requestedMode = (url.searchParams.get('mode') || 'classify').toLowerCase()
        const payload = await buildClassifyResponse(g, q, budget)
        if (requestedMode !== 'classify') {
          payload.note = `mode "${requestedMode}" is no longer supported — returning classify shape`
        }
        return writeJson(res, 200, withMeta(payload))
      }
      if (req.method === 'POST' && sub === 'scan') {
        return writeJson(res, 200, withMeta(g.stats()))
      }
      return writeJson(res, 404, { error: 'unknown symbol endpoint', path: url.pathname })
    }

    if (req.method === 'GET' && seg0 === 'summary') {
      const s = buildSummaryCached()
      if (!s) return writeJson(res, 503, { error: 'no folder loaded' })
      return writeJson(res, 200, withMeta(s))
    }
    if (req.method === 'GET' && seg0 === 'graph') {
      // filter → sort → paginate. Default sort is mass:desc so a bare
      // `limit=N` returns the N most-imported files (genuinely useful),
      // not insertion-order garbage. Pass sort=insertion to opt out.
      const data = getGraphState()
      const limit  = parseInt(url.searchParams.get('limit')  || '0', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const extFilter = url.searchParams.get('ext')
      const minMass = parseInt(url.searchParams.get('minMass') || '0', 10)
      const sort = url.searchParams.get('sort') || 'mass:desc'

      // Incoming map (computed once if mass involved in filter or sort)
      let inc = null
      const needsInc = sort.startsWith('mass') || minMass > 0
      if (needsInc) {
        inc = new Map()
        for (const e of scanner.edges) inc.set(e.t, (inc.get(e.t) || 0) + 1)
      }

      let files = data.files.slice()
      if (extFilter) files = files.filter((f) => f.ext === extFilter)
      if (minMass > 0) files = files.filter((f) => (inc.get(f.id) || 0) >= minMass)

      // Sort
      if (sort !== 'insertion') {
        const [key, dirRaw] = sort.split(':')
        const dir = dirRaw === 'asc' ? 1 : -1
        const getter = key === 'mass' ? ((f) => inc.get(f.id) || 0)
                     : key === 'size' ? ((f) => f.size)
                     : key === 'loc'  ? ((f) => f.loc)
                     : key === 'id'   ? null
                     : null
        if (getter) files.sort((a, b) => dir * (getter(a) - getter(b)))
        else if (key === 'id') files.sort((a, b) => dir * a.id.localeCompare(b.id))
        // else: unknown sort key — silently keep filter order
      }

      const totalAvailable = files.length
      const sliced = limit > 0 ? files.slice(offset, offset + limit) : files
      return writeJson(res, 200, withMeta(
        { root: data.root, files: sliced, edges: data.edges },
        { totalAvailable, returned: sliced.length, offset, limit: limit || sliced.length,
          sort, truncated: limit > 0 && (offset + limit) < totalAvailable }
      ))
    }
    if (req.method === 'GET' && seg0 === 'node' && rest.length > 0) {
      const id = traceId()
      const node = findNode(id)
      if (!node) return writeJson(res, 404, { error: 'not found' })
      return writeJson(res, 200, withMeta({
        ...node,
        imports: getDeps(id),
        importedBy: getUsers(id),
      }))
    }
    if (req.method === 'POST' && seg0 === 'refresh') {
      if (rest.length === 0) return writeJson(res, 400, { error: 'usage: POST /refresh/:id' })
      const id = idFromRest()
      try {
        const absPath = path.join(currentRoot, id)
        if (!isInsideRoot(currentRoot, absPath)) return writeJson(res, 400, { error: 'outside root' })
        if (!fs.existsSync(absPath)) {
          // File deleted — drop from graph
          if (scanner.files.delete(id)) { scanner.rebuildEdges(); scanner.emitSnapshot() }
          return writeJson(res, 200, withMeta({ ok: true, action: 'removed', id }))
        }
        // Force re-parse via scanner internals
        const file = scanner.parseOne(absPath)
        if (!file) return writeJson(res, 500, { error: 'parse failed' })
        scanner.files.set(file.id, file)
        scanner.rebuildEdges()
        scanner.emitSnapshot()
        return writeJson(res, 200, withMeta({ ok: true, action: 'refreshed', id }))
      } catch (e) { return writeJson(res, 500, { error: e.message }) }
    }
    if (req.method === 'GET' && seg0 === 'file' && rest.length > 0) {
      const id = traceId()
      const full = path.join(currentRoot, id)
      if (!isInsideRoot(currentRoot, full)) return writeJson(res, 400, { error: 'outside root' })
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile()) return writeJson(res, 404, { error: 'not a file' })
        if (stat.size > 2_000_000) return writeJson(res, 413, { error: 'file too large', size: stat.size })
        const buf = fs.readFileSync(full)
        // contentHash + size for AI freshness checks — parity with headless /file.
        const contentHash = require('crypto').createHash('sha256').update(buf).digest('hex')
        return writeJson(res, 200, { id, content: buf.toString('utf8'), contentHash, size: stat.size })
      } catch (e) {
        if (e.code === 'ENOENT') return writeJson(res, 404, { error: 'not found', id })
        return writeJson(res, 500, { error: e.message })
      }
    }
    if (req.method === 'GET' && seg0 === 'deps' && rest.length > 0) {
      return writeJson(res, 200, getDeps(traceId()))
    }
    if (req.method === 'GET' && seg0 === 'users' && rest.length > 0) {
      return writeJson(res, 200, getUsers(traceId()))
    }
    if (req.method === 'GET' && seg0 === 'find') {
      return writeJson(res, 200, searchFiles(url.searchParams.get('q') || ''))
    }
    if (req.method === 'GET' && seg0 === 'search') {
      // Full-text search across all tracked files (content scan).
      // Different from /find which only matches file IDs.
      // Runs in a worker_thread isolated from this event loop.
      const q = url.searchParams.get('q')
      if (!q) return writeJson(res, 400, { error: 'q (query) is required' })
      if (!scanner || !scanner.initialScanComplete) {
        const fileCount = scanner ? scanner.files.size : 0
        return writeJson(res, 503, {
          error: 'scan in progress',
          fileCount,
          retryAfterMs: 2000,
          hint: 'Initial scan still running. Try again in a couple of seconds; /health will keep increasing fileCount.',
        })
      }
      ;(async () => {
        try {
          const result = await _searchInWorker({
            q,
            regex:         url.searchParams.get('regex') === '1' || url.searchParams.get('regex') === 'true',
            caseSensitive: url.searchParams.get('case')  === '1' || url.searchParams.get('case')  === 'true',
            max:           parseInt(url.searchParams.get('max') || '100', 10),
            maxPerFile:    parseInt(url.searchParams.get('maxPerFile') || '10', 10),
          })
          writeJson(res, 200, withMeta(result))
        } catch (e) {
          const msg = e.message || String(e)
          if (msg.includes('busy')) return writeJson(res, 503, { error: msg, retryAfterMs: 1000 })
          writeJson(res, 500, { error: msg })
        }
      })().catch((e) => writeJson(res, 500, { error: e.message }))
      return
    }
    if (req.method === 'GET' && seg0 === 'external') {
      return writeJson(res, 200, getExternalUrls())
    }
    if (req.method === 'GET' && seg0 === 'timeline') {
      buildTimeline().then((data) => writeJson(res, 200, data))
        .catch((e) => writeJson(res, 500, { error: e.message }))
      return
    }
    if (req.method === 'GET' && seg0 === 'tour') {
      const t = buildTour()
      if (!t) return writeJson(res, 503, { error: 'no folder loaded' })
      return writeJson(res, 200, t)
    }
    if (req.method === 'GET' && seg0 === 'changes' && rest.length === 0) {
      return writeJson(res, 200, listSessionChanges())
    }
    if (req.method === 'GET' && seg0 === 'changes' && rest.length > 0) {
      const id = idFromRest()
      const d = getChangeDiff(id)
      if (!d) return writeJson(res, 404, { error: 'no change recorded for this file' })
      return writeJson(res, 200, d)
    }
    if (req.method === 'GET' && seg0 === 'blast' && rest.length > 0) {
      const id = idFromRest()
      const depth = Math.max(1, Math.min(10, parseInt(url.searchParams.get('depth') || '3', 10)))
      const dir = url.searchParams.get('dir') === 'deps' ? 'deps' : 'users'
      const r = computeBlastRadius(id, depth, dir)
      if (!r) { emitTrace('blast', id); return writeJson(res, 404, { error: 'not found' }) }
      // Log impact-level trust meta: how many impacted files use dynamic patterns
      // (→ the true blast may be larger than the count shown).
      const dynHits = r.files.filter((f) => (scanner.files.get(f.id)?.dynamicPatterns || []).length).length
      emitTrace('blast', id, { n: r.totalFiles, dyn: dynHits || undefined })
      // Send all impacted node ids to renderer for visual highlight
      mainWindow?.webContents.send('control:blast', { seed: id, ids: r.files.map((f) => f.id) })
      return writeJson(res, 200, r)
      // Send all impacted node ids to renderer for visual highlight
      mainWindow?.webContents.send('control:blast', { seed: id, ids: r.files.map((f) => f.id) })
      return writeJson(res, 200, r)
    }
    if (req.method === 'GET' && seg0 === 'history' && rest.length > 0) {
      return writeJson(res, 200, listHistory(currentRoot, traceId()))
    }
    if (req.method === 'POST' && seg0 === 'focus' && rest.length > 0) {
      const id = traceId()
      if (!scanner.files.has(id)) return writeJson(res, 404, { error: 'not found' })
      mainWindow?.webContents.send('control:focus', { id })
      return writeJson(res, 200, { ok: true, id })
    }
    if (req.method === 'POST' && seg0 === 'open' && rest.length > 0) {
      const id = traceId()
      if (!scanner.files.has(id)) return writeJson(res, 404, { error: 'not found' })
      mainWindow?.webContents.send('control:open', { id })
      return writeJson(res, 200, { ok: true, id })
    }
    if (req.method === 'POST' && seg0 === 'load' && rest.length === 0) {
      // Body: { path } — load a project folder. If same as currentRoot, no-op.
      // Used by `cs ensure` to auto-switch projects from CLI/MCP without
      // requiring the user to click "Open Folder" in the desktop UI.
      let bodyChunks = []
      req.on('data', (c) => bodyChunks.push(c))
      req.on('end', async () => {
        let target = null
        try {
          const bodyStr = Buffer.concat(bodyChunks).toString('utf8')
          if (bodyStr) target = JSON.parse(bodyStr)?.path || null
        } catch {}
        target = target || url.searchParams.get('path')
        if (!target) return writeJson(res, 400, { error: 'usage: { "path": "..." }' })
        let abs
        try {
          abs = path.resolve(target)
          // realpathSync normalizes symlinks so two different paths pointing
          // to the same directory hit the noop branch correctly.
          if (fs.existsSync(abs)) abs = fs.realpathSync(abs)
        } catch (e) { return writeJson(res, 400, { error: 'invalid path: ' + e.message }) }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          return writeJson(res, 400, { error: 'not a directory: ' + abs })
        }
        // Reject the OS root (C:\ on Windows, / on POSIX) — scanning that
        // would walk the entire filesystem. Almost certainly a mistake.
        if (abs === path.parse(abs).root) {
          return writeJson(res, 400, { error: 'refusing to load OS root: ' + abs })
        }
        // Confirm we can actually read it before triggering a scan.
        try { fs.accessSync(abs, fs.constants.R_OK) }
        catch { return writeJson(res, 403, { error: 'not readable: ' + abs }) }
        if (currentRoot === abs && scanner) {
          return writeJson(res, 200, { ok: true, action: 'noop', root: currentRoot, fileCount: scanner.files.size })
        }
        try {
          await startScanner(abs)
          return writeJson(res, 200, { ok: true, action: 'loaded', root: currentRoot, fileCount: scanner?.files?.size || 0 })
        } catch (e) { return writeJson(res, 500, { error: e.message }) }
      })
      return
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest.length === 0) {
      // Current session log. Filter by tool, since=, limit.
      const sinceRaw = url.searchParams.get('since')
      const toolFilter = url.searchParams.get('tool')
      const limit = parseInt(url.searchParams.get('limit') || '0', 10)
      let evs = _trace.log
      if (sinceRaw) {
        const since = parseInt(sinceRaw, 10)
        evs = evs.filter((e) => e.ts > since)
      }
      if (toolFilter) evs = evs.filter((e) => e.tool === toolFilter)
      const totalAvailable = evs.length
      if (limit > 0) evs = evs.slice(-limit)  // most recent N
      return writeJson(res, 200, withMeta({
        sessionId: _trace.sessionId,
        events: evs,
      }, { totalAvailable, returned: evs.length }))
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest[0] === 'stats') {
      // Stats over current session
      const stats = computeTraceStats(_trace.log)
      return writeJson(res, 200, withMeta({ sessionId: _trace.sessionId, ...stats }))
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest[0] === 'sessions') {
      return writeJson(res, 200, withMeta({
        sessions: listTraceSessions(currentRoot),
        currentSessionId: _trace.sessionId,
      }))
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest[0] === 'session' && rest[1]) {
      const id = parseInt(rest[1], 10)
      const data = readTraceSession(currentRoot, id)
      if (!data) return writeJson(res, 404, { error: 'session not found' })
      const stats = computeTraceStats(data.events)
      return writeJson(res, 200, withMeta({ ...data, stats }))
    }
    if (req.method === 'POST' && seg0 === 'trace' && rest[0] === 'clear') {
      // Soft clear: drop in-memory log + start a NEW session on disk so
      // old log file is preserved.
      _trace.log = []
      startTraceSession()
      return writeJson(res, 200, { ok: true, newSessionId: _trace.sessionId })
    }
    if (req.method === 'POST' && seg0 === 'trace' && rest[0] === 'export') {
      // Write current session to a user-chosen path. Body should be
      // { path } or query ?path=. Returns the absolute output path.
      let bodyChunks = []
      req.on('data', (c) => bodyChunks.push(c))
      req.on('end', () => {
        let exportPath = url.searchParams.get('path')
        try {
          const body = Buffer.concat(bodyChunks).toString('utf8')
          if (body) {
            const parsed = JSON.parse(body)
            exportPath = exportPath || parsed?.path
          }
        } catch {}
        if (!exportPath) return writeJson(res, 400, { error: 'usage: pass ?path= or { "path": "..." }' })
        try {
          const stats = computeTraceStats(_trace.log)
          const out = {
            sessionId: _trace.sessionId,
            root: currentRoot,
            startedAt: _trace.startedAt,
            exportedAt: Date.now(),
            stats,
            events: _trace.log,
          }
          fs.writeFileSync(exportPath, JSON.stringify(out, null, 2), 'utf8')
          return writeJson(res, 200, { ok: true, path: exportPath, eventCount: _trace.log.length })
        } catch (e) { return writeJson(res, 500, { error: e.message }) }
      })
      return
    }
    if (req.method === 'GET' && seg0 === 'legacy' && rest.length === 0) {
      // Async — returns once the legacy module is loaded
      buildLegacyCached().then((data) => {
        if (!data) return writeJson(res, 503, { error: 'no folder loaded' })
        // Optional ?type=orphan|path|filename|duplicate filter
        const type = url.searchParams.get('type')
        if (type) {
          const slice = { summary: data.summary }
          if (type === 'orphan')        slice.orphans = data.orphans
          else if (type === 'path')     slice.pathPatterns = data.pathPatterns
          else if (type === 'filename') slice.filenamePatterns = data.filenamePatterns
          else if (type === 'duplicate')slice.duplicates = data.duplicates
          else return writeJson(res, 400, { error: 'bad type; use orphan|path|filename|duplicate' })
          return writeJson(res, 200, withMeta(slice))
        }
        return writeJson(res, 200, withMeta(data))
      }).catch((e) => writeJson(res, 500, { error: e.message }))
      return
    }
    if (req.method === 'GET' && seg0 === 'packages' && rest.length === 0) {
      const data = buildPackagesCached()
      if (!data) return writeJson(res, 503, { error: 'no folder loaded' })
      return writeJson(res, 200, withMeta(data))
    }
    if (req.method === 'GET' && seg0 === 'package' && rest.length > 0) {
      const name = idFromRest()
      emitTrace('package', name)
      const d = buildPackageDetail(name)
      if (!d) return writeJson(res, 404, { error: 'package not found', name })
      return writeJson(res, 200, withMeta(d))
    }
    if (req.method === 'GET' && seg0 === 'package-graph') {
      const data = buildPackagesCached()
      if (!data) return writeJson(res, 503, { error: 'no folder loaded' })
      return writeJson(res, 200, withMeta({
        kind: data.kind,
        packages: data.packages.map((p) => ({ name: p.name, fileCount: p.fileCount })),
        edges: data.pkgEdges,
      }))
    }
    if (req.method === 'POST' && (seg0 === 'write' || seg0 === 'edit') && rest.length > 0) {
      // Body: /write/:id  expects { content }
      //       /edit/:id   expects { find, replace, replaceAll? }
      // Both wrapped through writeFileToRoot so audit trail is uniform.
      const id = idFromRest()
      const full = path.join(currentRoot, id)
      if (!isInsideRoot(currentRoot, full)) return writeJson(res, 400, { error: 'outside root' })
      let bodyChunks = []
      req.on('data', (c) => bodyChunks.push(c))
      req.on('end', () => {
        let body
        try { body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) }
        catch { return writeJson(res, 400, { error: 'invalid JSON body' }) }
        if (seg0 === 'write') {
          if (typeof body.content !== 'string') return writeJson(res, 400, { error: 'usage: { "content": "..." }' })
          const r = writeFileToRoot(id, body.content, { source: 'http-write' })
          if (!r.ok) return writeJson(res, 500, r)
          return writeJson(res, 200, withMeta({ ...r, id }))
        }
        // edit
        if (typeof body.find !== 'string' || typeof body.replace !== 'string') {
          return writeJson(res, 400, { error: 'usage: { "find": "...", "replace": "...", "replaceAll": false }' })
        }
        let content
        try { content = fs.readFileSync(full, 'utf8') }
        catch (e) { return writeJson(res, 500, { error: 'read failed: ' + e.message }) }
        const findStr = body.find
        if (!findStr) return writeJson(res, 400, { error: 'find string cannot be empty' })
        // Count occurrences
        let count = 0, idx = 0
        while ((idx = content.indexOf(findStr, idx)) !== -1) { count++; idx += findStr.length }
        if (count === 0) return writeJson(res, 404, { error: 'find string not found', find: findStr })
        const replaceAll = body.replaceAll === true
        if (!replaceAll && count > 1) {
          return writeJson(res, 409, {
            error: `find string is not unique (${count} occurrences). Pass replaceAll:true or use a more specific find string.`,
            occurrences: count,
          })
        }
        const next = replaceAll
          ? content.split(findStr).join(body.replace)
          : content.replace(findStr, body.replace)
        const r = writeFileToRoot(id, next, { source: 'http-edit' })
        if (!r.ok) return writeJson(res, 500, r)
        return writeJson(res, 200, withMeta({ ...r, id, replacements: replaceAll ? count : 1 }))
      })
      return
    }
    if (req.method === 'POST' && seg0 === 'restore' && rest.length > 0) {
      const id = idFromRest()
      emitTrace('write', id)
      const ts = parseInt(url.searchParams.get('ts') || '0', 10)
      if (!ts) return writeJson(res, 400, { error: 'missing ts' })
      const content = readHistorySnap(currentRoot, id, ts)
      if (content === null) return writeJson(res, 404, { error: 'snapshot not found' })
      const full = path.join(currentRoot, id)
      if (!isInsideRoot(currentRoot, full)) return writeJson(res, 400, { error: 'outside root' })
      try {
        fs.writeFileSync(full, content, 'utf8')
        snapshotHistory(currentRoot, id, content)
        return writeJson(res, 200, { ok: true, id, ts })
      } catch (e) { return writeJson(res, 500, { error: e.message }) }
    }
    return writeJson(res, 404, { error: 'unknown endpoint', path: url.pathname })
  } catch (e) {
    return writeJson(res, 500, { error: e.message })
  }
}

// Try `startPort` first, then increment up to `maxTries-1` more.
// On success: write port to lock file so CLI / MCP can find us.
// On exhaustion: log + give up (control API disabled).
const CONTROL_PORT_MAX_TRIES = 10
function getLockFilePath() {
  // ~/.codesynapt/port — CLI/MCP looks here when no env var set
  const homeDir = app.getPath('home')
  return path.join(homeDir, '.codesynapt', 'port')
}
function writeLockFile(port) {
  try {
    const file = getLockFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(port), 'utf8')
  } catch (e) {
    console.warn('[cs] could not write port lock file:', e.message)
  }
}
function clearLockFile() {
  try { fs.unlinkSync(getLockFilePath()) } catch {}
}
// ─── Desktop → per-project daemon registry ───────────────────────
// Register the desktop's own control-server in the SAME registry `cs serve`
// uses, so the CLI/MCP discover it by projectHash — not just via the legacy
// single global ~/.codesynapt/port lock (last-writer-wins across projects).
// NOT idle-reaped: the user owns the desktop's lifetime, so a heartbeat keeps
// the entry fresh and we remove it on folder swap / quit. Pure-client mode
// skips this (its attached `cs serve` daemon self-registers). This makes the
// registry the single source of truth for discovery.
const _deskRegistry = (() => { try { return require('../packages/core/lib/registry.cjs') } catch { return null } })()
const DESKTOP_EPOCH = (() => { try { return require('crypto').randomUUID() } catch { return 'desk-' + Date.now() } })()
let _deskRegPhash = null
let _deskRegHb = null
function registerDesktopDaemon() {
  if (PURE_CLIENT || !_deskRegistry || !controlPort || !currentRoot) return
  try {
    const phash = _deskRegistry.projectHash(currentRoot)
    if (_deskRegPhash && _deskRegPhash !== phash) {   // folder swapped → drop old entry
      try { _deskRegistry.remove('daemon', _deskRegPhash) } catch {}
    }
    _deskRegPhash = phash
    const touch = () => { try { _deskRegistry.touch('daemon', phash, {
      projectRoot: _deskRegistry.canonicalRoot(currentRoot), port: controlPort,
      epoch: DESKTOP_EPOCH, pid: process.pid, startedAt: Date.now(), desktop: true,
    }) } catch {} }
    touch()
    if (!_deskRegHb) { _deskRegHb = setInterval(touch, 5000); if (_deskRegHb.unref) _deskRegHb.unref() }
  } catch {}
}
function unregisterDesktopDaemon() {
  if (_deskRegHb) { clearInterval(_deskRegHb); _deskRegHb = null }
  if (_deskRegistry && _deskRegPhash) { try { _deskRegistry.remove('daemon', _deskRegPhash) } catch {} }
  _deskRegPhash = null
}
function startControlServer(startPort = controlPort, attempt = 0) {
  if (controlServer) return
  const port = startPort + attempt
  const server = http.createServer(handleControlRequest)
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < CONTROL_PORT_MAX_TRIES - 1) {
      // Try next port. Recurse without setting controlServer yet.
      try { server.close() } catch {}
      startControlServer(startPort, attempt + 1)
    } else if (err.code === 'EADDRINUSE') {
      console.warn(`[cs] all control ports ${startPort}..${startPort + CONTROL_PORT_MAX_TRIES - 1} in use — control API disabled. Set CS_PORT to override.`)
      controlServer = null
    } else {
      console.error('[cs] control server error:', err)
      controlServer = null
    }
  })
  server.listen(port, '127.0.0.1', () => {
    controlServer = server
    controlPort = port
    writeLockFile(port)
    registerDesktopDaemon()   // advertise in the per-project registry (if a folder is loaded)
    if (port !== startPort) {
      log.info('control API listening (fallback)', { port, requestedPort: startPort, host: '127.0.0.1' })
      console.log(`[cs] control API listening on http://127.0.0.1:${port}  (fallback — ${startPort} was in use)`)
    } else {
      log.info('control API listening', { port, host: '127.0.0.1' })
      console.log(`[cs] control API listening on http://127.0.0.1:${port}`)
    }
  })
}
function stopControlServer() {
  if (controlServer) {
    try { controlServer.close() } catch {}
    controlServer = null
  }
  clearLockFile()
  unregisterDesktopDaemon()
}
ipcMain.handle('control-port', () => (PURE_CLIENT && _ownDaemonPort) ? _ownDaemonPort : controlPort)

// ─── [④] Multi-session viewer client (DEFAULT ON; CS_REGISTRY=0 to disable) ─
// The desktop, as a PURE CLIENT, can attach to another Claude Code session's
// per-project daemon (`cs serve`) and watch ITS graph + trace — without running
// its own scanner for that project. The heavy lifting (registry discovery,
// daemon HTTP client, bootstrap, (epoch,seq) delta polling, viewer lease +
// heartbeat, re-bootstrap) lives in the headless-testable lib/viewer-client.cjs.
// Here we just pipe its callbacks into the SAME renderer ipc channels the local
// scanner already uses (`snapshot`, `control:trace`) — /graph's payload is shape-
// identical to scanner.snapshot(), so the renderer renders it unchanged.
//
// ADDITIVE & gated: with CS_REGISTRY unset the whole block is inert and the
// in-process scanner path is untouched (design: 점진 교체, 옛 경로 살려둠).
const USE_VIEWER = process.env.CS_REGISTRY !== '0'
let _viewer = null
const _viewerLib = (() => {
  try { return require('../packages/core/lib/viewer-client.cjs') } catch { return null }
})()
function viewerAttached() { return !!(_viewer && _viewer.isAttached()) }
function getViewer() {
  if (_viewer || !_viewerLib) return _viewer
  _viewer = new _viewerLib.ViewerClient({
    viewerId: 'desktop-' + process.pid,
    // The remote graph rides the SAME channel the local scanner uses. While a
    // viewer is attached, the local scanner's own snapshots are suppressed (see
    // the scanner.on('snapshot') guard) so the two don't fight over the canvas.
    onGraph: (g) => { try { mainWindow?.webContents.send('snapshot', g) } catch {} },
    onTraces: (evs) => {
      try { for (const ev of evs) mainWindow?.webContents.send('control:trace', { ...ev }) } catch {}
    },
    onStatus: (st) => { try { mainWindow?.webContents.send('viewer:status', st) } catch {} },
  })
  return _viewer
}
ipcMain.handle('viewer:enabled', () => USE_VIEWER)
ipcMain.handle('viewer:list-sessions', () => {
  if (!USE_VIEWER || !_viewerLib) return { enabled: false, sessions: [] }
  try { return { enabled: true, sessions: _viewerLib.listSessions() } }
  catch (e) { return { enabled: true, sessions: [], error: e.message } }
})
ipcMain.handle('viewer:attach', async (_e, sessionId) => {
  if (!USE_VIEWER || !_viewerLib) return { ok: false, error: 'viewer mode disabled' }
  const s = _viewerLib.listSessions().find((x) => String(x.sessionId) === String(sessionId))
  if (!s) return { ok: false, error: 'session not found (it may have ended)' }
  if (!s.daemonAlive) return { ok: false, error: 'daemon for this session is not running' }
  try {
    const r = await getViewer().attach(s)
    return { ok: true, sessionId: s.sessionId, label: s.label, projectRoot: s.projectRoot, epoch: r && r.epoch }
  } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('viewer:detach', async () => {
  if (_viewer) { try { await _viewer.detach() } catch {} }
  // Hand the canvas back to the local scanner: emit its current snapshot now so
  // the renderer doesn't sit on the detached remote graph until the next change.
  try { if (scanner && mainWindow) mainWindow.webContents.send('snapshot', { root: currentRoot, ...scanner.snapshot() }) } catch {}
  return { ok: true }
})
app.on('before-quit', () => { if (_viewer) { try { _viewer.detach() } catch {} } ; unregisterDesktopDaemon() })

// ─── [gap#2] Pure-client mode (dev-gated: CS_PURE_CLIENT=1) ──────
// The desktop runs NO local scanner / control-server for its own project. It
// ensures the per-project headless `cs serve` daemon and attaches to it as a
// viewer (graph + trace + symbol over HTTP via ViewerClient); graph-derived IPC
// handlers proxy to that daemon. Eliminates the "two servers / two scans per
// project" duplication. CS_PURE_CLIENT unset → fully legacy (local scanner +
// control server), unchanged. Once verified this folds into CS_REGISTRY default.
const PURE_CLIENT = process.env.CS_PURE_CLIENT === '1'
let _ownDaemonPort = null
const _pcRegistry = (() => { try { return require('../packages/core/lib/registry.cjs') } catch { return null } })()

function _pcPing(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1200 }, (res) => {
      let d = ''; res.on('data', (c) => d += c)
      res.on('end', () => { try { const b = JSON.parse(d); resolve(res.statusCode === 200 ? b : null) } catch { resolve(null) } })
    })
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null) })
  })
}
function _pcSameRoot(a, root) {
  if (!a) return false
  const A = path.resolve(a), B = path.resolve(root)
  return process.platform === 'win32' ? A.toLowerCase() === B.toLowerCase() : A === B
}
// Discover-or-spawn the per-project daemon (mirrors `cs ensure`'s registry path);
// resolves to its port once /health reports initialScanComplete.
async function ensureOwnDaemon(root, { onProgress } = {}) {
  if (!_pcRegistry) throw new Error('registry unavailable')
  const abs = path.resolve(root)
  const phash = _pcRegistry.projectHash(abs)
  const TTL = 15000
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const serveBin = path.join(__dirname, '..', 'packages', 'core', 'bin', 'codesynapt.cjs')
  let spawned = false
  const startedAt = Date.now()
  const budgetMs = 240000
  while (Date.now() - startedAt < budgetMs) {
    const d = _pcRegistry.readDaemon(phash, TTL)
    if (d && d.port) {
      const h = await _pcPing(d.port)
      if (h && _pcSameRoot(h.root, abs)) {
        if (h.initialScanComplete === true) return d.port
        if (onProgress) onProgress(h)
      }
    }
    if (!spawned) {
      const lock = _pcRegistry.acquireDaemonLock(phash, { pid: process.pid }, TTL)
      if (lock.won) {
        const child = require('child_process').spawn(process.execPath, [serveBin, 'serve', abs],
          { detached: true, stdio: 'ignore', env: { ...process.env } })
        child.unref(); spawned = true
      }
    }
    await sleep(500)
  }
  const d2 = _pcRegistry.readDaemon(phash, TTL)
  if (d2 && d2.port && await _pcPing(d2.port)) return d2.port
  throw new Error(`daemon not ready for ${abs}`)
}

// Enter pure-client mode for `root`: ensure its daemon, point controlPort at it,
// attach the viewer. Replaces startScanner() in pure-client mode.
async function startPureClient(root) {
  const abs = path.resolve(root)
  currentRoot = abs
  addRecent(abs)
  store.lastFolder = abs; saveStore()
  mainWindow?.webContents.send('folder-loaded', { root: abs })
  try {
    const port = await ensureOwnDaemon(abs, {
      onProgress: (h) => mainWindow?.webContents.send('scan-progress', { phase: h.scanPhase || 'scanning', fileCount: h.fileCount }),
    })
    _ownDaemonPort = port
    controlPort = port   // renderer's /symbol/graph fetch + control-port IPC now hit the daemon
    await getViewer().attach({ projectRoot: abs, daemonPort: port, sessionId: 'desktop-' + process.pid })
  } catch (e) {
    mainWindow?.webContents.send('error', { message: `Could not connect to daemon for ${abs}: ${e.message}` })
  }
}

// HTTP proxies to the own-project daemon for graph-derived IPC handlers.
function daemonGet(pathname) {
  if (!_ownDaemonPort) return Promise.reject(new Error('no daemon attached'))
  return _viewerLib.httpJson(_ownDaemonPort, pathname)
}
function daemonSend(method, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!_ownDaemonPort) return reject(new Error('no daemon attached'))
    const data = body != null ? JSON.stringify(body) : null
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    const r = http.request({ host: '127.0.0.1', port: _ownDaemonPort, path: pathname, method, headers, timeout: 60000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(d) } })
    })
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
    if (data) r.write(data)
    r.end()
  })
}

// ─── Log retention (audit + per-project traces) ────────────────
// Default 30 days; configurable via env. Prevents unbounded growth of
// ~/.codesynapt/audit/YYYY-MM-DD.jsonl and project-local .codesynapt/traces/.
function pruneOldLogs() {
  const days = parseInt(process.env.CS_AUDIT_RETENTION_DAYS || '30', 10)
  if (!days || days <= 0) return   // 0 = keep forever
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  const auditDir = path.join(app.getPath('home'), '.codesynapt', 'audit')
  const dirs = [auditDir]
  if (currentRoot) dirs.push(traceStore.traceDirFor(currentRoot))
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const f = path.join(dir, name)
        try {
          const stat = fs.statSync(f)
          if (stat.mtimeMs < cutoffMs) {
            fs.unlinkSync(f)
            log.info('log pruned', { file: f, retentionDays: days })
          }
        } catch {}
      }
    } catch {}
  }
}

// CS_HEADLESS=1 boots the control API + scanner without opening a
// BrowserWindow. Useful for: bench harnesses, CI runs, or a second
// instance on a non-default CS_PORT measuring alongside a live UI
// without spawning a second visible window.
const HEADLESS = process.env.CS_HEADLESS === '1'

// ─── Single-instance lock ───────────────────────────────────────
// Critical for clean version upgrades: when the NSIS installer launches
// the new version (runAfterFinish), if an old build is somehow still
// running, route the second-instance event to focus/restore instead of
// spawning a duplicate process. Also prevents two desktop windows
// fighting over port 7707.
// Headless mode skips the lock — bench harnesses and CI runs need to
// boot a second instance on a non-default CS_PORT alongside a live
// desktop without one killing the other.
const gotSingleInstanceLock = HEADLESS ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
    // If the second instance passed CS_INITIAL_ROOT via env or a path arg,
    // load that folder into the running window.
    const envRoot = process.env.CS_INITIAL_ROOT
    const argRoot = argv && argv.find && argv.find((a) => a && !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory())
    const target = envRoot && fs.existsSync(envRoot) ? envRoot : argRoot
    if (target && path.resolve(target) !== currentRoot) startScanner(path.resolve(target))
  })
}

// ─── App lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  // Serve public/ over the app:// scheme registered above (fixes ESM/importmap
  // under file://). Containment: only files inside public/ are served.
  protocol.handle('app', async (request) => {
    const { pathToFileURL } = require('url')
    const publicDir = path.join(__dirname, '..', 'public')
    const { pathname } = new URL(request.url)
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
    const filePath = path.normalize(path.join(publicDir, rel))
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    const res = await net.fetch(pathToFileURL(filePath).toString())
    // Dev (unpackaged): disable caching so Ctrl+R picks up renderer edits
    // (CSS/HTML/app.js) without a full restart. Packaged releases keep caching
    // for load speed — automatic, no manual toggle.
    if (!app.isPackaged) {
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'no-store')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    return res
  })

  if (!HEADLESS) {
    rebuildMenu()
    createWindow()
  } else {
    // Electron has no GUI-less mode — without at least one
    // BrowserWindow the app exits as soon as whenReady() resolves.
    // A 1×1 hidden window keeps the event loop alive and never
    // surfaces on screen, which is what we want for bench harnesses
    // and CI runs that only need the control API.
    new BrowserWindow({ show: false, width: 1, height: 1 })
  }
  if (!PURE_CLIENT) startControlServer()   // pure-client uses the daemon's server, not its own
  pruneOldLogs()   // one-shot on boot; daily users get fresh pruning

  app.on('activate', () => {
    if (!HEADLESS && BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // ─── Auto-updater (GitHub Releases) — OPT-IN, offline by default ──
  // HARD RULE: the app is offline by design (AGENTS.md / CLAUDE.md —
  // "No network calls in the app itself"). So the updater makes ZERO
  // outbound calls unless the user explicitly opts in with
  // CS_ENABLE_UPDATER=1. Default (env unset) = no GitHub check ever.
  //
  // When opted in, it is end-to-end: it finds the release, DOWNLOADS it,
  // shows a native OS notification, and installs on the next quit. The
  // renderer toast can also drive an explicit download/install via the
  // updater:* IPC channels declared above (which read the
  // _updateAvailableInfo / _updateDownloaded state this wiring sets).
  setupAutoUpdater()
})

// `_autoUpdater`, `_updateAvailableInfo`, `_updateDownloaded` and the
// updater:* control IPC handlers are declared once near the top of the
// file (renderer-driven download/install/check). This function only wires
// the electron-updater event lifecycle into that shared state.
function setupAutoUpdater() {
  // Opt-in only (pass-2 hardening). Anything other than an explicit '1'
  // keeps the app fully offline — no require(), no feed resolution, no
  // network. This satisfies the HARD RULE "No network calls in the app
  // itself"; the previous CS_DISABLE_UPDATER (on-by-default) gate is
  // intentionally superseded by this opt-in gate.
  if (process.env.CS_ENABLE_UPDATER !== '1') {
    log.info('auto-updater disabled (offline by design); set CS_ENABLE_UPDATER=1 to opt in')
    return
  }
  try {
    const { autoUpdater } = require('electron-updater')
    _autoUpdater = autoUpdater
    // Download automatically once an update is found, then notify +
    // install on quit. This is the "actually works end-to-end" path.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (e) => {
      log.error('updater error', { message: e.message })
      mainWindow?.webContents.send('updater:error', { message: e.message })
    })
    autoUpdater.on('update-available', (info) => {
      log.info('update available', { version: info.version })
      _updateAvailableInfo = info
      // Notify renderer; renderer shows a toast with "download / dismiss".
      mainWindow?.webContents.send('updater:available', { version: info.version, releaseNotes: info.releaseNotes })
    })
    autoUpdater.on('update-not-available', () => {
      _updateAvailableInfo = null
    })
    autoUpdater.on('download-progress', (p) => {
      // p: { percent, bytesPerSecond, transferred, total }
      mainWindow?.webContents.send('updater:progress', {
        percent: p.percent, transferred: p.transferred, total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      log.info('update downloaded', { version: info.version })
      _updateDownloaded = true
      mainWindow?.webContents.send('updater:downloaded', { version: info.version })
    })
    // Check ~10s after boot so the scanner gets network priority.
    // checkForUpdatesAndNotify downloads + shows a native notification
    // and arms install-on-quit — i.e. the full update lifecycle. The
    // renderer-driven updater:check / updater:download / updater:install
    // handlers (declared near the top of the file) drive the explicit
    // toast-based path on top of this.
    setTimeout(() => { autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn('update check failed', { error: e.message })) }, 10_000)
  } catch (e) {
    // Should not happen now that electron-updater is a production
    // dependency, but keep CLI/MCP-only installs resilient.
    log.warn('updater not loaded', { error: e.message })
  }
}

app.on('window-all-closed', () => {
  // Headless mode never opens a window, so this would fire as soon
  // as the event loop ticks and quit before the control API became
  // useful. Stay alive — caller terminates with SIGTERM.
  if (HEADLESS) return
  stopScanner()
  stopControlServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { stopScanner(); stopControlServer() })

// Hardening
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Defense-in-depth: block all in-window navigation away from our own
  // renderer origin. The packaged app is served over the custom app://
  // scheme (loadURL('app://bundle/index.html') + protocol.handle('app')),
  // NOT file:// — file:// was abandoned during migration because ESM +
  // importmap are blocked there by CORS. The old guard hard-coded
  // 'file://', so any legitimate same-origin app:// navigation would have
  // been wrongly preventDefault()'d. The allow-list must include app:// or
  // every in-app reload / internal navigation gets preventDefault()-ed and
  // the app appears to hang; file:// stays allowed as a belt-and-braces
  // fallback for dev/unpackaged/headless runs. CSP still blocks remote
  // loads — this is one more layer. Block the rest, forwarding external
  // http(s) links to the user's browser.
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://') && !url.startsWith('file://')) {
      event.preventDefault()
      if (url.startsWith('http')) shell.openExternal(url)
    }
  })
  // Deny every permission request — we don't use mic/camera/geolocation/etc.
  contents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
})
