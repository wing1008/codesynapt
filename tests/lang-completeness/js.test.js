import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── Symbol-completeness BAR — JavaScript (the template language) ──
// A known-answer fixture: every call site is labelled. The built call graph must
// match EXACTLY. This is the committed, reproducible anchor — "JS passes" means
// `npm test` is green, not an assistant's claim. See docs/design-symbol-
// completeness.md. The other 3 symbol languages (ts/py/java/cs) follow this shape.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const parsers = require(path.resolve(__dirname, '../../packages/core/lib/symbol-parsers.cjs'))
const sg = require(path.resolve(__dirname, '../../packages/core/lib/symbol-graph.cjs'))
const { SymbolGraph } = sg

async function buildGraph(files) {
  parsers.registerAll()
  const PARSERS = sg.PARSERS
  const g = new SymbolGraph()
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
  return g
}

// Helper: does a confident `call` edge exist between symbols whose names match?
function hasCall(g, fromName, toName) {
  for (const [src, set] of g.callOut) {
    const sn = g.nodes.get(src)
    if (!sn || sn.name !== fromName) continue
    for (const t of set) { const tn = g.nodes.get(t); if (tn && tn.name === toName) return true }
  }
  return false
}
function refExists(g, toName) {
  for (const [tgt] of g.refIn) { const tn = g.nodes.get(tgt); if (tn && tn.name === toName) return true }
  return false
}

const FIX = `
function leaf() { return 1 }
function mid() { return leaf() }            // EDGE mid -> leaf
function top() { return mid() + leaf() }    // EDGE top -> mid, top -> leaf
const arrow = () => leaf()                  // EDGE arrow -> leaf
function usesCallback(cb) { return cb() }   // DYNAMIC: cb is a param, not a symbol
function passesRef() { return [1].map(leaf) } // REF: leaf passed as a value, NOT called
function dispatch() {
  const o = { go() { return leaf() } }      // EDGE go -> leaf
  const k = 'go'
  return o[k]()                             // DYNAMIC: computed member, no static target
}
`

describe('symbol-completeness bar — JavaScript', () => {
  it('STATIC RECALL: every statically-determinable call edge is present', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'top', 'leaf')).toBe(true)
    expect(hasCall(g, 'arrow', 'leaf')).toBe(true)
    expect(hasCall(g, 'go', 'leaf')).toBe(true)
  })

  it('PRECISION: no phantom edges from refs or dynamic sites', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    // leaf passed to .map is a REFERENCE, must NOT be a call edge.
    expect(hasCall(g, 'passesRef', 'leaf')).toBe(false)
    // cb() resolves to no user symbol — must not mis-link to any same-named fn.
    expect(hasCall(g, 'usesCallback', 'leaf')).toBe(false)
    // computed o[k]() must not invent dispatch -> leaf (only go -> leaf is real).
    expect(hasCall(g, 'dispatch', 'leaf')).toBe(false)
  })

  it('REF honesty: a function passed as a value is recorded as used (not dead)', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    expect(refExists(g, 'leaf')).toBe(true)
  })
})
