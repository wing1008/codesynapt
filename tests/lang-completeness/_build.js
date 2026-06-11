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

export async function buildGraph(files) {
  parsers.registerAll()
  const PARSERS = sg.PARSERS
  const g = new sg.SymbolGraph()
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
