import fs from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import { EventEmitter } from 'events'
import { parseFile, resolveImport, resolveImportAll, clearParserCaches, normalizeUrlPath, routePathToRegex,
         isExternalApiUrl,
         extractNextApiRoutes, extractNuxtServerRoutes, extractSvelteKitServerRoutes } from './parser.js'
import { detectMonorepo, packageForFile } from './monorepo.js'
import { registerAll as registerSymbolParsers, SymbolGraph } from './lib/symbol-parsers.cjs'
import { enrich as enrichSubengines } from './lib/subengines.cjs'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.vercel', '.svelte-kit',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'venv', '.venv', 'env', 'site-packages', '.tox',
  'target', '.cache', '.parcel-cache',
  '.idea', '.vscode', '.DS_Store',
  'coverage', '.nyc_output',
  '.filegraph3d',
  // Editor/note vaults: Obsidian, etc. — third-party plugin/theme code
  // would otherwise dominate hub/orphan/url stats.
  '.obsidian', '.logseq', '.foam',
  // Mobile / native deps
  'Pods', 'DerivedData', '.gradle',
  // Misc
  'vendor',  // Go / PHP / Ruby vendored deps
])

// Prefix-based ignore for variant names (e.g. `.venv-foo`, `venv-bar`).
// Set lookup above is exact-match only, so `.venv-facefusion` wouldn't
// match `.venv`. This catches the long tail.
const IGNORE_DIR_PREFIXES = ['.venv', 'venv-', '.env-py']

function isIgnoredDir(name) {
  if (IGNORE_DIRS.has(name)) return true
  for (const p of IGNORE_DIR_PREFIXES) if (name.startsWith(p)) return true
  return false
}

// Parse a .gitignore file into a list of {pattern, negate} entries.
// Implements a subset that covers the vast majority of real-world
// .gitignore files: blank lines, comments, leading slash anchoring,
// trailing slash for directories, `**` glob, `!` negation, `*`/`?`.
function parseGitignore(text) {
  const lines = text.split(/\r?\n/)
  const rules = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let pattern = line
    let negate = false
    if (pattern.startsWith('!')) { negate = true; pattern = pattern.slice(1) }
    const anchored = pattern.startsWith('/')
    if (anchored) pattern = pattern.slice(1)
    const dirOnly = pattern.endsWith('/')
    if (dirOnly) pattern = pattern.slice(0, -1)
    // Build regex. Anchored uses ^ so it must start at the root.
    // Non-anchored allows any directory prefix.
    let re = anchored ? '^' : '(^|/)'
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '*') {
        if (pattern[i + 1] === '*') { re += '.*'; i++ }
        else re += '[^/]*'
      } else if (c === '?') re += '[^/]'
      else if ('.+^$()|{}\\'.includes(c)) re += '\\' + c
      else re += c
    }
    // For dirOnly: must be followed by '/' (so it matches directory
    // itself or any path inside it). For files: end-of-path or '/'.
    re += dirOnly ? '(/|$)' : '($|/)'
    try { rules.push({ regex: new RegExp(re), negate, dirOnly, raw: line }) }
    catch { /* invalid pattern — skip */ }
  }
  return rules
}

function loadGitignoreRules(root) {
  // Read only the root .gitignore. Per-subdirectory .gitignore is
  // rare in practice and full support adds significant complexity.
  const file = path.join(root, '.gitignore')
  try {
    if (fs.existsSync(file)) {
      return parseGitignore(fs.readFileSync(file, 'utf8'))
    }
  } catch { /* ignore read errors */ }
  return []
}

// Project-local CodeSynapt-specific ignore. Same syntax as .gitignore.
// Use when you want to keep a folder in git but hide it from the
// graph (e.g. vendored third-party code you don't edit).
// Reads .codesynaptignore first, falls back to legacy .fg3dignore.
function loadFg3dIgnoreRules(root) {
  for (const name of ['.codesynaptignore', '.fg3dignore']) {
    const file = path.join(root, name)
    try {
      if (fs.existsSync(file)) {
        return parseGitignore(fs.readFileSync(file, 'utf8'))
      }
    } catch { /* ignore */ }
  }
  return []
}

