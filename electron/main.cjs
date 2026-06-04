// Electron main process — desktop app shell for CodeSynapt
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } = require('electron')

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
      // TypeScript / TSX have no dedicated grammar in our bundled
      // tree-sitter-wasms — the JS grammar is missing `interface`,
      // type aliases, generics, etc. Keep babel for those.
      if (ext === 'ts' || ext === 'tsx') continue
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

// Path looks like a test file? Used by explore() ranking to push real
// implementation symbols above test fixtures with similar names.
// Heavier explore-only auxiliary-path filter than `isTestPath` —
// covers vendored bundles inside src/ (`compiled/`, `vendor/`),
// example apps, and tooling code. Match is "any segment is one of
// these". Distinct from isAuxPath in symbol-graph (that one drives
// resolver buckets); here it drives explore ranking.
const EXPLORE_AUX_SEGMENTS = new Set([
  'compiled', 'vendored', 'vendor', '_compiled',
  'examples', 'example', 'samples', 'sample', 'demo', 'demos',
  'scripts', 'script', 'tools', 'tool',
  'build', 'dist', 'out', 'bin',
  'fixtures', 'fixture',
  // Additional rarely-production segments — common in OSS layouts
  // but never the answer to "how does X actually work".
  'mocks', 'mock', '__mocks__',
  'stubs', 'stub',
  'storybook', '.storybook', 'stories',
  'docs-src', 'documentation',
])
function isAuxExplorePath(filePath) {
  if (!filePath) return false
  const parts = filePath.toLowerCase().replace(/\\/g, '/').split('/')
  return parts.some((p) => EXPLORE_AUX_SEGMENTS.has(p))
}

function isTestPath(filePath) {
  if (!filePath) return false
  const p = filePath.toLowerCase().replace(/\\/g, '/')
  // path segments: …/tests/, …/test/, …/__tests__/, …/spec/,
  // …/e2e/, …/integration/, …/bench/ (perf test)
  if (/\/(tests?|__tests__|spec|specs|e2e|integration|integration[_-]tests?|fixtures?|bench(es|marks?)?)\//.test('/' + p + '/')) return true
  // suffixes: foo_test.go, foo.test.ts, FooTests.swift, FooTest.java,
  //          foo.bench.ts, foo_bench.go, foo.spec.tsx
  if (/(?:_test|\.test|\.spec|\.bench|_bench|\.e2e)\.[a-z]+$/.test(p)) return true
  if (/tests?\.(swift|kt|java)$/.test(p)) return true
  return false
}

// Stopwords stripped from the explore query before keyword matching.
const EXPLORE_STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','do','does','for','from','how','in',
  'into','is','it','its','of','on','or','the','their','this','to','using','what',
  'when','where','which','who','why','will','with',
])

// Break a token at camelCase / PascalCase / digit boundaries so query
// "getUserName" also tries [get, user, name]. Acronym-aware: keeps
// uppercase runs together when followed by another word (HTTPRequest
// → [HTTP, Request], not [H, T, T, P, Request]). Each alternative
// covers a specific shape and the order matters:
//   1. [A-Z]+(?=[A-Z][a-z])  — leading acronym before a word
//      ("HTTP" in "HTTPRequest")
//   2. [A-Z]?[a-z]+          — normal camel word
//      ("Request" / "get" / "Name")
//   3. [A-Z]+                 — trailing acronym
//      ("HTML" at end of "URL2HTML")
//   4. [0-9]+                 — digit group
function splitCamelCase(w) {
  const parts = w.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) || []
  return parts.map((s) => s.toLowerCase())
}

// Simplified Porter-style stemmer. Two phases:
//   Step 2 — derivational suffix MAP (rewrite, not strip)
//            "authentication" → "authentic + ate" → "authenticate"
//   Step 4 — terminal suffix STRIP if stem stays ≥ 4 chars
//            "processing"/"processed"/"processor" → "process"
//
// Mapping suffixes first preserves the "verb form" so different
// noun/adjective inflections normalize back to it. Plain strip-only
// (the previous 12-suffix version) wasn't enough — "authentication"
// would just lose "ation" and become "authentic", which doesn't
// substring-match "authenticate".
//
// Stem length lower bound (>=4) guards against over-stripping
// "rate" → "r" etc. We deliberately don't strip bare "s" or "es":
// risks of mangling "process"/"business"/"axis" outweigh the wins.
const STEM_STEP2 = [
  ['ization', 'ize'], ['ational', 'ate'], ['fulness', 'ful'],
  ['ousness', 'ous'], ['iveness', 'ive'], ['tional', 'tion'],
  ['ation', 'ate'], ['ator', 'ate'], ['ative', 'ate'],
  ['izer', 'ize'], ['icate', 'ic'], ['alize', 'al'],
  ['ical', 'ic'],
]
const STEM_STEP4 = [
  'ement', 'ements', 'ance', 'ances', 'ence', 'ences',
  'ment', 'ments', 'tion', 'tions', 'sion', 'sions',
  'able', 'ables', 'ible', 'ibles', 'ism', 'isms',
  'ness', 'nesses', 'ful', 'fully', 'ous', 'ously',
  'ive', 'ives', 'ize', 'izes', 'ized', 'izing',
  'ing', 'ed', 'ly', 'er', 'or',
]
function stem(w) {
  if (w.length < 5) return w
  for (const [from, to] of STEM_STEP2) {
    if (w.endsWith(from) && w.length - from.length >= 3) {
      return w.slice(0, -from.length) + to
    }
  }
  for (const suf of STEM_STEP4) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) {
      return w.slice(0, -suf.length)
    }
  }
  return w
}

