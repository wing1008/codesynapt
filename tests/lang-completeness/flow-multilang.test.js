import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── Expression layer — reference-4 multilang BAR (Python, Java, C#) ──
// Same playbook as the function-layer 4→13 expansion: the JS template
// (flow-e1) defines the answer-key shape; these three reach the SAME bar,
// then the rest of the languages clone the proven walker. Certain flows
// only; everything else counted (zero-silence), never guessed.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const flow = require(path.resolve(__dirname, '../../packages/core/lib/symbol-flow.cjs'))

describe('expression flow — Python', () => {
  const SRC = `
def helper(x):
    return x + 1

def target(a, b):
    c = a
    r = helper(c)
    use(b)
    other(42, a)
    return r
`
  const sym = { name: 'target', startLine: 5, endLine: 10 }

  it('params + const-chain + literal precision + return provenance', async () => {
    const f = await flow.extractFlowAuto(SRC, 'fix.py', sym)
    expect(f.params).toEqual(['a', 'b'])
    const helperCall = f.calls.find((c) => c.name === 'helper')
    expect(helperCall.args[0].from).toBe('param:a')        // via c = a
    expect(f.calls.find((c) => c.name === 'use').args[0].from).toBe('param:b')
    const other = f.calls.find((c) => c.name === 'other')
    expect(other.args[0].from).toBe('literal')
    expect(other.args[1].from).toBe('param:a')
    expect(f.returns[0].from).toBe('call:helper')          // via r = helper(c)
  })

  it('ZERO SILENCE: object-attribute flow is counted, never guessed', async () => {
    const SRC2 = `
def tricky(a):
    o = wrap(a)
    consume(o.v)
    return a
`
    const f = await flow.extractFlowAuto(SRC2, 'f2.py', { name: 'tricky', startLine: 2, endLine: 5 })
    expect(f.calls.find((c) => c.name === 'consume').args[0].from).toBe('unknown')
    expect(f.unresolvedFlows).toBeGreaterThanOrEqual(1)
    expect(f.returns[0].from).toBe('param:a')
  })
})

describe('expression flow — Java', () => {
  const SRC = `
class Box {
  int helper(int x) { return x + 1; }

  int target(int a, int b) {
    int c = a;
    int r = helper(c);
    use(b);
    other(42, a);
    return r;
  }
}
`
  const sym = { name: 'target', startLine: 5, endLine: 11 }

  it('params + local-chain + literal precision + return provenance', async () => {
    const f = await flow.extractFlowAuto(SRC, 'Box.java', sym)
    expect(f.params).toEqual(['a', 'b'])
    expect(f.calls.find((c) => c.name === 'helper').args[0].from).toBe('param:a')
    expect(f.calls.find((c) => c.name === 'use').args[0].from).toBe('param:b')
    const other = f.calls.find((c) => c.name === 'other')
    expect(other.args[0].from).toBe('literal')
    expect(other.args[1].from).toBe('param:a')
    expect(f.returns[0].from).toBe('call:helper')
  })
})

describe('expression flow — C#', () => {
  const SRC = `
class Box {
  int Helper(int x) { return x + 1; }

  int Target(int a, int b) {
    var c = a;
    var r = Helper(c);
    Use(b);
    Other(42, a);
    return r;
  }
}
`
  const sym = { name: 'Target', startLine: 5, endLine: 11 }

  it('params + var-chain + literal precision + return provenance', async () => {
    const f = await flow.extractFlowAuto(SRC, 'Box.cs', sym)
    expect(f.params).toEqual(['a', 'b'])
    expect(f.calls.find((c) => c.name === 'Helper').args[0].from).toBe('param:a')
    expect(f.calls.find((c) => c.name === 'Use').args[0].from).toBe('param:b')
    const other = f.calls.find((c) => c.name === 'Other')
    expect(other.args[0].from).toBe('literal')
    expect(other.args[1].from).toBe('param:a')
    expect(f.returns[0].from).toBe('call:Helper')
  })
})

describe('extractFlowAuto — JS family still routes to the babel path', () => {
  it('JS answers match the E1 bar through the auto entry', async () => {
    const SRC = `
function target(a) {
  const c = a
  return helper(c)
}
`
    const f = await flow.extractFlowAuto(SRC, 'fix.js', { name: 'target', startLine: 2, endLine: 5 })
    expect(f.calls.find((c) => c.name === 'helper').args[0].from).toBe('param:a')
  })
})
