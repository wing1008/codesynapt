'use strict'
// Shared layer-2 symbol-endpoint views. Used by BOTH the headless control
// server (lib/control-server.cjs) and the desktop (electron/main.cjs) so a new
// /symbol/* endpoint is implemented ONCE here, not copied into both servers
// (the divergence that grew /symbol/blast and /symbol/graph into two places).
//
// Operates on a SymbolGraph instance + a small context: the scanner's file map
// and the set of symbol-covered file extensions (for honest coverage). Pure —
// no http, no closures over a specific server.

function symbolNodeView(g, n) {
  return {
    id: n.id, name: n.qualifiedName || n.name, kind: n.kind,
    file: n.file, line: n.startLine, exported: !!n.exported,
    callers: g.inAdj.get(n.id)?.size || 0,
    callees: g.outAdj.get(n.id)?.size || 0,
    // Dynamic candidate dispatch (possible, not confident). 0 omitted to keep
    // the common payload lean.
    candidateCallers: g.candIn?.get(n.id)?.size || undefined,
    candidateCallees: g.candOut?.get(n.id)?.size || undefined,
  }
}

// Honest coverage — which files the symbol graph actually parses vs not, so an
// under-populated graph isn't mistaken for "few dependencies".
function symbolCoverage(files, supportedExts) {
  const byExt = {}; let covered = 0, total = 0
  for (const f of files.values()) {
    total++; byExt[f.ext] = (byExt[f.ext] || 0) + 1
    if (supportedExts.has(f.ext)) covered++
  }
  const uncovered = Object.keys(byExt).filter((e) => !supportedExts.has(e)).sort((a, b) => byExt[b] - byExt[a])
  return {
    filesCovered: covered, filesTotal: total,
    coveragePct: total ? Math.round((100 * covered) / total) : 0,
    uncoveredLangs: uncovered.slice(0, 8),
    note: covered < total
      ? 'Symbol (function-level) graph covers JS/TS, Python, and the validated tree-sitter languages (Go, Rust, Java, Kotlin, Swift, C#, PHP, C/C++, Bash); other languages are tracked at file level (layer-1) only.'
      : undefined,
  }
}

function symbolSummary(g, files, supportedExts) {
  const hubs = []
  for (const n of g.nodes.values()) {
    const callers = g.inAdj.get(n.id)?.size || 0
    if (callers > 0) hubs.push({ name: n.qualifiedName || n.name, kind: n.kind, file: n.file, line: n.startLine, callers })
  }
  hubs.sort((a, b) => b.callers - a.callers)
  return { ...g.stats(), topHubs: hubs.slice(0, 15), coverage: symbolCoverage(files, supportedExts) }
}

// Function-level blast radius. direction 'callers' = "what breaks if I change
// this symbol" (transitive callers); 'callees' = "what this depends on".
function symbolBlast(g, id, depth = 3, direction = 'callers') {
  if (!g.nodes.has(id)) return null
  const visited = new Set([id]); let frontier = new Set([id])
  const byDepth = [{ depth: 0, count: 1 }]
  for (let d = 1; d <= depth; d++) {
    const next = new Set()
    for (const sid of frontier) {
      const adj = direction === 'callers' ? g.inAdj.get(sid) : g.outAdj.get(sid)
      if (!adj) continue
      // Only admit neighbours that resolve to a REAL symbol node. Adjacency
      // can hold a foreign/synthetic id (e.g. a `route:GET /x` handler whose
      // node was never materialised) — counting it here inflated byDepth so
      // sum(byDepth[d>0]) drifted ABOVE totalImpacted (totalImpacted is built
      // from g.nodes.get(x), which silently drops phantoms). Filtering at
      // frontier expansion keeps the per-hop counts and the impacted list in
      // exact agreement. The endpoint guard in addEdge now prevents phantoms
      // upstream too; this is the defence-in-depth at the consumer.
      for (const n of adj) if (!visited.has(n) && g.nodes.has(n)) { visited.add(n); next.add(n) }
    }
    if (!next.size) break
    byDepth.push({ depth: d, count: next.size }); frontier = next
  }
  const impacted = [...visited].filter((x) => x !== id)
    .map((x) => { const n = g.nodes.get(x); return n ? { name: n.qualifiedName || n.name, kind: n.kind, file: n.file, line: n.startLine } : null })
    .filter(Boolean)
  const files = new Set(impacted.map((i) => i.file))
  const seed = g.nodes.get(id)
  return {
    seed: { id, name: seed.qualifiedName || seed.name, file: seed.file, line: seed.startLine },
    direction, depth,
    totalImpacted: impacted.length, filesTouched: files.size,
    byDepth, impacted: impacted.slice(0, 200), truncated: impacted.length > 200,
    caveat: 'Static call graph. Dynamic/reflective dispatch (signals/slots, getattr, DI) and ambiguous method names are not resolved — treat this as a floor. Coverage: JS/TS + Python only.',
  }
}