// Deprecated / TODO-remove markers. SymbolGraph.build sets
// `node.deprecated` from the 5 lines above each symbol (handles
// babel's quirky export-wrapper leading-comment attachment). We
// also fall back to scanning doc/signature for parsers that do
// surface comments correctly (regex/tree-sitter parsers).
function isDeprecatedSymbol(node) {
  if (node.deprecated === true) return true
  const d = ((node.doc || '') + ' ' + (node.signature || '')).toLowerCase()
  if (!d) return false
  return /(\s|^)@?deprecated\b|todo\s*[:_-]?\s*remove|fixme\s*[:_-]?\s*remove/.test(d)
}

// Public entry detection — symbols that an external caller reaches
// (a `main`, a route handler, a CLI bin script, an SDK default
// export) often have in-degree zero in *our* graph because the
// caller lives outside the codebase (OS shell, HTTP request, npm
// consumer). Without flagging these, the orphan damping treats
// them as dead code. We flag only when the symbol is exported AND
// either the name or the containing file matches an entry pattern
// — both signals so we don't sweep every exported util into the
// "entry" bucket.
const ENTRY_NAMES = new Set([
  'main', 'run', 'start', 'init', 'handler', 'bootstrap',
  'setup', 'listen', 'serve', 'cli', 'app', 'default',
])
const ENTRY_FILE_RE = /(?:^|\/)(?:main|index|entry|server|app|cli|bin|run)(?:\.[a-z]+)?$/i
function isPublicEntry(node) {
  if (!node.exported) return false
  const name = (node.name || '').toLowerCase()
  if (ENTRY_NAMES.has(name)) return true
  if (ENTRY_FILE_RE.test(node.file || '')) return true
  return false
}


