// CodeSynapt symbol mode — in-memory symbol graph that lives alongside
// the file-graph Scanner. Built lazily; first /symbol/* request triggers
// the scan against the currently-loaded file set.
//
// Data model and design notes live in docs/SYMBOL-MODE-PLAN.md.

'use strict'

const fs = require('fs')
const path = require('path')

// Parser registry — extended per-language in Stage 1 / Stage 2.
// Each entry: { extractSymbols(content, fileId) → SymbolNode[],
//               extractReferences(content, fileId, index) → SymbolEdge[] }
const PARSERS = Object.create(null)

// Heuristic: a file at one of these path segments isn't usually called
// from production code. Affects resolveCall — when a name has matches
// in both production and auxiliary paths, production wins. Doesn't
// hide aux symbols, just deprioritises them as call targets.
const AUX_PATH_SEGMENTS = new Set([
  'scripts', 'script', 'tools', 'tool',
  'tests', 'test', '__tests__', 'spec', 'specs',
  'examples', 'example', 'samples', 'sample', 'demo', 'demos',
  'build', 'dist', 'out', 'bin',
  'docs', 'doc',
  'fixtures', 'fixture',
  'benchmarks', 'benchmark', 'bench',
  // Vendored / prebuilt bundles that ship inside source dirs
  // (Next.js's packages/next/src/compiled/* is the canonical case).
  // file-mode ignores top-level node_modules, but vendored copies
  // inside src/ slip through; deprioritise them as call targets.
  'compiled', 'vendored', 'vendor',
])
function isAuxPath(fileId) {
  if (!fileId) return false
  // Check the first path segment + any segment whose name matches.
  // `tests/foo.ts`, `packages/x/scripts/y.ts`, `build/x.js` all match.
  const parts = fileId.split('/')
  return parts.some((p) => AUX_PATH_SEGMENTS.has(p))
}

function registerParser(extOrExts, parser) {
  const exts = Array.isArray(extOrExts) ? extOrExts : [extOrExts]
  for (const e of exts) PARSERS[e] = parser
}

function extFor(filePath) {
  const e = path.extname(filePath).slice(1).toLowerCase()
  return e
}

class SymbolGraph {
  constructor() {
    this.nodes = new Map()      // id → SymbolNode
    this.edges = []             // SymbolEdge[]
    this.byFile = new Map()     // fileId → Set<symbolId>
    this.byName = new Map()     // lowercased name → Set<symbolId>
    // Adjacency for fast callers/callees lookup.
    this.outAdj = new Map()     // symbolId → Set<targetId>
    this.inAdj  = new Map()     // symbolId → Set<sourceId>
    // File-mode imports — fed in from the host (scanner.edges). Lets
    // call resolution disambiguate same-name symbols across files
    // by preferring targets in files the caller actually imports.
    this.fileImports = new Map() // fileId → Set<importedFileId>
    this.builtAt  = 0
    this.fileCount = 0
    this.scanMs = 0
  }

  clear() {
    this.nodes.clear()
    this.edges.length = 0
    this.byFile.clear()
    this.byName.clear()
    this.outAdj.clear()
    this.inAdj.clear()
    this.fileImports.clear()
    this.builtAt = 0
    this.fileCount = 0
    this.scanMs = 0
  }

  // Best symbol match for `name` called from `fromFileId`. Preference:
  //   1) same file
  //   2) a file directly imported by `fromFileId`
  // We deliberately *do not* fall back to "any file with that name"
  // — that would link a local `request` variable in utils.ts to an
  // unrelated `request()` function in some other file just because
  // they share a name. AI agents downstream would get noise edges
  // and follow false trails. Conservative beats clever here.
  // If the host wants the loose match, set `allowAny: true`.
  resolveCall(fromFileId, name, { allowAny = false } = {}) {
    if (!name) return null
    // Type-aware lookup: `User.method` matches a symbol whose
    // qualifiedName === 'User.method' exactly. Higher priority than
    // name-only matches because it narrows from "any method named X"
    // to "X defined on this class".
    if (name.includes('.')) {
      const tail = name.split('.').pop()
      const set = this.byName.get(tail.toLowerCase())
      if (set) {
        for (const id of set) {
          const node = this.nodes.get(id)
          if (node?.qualifiedName === name) return node
        }
      }
      // No qualifiedName match — fall back to the bare method name
      // through the regular path below.
      name = tail
    }
    const set = this.byName.get(name.toLowerCase())
    if (!set || !set.size) return null
    let sameFile = null, imported = null
    // Two-bucket fallback: prefer a production-path candidate
    // over an auxiliary-path one (scripts/, test/, build/, examples/
    // etc.) when nothing imported matches. Stops the case where
    // production code's call to `fetch(...)` lands on a helper named
    // `fetch` defined in scripts/.
    let prodAny = null, auxAny = null
    const callerIsAux = isAuxPath(fromFileId)
    const importsOf = this.fileImports.get(fromFileId)
    for (const id of set) {
      const node = this.nodes.get(id)
      if (!node) continue
      if (node.file === fromFileId) { sameFile = node; break }
      if (!imported && importsOf && importsOf.has(node.file)) imported = node
      if (isAuxPath(node.file)) {
        if (!auxAny) auxAny = node
      } else {
        if (!prodAny) prodAny = node
      }
    }
    if (sameFile) return sameFile
    if (imported) return imported
    if (!allowAny) return null
    // Prefer production over auxiliary unless the caller itself is
    // already aux (in which case linking back into scripts/ is fine).
    if (callerIsAux) return prodAny || auxAny
    return prodAny || auxAny
  }

