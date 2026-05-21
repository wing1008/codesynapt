import fs from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import { EventEmitter } from 'events'
import { parseFile, resolveImport, normalizeUrlPath, routePathToRegex } from './parser.js'
import { detectMonorepo, packageForFile } from './monorepo.js'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.vercel',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'venv', '.venv', 'env',
  'target', '.cache', '.parcel-cache',
  '.idea', '.vscode', '.DS_Store',
  'coverage', '.nyc_output',
  '.filegraph3d',
])

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
    this.watcher = null
    this._pendingSnapshot = null
    this.gitignoreRules = loadGitignoreRules(root)
    // Detect workspace structure once at construction. Cheap (one
    // directory walk capped at depth 6). Result feeds package-level
    // grouping in the UI and the /packages API for AI agents.
    try { this.monorepo = detectMonorepo(root) }
    catch (e) { this.monorepo = { kind: 'none', packages: [], rootIsPackage: false } }
  }

  toId(absPath) {
    return path.relative(this.root, absPath).split(path.sep).join('/')
  }

  shouldTrack(absPath) {
    const ext = path.extname(absPath).slice(1).toLowerCase()
    return TRACKED_EXT.has(ext)
  }

  start() {
    const root = this.root
    const rules = this.gitignoreRules
    this.watcher = chokidar.watch(root, {
      ignored: (p, stats) => {
        const rel = path.relative(root, p)
        if (!rel) return false
        const segments = rel.split(path.sep)
        if (segments.some((s) => IGNORE_DIRS.has(s))) return true
        // .gitignore matching uses '/'-joined relative path
        const relPosix = segments.join('/')
        const isDir = stats?.isDirectory() ?? false
        if (matchedByRules(relPosix, isDir, rules)) return true
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
      .on('ready', () => {
        initial = false
        this.emit('scan-progress', { count: scanCount, done: true })
        this.rebuildEdges()
        this.emitSnapshot()
        this.emit('stats', { initialScanComplete: true, fileCount: this.files.size })
      })
      .on('error', (e) => console.error('watcher error:', e.message))
  }

  stop() {
    if (this.watcher) this.watcher.close()
  }

  snapshot() {
    return {
      files: [...this.files.values()].map((f) => ({
        id: f.id, ext: f.ext, loc: f.loc, size: f.size,
        importCount: f.imports.length,
        pkg: f.pkg || null,
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

  async handleAdd(absPath, initial) {
    if (!this.shouldTrack(absPath)) return
    const file = this.parseOne(absPath)
    if (!file) return
    this.files.set(file.id, file)
    if (!initial) {
      this.rebuildEdges()
      this.emitSnapshot()
    }
  }

  async handleChange(absPath) {
    if (!this.shouldTrack(absPath)) return
    const file = this.parseOne(absPath)
    if (!file) return
    this.files.set(file.id, file)
    this.emit('file-changed', { id: file.id, absPath })
    this.rebuildEdges()
    this.emitSnapshot()
  }

  handleRemove(absPath) {
    const id = this.toId(absPath)
    if (this.files.delete(id)) {
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
    try { content = fs.readFileSync(absPath, 'utf8') } catch {}
    const loc = content ? content.split('\n').length : 0
    const { imports, routes, apiCalls, externalUrls, dynamicPatterns } = parseFile(absPath, content, ext)
    // Tag the file with its owning package (null if outside all
    // packages or no monorepo). Used by UI for package-level grouping
    // and by API endpoints for package-level slicing.
    const pkg = this.monorepo?.packages?.length
      ? packageForFile(id, this.monorepo.packages)
      : null
    return {
      id, ext, loc, size: stat.size, imports, absPath,
      routes:           routes           || [],
      apiCalls:         apiCalls         || [],
      externalUrls:     externalUrls     || [],
      dynamicPatterns:  dynamicPatterns  || [],
      pkg,
      lastSeenAt:       Date.now(),
    }
  }

  rebuildEdges() {
    const edges = []
    const seen = new Set()
    const idSet = new Set(this.files.keys())

    // 1) Static import edges (file→file dependency)
    for (const file of this.files.values()) {
      for (const imp of file.imports) {
        const target = resolveImport(file.absPath, imp.spec, this.root, idSet, file.ext)
        if (target && target !== file.id) {
          const key = `${file.id}→${target}:${imp.kind}`
          if (seen.has(key)) continue
          seen.add(key)
          edges.push({ s: file.id, t: target, k: imp.kind })
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