// ─── mode 3 (classify) — ranking-free response ─────────────────
// Returns symbols grouped by lifecycle classification, no score
// sort. AI/user picks the group it cares about (active for "what
// runs in production", deprecated/legacy/orphan for "what's safe
// to delete"). Same candidate selection as the ranked mode 2 —
// keyword expansion + optional semantic — but the only ordering
// inside each group is in-degree DESC (graph signal, not a
// computed score).
//
// Why a separate mode 3 instead of just sorting mode 2's output?
// Mode 2 collapses everything into a single ranked list, so a
// deprecated symbol with a perfect keyword match can still beat
// the live implementation just by score arithmetic. Mode 3 makes
// the grouping the contract — `groups.active[0]` is always the
// live answer even if a deprecated dup has the same name.
async function buildClassifyResponse(g, query, budget = 8000) {
  const q = (query || '').toLowerCase()
  const rawTokens = q.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
  const expanded = new Set(rawTokens)
  for (const t of rawTokens) {
    for (const p of splitCamelCase(t)) if (p.length > 1) expanded.add(p)
    const s = stem(t)
    if (s !== t && s.length > 2) expanded.add(s)
  }
  const keywords = [...expanded].filter((t) => t.length > 1 && !EXPLORE_STOPWORDS.has(t))
  if (!keywords.length) {
    return { query, mode: 'classify', keywords: [], groups: {}, counts: {}, snippets: [], note: 'no usable keywords' }
  }

  // Candidate selection — same byName / byFile index walk mode 2
  // does. No scoring; we just collect every symbol whose name or
  // file path contains at least one keyword as a substring.
  const candidates = new Set()
  for (const k of keywords) {
    for (const [n, ids] of g.byName) {
      if (n.includes(k)) for (const id of ids) candidates.add(id)
    }
    for (const [f, ids] of g.byFile) {
      if (f.toLowerCase().includes(k)) for (const id of ids) candidates.add(id)
    }
  }

  // Optional semantic candidate enrichment — when embeddings are
  // ready, pull the top 30 symbols by cosine similarity to the
  // raw query and union them in. Lets a query like "auth" find
  // `login` / `signIn` even when the keyword set never hits.
  let semHits = new Map()    // id → similarity
  if (g._embedded && query) {
    try {
      const embedding = require('../packages/core/lib/embedding.cjs')
      const qVec = await embedding.embed(query)
      if (qVec) {
        const sims = []
        for (const node of g.nodes.values()) {
          if (!node._embedding) continue
          const sim = embedding.cosineSim(qVec, node._embedding)
          if (sim > 0.3) sims.push({ id: node.id, sim })
        }
        sims.sort((a, b) => b.sim - a.sim)
        for (const { id, sim } of sims.slice(0, 30)) {
          candidates.add(id)
          semHits.set(id, sim)
        }
      }
    } catch {}
  }

  // Classify every candidate. Two cross-cutting groups (exact_match
  // and semantic) take precedence over the lifecycle classification
  // and are *exclusive* — a symbol that lives in exact_match is
  // intentionally NOT also listed in active/orphan/etc, so the AI
  // doesn't have to dedupe. The lifecycle bucket is preserved as a
  // field on each entry so the consumer still sees "this exact-match
  // is actually deprecated".
  const groups = {
    exact_match: [], semantic: [],
    active: [], entry: [], deprecated: [], legacy: [],
    test: [], aux: [], orphan: [], normal: [],
  }
  const keywordSet = new Set(keywords)
  for (const id of candidates) {
    const node = g.nodes.get(id)
    if (!node) continue
    const inD = g.inAdj.get(id)?.size || 0
    const ouD = g.outAdj.get(id)?.size || 0
    const mtime = node.mtimeMs || 0
    const ageMs = mtime ? (Date.now() - mtime) : 0
    const ONE_YEAR = 365 * 86400_000

    let cls
    if (isDeprecatedSymbol(node)) cls = 'deprecated'
    else if (isTestPath(node.file)
     || /^test[A-Z_]/.test(node.name || '')
     || /(_test$|spec$|Spec$)/.test(node.name || '')) cls = 'test'
    else if (isAuxExplorePath(node.file)) cls = 'aux'
    else if (isPublicEntry(node))         cls = 'entry'
    else if (inD === 0 && ouD === 0)      cls = 'orphan'
    else if (ageMs > ONE_YEAR && inD < 2) cls = 'legacy'
    else if (inD >= 3)                    cls = 'active'
    else                                  cls = 'normal'

    const reachable = g._reachable ? g._reachable.has(id) : null
    const semOnly = !rawHasSubstring(node, keywords)
    const nameLower = (node.name || '').toLowerCase()
    const isExactName = keywordSet.has(nameLower)

    const entry = {
      qualifiedName: node.qualifiedName || node.name,
      name: node.name, kind: node.kind,
      file: node.file, startLine: node.startLine, endLine: node.endLine,
      inDegree: inD, outDegree: ouD,
      ageDays: mtime ? Math.floor(ageMs / 86400_000) : null,
      reachable,
      semSim: semHits.get(id) ?? null,
      classification: cls,    // lifecycle preserved even when bucketed elsewhere
      semanticOnly: semOnly,
    }
    // Routing order: exact_match wins over everything (user typed
    // the exact name — surface that even if the symbol is orphan).
    // Then semantic (keyword 0 hit, only the embedding pulled it
    // in). Then lifecycle classification.
    if (isExactName)      groups.exact_match.push(entry)
    else if (semOnly)     groups.semantic.push(entry)
    else                  groups[cls].push(entry)
  }

  // Sort each group: in-degree DESC, then semSim DESC (so semantic
  // candidates surface inside their group when present). Cap per
  // group to keep responses manageable.
  const PER_GROUP_CAP = 8
  for (const g_name of Object.keys(groups)) {
    groups[g_name].sort((a, b) => (b.inDegree - a.inDegree) || ((b.semSim || 0) - (a.semSim || 0)))
    groups[g_name] = groups[g_name].slice(0, PER_GROUP_CAP)
  }

  // Snippets — source bodies for the top members of the most
  // informative groups. `active` first (real implementation),
  // then `entry`, then `normal`. Skips test/aux/orphan/deprecated
  // unless those are the only groups with hits — saves token
  // budget for code AI actually needs to read.
  const snippets = []
  const MAX_LINES_PER_SNIPPET = 40
  let used = 0
  const SNIPPET_ORDER = ['exact_match', 'active', 'entry', 'normal', 'semantic', 'legacy', 'deprecated', 'test', 'orphan', 'aux']
  outer: for (const groupName of SNIPPET_ORDER) {
    const members = groups[groupName]
    if (!members.length) continue
    const perGroupBudget = groupName === 'exact_match' ? 5
                         : (groupName === 'active' || groupName === 'entry') ? 3
                         : 1
    for (const m of members.slice(0, perGroupBudget)) {
      if (used >= budget) break outer
      try {
        const filePath = path.join(currentRoot, m.file)
        const lines = fs.readFileSync(filePath, 'utf8').split('\n')
        const end = Math.min(m.endLine, m.startLine + MAX_LINES_PER_SNIPPET - 1)
        const source = lines.slice(m.startLine - 1, end).join('\n')
        const cost = Math.ceil(source.length / 4)
        if (used + cost > budget && snippets.length > 0) break outer
        snippets.push({
          group: groupName, file: m.file, line: m.startLine,
          name: m.name, kind: m.kind, source,
        })
        used += cost
      } catch {}
    }
  }

  const counts = {}
  for (const [k, v] of Object.entries(groups)) if (v.length) counts[k] = v.length

  return {
    query, mode: 'classify', keywords,
    groups, counts, snippets,
    embeddingReady: !!g._embedded,
  }
}