function matchedByRules(relPath, isDir, rules) {
  let ignored = false
  for (const rule of rules) {
    // Standard match
    if (rule.regex.test(relPath)) {
      if (!rule.dirOnly || isDir) {
        ignored = !rule.negate
        continue
      }
    }
    // dirOnly rules should also match files inside the matching dir.
    // Check every prefix (path up to each slash) against the dir rule.
    if (rule.dirOnly && !isDir) {
      const parts = relPath.split('/')
      for (let i = 0; i < parts.length - 1; i++) {
        const prefix = parts.slice(0, i + 1).join('/')
        if (rule.regex.test(prefix + '/')) {
          ignored = !rule.negate
          break
        }
      }
    }
  }
  return ignored
}

// Parse a .env file and return the list of keys declared inside.
// Keys must start with an uppercase letter (POSIX convention) to match
// our extractEnvUsage filter on the consumption side.
function parseEnvFileKeys(absPath) {
  let content
  try { content = fs.readFileSync(absPath, 'utf8') } catch { return [] }
  const keys = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)
    if (m) keys.push(m[1])
  }
  return keys
}

const TRACKED_EXT = new Set([
  // JS / TS family
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  // Python
  'py', 'pyw', 'pyi',
  // Jupyter — JSON wrapper around Python (usually) code cells
  'ipynb',
  // Lisp / Scheme / Clojure / Emacs
  'lsp', 'dcl', 'lisp', 'el', 'clj', 'scm', 'cljc',
  // Styles
  'css', 'scss', 'sass', 'less', 'styl',
  // Markup / Component
  'html', 'htm', 'vue', 'svelte', 'astro',
  // Config / Data
  'json', 'yaml', 'yml', 'toml',
  // Docs
  'md', 'mdx', 'rst',
  // JVM family
  'java', 'kt',
  // .NET family
  'cs',
  // Apple family
  'swift',
  // Dart / Flutter
  'dart',
  // Systems
  'rs', 'go', 'rb', 'php',
  'c', 'cc', 'cpp', 'h', 'hpp',
  // Shell / scripting
  'sh', 'bash', 'zsh', 'ps1', 'psm1',
  // Data
  'sql', 'xml',
  // DB schema (Prisma)
  'prisma',
  // JVM/scripting with L2 symbol support
  'scala', 'lua',
  // NOTE: dwg/dxf removed — binary CAD files have no import concept,
  // scanning them just creates orphan noise.
])

export class Scanner extends EventEmitter {
  constructor(root) {
    super()
    this.root = root
    this.files = new Map() // id -> { id, ext, loc, size, imports, absPath, pkg }
    this.edges = []
    this.pkgEdges = []  // package-to-package edges aggregated from file edges
    // Layer-2 (symbol/function graph). Lazy: built on first request, marked
    // stale whenever the file graph changes. See docs/SYMBOL-MODE-PLAN.md.
    this.symbolGraph = null
    this._symbolGraphStale = true
    this._symbolGraphBuilding = null
    this.watcher = null
    this._pendingSnapshot = null
    // True once the chokidar 'ready' has fired and the initial walk is done.
    // Used by /search to refuse work while the event loop is still saturated
    // by add events — returning 503 instead of hanging.
    this.initialScanComplete = false
    this.gitignoreRules = loadGitignoreRules(root)
    this.fg3dIgnoreRules = loadFg3dIgnoreRules(root)
    this.envFiles = []  // [{ id, keys: [...] }] — populated on first ready
    // Detect workspace structure once at construction. Cheap (one
    // directory walk capped at depth 6). Result feeds package-level
    // grouping in the UI and the /packages API for AI agents.
    try { this.monorepo = detectMonorepo(root) }
    catch (e) { this.monorepo = { kind: 'none', packages: [], rootIsPackage: false } }
  }

  toId(absPath) {
    return path.relative(this.root, absPath).split(path.sep).join('/')
  }

