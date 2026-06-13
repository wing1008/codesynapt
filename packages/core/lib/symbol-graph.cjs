// CodeSynapt symbol mode — in-memory symbol graph that lives alongside
// the file-graph Scanner. Built lazily; first /symbol/* request triggers
// the scan against the currently-loaded file set.
//
// Data model and design notes live in docs/SYMBOL-MODE-PLAN.md.

'use strict'

const fs = require('fs')
const path = require('path')

// Decline SAMPLING (which specific calls were declined) is a DIAGNOSTIC, not a
// shipped signal — every /symbol/summary response is consumed by AI agents on a
// token budget, so we never bloat it with samples in production. The compact
// declineReasons COUNTS always ship (they power the honest static-floor footer);
// the per-call samples only collect when CS_DBG is set.
const CS_DECLINE_SAMPLES = !!(process.env.CS_DBG || process.env.CS_DECLINE_SAMPLES)

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

// Coarse language group of a file, by extension. A static call never crosses
// languages, so a candidate (dynamic-dispatch) caller/callee in another language
// is always spurious (insp-004 #50: a JS arrow's candidate callers included a
// Java method and a Python module of the same name).
const _LANG_GROUPS = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyw: 'py', pyi: 'py',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'cpp', c: 'cpp',
}
function langGroupOf(fileId) {
  const ext = (String(fileId).split('.').pop() || '').toLowerCase()
  return _LANG_GROUPS[ext] || ext
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

// Grammars whose web-tree-sitter wasm parser leaks memory at scale and must be
// parsed in a recycled child process. Swift is the known offender (OOMs ~50+
// files); kept as a set so others can be added if they exhibit the same.
const WORKER_GRAMMAR_EXTS = new Set(['swift'])

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
    // Call-graph adjacency for fast callers/callees lookup. Built from
    // kind==='call' edges ONLY (see addEdge) — structural edges (extends /
    // implements / ref / type-ref / jsx-ref) are indexed separately so they
    // can't inflate callers/callees/blast. Backs callersOf()/calleesOf().
    this.outAdj = new Map()     // symbolId → Set<calleeId>
    this.inAdj  = new Map()     // symbolId → Set<callerId>
    // Call-ONLY adjacency. Reachability (dead-code detection) must walk the
    // *call* graph, not structural edges: a `type-ref`/`extends`/`ref` to a
    // symbol does not mean it is invoked, so it must not keep dead code alive.
    // Kept as a separate index so callersOf/calleesOf semantics are unchanged.
    this.callOut = new Map()    // symbolId → Set<calleeId>   (kind === 'call')
    this.callIn  = new Map()    // symbolId → Set<callerId>   (kind === 'call')
    // Dynamic candidate adjacency (kind === 'call-candidate'). Kept SEPARATE
    // from the confident call graph so callers/callees/blast stay precise; the
    // "could be one of these" set is queried on demand via candidate*Of().
    this.candOut = new Map()    // symbolId → Set<candidateCalleeId>
    this.candIn  = new Map()    // symbolId → Set<candidateCallerId>
    // Reference adjacency (kind === 'ref'): a symbol passed as a VALUE — a
    // callback (`arr.map(fn)`), an assignment, an argument — not directly
    // invoked. Kept OUT of the call graph (callers/blast/reachability stay
    // precise) but indexed so a callback-ONLY function isn't misread as
    // "0 callers / dead code". Surfaced via refCallersOf().
    this.refIn = new Map()      // symbolId → Set<referencingSymbolId>
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
    // Renamed/sourced re-exports: fileId → Map<exportedName, {orig, srcSpec}>.
    // Lets a namespace member call `ns.bar()` redirect to the real `_bar` when
    // the module does `export { _bar as bar } from './x'` (alias hides the true
    // name from the byName index).
    this.fileExportAlias = new Map()
    this.builtAt  = 0
    this.fileCount = 0
    this.scanMs = 0
    // Honest signal: calls we saw a candidate for but declined to resolve
    // (builtin/common name, or ambiguous across >1 production file). Surfaced
    // in stats() so "unresolved" reads as data, not a silent drop.
    this.unresolvedAmbiguous = 0
    // Decomposition of unresolvedAmbiguous by decline reason — separates
    // correct stdlib/builtin declines (not real edges) from genuine unresolved
    // user calls (the real static gap). Surfaced in stats().
    this.declineReasons = Object.create(null)
    this.declineSamples = []
    // Zero-silence ledger (user bar #3): call sites whose CALLEE cannot even be
    // named statically — computed members `obj[k]()`, indirect `f()()`, local
    // callbacks `cb()`. These previously produced NO edge and NO counter (proven
    // by fixture: invisible). Now every such site is recorded against its
    // enclosing symbol so accounting/blast can say "this symbol contains N
    // dynamic call sites" instead of silently looking complete.
    this.dynamicSites = new Map()   // symbolId → [{ line, form }]
    // Recall-miss SUSPECTS (roadmap ② auto-discovery): observed edges that
    // LOOK statically resolvable but had neither a call nor a candidate edge.
    // SUSPICION, never verdict (safety rules in design-symbol-completeness.md)
    // — review queue material, no auto-fix, capped.
    this.recallSuspects = []
    this._suspectKeys = new Set()   // dedup — re-observing an edge must not refill the cap
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
    this.refIn.clear()
    this.candOut.clear()
    this.candIn.clear()
    this._edgeKeys.clear()
    this.fileImports.clear()
    this.fileReexports.clear()
    this._reexportReach.clear()
    this._moduleReachCache?.clear()
    this.fileExportAlias.clear()
    this._ctorIdx = null
    this.builtAt = 0
    this.fileCount = 0
    this.scanMs = 0
    this.unresolvedAmbiguous = 0
    this.declineReasons = Object.create(null)
    this.declineSamples = []
    this.dynamicSites.clear()
    this.recallSuspects = []
    this._suspectKeys = new Set()
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

  // Module + everything it re-exports (barrel `export * from`). Used to pin a
  // namespace member call `ns.fn()` to the module `ns` was imported from, so it
  // can never grab a same-named symbol from an UNRELATED import (the
  // `checks.slugify` → `util.slugify` wrong-function bug).
  _moduleReach(moduleFileId) {
    if (!this._moduleReachCache) this._moduleReachCache = new Map()
    const cached = this._moduleReachCache.get(moduleFileId)
    if (cached) return cached
    const out = new Set([moduleFileId])
    const queue = [moduleFileId]
    while (queue.length) {
      const f = queue.shift()
      const rx = this.fileReexports.get(f)
      if (rx) for (const t of rx) if (!out.has(t)) { out.add(t); queue.push(t) }
    }
    this._moduleReachCache.set(moduleFileId, out)
    return out
  }

  // Resolve a relative module specifier to a graph fileId (mirror of the JS
  // parser's resolver, but graph-side for alias chains). TS maps `./x.js`→`x.ts`.
  _resolveSpec(fromFileId, spec) {
    if (!spec || spec[0] !== '.') return null
    const dir = fromFileId.includes('/') ? fromFileId.slice(0, fromFileId.lastIndexOf('/')) : ''
    const stack = []
    for (const p of (dir ? dir.split('/') : []).concat(spec.split('/'))) {
      if (p === '' || p === '.') continue
      if (p === '..') stack.pop()
      else stack.push(p)
    }
    const base = stack.join('/')
    if (this.byFile.has(base)) return base
    const stem = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '')
    for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts',
      '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs']) {
      const c = stem + e
      if (this.byFile.has(c)) return c
    }
    return null
  }

  // Redirect an exported name through a module's rename re-exports to the real
  // declaration: `export { _bar as bar } from './x'` makes `ns.bar` → `_bar` in
  // x. Follows alias chains (bounded). Returns the real node or null.
  _resolveExportAlias(moduleFileId, name, depth) {
    if (depth > 6) return null
    const m = this.fileExportAlias.get(moduleFileId)
    if (!m || !m.has(name)) return null
    const { orig, srcSpec } = m.get(name)
    const srcFile = srcSpec ? this._resolveSpec(moduleFileId, srcSpec) : moduleFileId
    if (srcFile) {
      const deeper = this._resolveExportAlias(srcFile, orig, depth + 1)
      if (deeper) return deeper
    }
    const set = this.byName.get(orig.toLowerCase())
    if (set) {
      // `orig` may be DECLARED in srcFile, or star-re-exported by it (the alias
      // pointed at a barrel). Prefer an exact-file decl, else accept one inside
      // srcFile's re-export reach (orig is the canonical name, ~always unique).
      const reach = srcFile ? this._moduleReach(srcFile) : null
      let inReach = null, any = null
      for (const id of set) {
        const n = this.nodes.get(id)
        if (!n || n.name !== orig) continue
        if (srcFile && n.file === srcFile) return n
        if (reach && reach.has(n.file) && !inReach) inReach = n
        if (!any) any = n
      }
      if (inReach) return inReach
      if (!srcFile && any) return any
    }
    return null
  }

  // Record a statically-unnameable call site against its enclosing symbol.
  // forms: 'computed-member' (obj[k]()), 'indirect' (f()(), (expr)()),
  // 'local-callback' (cb() where cb is a param/local non-function binding).
  recordDynamicSite(symbolId, line, form) {
    if (!symbolId) return
    let list = this.dynamicSites.get(symbolId)
    if (!list) { list = []; this.dynamicSites.set(symbolId, list) }
    if (list.length < 64) list.push({ line: line || 0, form: form || 'unknown' })
  }

  // Record a declined call resolution under a labeled reason. The sum of
  // declineReasons always equals unresolvedAmbiguous — it just tells us WHICH
  // declines are correct (stdlib/builtin) vs a genuine unresolved user call.
  _decline(reason, name, fromFileId) {
    this.unresolvedAmbiguous++
    this.declineReasons[reason] = (this.declineReasons[reason] || 0) + 1
    // Sample the genuinely-uncertain declines (NOT stdlib/builtin noise) so the
    // real static gap is inspectable — DIAGNOSTIC ONLY (CS_DBG), never in the
    // shipped response. Capped to stay cheap even when enabled.
    if (CS_DECLINE_SAMPLES && reason !== 'builtin-method' && reason !== 'builtin-fallback'
        && this.declineSamples.length < 100) {
      this.declineSamples.push({ reason, name, from: fromFileId })
    }
    return null
  }

  resolveCall(fromFileId, name, { allowAny = false, qualifiedOnly = false, memberCall = false, importedOnly = false, inModule = null } = {}) {
    if (!name) return null
    // Untyped member call `obj.foo()` where foo is a builtin / common method
    // name (.add/.get/.map/.then…): never a call to a user free function of
    // that name. Reject before the same-file/imported lookup (those run
    // before the allowAny builtin filter and would otherwise grab a same-file
    // `add` for `visited.add()` — B-2 / the JS-recall measurement). Bare
    // calls `foo()` are unaffected (memberCall=false).
    // EXCEPTION: a namespace/default-import member call (`ns.fn()`, pinned via
    // importedOnly+inModule) targets a KNOWN module, so a builtin-looking name
    // there is still that module's real export — `registry.remove()` is the
    // user's exported remove(), not Set.remove (insp-004 #49).
    if (memberCall && !(importedOnly && inModule) && BUILTIN_NAMES.has((name.split('.').pop() || name).toLowerCase())) {
      return this._decline('builtin-method', name, fromFileId)
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
    // Namespace member call pinned to its source module: if that module
    // re-exports `name` under a rename (`export { _bar as bar }`), redirect to
    // the real `_bar` before the byName scan — otherwise a same-named symbol
    // reachable through an unrelated barrel wins (the `checks.slugify` →
    // `util.slugify` wrong edge).
    if (importedOnly && inModule) {
      const aliased = this._resolveExportAlias(inModule, name, 0)
      if (aliased) return aliased
    }
    const set = this.byName.get(name.toLowerCase())
    if (!set || !set.size) return null
    // Ambiguous-method guard: a bare-name MEMBER call (`Self::m()`, `x.m()` with
    // unknown receiver) where ≥2 production classes define a method of that name
    // cannot be pinned to one — confidently returning the first same-file/
    // imported match is the "arbitrary impl" bug (Rust `Self::read_u32` → an
    // arbitrary `BigEndian.read_u32` among 3 trait impls). Decline so the
    // dynamic candidate leg surfaces ALL impls instead. Typed member calls are
    // already resolved above (qualifiedOnly) and never reach here.
    let methodNameCount = 0
    if (memberCall) {
      for (const id of set) {
        const n = this.nodes.get(id)
        if (n && n.name === name && n.qualifiedName && n.qualifiedName.includes('.') && n.qualifiedName !== n.name && !isAuxPath(n.file)) methodNameCount++
      }
    }
    const ambiguousMethodCall = methodNameCount > 1
    let sameFile = null, imported = null
    // Precision-first imported-candidate tracking. The old code set `imported`
    // to the FIRST imported file bearing the name (byName Set iteration order)
    // — when ≥2 imported files declare the same name that arbitrary, order-
    // dependent pick is both possibly-wrong and nondeterministic. Instead we
    // record EVERY distinct imported-file candidate; only when exactly one
    // exists do we confidently resolve to it. ≥2 ⇒ decline (fall through to the
    // production/candidate legs) rather than guess. Single-candidate resolution
    // (the common, correct case) is unchanged.
    let importedCand = null, importedCandCount = 0
    const importedFilesSeen = new Set()
    // Count *production* candidates (not aux: scripts/, test/, build/…).
    // The tightened allowAny fallback resolves only when exactly one
    // production symbol bears the name — more than one is ambiguous and we
    // refuse to guess (see docs/SYMBOL-MODE-PLAN.md §5).
    let prodOne = null, prodCount = 0
    // importedOnly follows barrel re-export chains so `ns.fn()` resolves to the
    // file that actually declares fn, not just the directly-imported barrel.
    const importsOf = importedOnly ? this._importReachable(fromFileId) : this.fileImports.get(fromFileId)
    // Namespace member call pinned to its source module: accept ONLY symbols in
    // that module's re-export reach — so `checks.slugify` can never grab an
    // unrelated import's `util.slugify` (the one measured wrong-function edge).
    // When the source can't be resolved (external pkg / path miss) pin is null
    // and we keep the plain import-reachable match — no recall change there.
    const pin = (importedOnly && inModule) ? this._moduleReach(inModule) : null
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
      // Symmetric guard: an untyped member call `x.foo()` (unknown receiver)
      // targets a METHOD on that receiver, never a free function `foo`.
      // Confidently resolving it to an imported/same-file free function is a
      // wrong dataflow edge — `sock.encode(p)` does NOT call codec's free
      // `encode` (insp-004). Free-function candidates are left to the dynamic
      // candidate leg, which surfaces them honestly as "could be". A
      // namespace/default-import member call (`ns.fn()`, importedOnly) DOES
      // legitimately target the module's free function, so it is exempt.
      if (memberCall && !importedOnly && (!node.qualifiedName || !node.qualifiedName.includes('.') || node.qualifiedName === node.name)) continue
      // importedOnly (a namespace/default-import member call `ns.fn()`): the
      // target is in the IMPORTED module, never same-file — don't break on a
      // same-file match (that was the `ns.fn()` → same-file phantom), keep
      // scanning for the imported one.
      if (node.file === fromFileId) { sameFile = node; if (!importedOnly) break }
      if (importedOnly && pin) {
        // Pinned: a candidate from outside the namespace's module reach is the
        // wrong module's same-named symbol — skip it entirely.
        if (pin.has(node.file) && !imported) imported = node
      } else if (importsOf && importsOf.has(node.file)) {
        // Count distinct imported FILES that declare this name (multiple symbols
        // in the same file collapse to one candidate — same resolution target).
        if (!importedFilesSeen.has(node.file)) {
          importedFilesSeen.add(node.file)
          importedCandCount++
          if (!importedCand) importedCand = node
        }
      }
      if (!isAuxPath(node.file)) { prodCount++; if (!prodOne) prodOne = node }
    }
    // Ambiguous bare-name member call (≥2 impls of the method name) — refuse the
    // arbitrary first match; the candidate leg exposes all impls instead.
    if (ambiguousMethodCall) { return this._decline('ambiguous-user-method', name, fromFileId) }
    if (sameFile && !importedOnly) return sameFile
    // Pinned namespace match (single module reach) takes precedence as before.
    if (imported) return imported
    // Non-pinned imported candidate: confidently resolve ONLY when exactly one
    // imported file declares the name. ≥2 ⇒ ambiguous; decline here and fall
    // through to the production/candidate legs rather than pick an arbitrary,
    // iteration-order-dependent file (the documented nondeterminism bug).
    if (importedCandCount === 1) return importedCand
    if (importedCandCount > 1) { return this._decline('imported-ambiguous', name, fromFileId) }
    if (!allowAny) return null
    // Tightened fallback. The old code returned ANY same-named symbol here,
    // which mis-linked `.add()`/`.resolve()` method calls on unknown
    // receivers to unrelated module functions. Now: never guess a builtin /
    // common method name by bare name, and leave an ambiguous name (>1
    // production candidate) unresolved rather than mis-link. Phase-0 spike:
    // suspect cross-file edges −81% (JS) / −54% (Python), <1% real loss.
    if (BUILTIN_NAMES.has(name.toLowerCase())) { return this._decline('builtin-fallback', name, fromFileId) }
    if (prodCount === 1) return prodOne
    return this._decline(prodCount === 0 ? 'no-match' : 'ambiguous-prod', name, fromFileId)
  }

  // The DYNAMIC candidate leg. When a call can't be pinned to ONE static target
  // (polymorphic dispatch, unknown receiver type, ambiguous name) we do NOT drop
  // it — we expose the maximal HONEST candidate set: every production callable
  // that bears the call name. The real target is guaranteed to be among these
  // (a superset, never a wrong single guess), which is exactly the user's spec:
  // "정적은 100%, 동적은 후보군 최대치". Builtin/common method names on member
  // calls are dispatch noise (.map/.add/.get on stdlib values), not a knowable
  // user candidate set, so they return empty. Capped to keep a hot name
  // (`validate` on 40 classes) from flooding; `capped` signals truncation.
  candidatesFor(fromFileId, name, { memberCall = false, cap = 24 } = {}) {
    const bare = name.includes('.') ? name.split('.').pop() : name
    if (!bare) return { candidates: [], capped: false }
    if (memberCall && BUILTIN_NAMES.has(bare.toLowerCase())) return { candidates: [], capped: false }
    const set = this.byName.get(bare.toLowerCase())
    if (!set) return { candidates: [], capped: false }
    const fromGroup = langGroupOf(fromFileId)
    const out = []
    let capped = false
    for (const id of set) {
      const n = this.nodes.get(id)
      if (!n || n.name !== bare) continue                 // exact-case, real callable
      if (n.kind !== 'function' && n.kind !== 'method') continue
      if (isAuxPath(n.file)) continue                     // production only
      if (langGroupOf(n.file) !== fromGroup) continue     // a call never crosses languages (#50)
      out.push(n)
      if (out.length >= cap) { capped = true; break }
    }
    return { candidates: out, capped }
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
    // Dynamic candidate adjacency — isolated from the confident call graph.
    if (kind === 'call-candidate') {
      if (!this.candOut.has(source)) this.candOut.set(source, new Set())
      this.candOut.get(source).add(target)
      if (!this.candIn.has(target)) this.candIn.set(target, new Set())
      this.candIn.get(target).add(source)
      return true
    }
    // Reference adjacency (value-use / callback) — indexed but deliberately NOT
    // part of the call graph, so it surfaces usage without inflating callers /
    // blast / reachability. Both endpoints must be real nodes.
    if (kind === 'ref') {
      if (this.nodes.has(source) && this.nodes.has(target)) {
        if (!this.refIn.has(target)) this.refIn.set(target, new Set())
        this.refIn.get(target).add(source)
      }
      return true
    }
    // 'observed' = a runtime-witnessed call (cs trace run). It IS a real call
    // edge — indexed into the same caller/callee adjacency so blast, dead-code
    // and callers() see it — while byEdgeKind keeps its provenance distinct.
    if (kind !== 'call' && kind !== 'observed') return true
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
  // Map each class id -> its constructor method ids. A `new C()` call lands its
  // edge on the CLASS node (callers of C), not on C's constructor method, so
  // without this a statically-constructed class's constructor — and the super()
  // chain it calls — looks dead (insp-004). Cached; invalidated on clear().
  _constructorIndex() {
    if (this._ctorIdx) return this._ctorIdx
    const idx = new Map()
    const classByQN = new Map()
    for (const n of this.nodes.values()) {
      if (n.kind === 'class') classByQN.set(n.file + '␞' + (n.qualifiedName || n.name), n.id)
    }
    for (const n of this.nodes.values()) {
      if (n.kind !== 'method' && n.kind !== 'function') continue
      const qn = n.qualifiedName || ''
      const dot = qn.lastIndexOf('.')
      if (dot < 0) continue
      const clsQN = qn.slice(0, dot)
      const mname = qn.slice(dot + 1)
      const className = clsQN.slice(clsQN.lastIndexOf('.') + 1)
      // constructor (JS) / __init__ (py) / same-name method (Java/C++/C#).
      if (mname === 'constructor' || mname === '__init__' || mname === className) {
        const cid = classByQN.get(n.file + '␞' + clsQN)
        if (cid) { if (!idx.has(cid)) idx.set(cid, []); idx.get(cid).push(n.id) }
      }
    }
    this._ctorIdx = idx
    return idx
  }

  computeReachability(isEntry) {
    const reachable = new Set()
    const queue = []
    const ctorIdx = this._constructorIndex()
    const enqueue = (id) => {
      if (reachable.has(id)) return
      reachable.add(id); queue.push(id)
      const cs = ctorIdx.get(id)
      if (cs) for (const cid of cs) enqueue(cid)
    }
    for (const node of this.nodes.values()) {
      try {
        if (isEntry(node)) enqueue(node.id)
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
      for (const c of callees) enqueue(c)
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
  // Dynamic candidate dispatch (kind 'call-candidate'): possible targets/sources
  // for calls that couldn't be statically pinned. Honest "could be one of these"
  // — never asserted as a confident edge.
  candidateCalleesOf(id) {
    const set = this.candOut.get(id)
    if (!set) return []
    return [...set].map((tid) => this.nodes.get(tid)).filter(Boolean)
  }
  candidateCallersOf(id) {
    const set = this.candIn.get(id)
    if (!set) return []
    return [...set].map((sid) => this.nodes.get(sid)).filter(Boolean)
  }
  // Symbols that REFERENCE this one as a value (callback / passed-as-arg /
  // assigned) without directly invoking it. Lets a caller surface "used, just
  // not called here" so a callback-only symbol isn't read as dead. (kind 'ref')
  refCallersOf(id) {
    const set = this.refIn.get(id)
    if (!set) return []
    return [...set].map((sid) => this.nodes.get(sid)).filter(Boolean)
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
  // Parse heavy-grammar files in recycled child processes (small batches, fresh
  // process per batch) to bound web-tree-sitter's ever-growing wasm heap.
  // phase 'symbols' → returns SymbolNode[]; phase 'refs' → returns SymbolEdge[]
  // (extra ships {nodes, extends} so the child rebuilds a resolver index).
  // A crashed batch (OOM/parse error) degrades gracefully: those files are
  // skipped, not fatal to the whole build.
  _workerParse(phase, files, extra = {}) {
    const cp = require('child_process')
    const worker = path.join(__dirname, 'symbol-parse-worker.cjs')
    const BATCH = parseInt(process.env.CS_WORKER_BATCH || '20', 10)
    const out = []
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH)
      let req
      try { req = JSON.stringify({ phase, files: batch, ...extra }) } catch { continue }
      try {
        const r = cp.spawnSync(process.execPath, [worker], {
          input: req, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
          // In the Electron desktop, execPath is the Electron binary — run it as
          // plain Node so the worker script executes (no-op under real node).
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        // IGNORE exit status: the heavy grammars OOM on process TEARDOWN, after
        // the result is already written to stdout. As long as stdout parses to
        // complete JSON, the batch succeeded. A mid-parse crash leaves stdout
        // empty/partial → parse throws → those files are skipped.
        if (!r.stdout) continue
        const res = JSON.parse(r.stdout)
        if (res.symbols) for (const s of res.symbols) out.push(s)
        if (res.edges) for (const e of res.edges) out.push(e)
      } catch (e) { if (process.env.CS_DBG) console.error('[cs] _workerParse batch (' + phase + '):', e && e.message) /* batch failed — skip its files */ }
    }
    return out
  }

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
    // Grammars whose wasm parser leaks memory at scale → parsed via a recycled
    // child process (see symbol-parse-worker.cjs). Opt-out with CS_NO_WORKER.
    const WORKER_EXTS = (process.env.CS_NO_WORKER || options.noWorker) ? new Set() : WORKER_GRAMMAR_EXTS
    const workerFiles = []            // heavy-grammar files deferred to the worker
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
      // Heavy-grammar files (Swift) are parsed in a recycled child process —
      // web-tree-sitter's wasm heap never shrinks, so parsing them in-process
      // OOMs on large repos. Defer to the worker pass below.
      if (WORKER_EXTS.has(entry.ext)) { workerFiles.push({ id: entry.id, ext: entry.ext, content, mtimeMs: fileMtimeMs }); continue }
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
        // Re-export alias entry (not a node) — index it for namespace
        // member-call redirection (`export { _bar as bar }`).
        if (s.__exportAlias) {
          let m = this.fileExportAlias.get(s.file)
          if (!m) { m = new Map(); this.fileExportAlias.set(s.file, m) }
          if (!m.has(s.exported)) m.set(s.exported, { orig: s.orig, srcSpec: s.srcSpec })
          continue
        }
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
    // Worker pass 1 — heavy-grammar symbols, parsed in recycled child processes.
    if (workerFiles.length) {
      for (const s of this._workerParse('symbols', workerFiles)) {
        if (this.nodes.size >= MAX_SYMBOLS) { abortedAt = 'symbols'; break }
        this.addNode(s)
      }
      fileCount += new Set(workerFiles.map((f) => f.id)).size
    }
    // Pass 2 — references. Per-file, ask the language parser to find
    // call/extends/implements edges. Parsers consult `this` (the
    // symbol index) to resolve names.
    for (const [fileId, content] of fileContents) {
      if (this.edges.length >= MAX_EDGES) { abortedAt = abortedAt || 'edges'; break }
      const ext = extFor(fileId)
      if (WORKER_EXTS.has(ext)) continue   // handled by the worker pass below
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
    // Worker pass 2 — heavy-grammar references. The worker rebuilds a resolver
    // from the symbols we just indexed for those grammars (+ their structural
    // edges) so the normal extractReferences path runs unchanged in the child.
    if (workerFiles.length && this.edges.length < MAX_EDGES) {
      const wExts = new Set(workerFiles.map((f) => f.ext))
      const wNodes = []
      for (const n of this.nodes.values()) if (wExts.has(extFor(n.file))) wNodes.push(n)
      const wExtends = this.edges.filter((e) => (e.kind === 'extends' || e.kind === 'implements') && wExts.has(extFor(this.nodes.get(e.source)?.file || '')))
      for (const r of this._workerParse('refs', workerFiles, { nodes: wNodes, extends: wExtends })) {
        if (this.edges.length >= MAX_EDGES) { abortedAt = abortedAt || 'edges'; break }
        if (this.nodes.has(r.source) && this.nodes.has(r.target)) this.addEdge(r)
      }
    }
    this.finalizeDispatchCandidates()
    this.fileCount = fileCount
    this.builtAt = Date.now()
    this.scanMs = this.builtAt - start
    this.abortedAt = abortedAt          // null or 'symbols'/'edges'
    return this.stats()
  }

  // Polymorphic-dispatch candidates (post-pass; user bar: "동적은 후보군 최대치").
  // A typed member call resolving to an interface/base METHOD declaration is a
  // CORRECT confident edge — but at runtime the dispatch lands on an OVERRIDE in
  // an implementing/extending class. Without this pass those real targets are
  // invisible: blast on `Alpha.greet` misses the caller of `Greeter.greet`.
  // For every confident call edge whose target method's declaring type has
  // subtypes (reverse extends/implements, transitive), emit `call-candidate`
  // edges to each subtype's same-named override. Isolated from the confident
  // call graph (candidate adjacency only), capped to avoid hierarchy explosion.
  finalizeDispatchCandidates(cap = 24) {
    if (!this.extendsOut.size) return
    // Reverse subtype index: baseClassId → Set<subClassId>
    const subsOf = new Map()
    for (const [sub, bases] of this.extendsOut) {
      for (const base of bases) {
        if (!subsOf.has(base)) subsOf.set(base, new Set())
        subsOf.get(base).add(sub)
      }
    }
    const allSubsOf = (typeId) => {
      const out = new Set(); const q = [typeId]
      while (q.length) {
        const cur = q.pop()
        const subs = subsOf.get(cur)
        if (!subs) continue
        for (const s of subs) { if (!out.has(s)) { out.add(s); q.push(s) } }
      }
      return out
    }
    // Snapshot — addEdge below appends to this.edges; never iterate a growing list.
    const callEdges = this.edges.filter((e) => e.kind === 'call')
    const pending = []
    for (const e of callEdges) {
      const t = this.nodes.get(e.target)
      if (!t || !t.qualifiedName || !t.qualifiedName.includes('.') || t.qualifiedName === t.name) continue
      const dot = t.qualifiedName.lastIndexOf('.')
      const typeName = t.qualifiedName.slice(0, dot)
      const methodName = t.qualifiedName.slice(dot + 1)
      const typeIds = this.byName.get(typeName.toLowerCase())
      if (!typeIds) continue
      let emitted = 0
      for (const tid of typeIds) {
        const tn = this.nodes.get(tid)
        if (!tn || tn.name !== typeName) continue
        for (const subId of allSubsOf(tid)) {
          if (emitted >= cap) break
          const sub = this.nodes.get(subId)
          if (!sub) continue
          const overrides = this.byName.get(methodName.toLowerCase())
          if (!overrides) continue
          for (const oid of overrides) {
            const o = this.nodes.get(oid)
            // oid === e.source guard: a super-call edge's source IS a subtype
            // override of the target — without it every super()/super./base.
            // call sprayed a self-loop "I am my own dispatch candidate".
            if (!o || oid === e.target || oid === e.source || o.qualifiedName !== `${sub.name}.${methodName}`) continue
            pending.push({ source: e.source, target: oid, kind: 'call-candidate', line: e.line, candidate: true, dispatch: 'override' })
            emitted++
            if (emitted >= cap) break
          }
        }
      }
    }
    for (const e of pending) this.addEdge(e)
  }

  // ── Accounting completeness (user bar #4): EVERY symbol gets exactly one
  //    label — entry / reachable (confident call chain from an entry) /
  //    possible (only via candidate-dispatch or value-reference, i.e. could be
  //    live) / dead (statically unreachable). unexplained is 0 BY CONSTRUCTION;
  //    the bar test asserts the partition sums to the total.
  //    HONESTY CAVEATS (returned, never hidden): a "dead" verdict is a static
  //    floor — dynamicSiteCount > 0 means unnameable call sites exist that
  //    could invoke anything; entry detection itself can miss framework-implicit
  //    entries. Dead therefore means "no static evidence of life", not proof.
  accounting(entryIds = null) {
    const entries = new Set()
    if (entryIds && entryIds.length) {
      for (const id of entryIds) if (this.nodes.has(id)) entries.add(id)
    } else {
      // Default entries: exported symbols + module pseudo-symbols (top-level code).
      for (const n of this.nodes.values()) {
        if (n.exported || n.kind === 'module') entries.add(n.id)
      }
    }
    // Tier 1 — confident reach: BFS over call edges from entries. A live class
    // pulls in its constructor (and the super() chain) — `new C()` edges land on
    // the class, not the ctor method (insp-004).
    const ctorIdx = this._constructorIndex()
    const reachable = new Set()
    const q1 = []
    const enqueue1 = (id) => {
      if (reachable.has(id)) return
      reachable.add(id); q1.push(id)
      const cs = ctorIdx.get(id)
      if (cs) for (const cid of cs) enqueue1(cid)
    }
    for (const id of entries) enqueue1(id)
    while (q1.length) {
      const cur = q1.pop()
      const outs = this.callOut.get(cur)
      if (outs) for (const t of outs) enqueue1(t)
    }
    // Tier 2 — possible reach: from anything live, follow candidate-dispatch and
    // value-reference edges too (a callback passed somewhere can run; a dispatch
    // candidate can be the runtime target). Newly reached symbols are 'possible',
    // and their own confident callees are possible as well.
    const refOut = new Map()
    for (const e of this.edges) {
      if (e.kind !== 'ref') continue
      if (!refOut.has(e.source)) refOut.set(e.source, new Set())
      refOut.get(e.source).add(e.target)
    }
    const possible = new Set()
    const seen = new Set(reachable)
    const q2 = [...reachable]
    // Inline callbacks defined as values (object-literal property/method) are
    // passed somewhere and invoked via dispatch — seed them as 'possible' so
    // they AND what they call propagate as could-run (insp-004 #51).
    for (const n of this.nodes.values()) {
      if (n.valueCallback && !seen.has(n.id)) { seen.add(n.id); possible.add(n.id); q2.push(n.id) }
    }
    while (q2.length) {
      const cur = q2.pop()
      for (const m of [this.callOut.get(cur), this.candOut.get(cur), refOut.get(cur)]) {
        if (!m) continue
        for (const t of m) if (!seen.has(t)) { seen.add(t); possible.add(t); q2.push(t) }
      }
    }
    const dead = []
    for (const id of this.nodes.keys()) {
      if (!reachable.has(id) && !possible.has(id)) dead.push(id)
    }
    const total = this.nodes.size
    const entryCount = entries.size
    const reachableCount = reachable.size - entries.size
    const possibleCount = possible.size
    const deadCount = dead.length
    return {
      total,
      entryCount, reachableCount, possibleCount, deadCount,
      unexplained: total - (entryCount + reachableCount + possibleCount + deadCount),
      dead: dead.slice(0, 200),
      deadTruncated: dead.length > 200,
      // Caveats — the consumer must see WHY dead is a floor, not proof.
      dynamicSiteCount: [...this.dynamicSites.values()].reduce((a, l) => a + l.length, 0),
      entryDetection: entryIds && entryIds.length ? 'explicit' : 'exports+modules (framework-implicit entries may be missed)',
    }
  }

  // ── Runtime tracing (Leg C). Map a runtime stack frame (file id + 1-based
  //    line) to the TIGHTEST enclosing symbol. See docs/design-runtime-tracing.md.
  symbolAtLine(fileId, line) {
    const ids = this.byFile.get(fileId)
    if (!ids) return null
    let best = null, bestSpan = Infinity
    let moduleSym = null
    for (const id of ids) {
      const n = this.nodes.get(id)
      if (!n || n.startLine == null || n.endLine == null) continue
      // The <module> pseudo-symbol is a 1-line container stub (span 0) — it
      // would WIN tightest-span against any real function defined on line 1
      // (a Python tracer pair mapped dispatch→<module> instead of →leaf).
      // Treat it strictly as the fallback when no real symbol contains the line.
      if (n.kind === 'module') { moduleSym = n; continue }
      if (line >= n.startLine && line <= n.endLine) {
        const span = n.endLine - n.startLine
        if (span < bestSpan) { bestSpan = span; best = n }
      }
    }
    return best || moduleSym
  }

  // Classify a batch of OBSERVED runtime call edges against the static graph.
  // `pairs` = [{ cf, cl, ef, el }] (caller file/line, callee file/line; 1-based).
  // Pure — no mutation. Returns how many observed edges confirm a static `call`,
  // confirm a `call-candidate` (resolved a real ambiguity), or are NEW (dynamic,
  // invisible to static) — plus observed-coverage so it is never read as the
  // whole graph (runtime sees only exercised paths).
  observeRuntimeEdges(pairs, opts = {}) {
    const observed = new Set()
    const touched = new Set()
    let unmapped = 0
    for (const p of pairs || []) {
      const a = this.symbolAtLine(p.cf, p.cl)
      const b = this.symbolAtLine(p.ef, p.el)
      if (a) touched.add(a.id)
      if (b) touched.add(b.id)
      if (!a || !b) { unmapped++; continue }
      if (a.id === b.id) continue
      observed.add(a.id + '\t' + b.id)
    }
    let confirmedStatic = 0, confirmedCandidate = 0, newDynamic = 0, merged = 0
    const newDynamicSamples = []
    for (const key of observed) {
      const i = key.indexOf('\t')
      const a = key.slice(0, i), b = key.slice(i + 1)
      // Classify against STATIC `call` edges only (via the kind-aware edge-key
      // set) — callOut also contains previously-merged 'observed' edges, which
      // made a re-observed runtime-only edge count as "confirmedStatic"
      // (a false "static already knew this" on every trace-watch cycle).
      if (this._edgeKeys.has(`${a}␞${b}␞call`)) confirmedStatic++
      else if (this.candOut.get(a) && this.candOut.get(a).has(b)) confirmedCandidate++
      else {
        newDynamic++
        if (newDynamicSamples.length < 50) newDynamicSamples.push({ from: a, to: b })
        // Auto-discovery (roadmap ②): does this runtime-only edge LOOK like
        // something static analysis should have found? CONSERVATIVE predicate —
        // target name unique project-wide, caller's file is the target's file
        // or imports it, name not a builtin. Sampling/line-mapping artifacts
        // and genuine dynamics still slip through, so this is a SUSPICION for
        // the review queue, never a verdict and never an auto-fix.
        const an = this.nodes.get(a), bn = this.nodes.get(b)
        if (an && bn && this.recallSuspects.length < 200) {
          const sameName = this.byName.get((bn.name || '').toLowerCase())
          const unique = sameName && sameName.size === 1
          const related = an.file === bn.file
            || (this.fileImports.get(an.file) && this.fileImports.get(an.file).has(bn.file))
          if (unique && related && !BUILTIN_NAMES.has((bn.name || '').toLowerCase()) && !this._suspectKeys.has(key)) {
            this._suspectKeys.add(key)
            this.recallSuspects.push({ from: a, to: b, fromFile: an.file, toFile: bn.file, name: bn.qualifiedName || bn.name })
          }
        }
      }
      // merge: persist the runtime-witnessed edge into the live graph as kind
      // 'observed' (already-static-confirmed pairs gain a provenance edge too —
      // byEdgeKind keeps the distinction; adjacency dedups).
      if (opts.merge) {
        if (this.addEdge({ source: a, target: b, kind: 'observed', line: 0, observed: true })) merged++
      }
    }
    return {
      observedEdges: observed.size,
      confirmedStatic,
      confirmedCandidate,
      newDynamic,
      newDynamicSamples,
      merged: opts.merge ? merged : undefined,
      recallSuspects: this.recallSuspects.length ? this.recallSuspects.slice(-20) : undefined,
      symbolsTouched: touched.size,
      totalSymbols: this.nodes.size,
      unmappedFrames: unmapped,
    }
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
      declineReasons: this.declineReasons,  // breakdown: stdlib-correct vs genuine gap
      // Zero-silence ledger summary — sites whose callee static analysis cannot
      // even NAME. Nonzero here means "the call graph for these symbols is a
      // floor"; per-symbol detail via this.dynamicSites.
      dynamicSiteCount: [...this.dynamicSites.values()].reduce((a, l) => a + l.length, 0),
      dynamicSiteSymbols: this.dynamicSites.size,
      // Auto-discovered recall-miss suspects (observed↔static cross-check) —
      // review-queue material; see design doc safety rules.
      recallSuspectCount: this.recallSuspects.length,
      // Per-call samples are diagnostic-only — omitted from the shipped response
      // unless CS_DBG populated them (keeps the AI-consumed payload lean).
      ...(this.declineSamples.length ? { declineSamples: this.declineSamples } : {}),
      parseFailures: this.parseFailures,   // files whose parser threw (swallowed to [])
      emptyFiles: this.emptyFiles,         // files parsed OK but with 0 symbols
    }
  }
}

module.exports = { SymbolGraph, registerParser, extFor, PARSERS }