// Render payload for the 3D function layer: symbols + call edges, capped.
function symbolGraphPayload(g, limit = 12000) {
  limit = Math.min(40000, Math.max(1, parseInt(limit, 10) || 12000))
  const symbols = []
  for (const n of g.nodes.values()) {
    symbols.push({ id: n.id, file: n.file, name: n.qualifiedName || n.name, kind: n.kind, line: n.startLine })
    if (symbols.length >= limit) break
  }
  const ids = new Set(symbols.map((s) => s.id))
  const calls = []; const maxCalls = limit * 3
  for (const e of g.edges) {
    if (e.kind !== 'call') continue
    if (ids.has(e.source) && ids.has(e.target)) calls.push({ s: e.source, t: e.target })
    if (calls.length >= maxCalls) break
  }
  return { symbols, calls, truncated: g.nodes.size > symbols.length, total: { symbols: g.nodes.size, calls: g.edges.filter((e) => e.kind === 'call').length } }
}

// GET /symbol/<sub>. Returns { status, body } for the SHARED endpoints, or null
// for server-specific ones (node-with-source, explore, scan) — the caller
// handles those itself. Keeps the common surface (the parts that kept getting
// copied) in one place.
//   params: { q, id, limit, depth, direction }
//   ctx:    { files: scanner.files, supportedExts: Set }
function handleSymbolView(g, sub, params = {}, ctx = {}) {
  const { files, supportedExts } = ctx
  switch (sub) {
    case '':
    case 'summary': return { status: 200, body: symbolSummary(g, files, supportedExts) }
    case 'graph':   return { status: 200, body: symbolGraphPayload(g, params.limit) }
    case 'find':    return { status: 200, body: { query: params.q || '', matches: g.findByName(params.q || '', 50).map((n) => symbolNodeView(g, n)) } }
    case 'callers': {
      const id = params.id || ''
      if (!g.nodes.has(id)) return { status: 404, body: { error: 'symbol not found', id } }
      const cand = g.candidateCallersOf(id).map((c) => symbolNodeView(g, c))
      return { status: 200, body: {
        id, callers: g.callersOf(id).map((c) => symbolNodeView(g, c)),
        // Dynamic dispatch (possible callers, not confirmed) — see candidate leg.
        candidateCallers: cand.length ? cand : undefined,
        candidateNote: cand.length ? 'candidate* = possible dynamic-dispatch targets (the call could not be statically pinned to one); the real one is among these.' : undefined,
      } }
    }
    case 'callees': {
      const id = params.id || ''
      if (!g.nodes.has(id)) return { status: 404, body: { error: 'symbol not found', id } }
      const cand = g.candidateCalleesOf(id).map((c) => symbolNodeView(g, c))
      return { status: 200, body: {
        id, callees: g.calleesOf(id).map((c) => symbolNodeView(g, c)),
        candidateCallees: cand.length ? cand : undefined,
        candidateNote: cand.length ? 'candidate* = possible dynamic-dispatch targets (the call could not be statically pinned to one); the real one is among these.' : undefined,
      } }
    }
    case 'blast': {
      const id = params.id || ''
      const depth = Math.min(6, Math.max(1, parseInt(params.depth, 10) || 3))
      const dir = params.direction === 'callees' ? 'callees' : 'callers'
      const r = symbolBlast(g, id, depth, dir)
      if (!r) return { status: 404, body: { error: 'symbol not found', id } }
      return { status: 200, body: r }
    }
    default: return null   // node (with source) / explore / scan — server-specific
  }
}

module.exports = { symbolNodeView, symbolCoverage, symbolSummary, symbolBlast, symbolGraphPayload, handleSymbolView }
