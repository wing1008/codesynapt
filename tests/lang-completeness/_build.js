// Shared graph builder for the lang-completeness bar tests. Mirrors the real
// build path (parser → addNode → extractReferences → addEdge) without disk I/O.
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const parsers = require(path.resolve(__dirname, '../../packages/core/lib/symbol-parsers.cjs'))
const sg = require(path.resolve(__dirname, '../../packages/core/lib/symbol-graph.cjs'))

export const { SymbolGraph } = sg

// files: [{id, ext, content}]; fileImports (optional): { 'b.js': ['a.js'] } —
// the Layer-1 import map the scanner normally provides, needed for
// imported-name disambiguation across files.
export async function buildGraph(files, fileImports = null) {
  parsers.registerAll()
  const PARSERS = sg.PARSERS
  const g = new sg.SymbolGraph()
  if (fileImports) {
    g.fileImports = new Map(Object.entries(fileImports).map(([k, v]) => [k, new Set(v)]))
  }
  for (const f of files) {
    const p = PARSERS[f.ext]
    if (!p || !p.extractSymbols) continue
    const syms = (await p.extractSymbols(f.content, f.id)) || []
    for (const s of syms) g.addNode(s)
  }
  for (const f of files) {
    const p = PARSERS[f.ext]
    if (!p || !p.extractReferences) continue
    const edges = (await p.extractReferences(f.content, f.id, g)) || []
    for (const e of edges) g.addEdge(e)
  }
  // Same post-pass the real build() runs (polymorphic-dispatch candidates).
  g.finalizeDispatchCandidates()
  return g
}

// Matches by short name OR exact qualifiedName ('greet' or 'Alpha.greet').
function nameMatch(node, want) {
  return !!node && (node.name === want || node.qualifiedName === want)
}

// Confident `call` edge between matched symbols.
export function hasCall(g, fromName, toName) {
  for (const [src, set] of g.callOut) {
    if (!nameMatch(g.nodes.get(src), fromName)) continue
    for (const t of set) { if (nameMatch(g.nodes.get(t), toName)) return true }
  }
  return false
}

// Dynamic candidate edge (kind 'call-candidate') between matched symbols.
export function hasCandidate(g, fromName, toName) {
  for (const [src, set] of g.candOut) {
    if (!nameMatch(g.nodes.get(src), fromName)) continue
    for (const t of set) { if (nameMatch(g.nodes.get(t), toName)) return true }
  }
  return false
}

export function refExists(g, toName) {
  for (const [tgt] of g.refIn) { const tn = g.nodes.get(tgt); if (tn && tn.name === toName) return true }
  return false
}

export function symbolNames(g) {
  return [...g.nodes.values()].map((n) => n.name)
}

// File-pinned variant: the confident edge must land on toName declared IN toFile.
export function hasCallTo(g, fromName, toName, toFile) {
  for (const [src, set] of g.callOut) {
    if (!nameMatch(g.nodes.get(src), fromName)) continue
    for (const t of set) {
      const tn = g.nodes.get(t)
      if (nameMatch(tn, toName) && tn.file === toFile) return true
    }
  }
  return false
}

// Zero-silence ledger: forms of dynamic call sites recorded inside a symbol.
export function dynamicSiteForms(g, symName) {
  for (const [sid, list] of g.dynamicSites) {
    if (nameMatch(g.nodes.get(sid), symName)) return list.map((s) => s.form)
  }
  return []
}