  // ── Third-party folder auto-detection ────────────────────────
  // Heuristic: a sub-folder is "vendored" / "third-party" if it shows
  // any of these signals (combined for confidence):
  //   - .git/ subdirectory (nested repo / submodule)              +0.5
  //   - LICENSE/LICENCE/COPYING file at folder root               +0.2
  //   - own package.json / pyproject.toml / Cargo.toml /
  //     go.mod / Gemfile / pom.xml + the parent has its own       +0.3
  //   - conventional name: vendor / vendors / third_party /       +0.2
  //     third-party / external / deps / submodules / tools
  //
  // We only report folders, never auto-ignore — the user can copy
  // suggested entries into `.codesynaptignore`. Reported via `vendorCandidates`
  // on the snapshot.
  scanVendorCandidates() {
    this.vendorCandidates = []
    const CONVENTIONAL_NAMES = new Set([
      'vendor', 'vendors', 'third_party', 'third-party',
      'external', 'externals', 'deps', 'submodules',
    ])
    const ROOT_HAS_MANIFEST = (() => {
      for (const name of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml']) {
        if (fs.existsSync(path.join(this.root, name))) return true
      }
      return false
    })()
    // Folders we'd normally ignore in scanning but want to walk INTO
    // when looking for vendor candidates (the whole point of this scan).
    const VENDOR_OK = new Set(['vendor', 'vendors', 'third_party', 'third-party',
                                'external', 'externals', 'deps', 'submodules', 'tools'])
    const seen = new Set()
    const walk = (dir, depth, relParts) => {
      if (depth > 3) return    // shallow only — vendored libs usually at depth 1-2
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        // Skip hard-ignores (node_modules, .git, .venv*, etc.) but keep
        // conventional vendor names — those are what we're looking for.
        if (!VENDOR_OK.has(e.name) && (IGNORE_DIRS.has(e.name) || isIgnoredDir(e.name))) continue
        const full = path.join(dir, e.name)
        const rel  = [...relParts, e.name].join('/')
        if (seen.has(rel)) continue
        seen.add(rel)

        let confidence = 0
        const reasons = []
        try {
          if (fs.existsSync(path.join(full, '.git'))) {
            confidence += 0.5; reasons.push('nested .git (submodule or sub-repo)')
          }
          for (const lic of ['LICENSE', 'LICENCE', 'COPYING', 'LICENSE.md', 'LICENSE.txt']) {
            if (fs.existsSync(path.join(full, lic))) { confidence += 0.2; reasons.push(`has ${lic}`); break }
          }
          if (ROOT_HAS_MANIFEST) {
            for (const mf of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml']) {
              if (fs.existsSync(path.join(full, mf))) {
                confidence += 0.3; reasons.push(`own ${mf} (sub-project)`); break
              }
            }
          }
          if (CONVENTIONAL_NAMES.has(e.name.toLowerCase())) {
            confidence += 0.2; reasons.push('conventional vendor folder name')
          }
        } catch {}

        if (confidence >= 0.3) {
          this.vendorCandidates.push({
            path: rel,
            confidence: Math.min(1, +confidence.toFixed(2)),
            reasons,
          })
        } else {
          // Only recurse into non-obvious folders. Don't dive into
          // anything already flagged (its children would inherit).
          walk(full, depth + 1, [...relParts, e.name])
        }
      }
    }
    walk(this.root, 0, [])
    this.vendorCandidates.sort((a, b) => b.confidence - a.confidence)
  }

  // ── .env file index ───────────────────────────────────────────
  // We don't add .env files to the graph (they're config, not code),
  // but we DO scan them to know which env vars are declared. The
  // server then cross-references against extractEnvUsage in source.
  scanEnvFiles() {
    this.envFiles = []
    const names = ['.env', '.env.local', '.env.production', '.env.development',
                   '.env.test', '.env.example', '.env.sample']
    const walk = (dir, depth) => {
      if (depth > 4) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (isIgnoredDir(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile() && names.includes(e.name)) {
          const keys = parseEnvFileKeys(full)
          this.envFiles.push({ id: this.toId(full), keys })
        }
      }
    }
    walk(this.root, 0)
  }

  shouldTrack(absPath) {
    const ext = path.extname(absPath).slice(1).toLowerCase()
    return TRACKED_EXT.has(ext)
  }

  start() {
    const root = this.root
    const rules = this.gitignoreRules
    const fg3dRules = this.fg3dIgnoreRules
    this.watcher = chokidar.watch(root, {
      ignored: (p, stats) => {
        const rel = path.relative(root, p)
        if (!rel) return false
        const segments = rel.split(path.sep)
        if (segments.some(isIgnoredDir)) return true
        // .gitignore matching uses '/'-joined relative path
        const relPosix = segments.join('/')
        const isDir = stats?.isDirectory() ?? false
        if (matchedByRules(relPosix, isDir, rules)) return true
        if (fg3dRules.length && matchedByRules(relPosix, isDir, fg3dRules)) return true
        return false
      },
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 },
    })

    let initial = true
    let scanCount = 0
    let lastProgressEmit = 0
    this.watcher
      .on('add', (p) => {
        this.handleAdd(p, initial)
        if (initial) {
          scanCount++
          // Throttle progress emission to ~10/sec; final ready emit
          // gives the accurate total.
          const now = Date.now()
          if (now - lastProgressEmit > 100) {
            lastProgressEmit = now
            this.emit('scan-progress', { count: scanCount, done: false })
          }
        }
      })
      .on('change', (p) => this.handleChange(p))
      .on('unlink', (p) => this.handleRemove(p))
      .on('ready', async () => {
        initial = false
        // Finish draining the cooperative parse queue before resolving edges.
        if (this._initialDrain) { try { await this._initialDrain } catch {} }
        while (this._initialQueue && this._initialQueue.length) {
          const p = this._initialQueue.shift()
          // Log parse failures (consistent with the batched drain in
          // _ensureInitialDrain) instead of swallowing them — a silently
          // dropped file here is an invisible hole in the graph, which is
          // exactly the kind of gap that erodes trust in the tool's output.
          try { const f = this.parseOne(p); if (f) this.files.set(f.id, f) }
          catch (e) { process.stderr.write(`[scanner] parse ${p}: ${e && e.message}\n`) }
        }
        this.initialScanComplete = true
        this.emit('scan-progress', { count: scanCount, done: true })
        this.scanEnvFiles()
        this.scanVendorCandidates()
        this.rebuildEdges()
        this.emitSnapshot()
        this.emit('stats', { initialScanComplete: true, fileCount: this.files.size })
      })
      .on('error', (e) => console.error('watcher error:', e.message))
  }

  stop() {
    // Drop this root's resolution caches so reloading another project doesn't
    // retain (or serve stale) the previous one's index — and return the
    // watcher's close() promise so callers can await full teardown (chokidar
    // close is async; not awaiting leaks fs handles, especially on Windows).
    this._stopped = true   // aborts any in-flight cooperative parse drain
    try { clearParserCaches(this.root) } catch {}
    if (this.watcher) {
      const w = this.watcher
      this.watcher = null
      return w.close()
    }
  }

  snapshot() {
    return {
      files: [...this.files.values()].map((f) => ({
        id: f.id, ext: f.ext, loc: f.loc, size: f.size,
        importCount: f.imports.length,
        pkg: f.pkg || null,
        hasDynamicResolution: (f.dynamicPatterns || []).length > 0,
        dynamicPatterns:      f.dynamicPatterns || [],
        confidence:           f.confidence || 'high',
      })),
      edges: this.edges,
      monorepo: this.monorepo,
      pkgEdges: this.pkgEdges,
    }
  }

  emitSnapshot() {
    // Debounce snapshots during burst changes
    if (this._pendingSnapshot) clearTimeout(this._pendingSnapshot)
    this._pendingSnapshot = setTimeout(() => {
      this._pendingSnapshot = null
      this._lastSnapshotAt = Date.now()
      this.snapshotVersion = (this.snapshotVersion || 0) + 1
      this.emit('snapshot', this.snapshot())
    }, 60)
  }

  // A change to a .cs file (namespace index) or a resolution-manifest
  // (tsconfig/jsconfig/composer/pubspec/go.mod) makes the per-root parser
  // caches stale — drop them so the next rebuild re-resolves correctly.
  _maybeInvalidateCaches(absPath) {
    const base = path.basename(absPath).toLowerCase()
    const ext = path.extname(absPath).slice(1).toLowerCase()
    if (ext === 'cs' || ['tsconfig.json', 'jsconfig.json', 'composer.json', 'pubspec.yaml', 'go.mod', 'cargo.toml', 'package.json'].includes(base)) {
      clearParserCaches(this.root)
    }
  }

  async handleAdd(absPath, initial) {
    // These fire-and-forget from chokidar event listeners; an unhandled throw
    // would become a fatal unhandledRejection (Node ≥20). Never let one bad
    // file take down the daemon.
    try {
      if (!this.shouldTrack(absPath)) return
      if (initial) {
        // Cooperative initial scan: enqueue and parse in batches that yield the
        // event loop (see _ensureInitialDrain), so the control-server stays
        // responsive during a large scan instead of freezing for seconds.
        ;(this._initialQueue || (this._initialQueue = [])).push(absPath)
        this._ensureInitialDrain()
        return
      }
      const file = this.parseOne(absPath)
      if (!file) return
      this.files.set(file.id, file)
      this._maybeInvalidateCaches(absPath)
      this.emit('file-added', { id: file.id, absPath })
      this.rebuildEdges()
      this.emitSnapshot()
    } catch (e) {
      process.stderr.write(`[scanner] handleAdd ${absPath}: ${e && e.message}\n`)
    }
  }

  // Drain the initial-scan parse queue in batches, yielding the event loop
  // between batches so HTTP requests are serviced while a big project scans.
  _ensureInitialDrain() {
    if (this._draining) return this._initialDrain
    this._draining = true
    this._initialDrain = (async () => {
      const BATCH = 100
      while (true) {
        if (this._stopped) { this._draining = false; return }
        const q = this._initialQueue
        if (!q || q.length === 0) { this._draining = false; return }
        const n = Math.min(BATCH, q.length)
        for (let i = 0; i < n; i++) {
          const p = q.shift()
          try { const f = this.parseOne(p); if (f) this.files.set(f.id, f) } catch (e) { process.stderr.write(`[scanner] parse ${p}: ${e && e.message}\n`) }
        }
        await new Promise((r) => setImmediate(r))   // yield → service pending HTTP/IO
      }
    })()
    return this._initialDrain
  }

  async handleChange(absPath) {
    try {
      if (!this.shouldTrack(absPath)) return
      const file = this.parseOne(absPath)
      if (!file) return
      this.files.set(file.id, file)
      // During the initial scan, just record the latest content — the single
      // rebuildEdges on 'ready' covers it. Avoids redundant partial rebuilds.
      if (!this.initialScanComplete) return
      this._maybeInvalidateCaches(absPath)
      this.emit('file-changed', { id: file.id, absPath })
      this.rebuildEdges()
      this.emitSnapshot()
    } catch (e) {
      process.stderr.write(`[scanner] handleChange ${absPath}: ${e && e.message}\n`)
    }
  }

  handleRemove(absPath) {
    const id = this.toId(absPath)
    if (this.files.delete(id)) {
      this._maybeInvalidateCaches(absPath)
      this.emit('file-removed', { id, absPath })
      this.rebuildEdges()
      this.emitSnapshot()
    }
  }

  parseOne(absPath) {
    let stat
    try { stat = fs.statSync(absPath) } catch { return null }
    const id = this.toId(absPath)
    const ext = path.extname(absPath).slice(1).toLowerCase()
    let content = ''
    // Size + binary gate: huge/generated/minified or binary files (which can
    // slip past the extension filter) would stall or OOM the parser's regex
    // passes. Index them as nodes (size known) but don't parse their content.
    const MAX_PARSE_BYTES = 2 * 1024 * 1024  // 2 MB
    let readError = false
    if (stat.size <= MAX_PARSE_BYTES) {
      // Distinguish a genuine read failure (EACCES, transient lock, encoding
      // fault) from a deliberately-skipped huge/binary file. A swallowed read
      // error used to leave content='' and produce a FULL node (loc:0,
      // imports:[], confidence:high) — its real outgoing edges vanished, so its
      // import targets were falsely reclassified as high-confidence orphans, and
      // the file itself looked like a clean dependency-less node. We now log the
      // failure and mark the node so the orphan/legacy audit doesn't trust it.
      try {
        content = fs.readFileSync(absPath, 'utf8')
      } catch (e) {
        readError = true
        process.stderr.write(`[scanner] read ${absPath}: ${e && e.message}\n`)
      }
      if (content.indexOf('\u0000') !== -1) content = ''   // binary → skip parsing
    }
    const loc = content ? content.split('\n').length : 0
    const { imports, routes, apiCalls, externalUrls, dynamicPatterns, envUsage, dbModels, confidence } = parseFile(absPath, content, ext)
    // Augment with file-system server routes (Next.js / Nuxt 3 /
    // SvelteKit). Conservative: append-only.
    let finalRoutes = routes || []
    if (['ts','tsx','js','jsx','mjs','cjs','mts','cts'].includes(ext)) {
      const fsRoutes = [
        ...extractNextApiRoutes(id, content),
        ...extractNuxtServerRoutes(id, content),
        ...extractSvelteKitServerRoutes(id, content),
      ]
      if (fsRoutes.length > 0) finalRoutes = [...finalRoutes, ...fsRoutes]
    }
    // Tag the file with its owning package (null if outside all
    // packages or no monorepo). Used by UI for package-level grouping
    // and by API endpoints for package-level slicing.
    const pkg = this.monorepo?.packages?.length
      ? packageForFile(id, this.monorepo.packages)
      : null
    // On a genuine read failure we have NO real import info for this file, so we
    // must not present it as a clean high-confidence node. Force confidence low
    // and inject a 'read-error' dynamic-pattern marker so the orphan/legacy
    // audit (which keys off dynamicPatterns) does not treat its (unknown) edges
    // as definitively absent. `readError` is surfaced for callers/UI.
    const finalDynamic = readError
      ? [...(dynamicPatterns || []), 'read-error']
      : (dynamicPatterns || [])
    return {
      id, ext, loc, size: stat.size, imports, absPath,
      routes:           finalRoutes,
      apiCalls:         apiCalls         || [],
      externalUrls:     externalUrls     || [],
      dynamicPatterns:  finalDynamic,
      envUsage:         envUsage         || [],
      dbModels:         dbModels         || [],
      confidence:       readError ? 'low' : (confidence || 'high'),
      readError:        readError || undefined,
      pkg,
      lastSeenAt:       Date.now(),
    }
  }

  rebuildEdges() {
    const edges = []
    const seen = new Set()
    const idSet = new Set(this.files.keys())

    // 1) Static import edges (file→file dependency)
    // Memoize the fanout languages whose resolution depends only on (ext, spec)
    // — Go/Swift scan the whole id-set per import, and the same package/module
    // is imported many times; without this, rebuildEdges is O(imports × files)
    // on every file change. (Relative/file-precise langs don't scan, so they
    // are left un-memoized — their result also depends on the importing file.)
    const fanoutMemo = new Map()
    for (const file of this.files.values()) {
      for (const imp of file.imports) {
        let targets
        if (file.ext === 'go' || file.ext === 'swift') {
          const key = file.ext + '\u0000' + imp.spec
          targets = fanoutMemo.get(key)
          if (!targets) {
            targets = resolveImportAll(file.absPath, imp.spec, this.root, idSet, file.ext)
            fanoutMemo.set(key, targets)
          }
        } else {
          targets = resolveImportAll(file.absPath, imp.spec, this.root, idSet, file.ext)
        }
        for (const target of targets) {
          if (target && target !== file.id) {
            const key = `${file.id}→${target}:${imp.kind}`
            if (seen.has(key)) continue
            seen.add(key)
            edges.push({ s: file.id, t: target, k: imp.kind })
          }
        }
      }
    }

    // 2) Full-stack edges (client API call → server route handler)
    //
    // Build a route index across all files, then for each apiCall try
    // to match. A single client URL may match multiple registered
    // routes (e.g. /users/123 matches both /users/:id GET and POST) —
    // we emit edges to each matching handler so the user sees all the
    // server-side files involved. Matching keys on (method, path) so
    // an axios.post matches the POST handler, not the GET one.
    const routeIndex = []  // { fileId, method, regex, raw }
    for (const file of this.files.values()) {
      for (const r of file.routes) {
        try {
          routeIndex.push({
            fileId: file.id,
            method: r.method,
            regex: routePathToRegex(r.path),
            raw: r.path,
          })
        } catch { /* invalid regex — skip */ }
      }
    }

    if (routeIndex.length > 0) {
      for (const file of this.files.values()) {
        for (const call of file.apiCalls) {
          // Third-party (external-host) calls — e.g. https://stripe.com/users/42
          // — must NOT be matched to local routes. normalizeUrlPath strips the
          // host, so without this guard a remote URL whose path shape happens to
          // match a local route would emit a bogus full-stack edge.
          if (isExternalApiUrl(call.url)) continue
          const p = normalizeUrlPath(call.url)
          if (!p) continue
          for (const route of routeIndex) {
            // Method match: HEAD/OPTIONS handled by ALL; otherwise exact.
            // Also: client GET (the default) matches a route's ALL.
            if (route.method !== 'ALL' && route.method !== call.method) continue
            if (!route.regex.test(p)) continue
            if (route.fileId === file.id) continue   // self-call, skip
            const key = `${file.id}→${route.fileId}:api`
            if (seen.has(key)) continue
            seen.add(key)
            edges.push({ s: file.id, t: route.fileId, k: 'api' })
          }
        }
      }
    }

    this.edges = edges
    this.rebuildPackageEdges()
    // File graph changed → the symbol graph (which folds in these import
    // edges for call resolution) is now stale; rebuild lazily on next request.
    this._symbolGraphStale = true
  }

  // ── Layer-2: symbol / function-call graph ────────────────────────
  // Build the function/method-level graph from the current file set + import
  // edges. fileImports (caller → imported files) lets call resolution prefer
  // a method in a file the caller actually imports. Async because tree-sitter
  // parsers init a WASM grammar on first use. See docs/SYMBOL-MODE-PLAN.md.
  async buildSymbolGraph() {
    registerSymbolParsers()
    const entries = []
    for (const f of this.files.values()) {
      entries.push({ id: f.id, absPath: f.absPath, ext: f.ext })
    }
    const fileImports = new Map()
    const fileReexports = new Map()   // barrel `export * from` — for re-export chain resolution
    for (const e of this.edges) {
      if (!fileImports.has(e.s)) fileImports.set(e.s, new Set())
      fileImports.get(e.s).add(e.t)
      if (e.k === 'reexport') {
        if (!fileReexports.has(e.s)) fileReexports.set(e.s, new Set())
        fileReexports.get(e.s).add(e.t)
      }
    }
    const g = new SymbolGraph()
    await g.build(entries, fileImports, { fileReexports })
    this.symbolGraph = g
    this._symbolGraphStale = false
    return g
  }

  // Optional sub-engine enrichment. The fast AST engine (build above) resolves
  // ~80% of static calls across all languages; registered per-language
  // sub-engines (e.g. the TS type-checker block) union in the rest that need
  // real type resolution (generics/field-chains). Lazy + isolated: the host
  // calls this AFTER build, ideally in the background (the TS block is ~1.5-2s
  // for a few-hundred-file repo). No-op if no sub-engine is available, and it
  // never touches the build path — pure post-pass on the existing graph.
  enrichSymbolGraph() {
    if (!this.symbolGraph) return null
    try {
      const files = []
      for (const f of this.files.values()) if (f.absPath) files.push(f.absPath)
      return enrichSubengines(this.symbolGraph, { files, rootDir: this.root })
    } catch (e) { if (process.env.CS_DBG) console.error('enrich err', e && e.stack); return null }
  }

  // Lazy accessor. Coalesces concurrent callers onto one in-flight build so a
  // burst of /symbol/* requests doesn't trigger N parallel scans.
  async getSymbolGraph() {
    if (this.symbolGraph && !this._symbolGraphStale) return this.symbolGraph
    if (!this._symbolGraphBuilding) {
      this._symbolGraphBuilding = this.buildSymbolGraph()
        .finally(() => { this._symbolGraphBuilding = null })
    }
    await this._symbolGraphBuilding
    return this.symbolGraph
  }

  // Aggregate file-level edges into package-level edges. A single edge
  // between two packages can correspond to many file edges — we keep
  // a count so the UI can size them by weight.
  rebuildPackageEdges() {
    if (!this.monorepo?.packages?.length) { this.pkgEdges = []; return }
    const counts = new Map()  // key: "src→dst" → { s, t, count, kinds: Set }
    for (const e of this.edges) {
      const sf = this.files.get(e.s)
      const tf = this.files.get(e.t)
      if (!sf || !tf) continue
      const sp = sf.pkg, tp = tf.pkg
      if (!sp || !tp || sp === tp) continue
      const key = sp + '→' + tp
      const c = counts.get(key)
      if (c) { c.count++; c.kinds.add(e.k) }
      else counts.set(key, { s: sp, t: tp, count: 1, kinds: new Set([e.k]) })
    }
    this.pkgEdges = [...counts.values()].map((e) => ({
      s: e.s, t: e.t, count: e.count, kinds: [...e.kinds],
    })).sort((a, b) => b.count - a.count)
  }
}