  addNode(node) {
    this.nodes.set(node.id, node)
    if (!this.byFile.has(node.file)) this.byFile.set(node.file, new Set())
    this.byFile.get(node.file).add(node.id)
    const key = (node.name || '').toLowerCase()
    if (key) {
      if (!this.byName.has(key)) this.byName.set(key, new Set())
      this.byName.get(key).add(node.id)
    }
  }

  addEdge(edge) {
    this.edges.push(edge)
    if (!this.outAdj.has(edge.source)) this.outAdj.set(edge.source, new Set())
    this.outAdj.get(edge.source).add(edge.target)
    if (!this.inAdj.has(edge.target)) this.inAdj.set(edge.target, new Set())
    this.inAdj.get(edge.target).add(edge.source)
  }

  // BFS along outAdj from every symbol the host considers a public
  // entry (main, route handler, exported CLI bin, etc). Symbols not
  // reachable from any entry are likely dead code. The host passes
  // its own isEntry predicate so this module stays parser-agnostic.
  //
  // Important caveat documented in the explore code: our entry
  // heuristic (name + path patterns) misses some real entries
  // (React components, framework callbacks, decorator-bound
  // handlers), so a `reachable: false` flag is a *hint*, not a
  // verdict — we expose it as data and let the ranker / UI choose
  // how strongly to weight it.
  computeReachability(isEntry) {
    const reachable = new Set()
    const queue = []
    for (const node of this.nodes.values()) {
      try {
        if (isEntry(node)) { reachable.add(node.id); queue.push(node.id) }
      } catch {}
    }
    while (queue.length) {
      const id = queue.shift()
      const callees = this.outAdj.get(id)
      if (!callees) continue
      for (const c of callees) {
        if (!reachable.has(c)) { reachable.add(c); queue.push(c) }
      }
    }
    this._reachable = reachable
    return reachable
  }

  callersOf(id) {
    const set = this.inAdj.get(id)
    if (!set) return []
    return [...set].map((sid) => this.nodes.get(sid)).filter(Boolean)
  }
  calleesOf(id) {
    const set = this.outAdj.get(id)
    if (!set) return []
    return [...set].map((tid) => this.nodes.get(tid)).filter(Boolean)
  }
  findByName(query, limit = 50) {
    const q = (query || '').toLowerCase()
    if (!q) return []
    const matches = []
    for (const [name, ids] of this.byName) {
      if (name.includes(q)) {
        for (const id of ids) {
          const n = this.nodes.get(id)
          if (n) matches.push(n)
          if (matches.length >= limit) return matches
        }
      }
    }
    return matches
  }

