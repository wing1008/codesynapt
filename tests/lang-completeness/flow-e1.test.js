import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── Expression layer E1 BAR — per-function dataflow facts (JS, lazy) ──
// Known-answer fixture written BEFORE the implementation (the proven
// playbook). Scope per docs/design-expression-layer.md: ONLY certain flows —
// identifier passed directly, or through simple const/let re-binding chains.
// Anything else lands in `unresolvedFlows` (zero-silence), never guessed.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const flow = require(path.resolve(__dirname, '../../packages/core/lib/symbol-flow.cjs'))

const SRC = `
function helper(x) { return x + 1 }

function target(a, b) {
  const c = a              // local c <- param a
  const r = helper(c)      // helper arg0 <- c <- param a
  use(b)                   // use arg0 <- param b
  other(42, a)             // literal arg0, param a arg1
  return r                 // return <- call helper (via r)
}
`

function targetFacts() {
  // The symbol node shape the Layer-2 graph stores (file + line range).
  return flow.extractFlow(SRC, 'fix.js', { name: 'target', startLine: 4, endLine: 10 })
}

describe('expression flow E1 — JavaScript', () => {
  it('params are listed', () => {
    const f = targetFacts()
    expect(f.params).toEqual(['a', 'b'])
  })

  it('CERTAIN flows: param→arg directly and through a const chain', () => {
    const f = targetFacts()
    const helperCall = f.calls.find((c) => c.name === 'helper')
    expect(helperCall.args[0].from).toBe('param:a')      // via const c = a
    const useCall = f.calls.find((c) => c.name === 'use')
    expect(useCall.args[0].from).toBe('param:b')
  })

  it('PRECISION: literals and cross-params never mis-attributed', () => {
    const f = targetFacts()
    const otherCall = f.calls.find((c) => c.name === 'other')
    expect(otherCall.args[0].from).toBe('literal')
    expect(otherCall.args[1].from).toBe('param:a')
    // b must NOT appear as a source for helper's arg
    const helperCall = f.calls.find((c) => c.name === 'helper')
    expect(helperCall.args[0].from).not.toBe('param:b')
  })

  it('RETURN provenance: r <- helper(...) call', () => {
    const f = targetFacts()
    expect(f.returns.length).toBe(1)
    expect(f.returns[0].from).toBe('call:helper')
  })

  it('ZERO SILENCE: an un-trackable flow is COUNTED, never guessed', () => {
    const SRC2 = `
function tricky(a) {
  const o = { v: a }
  consume(o.v)            // through an object property — out of E1 scope
  return a
}
`
    const f = flow.extractFlow(SRC2, 'f2.js', { name: 'tricky', startLine: 2, endLine: 6 })
    const call = f.calls.find((c) => c.name === 'consume')
    expect(call.args[0].from).toBe('unknown')
    expect(f.unresolvedFlows).toBeGreaterThanOrEqual(1)
    expect(f.returns[0].from).toBe('param:a')
  })
})