// Whether any keyword raw-substring matches the symbol — used to
// flag entries that came in via semantic similarity only.
function rawHasSubstring(node, keywords) {
  const name = (node.name || '').toLowerCase()
  const qn   = (node.qualifiedName || '').toLowerCase()
  const file = (node.file || '').toLowerCase()
  for (const k of keywords) {
    if (name.includes(k) || qn.includes(k) || file.includes(k)) return true
  }
  return false
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
    mainWindow?.webContents.send('snapshot', { ...data, root })
  })
  scanner.on('stats', (s) => {
    mainWindow?.webContents.send('stats', s)
  })
  scanner.on('scan-progress', (p) => {
    mainWindow?.webContents.send('scan-progress', p)
  })
  scanner.on('file-changed', ({ id, absPath }) => {
    try {
      const stat = fs.statSync(absPath)
      if (stat.size > 2_000_000) return
      const content = fs.readFileSync(absPath, 'utf8')
      snapshotHistory(currentRoot, id, content)
      trackChange(id, content)
    } catch {}
  })

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
  closeTraceWriteStream()
  currentRoot = null
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
  stopScanner()
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
const sessionChanges = new Map()   // id -> { firstAt, lastAt, count, firstSeen, currentSize, currentLoc }
function trackChange(id, content) {
  const existing = sessionChanges.get(id)
  const now = Date.now()
  const loc = content ? content.split('\n').length : 0
  const size = Buffer.byteLength(content || '', 'utf8')
  if (existing) {
    existing.lastAt = now
    existing.count += 1
    existing.currentSize = size
    existing.currentLoc = loc
  } else {
    // First change we see — we already lost the original "before".
    // Capture the current content as "firstSeen" so subsequent changes
    // have something to diff against.
    sessionChanges.set(id, {
      firstAt: now, lastAt: now, count: 1,
      firstSeen: content || '',
      firstSeenSize: size, firstSeenLoc: loc,
      currentSize: size, currentLoc: loc,
    })
  }
}
function listSessionChanges() {
  const items = []
  for (const [id, c] of sessionChanges.entries()) {
    items.push({
      id,
      firstAt: c.firstAt, lastAt: c.lastAt, count: c.count,
      sizeBefore: c.firstSeenSize, sizeAfter: c.currentSize,
      locBefore: c.firstSeenLoc,   locAfter: c.currentLoc,
      sizeDelta: c.currentSize - c.firstSeenSize,
      locDelta:  c.currentLoc  - c.firstSeenLoc,
    })
  }
  items.sort((a, b) => b.lastAt - a.lastAt)
  return items
}
function getChangeDiff(id) {
  const c = sessionChanges.get(id)
  if (!c) return null
  let after = null
  try {
    if (!currentRoot) return null
    const full = path.join(currentRoot, id)
    if (!isInsideRoot(currentRoot, full)) return null
    const stat = fs.statSync(full)
    if (stat.size > 2_000_000) return { error: 'file too large' }
    after = fs.readFileSync(full, 'utf8')
  } catch (e) { return { error: e.message } }
  return {
    id, firstAt: c.firstAt, lastAt: c.lastAt, count: c.count,
    before: c.firstSeen,
    after,
    lines: makeLineDiff(c.firstSeen, after),
  }
}
// Tiny LCS-based unified diff. Returns array of { tag: 'eq'|'add'|'del', a?: lineNo, b?: lineNo, text }.
function makeLineDiff(before, after) {
  const A = (before || '').split('\n')
  const B = (after  || '').split('\n')
  const n = A.length, m = B.length
  // LCS table — bail out if too large to avoid huge allocations.
  if (n * m > 2_000_000) return [{ tag: 'note', text: 'file too large to diff line-by-line' }]
  const dp = new Uint32Array((n + 1) * (m + 1))
  const W = m + 1
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ tag: 'eq', a: i + 1, b: j + 1, text: A[i] }); i++; j++ }
    else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { out.push({ tag: 'del', a: i + 1, text: A[i] }); i++ }
    else { out.push({ tag: 'add', b: j + 1, text: B[j] }); j++ }
  }
  while (i < n) { out.push({ tag: 'del', a: i + 1, text: A[i] }); i++ }
  while (j < m) { out.push({ tag: 'add', b: j + 1, text: B[j] }); j++ }
  return out
}

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
ipcMain.handle('panel:tour',       () => buildTour())
ipcMain.handle('panel:timeline',   async () => await buildTimeline())
ipcMain.handle('panel:changes',    () => listSessionChanges())
ipcMain.handle('panel:change-diff', (_e, id) => getChangeDiff(id))
ipcMain.handle('panel:packages',   () => buildPackagesCached())
ipcMain.handle('panel:package',    (_e, name) => buildPackageDetail(name))
ipcMain.handle('panel:legacy',     async () => await buildLegacyCached())
ipcMain.handle('trace:log',        (_e, opts = {}) => {
  let evs = traceLog
  if (opts.tool) evs = evs.filter((e) => e.tool === opts.tool)
  if (opts.limit) evs = evs.slice(-opts.limit)
  return { sessionId: traceSessionId, events: evs, totalAvailable: traceLog.length }
})
ipcMain.handle('trace:stats',      () => ({ sessionId: traceSessionId, ...computeTraceStats(traceLog) }))
ipcMain.handle('trace:sessions',   () => ({
  sessions: listTraceSessions(currentRoot), currentSessionId: traceSessionId,
}))
ipcMain.handle('trace:session',    (_e, id) => {
  const data = readTraceSession(currentRoot, id)
  if (!data) return null
  return { ...data, stats: computeTraceStats(data.events) }
})
ipcMain.handle('trace:clear',      () => { traceLog = []; startTraceSession(); return { newSessionId: traceSessionId } })
ipcMain.handle('trace:export',     async (_e, exportPath) => {
  if (!exportPath) {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export AI trace session',
      defaultPath: `cs-trace-${traceSessionId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { canceled: true }
    exportPath = r.filePath
  }
  try {
    const stats = computeTraceStats(traceLog)
    const out = {
      sessionId: traceSessionId, root: currentRoot,
      startedAt: traceSessionStartedAt, exportedAt: Date.now(),
      stats, events: traceLog,
    }
    fs.writeFileSync(exportPath, JSON.stringify(out, null, 2), 'utf8')
    return { ok: true, path: exportPath, eventCount: traceLog.length }
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
let timelineCache = { root: null, data: null, building: false }
async function buildTimeline() {
  if (!currentRoot) return { error: 'no folder loaded', isGit: false }
  if (timelineCache.root === currentRoot && timelineCache.data) return timelineCache.data
  if (timelineCache.building) return { error: 'building', isGit: true, building: true }
  timelineCache.building = true
  try {
    await pExecFile('git', ['rev-parse', '--git-dir'], { cwd: currentRoot })
  } catch {
    timelineCache.building = false
    return { error: 'not a git repository', isGit: false }
  }
  try {
    const { stdout } = await pExecFile(
      'git',
      ['log', '--reverse', '--diff-filter=A', '--name-only', '--format=__C__%H|%at|%s'],
      { cwd: currentRoot, maxBuffer: 100 * 1024 * 1024 }
    )
    const points = []
    let cur = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('__C__')) {
        const [hash, atStr, ...subj] = line.slice(5).split('|')
        cur = { hash, ts: parseInt(atStr, 10) * 1000, subject: subj.join('|'), addedFiles: [] }
        points.push(cur)
      } else if (line && cur) {
        // Only keep files we currently track (filters renames + deletes)
        const id = line.replace(/\\/g, '/')
        if (scanner?.files?.has(id)) cur.addedFiles.push(id)
      }
    }
    // Drop empty commits (commits that added only files we no longer have)
    const filtered = points.filter((p) => p.addedFiles.length > 0)
    const data = {
      isGit: true,
      points: filtered,
      firstAt: filtered[0]?.ts || Date.now(),
      lastAt:  filtered[filtered.length - 1]?.ts || Date.now(),
      commitCount: filtered.length,
    }
    timelineCache = { root: currentRoot, data, building: false }
    return data
  } catch (e) {
    timelineCache.building = false
    return { error: e.message, isGit: true }
  }
}

// Heuristic-only onboarding tour. Picks likely entry points (index/
// main/app/server at the project root or under src/), then the top
// hub files by incoming-import count. Each stop has a generated
// human-readable hint. An MCP client can call cs_trace({action:'tour'}) to get
// the same script for narrating.
function buildTour() {
  if (!scanner) return null
  const files = [...scanner.files.values()]
  const stops = []
  const seen = new Set()
  const entryRe = /^(?:src\/)?(?:index|main|app|server|cli|bin)(?:\.[a-z]+)+$/i
  const entries = files.filter((f) => entryRe.test(f.id)).sort((a, b) => a.id.length - b.id.length).slice(0, 3)
  for (const f of entries) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    stops.push({
      id: f.id,
      kind: 'entry',
      hint: `Entry point — likely where execution starts. ${f.ext.toUpperCase()} file, ${f.loc} LOC.`,
    })
  }
  // Inbound count per file
  const inCount = new Map()
  for (const e of scanner.edges) inCount.set(e.t, (inCount.get(e.t) || 0) + 1)
  const hubs = files
    .map((f) => ({ ...f, inCount: inCount.get(f.id) || 0 }))
    .filter((f) => f.inCount >= 2 && !seen.has(f.id))
    .sort((a, b) => b.inCount - a.inCount)
    .slice(0, 5)
  for (const f of hubs) {
    seen.add(f.id)
    stops.push({
      id: f.id,
      kind: 'hub',
      hint: `Hub file — ${f.inCount} other files import this. Core utility or shared module.`,
    })
  }
  // External-call concentrators
  const ext = getExternalUrls()
  const topCallers = new Map()
  for (const d of ext.domains) {
    for (const c of d.callers) {
      topCallers.set(c.file, (topCallers.get(c.file) || 0) + 1)
    }
  }
  const apiFiles = [...topCallers.entries()]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  for (const [id, count] of apiFiles) {
    seen.add(id)
    stops.push({
      id, kind: 'api',
      hint: `External API integration — calls ${count} different external URL${count === 1 ? '' : 's'}.`,
    })
  }
  return { stops, totalFiles: scanner.files.size }
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
const TRACE_DIR_NAME = 'traces'
const TRACE_MEM_CAP = 10000   // in-memory cap to prevent unbounded growth
let traceSessionId = null      // ms timestamp; set in startScanner
let traceSessionStartedAt = null
let traceLog = []              // [{ tool, id, ts }]
let traceWriteStream = null

function traceDirFor(root) { return path.join(root, HISTORY_DIR_NAME, TRACE_DIR_NAME) }
function traceFileFor(root, sessionId) {
  return path.join(traceDirFor(root), `session-${sessionId}.jsonl`)
}

function startTraceSession() {
  if (!currentRoot) return
  traceSessionId = Date.now()
  traceSessionStartedAt = traceSessionId
  traceLog = []
  closeTraceWriteStream()
  try {
    fs.mkdirSync(traceDirFor(currentRoot), { recursive: true })
    traceWriteStream = fs.createWriteStream(traceFileFor(currentRoot, traceSessionId), { flags: 'a' })
    // First line: session metadata
    traceWriteStream.write(JSON.stringify({
      type: 'meta', sessionId: traceSessionId, root: currentRoot, startedAt: traceSessionStartedAt,
    }) + '\n')
  } catch (e) {
    traceWriteStream = null
  }
}
function closeTraceWriteStream() {
  if (traceWriteStream) {
    try { traceWriteStream.end() } catch {}
    traceWriteStream = null
  }
}

// Trust metadata for an AI session-trace event: was the queried/touched file
// statically confident, or does it use dynamic/reflective/DI patterns the graph
// can't fully resolve? Logging this per query lets a reviewer judge whether the
// AI was working from complete data or known-incomplete data.
function traceMetaFor(id) {
  const f = scanner && scanner.files && scanner.files.get(id)
  if (!f) return null
  const dyn = (f.dynamicPatterns || [])
  return { conf: f.confidence || 'high', dyn: dyn.length ? dyn : undefined }
}

function emitTrace(tool, id, meta) {
  if (!id) return
  const ts = Date.now()
  // Auto-attach per-file trust meta (confidence / dynamic patterns) unless the
  // caller passed its own richer meta (e.g. blast impact stats).
  const ev = { tool, id, ts, ...(meta || traceMetaFor(id) || {}) }
  // In-memory (cap with sliding window)
  traceLog.push(ev)
  if (traceLog.length > TRACE_MEM_CAP) traceLog.splice(0, traceLog.length - TRACE_MEM_CAP)
  // Disk append (best-effort)
  if (traceWriteStream) {
    try { traceWriteStream.write(JSON.stringify(ev) + '\n') } catch {}
  }
  mainWindow?.webContents.send('control:trace', { ...ev })
}

function listTraceSessions(root) {
  if (!root) return []
  const dir = traceDirFor(root)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^session-(\d+)\.jsonl$/)
    if (!m) continue
    const sessionId = parseInt(m[1], 10)
    const full = path.join(dir, name)
    let stat, size = 0, eventCount = 0, endedAt = sessionId
    try { stat = fs.statSync(full); size = stat.size; endedAt = stat.mtimeMs } catch {}
    // Cheap line count for event count (subtract 1 for meta line)
    try {
      const data = fs.readFileSync(full, 'utf8')
      eventCount = Math.max(0, data.split('\n').filter((l) => l.trim()).length - 1)
    } catch {}
    out.push({
      sessionId, startedAt: sessionId, endedAt,
      eventCount, size,
      isCurrent: sessionId === traceSessionId,
    })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function readTraceSession(root, sessionId) {
  if (!root) return null
  const f = traceFileFor(root, sessionId)
  if (!fs.existsSync(f)) return null
  let meta = null
  const events = []
  try {
    const data = fs.readFileSync(f, 'utf8')
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (j.type === 'meta') meta = j
        else events.push(j)
      } catch {}
    }
  } catch { return null }
  return { sessionId, meta, events, eventCount: events.length }
}

// Compute stats over an event array. Used by /trace/stats and by the
// session-detail endpoint.
function computeTraceStats(events) {
  const byTool = {}
  const byFile = new Map()
  let firstAt = null, lastAt = null
  for (const e of events) {
    byTool[e.tool] = (byTool[e.tool] || 0) + 1
    byFile.set(e.id, (byFile.get(e.id) || 0) + 1)
    if (firstAt === null || e.ts < firstAt) firstAt = e.ts
    if (lastAt  === null || e.ts > lastAt)  lastAt = e.ts
  }
  const topFiles = [...byFile.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
  // Time histogram — 20 buckets across [firstAt, lastAt]
  let timeline = []
  if (firstAt !== null && lastAt !== null && lastAt > firstAt) {
    const buckets = 20
    timeline = Array(buckets).fill(0)
    const span = lastAt - firstAt
    for (const e of events) {
      const idx = Math.min(buckets - 1, Math.floor((e.ts - firstAt) / span * buckets))
      timeline[idx]++
    }
  }
  return {
    eventCount: events.length,
    fileCount: byFile.size,
    byTool, topFiles, timeline,
    firstAt, lastAt,
    durationMs: (firstAt && lastAt) ? lastAt - firstAt : 0,
  }
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

function _teardownSearchWorker() {
  if (_searchWorker) { try { _searchWorker.terminate() } catch {} }
  _searchWorker = null
  _searchWorkerReady = false
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
  // Keep worker's cache in sync with scanner
  if (scanner) {
    scanner.on('file-changed', ({ id }) => { try { w.postMessage({ type: 'invalidate', id }) } catch {} })
    scanner.on('file-removed', ({ id }) => { try { w.postMessage({ type: 'invalidate', id }) } catch {} })
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
            if (cacheEnabled) {
              try {
                if (fs.existsSync(cachePath)) {
                  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
                  // Newest mtime in the file set must be older than the
                  // cache mtime for it to be valid.
                  let newest = 0
                  for (const f of scanner.files.values()) {
                    try { const t = fs.statSync(f.absPath).mtimeMs; if (t > newest) newest = t } catch {}
                  }
                  const cacheMtime = fs.statSync(cachePath).mtimeMs
                  if (newest > 0 && cacheMtime >= newest) {
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
            // ─── Persist symbol graph to cache (opt-in) ──────────
            if (cacheEnabled) {
              try {
                fs.mkdirSync(cacheDir, { recursive: true })
                const payload = {
                  nodes: [...g.nodes.values()],
                  edges: g.edges,
                  fileCount: g.fileCount,
                  builtAt: g.builtAt,
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

      if (req.method === 'GET' && (sub === '' || sub === 'summary')) {
        return writeJson(res, 200, withMeta(g.stats()))
      }
      if (req.method === 'GET' && sub === 'find') {
        const q = url.searchParams.get('q') || ''
        const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10))
        const matches = g.findByName(q, limit)
        return writeJson(res, 200, withMeta({ query: q, matches }))
      }
      if (req.method === 'GET' && sub === 'node' && rest[1]) {
        const id = decodeURIComponent(rest.slice(1).join('/'))
        const node = g.nodes.get(id)
        if (!node) return writeJson(res, 404, { error: 'symbol not found', id })
        // Pull source between startLine and endLine
        let source = ''
        try {
          const filePath = path.join(currentRoot, node.file)
          const lines = fs.readFileSync(filePath, 'utf8').split('\n')
          source = lines.slice(node.startLine - 1, node.endLine).join('\n')
          if (source.length > 4000) source = source.slice(0, 4000) + '\n…'
        } catch {}
        return writeJson(res, 200, withMeta({ ...node, source }))
      }
      if (req.method === 'GET' && sub === 'callers' && rest[1]) {
        const id = decodeURIComponent(rest.slice(1).join('/'))
        return writeJson(res, 200, withMeta({ id, callers: g.callersOf(id) }))
      }
      if (req.method === 'GET' && sub === 'callees' && rest[1]) {
        const id = decodeURIComponent(rest.slice(1).join('/'))
        return writeJson(res, 200, withMeta({ id, callees: g.calleesOf(id) }))
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
        return writeJson(res, 200, { id, content: fs.readFileSync(full, 'utf8') })
      } catch (e) { return writeJson(res, 500, { error: e.message }) }
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
      let evs = traceLog
      if (sinceRaw) {
        const since = parseInt(sinceRaw, 10)
        evs = evs.filter((e) => e.ts > since)
      }
      if (toolFilter) evs = evs.filter((e) => e.tool === toolFilter)
      const totalAvailable = evs.length
      if (limit > 0) evs = evs.slice(-limit)  // most recent N
      return writeJson(res, 200, withMeta({
        sessionId: traceSessionId,
        events: evs,
      }, { totalAvailable, returned: evs.length }))
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest[0] === 'stats') {
      // Stats over current session
      const stats = computeTraceStats(traceLog)
      return writeJson(res, 200, withMeta({ sessionId: traceSessionId, ...stats }))
    }
    if (req.method === 'GET' && seg0 === 'trace' && rest[0] === 'sessions') {
      return writeJson(res, 200, withMeta({
        sessions: listTraceSessions(currentRoot),
        currentSessionId: traceSessionId,
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
      traceLog = []
      startTraceSession()
      return writeJson(res, 200, { ok: true, newSessionId: traceSessionId })
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
          const stats = computeTraceStats(traceLog)
          const out = {
            sessionId: traceSessionId,
            root: currentRoot,
            startedAt: traceSessionStartedAt,
            exportedAt: Date.now(),
            stats,
            events: traceLog,
          }
          fs.writeFileSync(exportPath, JSON.stringify(out, null, 2), 'utf8')
          return writeJson(res, 200, { ok: true, path: exportPath, eventCount: traceLog.length })
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
}
ipcMain.handle('control-port', () => controlPort)

// ─── Log retention (audit + per-project traces) ────────────────
// Default 30 days; configurable via env. Prevents unbounded growth of
// ~/.codesynapt/audit/YYYY-MM-DD.jsonl and project-local .codesynapt/traces/.
function pruneOldLogs() {
  const days = parseInt(process.env.CS_AUDIT_RETENTION_DAYS || '30', 10)
  if (!days || days <= 0) return   // 0 = keep forever
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  const auditDir = path.join(app.getPath('home'), '.codesynapt', 'audit')
  const dirs = [auditDir]
  if (currentRoot) dirs.push(traceDirFor(currentRoot))
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
  protocol.handle('app', (request) => {
    const { pathToFileURL } = require('url')
    const publicDir = path.join(__dirname, '..', 'public')
    const { pathname } = new URL(request.url)
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
    const filePath = path.normalize(path.join(publicDir, rel))
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
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
  startControlServer()
  pruneOldLogs()   // one-shot on boot; daily users get fresh pruning

  app.on('activate', () => {
    if (!HEADLESS && BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Auto-updater (GitHub Releases). Disabled by env var for users who
  // want zero outbound network calls. Silently no-ops if no published
  // releases yet (404 from update feed → updater logs and does nothing).
  if (process.env.CS_DISABLE_UPDATER !== '1') {
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.autoDownload = false   // ask user before downloading
      autoUpdater.on('error', (e) => log.error('updater error', { message: e.message }))
      autoUpdater.on('update-available', (info) => {
        log.info('update available', { version: info.version })
        // Notify renderer; renderer shows a toast with "download / dismiss".
        mainWindow?.webContents.send('updater:available', { version: info.version, releaseNotes: info.releaseNotes })
      })
      autoUpdater.on('update-downloaded', (info) => {
        mainWindow?.webContents.send('updater:downloaded', { version: info.version })
      })
      // Check ~10s after boot so the scanner gets the network priority.
      setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 10_000)
    } catch (e) {
      // electron-updater is optional at runtime; CLI/MCP-only installs skip it
      log.warn('updater not loaded', { error: e.message })
    }
  }
})

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
  // Defense-in-depth: block all in-window navigation away from our file://.
  // CSP already blocks remote loads, but this is one more layer.
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      if (url.startsWith('http')) shell.openExternal(url)
    }
  })
  // Deny every permission request — we don't use mic/camera/geolocation/etc.
  contents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
})
