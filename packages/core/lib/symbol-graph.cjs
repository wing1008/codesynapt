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

// Common builtin / inherited / stdlib method names. When a call's receiver
// type is unknown, a bare `.add()` / `.resolve()` / `.save()` is almost
// never a call to a user-defined *module-level* function that merely shares
// the name — it's a method on a value, a Promise, an EventEmitter, a stdlib
// object. The old allowAny path linked these to unrelated same-named symbols
// across files, sending AI down false trails. We refuse to guess on them.
// See docs/SYMBOL-MODE-PLAN.md §5–6. List intentionally conservative; a real
// imported call still resolves via the same-file / imported / qualified
// paths above this fallback.
const BUILTIN_NAMES = new Set([
  'resolve', 'reject', 'emit', 'on', 'off', 'once', 'add', 'remove', 'delete',
  'has', 'get', 'set', 'clear', 'push', 'pop', 'shift', 'unshift', 'slice',
  'splice', 'map', 'filter', 'reduce', 'foreach', 'find', 'join', 'split',
  'replace', 'match', 'test', 'log', 'warn', 'error', 'info', 'debug', 'write',
  'read', 'close', 'open', 'end', 'start', 'stop', 'run', 'init', 'setup',
  'destroy', 'connect', 'send', 'next', 'then', 'catch', 'append', 'prepend',
  'save', 'load', 'update', 'create', 'show', 'hide', 'flush', 'data',
  'tostring', 'valueof', 'keys', 'values', 'entries', 'includes', 'indexof',
  'trim', 'concat', 'flat', 'sort', 'reverse', 'call', 'apply', 'bind',
  // String / Object builtins that collided with same-named user helpers on
  // member calls (zod precision audit: Object.defineProperty, str.startsWith…).
  // Deliberately NOT included: parse / stringify / validate / format — those
  // are very commonly USER methods (e.g. zod's schema.parse()), so blocking
  // them would cost real recall.
  'defineproperty', 'getownpropertydescriptor', 'getownpropertynames',
  'getprototypeof', 'setprototypeof', 'freeze', 'seal', 'preventextensions',
  'startswith', 'endswith', 'normalize', 'tolowercase', 'touppercase',
  'padstart', 'padend', 'repeat', 'charat', 'charcodeat', 'codepointat',
  'substring', 'substr', 'lastindexof', 'tofixed',
])

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
    // Adjacency for fast callers/callees lookup. Holds EVERY edge kind
    // (call / extends / implements / ref / type-ref / jsx-ref) — used by
    // callersOf/calleesOf and the structural blast radius.
    this.outAdj = new Map()     // symbolId → Set<targetId>
    this.inAdj  = new Map()     // symbolId → Set<sourceId>
    // Call-ONLY adjacency. Reachability (dead-code detection) must walk the
    // *call* graph, not structural edges: a `type-ref`/`extends`/`ref` to a
    // symbol does not mean it is invoked, so it must not keep dead code alive.
    // Kept as a separate index so callersOf/calleesOf semantics are unchanged.
    this.callOut = new Map()    // symbolId → Set<calleeId>   (kind === 'call')
    this.callIn  = new Map()    // symbolId → Set<callerId>   (kind === 'call')
    this.extendsOut = new Map() // classId → Set<baseId>      (extends/implements)
    // Dedup guard for the raw edge log: (source␞target␞kind) seen-set so a
    // symbol called from two sites (foo() on line 5 AND line 9) yields ONE
    // edge, matching the deduped adjacency. Without this edgeCount over-counts
    // call sites while the Set-based adjacency collapses them — divergence.
    this._edgeKeys = new Set()
    // File-mode imports — fed in from the host (scanner.edges). Lets
    // call resolution disambiguate same-name symbols across files
    // by preferring targets in files the caller actually imports.
    this.fileImports = new Map() // fileId → Set<importedFileId>
    this.fileReexports = new Map() // fileId → Set<file it re-exports from (barrel `export * from`)>
    this._reexportReach = new Map() // fileId → expanded import+reexport reachable set (cache)
    this.builtAt  = 0
    this.fileCount = 0
    this.scanMs = 0
    // Honest signal: calls we saw a candidate for but declined to resolve
    // (builtin/common name, or ambiguous across >1 production file). Surfaced
    // in stats() so "unresolved" reads as data, not a silent drop.
    this.unresolvedAmbiguous = 0
    // Honest signal #2: parser outcomes per file, so a broken-language /
    // crashed-parser file is distinguishable from a legitimately symbol-less
    // one. parseFailures = files whose parser THREW (extractSymbols or
    // extractReferences raised) — those are swallowed to [] and would
    // otherwise be invisible. emptyFiles = files a parser handled without
    // throwing but that produced 0 symbols (tree-sitter is error-tolerant and
    // rarely throws, so a silently-degraded grammar shows up here, not in
    // parseFailures). Surfaced in stats().
    this.parseFailures = 0
    this.emptyFiles = 0
  }

  clear() {
    this.nodes.clear()
    this.edges.length = 0
    this.byFile.clear()
    this.byName.clear()
    this.outAdj.clear()
    this.extendsOut.clear()
    this.inAdj.clear()
    this.callOut.clear()
    this.callIn.clear()
    this._edgeKeys.clear()
    this.fileImports.clear()
    this.fileReexports.clear()
    this._reexportReach.clear()
    this.builtAt = 0
    this.fileCount = 0
    this.scanMs = 0
    this.unresolvedAmbiguous = 0
    this.parseFailures = 0
    this.emptyFiles = 0
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
  // Files reachable from `fromFileId`'s imports, FOLLOWING barrel re-export
  // chains (`export * from './x'`). Lets `ns.fn()` (ns = `import * as ns from
  // './index'`) resolve `fn` to the real declaration that index.ts only
  // re-exports. Cached per caller.
  _importReachable(fromFileId) {
    let cached = this._reexportReach.get(fromFileId)
    if (cached) return cached
    const out = new Set()
    const direct = this.fileImports.get(fromFileId)
    if (direct) {
      const queue = [...direct]
      while (queue.length) {
        const f = queue.shift()
        if (out.has(f)) continue
        out.add(f)
        const rx = this.fileReexports.get(f)
        if (rx) for (const t of rx) if (!out.has(t)) queue.push(t)
      }
    }
    this._reexportReach.set(fromFileId, out)
    return out
  }

  resolveCall(fromFileId, name, { allowAny = false, qualifiedOnly = false, memberCall = false, importedOnly = false } = {}) {
    if (!name) return null
    // Untyped member call `obj.foo()` where foo is a builtin / common method
    // name (.add/.get/.map/.then…): never a call to a user free function of
    // that name. Reject before the same-file/imported lookup (those run
    // before the allowAny builtin filter and would otherwise grab a same-file
    // `add` for `visited.add()` — B-2 / the JS-recall measurement). Bare
    // calls `foo()` are unaffected (memberCall=false).
    if (memberCall && BUILTIN_NAMES.has((name.split('.').pop() || name).toLowerCase())) {
      this.unresolvedAmbiguous++
      return null
    }
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
      // Class-hierarchy (MRO) walk: `Sub.method` with no direct match — the
      // method is inherited. Follow extends/implements edges to the bases and
      // try `Base.method`. (Flask.register_blueprint → App.register_blueprint.)
      const dot = name.lastIndexOf('.')
      if (dot > 0) {
        const typeName = name.slice(0, dot)
        const inh = this._qualifiedViaHierarchy(typeName, name.slice(dot + 1), new Set([typeName.toLowerCase()]))
        if (inh) return inh
      }
      // A typed member call (`Type.method`) with no exact qualifiedName
      // match must NOT degrade to a bare-name guess — that is how
      // `visited.add()` ('Set.add' → no match → bare 'add') mis-linked to
      // an unrelated same-file `add` (B-2). Callers that know the receiver
      // type pass qualifiedOnly so "type known, method not found" stays
      // empty rather than wrong.
      if (qualifiedOnly) return null
      // Otherwise fall back to the bare method name through the regular
      // path below.
      name = tail
    }
    const set = this.byName.get(name.toLowerCase())
    if (!set || !set.size) return null
    let sameFile = null, imported = null
    // Count *production* candidates (not aux: scripts/, test/, build/…).
    // The tightened allowAny fallback resolves only when exactly one
    // production symbol bears the name — more than one is ambiguous and we
    // refuse to guess (see docs/SYMBOL-MODE-PLAN.md §5).
    let prodOne = null, prodCount = 0
    // importedOnly follows barrel re-export chains so `ns.fn()` resolves to the
    // file that actually declares fn, not just the directly-imported barrel.
    const importsOf = importedOnly ? this._importReachable(fromFileId) : this.fileImports.get(fromFileId)
    for (const id of set) {
      const node = this.nodes.get(id)
      if (!node) continue
      // Exact-case match. byName is lowercased (so search/findByName is
      // case-insensitive), but call RESOLUTION must respect case — every
      // language we parse is case-sensitive. Without this, a call to the
      // class `Request` (urllib) folds onto a user method `request`, a
      // constructor `Transformer()` onto a function `transformer`, etc.
      // — phantom edges to same-spelled-different-case symbols (B-2).
      if (node.name !== name) continue
      // A bare call `foo()` cannot target a METHOD (`Class.foo` needs a
      // receiver). Skipping same-file methods lets a method body's `dumps()`
      // (calling the IMPORTED free `dumps`) resolve to the import instead of
      // self-shadowing to the enclosing method.
      if (!memberCall && node.qualifiedName && node.qualifiedName.includes('.') && node.qualifiedName !== node.name) continue
      // importedOnly (a namespace/default-import member call `ns.fn()`): the
      // target is in the IMPORTED module, never same-file — don't break on a
      // same-file match (that was the `ns.fn()` → same-file phantom), keep
      // scanning for the imported one.
      if (node.file === fromFileId) { sameFile = node; if (!importedOnly) break }
      if (!imported && importsOf && importsOf.has(node.file)) imported = node
      if (!isAuxPath(node.file)) { prodCount++; if (!prodOne) prodOne = node }
    }
    if (sameFile && !importedOnly) return sameFile
    if (imported) return imported
    if (!allowAny) return null
    // Tightened fallback. The old code returned ANY same-named symbol here,
    // which mis-linked `.add()`/`.resolve()` method calls on unknown
    // receivers to unrelated module functions. Now: never guess a builtin /
    // common method name by bare name, and leave an ambiguous name (>1
    // production candidate) unresolved rather than mis-link. Phase-0 spike:
    // suspect cross-file edges −81% (JS) / −54% (Python), <1% real loss.
    if (BUILTIN_NAMES.has(name.toLowerCase())) { this.unresolvedAmbiguous++; return null }
    if (prodCount === 1) return prodOne
    this.unresolvedAmbiguous++
    return null
  }

  // Walk a class's extends/implements chain looking for `Base.method`. Bounded
  // by `seen` (cycle/diamond guard). Returns the inherited method node or null.
  _qualifiedViaHierarchy(typeName, method, seen) {
    const clsSet = this.byName.get(typeName.toLowerCase())
    if (!clsSet) return null
    const mSet = this.byName.get(method.toLowerCase())
    for (const cid of clsSet) {
      const cnode = this.nodes.get(cid)
      if (!cnode || cnode.name !== typeName) continue
      const bases = this.extendsOut.get(cid)
      if (!bases) continue
      for (const bid of bases) {
        const bnode = this.nodes.get(bid)
        if (!bnode || seen.has(bnode.name.toLowerCase())) continue
        seen.add(bnode.name.toLowerCase())
        const q = `${bnode.name}.${method}`
        if (mSet) for (const id of mSet) { const n = this.nodes.get(id); if (n?.qualifiedName === q) return n }
        const up = this._qualifiedViaHierarchy(bnode.name, method, seen)
        if (up) return up
      }
    }
    return null
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

  // Record one symbol→symbol relationship. Returns true if the edge was
  // newly added, false if it was a duplicate or referenced an unknown symbol.
  //
  // Integrity contract (relied on by stats/blast/reachability):
  //   • Endpoint guard — both source and target must be real nodes. A
  //     synthetic/foreign id (e.g. a `route:GET /x` handler the parser emitted
  //     before its node existed, or a stale id) must NOT leak into adjacency;
  //     otherwise blast counts a phantom (byDepth inflates past totalImpacted)
  //     and reachability walks into nowhere.
  //   • Dedup — the same (source, target, kind) triple is recorded once. The
  //     adjacency Sets already collapse duplicate pairs; we collapse the raw
  //     `edges` log to match so edgeCount === unique adjacency relationships
  //     (a function called from two lines is ONE call edge, not two).
  addEdge(edge) {
    const { source, target, kind } = edge
    // Endpoint guard: never index an edge that dangles off a non-existent
    // symbol. (build() already pre-filters, but addEdge is public API and the
    // guard is what makes the phantom-id class of bug structurally impossible.)
    if (!this.nodes.has(source) || !this.nodes.has(target)) return false
    const key = `${source}␞${target}␞${kind}`
    if (this._edgeKeys.has(key)) return false
    this._edgeKeys.add(key)
    this.edges.push(edge)
    // Caller/callee adjacency is the CALL graph only. extends / implements /
    // ref / jsx-ref / type-ref are real relationships kept in `this.edges`
    // (and surfaced via byEdgeKind), but they are NOT calls — letting them
    // into inAdj/outAdj inflated callers/callees/blast/internalHubs and the
    // symbolNodeView counts (a subclass counted as a "caller" of its base, a
    // type annotation as a "callee"). Likewise synthetic sources that were
    // never addNode'd — e.g. the desktop's `route:GET /x` route→handler
    // edges (source is a route string, not a symbol) — must not inflate a
    // handler's caller count past what callersOf() (which drops non-nodes)
    // can return. So: only call edges between two real nodes build adjacency.
    //
    // A structural (non-call) edge is still a real, newly-recorded
    // relationship (it lives in `this.edges`/`_edgeKeys` and is surfaced via
    // byEdgeKind) — we just don't let it inflate the call adjacency. Per the
    // method contract we report it as newly added (return true) but build no
    // adjacency for it.
    // Class-hierarchy index (extends/implements) — lets resolveCall walk from a
    // class to its bases/interfaces so an inherited method `Sub.m()` resolves to
    // `Base.m`. Kept separate from call adjacency (it is not a call).
    if (kind === 'extends' || kind === 'implements') {
      if (!this.extendsOut.has(source)) this.extendsOut.set(source, new Set())
      this.extendsOut.get(source).add(target)
    }
    if (kind !== 'call') return true
    if (!this.nodes.has(source) || !this.nodes.has(target)) return true
    // inAdj/outAdj back callersOf()/calleesOf() (call graph only, per above).
    if (!this.outAdj.has(source)) this.outAdj.set(source, new Set())
    this.outAdj.get(source).add(target)
    if (!this.inAdj.has(target)) this.inAdj.set(target, new Set())
    this.inAdj.get(target).add(source)
    // callOut/callIn are the dedicated call-only adjacency feeding
    // reachability (call graph, not structural). With the kind === 'call'
    // guard above these now mirror inAdj/outAdj, but they are kept as a
    // distinct pair so reachability stays correct even if inAdj/outAdj are
    // ever widened to structural edges again.
    if (!this.callOut.has(source)) this.callOut.set(source, new Set())
    this.callOut.get(source).add(target)
    if (!this.callIn.has(target)) this.callIn.set(target, new Set())
    this.callIn.get(target).add(source)
    return true
  }

  // Index every symbol as a 384-d MiniLM embedding so /symbol/explore
  // can rerank by semantic similarity (auth ↔ login synonyms etc).
  // Runs in batches of 32 to keep peak memory bounded; the caller
  // typically fires this off without awaiting so the build finishes
  // quickly and the embeddings populate in the background.
  //
  // Each symbol gets a `_embedding` Float64-style Array assigned in
  // place. Falls back silently if `embedBatchFn` returns null (e.g.
  // the @xenova/transformers dep isn't installed).
  async embedAllSymbols(embedBatchFn, { chunkSize = 32 } = {}) {
    if (this._embedded || this._embedding) return  // idempotent
    this._embedding = true
    const ids = []
    const texts = []
    for (const n of this.nodes.values()) {
      ids.push(n.id)
      // Keep text short — MiniLM is a 128-token model, longer input
      // gets truncated. name + qn + kind + first 100 chars of doc is
      // enough signal to distinguish auth-shaped from db-shaped.
      const doc = (n.doc || '').slice(0, 100)
      texts.push(`${n.name || ''} ${n.qualifiedName || ''} ${n.kind || ''} ${doc}`.trim())
    }
    const start = Date.now()
    let done = 0
    for (let i = 0; i < texts.length; i += chunkSize) {
      const batch = texts.slice(i, i + chunkSize)
      const vecs = await embedBatchFn(batch)
      if (!vecs) {              // embed failed — give up cleanly
        this._embedding = false
        return false
      }
      for (let j = 0; j < vecs.length; j++) {
        const node = this.nodes.get(ids[i + j])
        if (node) node._embedding = vecs[j]
      }
      done += vecs.length
      // Yield to the event loop between batches so concurrent HTTP
      // requests (the desktop UI, the bench harness, MCP tools)
      // aren't starved while a multi-second indexing pass runs.
      // ONNX inference inside embedBatchFn pegs the main thread, so
      // a `setImmediate` after each batch is the difference between
      // "queries time out" and "queries respond within 50 ms".
      await new Promise((r) => setImmediate(r))
    }
    this._embedded = true
    this._embedding = false
    this.embedMs = Date.now() - start
    return true
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
    // BFS over the CALL graph only. A symbol reached solely by a structural
    // edge (extends/implements/ref/type-ref/jsx-ref) is referenced, not
    // *invoked* — counting those as reachable would mask genuinely dead code
    // (the whole point of this pass). callOut is the call-only adjacency.
    //
    // Use a head pointer instead of Array.shift(): shift() is O(n) (it
    // re-indexes the whole array), so the old loop was O(V²) on a long call
    // chain. Advancing `head` is O(1); we never mutate the array length until
    // the end, so the walk is O(V+E).
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]
      const callees = this.callOut.get(id)
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
    if (options.fileReexports) this.fileReexports = options.fileReexports
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
      let parseThrew = false
      try {
        const ret = parser.extractSymbols(content, entry.id)
        symbols = (await ret) || []
      } catch (e) { symbols = []; parseThrew = true; this.parseFailures++ }
      // A file the parser handled but that yielded nothing is tracked
      // separately — see constructor. Distinguishes "no symbols" (legit
      // data) from "parser crashed" (parseFailures) AND from a silently
      // degraded tree-sitter grammar (emptyFiles, no throw).
      if (!parseThrew && symbols.length === 0) this.emptyFiles++
      // Lazy split per file — used by the deprecated probe below.
      // Most files have no deprecated marker, so the .test() short-
      // circuits and we never pay the split cost.
      let _lines = null
      const lines = () => _lines ??= content.split('\n')
      const DEPRECATED_RE = /@?deprecated\b|todo\s*[:_-]?\s*remove|fixme\s*[:_-]?\s*remove/i
      // Stricter pattern — used ONLY against the file header so
      // common code-body words like "wip"/"work in progress" don't
      // false-positive entire files. The body-level probe sticks to
      // the precise @deprecated / TODO remove patterns above.
      const HEAD_DEPRECATED_RE = /@?deprecated\b|do\s+not\s+use\b|work\s+in\s+progress\b|\bwip[\s:]/i
      const fileHasDeprecated = DEPRECATED_RE.test(content)
      // File-level deprecated marker — if the first 5 lines flag the
      // whole file as deprecated (common pattern: file header with
      // `// @deprecated — moved to …`), tag every symbol the file
      // exports. Avoids the case where the file header is far above
      // any declaration's 5-line probe window. Header check uses
      // HEAD_DEPRECATED_RE so a body-only deprecated marker can't
      // promote a single-symbol file to "everything deprecated".
      let fileLevelDeprecated = false
      const head = lines().slice(0, 5).join('\n')
      if (HEAD_DEPRECATED_RE.test(head)) fileLevelDeprecated = true
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
      } catch (e) { refs = []; this.parseFailures++ }
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
      unresolvedAmbiguous: this.unresolvedAmbiguous,  // calls we declined to guess
      parseFailures: this.parseFailures,   // files whose parser threw (swallowed to [])
      emptyFiles: this.emptyFiles,         // files parsed OK but with 0 symbols
    }
  }
}

module.exports = { SymbolGraph, registerParser, extFor, PARSERS }