  // ─── Scanning ──────────────────────────────────────────────────
  // `fileEntries` is an iterable of { id, absPath, ext } — typically
  // derived from the file-mode Scanner's `files` map.
  // `fileImports` (optional) is a Map<fileId, Set<importedFileId>>
  // built from the file-mode edge list; lets resolveCall prefer
  // imported targets.
  async build(fileEntries, fileImports = null, options = {}) {
    const start = Date.now()
    this.clear()
    // Set imports *after* clear so the host-provided map survives.
    if (fileImports) this.fileImports = fileImports
    // Big-repo safety knobs. None of them block — they cap the work
    // so a runaway monorepo (100k+ symbols) doesn't OOM the process.
    const MAX_SYMBOLS = options.maxSymbols
      || parseInt(process.env.CS_MAX_SYMBOLS || '200000', 10)
    const MAX_EDGES = options.maxEdges
      || parseInt(process.env.CS_MAX_EDGES || '1000000', 10)
    const MAX_FILE_BYTES = options.maxFileBytes
      || parseInt(process.env.CS_MAX_FILE_BYTES || '524288', 10)  // 512KB
    let abortedAt = null
    // Pass 1 — symbols. We need every symbol indexed before we can
    // resolve references in pass 2.
    let fileCount = 0
    const fileContents = new Map()    // fileId → content (kept for pass 2)
    for (const entry of fileEntries) {
      if (this.nodes.size >= MAX_SYMBOLS) { abortedAt = 'symbols'; break }
      const parser = PARSERS[entry.ext]
      if (!parser) continue
      let content, fileMtimeMs = 0
      try {
        const stat = fs.statSync(entry.absPath)
        if (stat.size > MAX_FILE_BYTES) continue   // skip giant files (minified bundles, vendored libs)
        content = fs.readFileSync(entry.absPath, 'utf8')
        fileMtimeMs = stat.mtimeMs
      } catch { continue }
      fileContents.set(entry.id, content)
      let symbols
      try {
        const ret = parser.extractSymbols(content, entry.id)
        symbols = (await ret) || []
      } catch (e) { symbols = [] }
      // Lazy split per file — used by the deprecated probe below.
      // Most files have no deprecated marker, so the .test() short-
      // circuits and we never pay the split cost.
      let _lines = null
      const lines = () => _lines ??= content.split('\n')
      const DEPRECATED_RE = /@?deprecated\b|todo\s*[:_-]?\s*remove|fixme\s*[:_-]?\s*remove/i
      const fileHasDeprecated = DEPRECATED_RE.test(content)
      // File-level deprecated marker — if the first 5 lines flag the
      // whole file as deprecated (common pattern: file header with
      // `// @deprecated — moved to …`), tag every symbol the file
      // exports. Avoids the case where the file header is far above
      // any declaration's 5-line probe window.
      let fileLevelDeprecated = false
      if (fileHasDeprecated) {
        const head = lines().slice(0, 5).join('\n')
        fileLevelDeprecated = DEPRECATED_RE.test(head)
      }
      for (const s of symbols) {
        if (this.nodes.size >= MAX_SYMBOLS) { abortedAt = 'symbols'; break }
        // Stamp every symbol with the file's mtime — explore uses it
        // for the `legacy` classification (old + low in-degree). Cost
        // is one extra Map allocation per symbol; the stat call was
        // already happening above.
        s.mtimeMs = fileMtimeMs
        // Deprecated marker — look at the 5 lines directly above the
        // symbol declaration. Cheaper + more precise than fighting
        // babel's export-wrapper leading-comment attachment quirk.
        if (fileLevelDeprecated) {
          s.deprecated = true
        } else if (fileHasDeprecated && s.startLine) {
          const start = Math.max(0, s.startLine - 1 - 5)
          const prelude = lines().slice(start, s.startLine - 1).join('\n')
          if (DEPRECATED_RE.test(prelude)) s.deprecated = true
        }
        this.addNode(s)
      }
      fileCount++
    }
    // Pass 2 — references. Per-file, ask the language parser to find
    // call/extends/implements edges. Parsers consult `this` (the
    // symbol index) to resolve names.
    for (const [fileId, content] of fileContents) {
      if (this.edges.length >= MAX_EDGES) { abortedAt = abortedAt || 'edges'; break }
      const ext = extFor(fileId)
      const parser = PARSERS[ext]
      if (!parser || !parser.extractReferences) continue
      let refs
      try {
        const ret = parser.extractReferences(content, fileId, this)
        refs = (await ret) || []
      } catch (e) { refs = [] }
      for (const r of refs) {
        if (this.edges.length >= MAX_EDGES) { abortedAt = abortedAt || 'edges'; break }
        if (this.nodes.has(r.source) && this.nodes.has(r.target)) {
          this.addEdge(r)
        }
      }
    }
    this.fileCount = fileCount
    this.builtAt = Date.now()
    this.scanMs = this.builtAt - start
    this.abortedAt = abortedAt          // null or 'symbols'/'edges'
    return this.stats()
  }

  stats() {
    const byKind = {}
    for (const n of this.nodes.values()) {
      byKind[n.kind] = (byKind[n.kind] || 0) + 1
    }
    const byEdgeKind = {}
    for (const e of this.edges) {
      byEdgeKind[e.kind] = (byEdgeKind[e.kind] || 0) + 1
    }
    return {
      fileCount: this.fileCount,
      symbolCount: this.nodes.size,
      edgeCount: this.edges.length,
      byKind,
      byEdgeKind,
      scanMs: this.scanMs,
      builtAt: this.builtAt,
      abortedAt: this.abortedAt || null,   // null | 'symbols' | 'edges'
    }
  }
}

module.exports = { SymbolGraph, registerParser, extFor, PARSERS }
