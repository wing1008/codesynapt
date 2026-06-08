'use strict'
// ── Sub-engine merge layer (BLOCK registry) ──────────────────────────────────
// Runs registered per-language sub-engines as an OPTIONAL post-pass over a built
// SymbolGraph and unions in the edges the main AST engine missed. The main
// engine (symbol-graph.cjs) is untouched — enrich() is a separate step the host
// (scanner) may call after build(); if no sub-engine is available it's a no-op.
//
// Each sub-engine is a self-contained block exporting { exts, available(),
// resolve(absFiles, rootDir) -> records }. resolve returns RAW call records
// (caller/decl by file+line+name); this layer maps them to graph nodes and adds
// only NEW edges (provenance via:'tsc') + promotes matching candidates.

const ENGINES = []
function register(engine) { if (engine && engine.available && engine.resolve) ENGINES.push(engine) }
// Built-in blocks. TS = bundled (typescript npm). Java = toolchain-gated (JDK).
try { register(require('./subengine-ts.cjs')) } catch { /* optional */ }
try { register(require('./subengine-java.cjs')) } catch { /* optional */ }

// Smallest graph symbol whose line range encloses `line` in `file` (the calling
// function/method); falls back to the file's <module> node.
function buildEnclosingIndex(g) {
  const byFile = new Map()
  for (const n of g.nodes.values()) {
    if (!byFile.has(n.file)) byFile.set(n.file, [])
    byFile.get(n.file).push(n)
  }
  return (file, line) => {
    const arr = byFile.get(file); if (!arr) return null
    let best = null, bestSpan = Infinity, mod = null
    for (const n of arr) {
      if (n.name === '<module>') { mod = n; continue }
      const s = n.startLine || 0, e = n.endLine || s
      if (s <= line && line <= e) { const span = e - s; if (span < bestSpan) { bestSpan = span; best = n } }
    }
    return best || mod
  }
}
// Target node for a resolved declaration (file + name, nearest line).
function buildTargetIndex(g) {
  const byKey = new Map() // file|name -> nodes
  for (const n of g.nodes.values()) {
    const k = n.file + '|' + n.name
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(n)
  }
  return (file, name, line) => {
    const arr = byKey.get(file + '|' + name); if (!arr) return null
    if (arr.length === 1) return arr[0]
    let best = arr[0], bd = Infinity
    for (const n of arr) { const d = Math.abs((n.startLine || 0) - line); if (d < bd) { bd = d; best = n } }
    return best
  }
}

// Enrich a built graph in place. opts = { files: [absPath], rootDir }.
// Returns { engine: {added, considered, unmapped} } per engine.
function enrich(g, opts = {}) {
  const files = opts.files || []
  const rootDir = opts.rootDir || ''
  const exts = new Set(files.map((f) => (f.split('.').pop() || '').toLowerCase()))
  const stats = {}
  let encl = null, tgt = null
  for (const engine of ENGINES) {
    if (!engine.exts.some((e) => exts.has(e))) continue
    if (!engine.available()) continue
    let records
    try { records = engine.resolve(files, rootDir) || [] } catch { continue }
    if (!encl) { encl = buildEnclosingIndex(g); tgt = buildTargetIndex(g) }
    let added = 0, unmapped = 0
    for (const r of records) {
      if (!r.declName) continue
      const src = encl(r.callerFile, r.callLine)
      const dst = tgt(r.declFile, r.declName, r.declLine)
      if (!src || !dst) { unmapped++; continue }
      if (src.id === dst.id) continue
      // addEdge dedups; a duplicate of a main-engine edge is a no-op, so this
      // only ADDS the ones the AST engine missed.
      if (g.addEdge({ source: src.id, target: dst.id, kind: 'call', line: r.callLine, via: engine.name })) added++
    }
    stats[engine.name] = { added, considered: records.length, unmapped }
  }
  return stats
}

module.exports = { register, enrich, ENGINES }
