import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { buildGraph } from './_build.js'

// ── Expression layer E2 BAR — argument-level blast ──
// "If I change THIS parameter, which downstream call sites receive the value?"
// Fixture-first. Walks E1 flow facts across CONFIDENT Layer-2 call edges only;
// an ambiguous/unknown call target STOPS the walk and is COUNTED (precision
// first — a wrong propagation is worse than a short one).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const flow = require(path.resolve(__dirname, '../../packages/core/lib/symbol-flow.cjs'))

const SRC = `
function sink(v) {
  return v
}

function step(x) {
  return sink(x)
}

function entry(a, b) {
  step(a)
  other(b)
  return a
}
`

async function setup() {
  const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: SRC }])
  const entry = [...g.nodes.values()].find((n) => n.name === 'entry')
  const readFile = () => SRC
  return { g, entry, readFile }
}

describe('expression flow E2 — argument-level blast', () => {
  it('a param propagates through confident call edges, depth-labelled', async () => {
    const { g, entry, readFile } = await setup()
    const r = flow.argBlast(g, readFile, entry, 'a', { depth: 4 })
    const hits = r.impacted.map((h) => `${h.fn}:${h.param}@d${h.depth}`)
    expect(hits).toContain('step:x@d1')      // entry.a → step(x)
    expect(hits).toContain('sink:v@d2')      // step.x → sink(v)
  })

  it('PRECISION: sibling params never cross-contaminate', async () => {
    const { g, entry, readFile } = await setup()
    const r = flow.argBlast(g, readFile, entry, 'a', { depth: 4 })
    expect(r.impacted.some((h) => h.fn === 'other')).toBe(false)   // b's path, not a's
  })

  it('ZERO SILENCE: an unresolvable call target stops the walk and is counted', async () => {
    const { g, entry, readFile } = await setup()
    const r = flow.argBlast(g, readFile, entry, 'b', { depth: 4 })
    // `other` has no symbol in the graph → cannot follow → counted, not guessed.
    expect(r.impacted.length).toBe(0)
    expect(r.unresolvedTargets).toBeGreaterThanOrEqual(1)
  })

  it('reports the return-provenance hit too (a flows to entry return)', async () => {
    const { g, entry, readFile } = await setup()
    const r = flow.argBlast(g, readFile, entry, 'a', { depth: 4 })
    expect(r.returnsParam).toBe(true)
  })
})
