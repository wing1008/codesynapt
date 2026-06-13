import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── insp-004: expression flow obeys the bar — NO wrong claim, unknown counted ──
// A binding that is reassigned / augmented (+=) / self-referential / a default
// value / a reassigned parameter is NOT a single certain source, so it must be
// `unknown` and COUNTED in unresolvedFlows — never attributed to a stale value.
// Single-assignment bindings keep their precise provenance (the anchor that
// proves we degraded honestly, not blanket-blinded).

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const flow = require(path.resolve(__dirname, '../../packages/core/lib/symbol-flow.cjs'))
const F = (src, file, sym) => flow.extractFlowAuto(src, file, sym)
const arg0 = (f, name) => f.calls.find((c) => c.name === name)?.args[0]?.from

describe('expression flow honesty — JS walker', () => {
  it('reassignment -> unknown (not the first write)', async () => {
    const f = await F('function t(a){ let c=a; c=5; return use(c) }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'use')).toBe('unknown')
  })
  it('augmented assignment accumulator -> unknown + counted', async () => {
    const f = await F('function t(a){ let r=""; for(const x of a){ r+=x } return r }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(f.returns[0].from).toBe('unknown')
    expect(f.unresolvedFlows).toBeGreaterThanOrEqual(1)
  })
  it('interpolated template literal -> unknown (not literal)', async () => {
    const f = await F('function t(a){ return wrap(`x${a}`) }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'wrap')).toBe('unknown')
  })
  it('a NON-interpolated template literal is still literal', async () => {
    const f = await F('function t(){ return wrap(`plain`) }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'wrap')).toBe('literal')
  })
  it('reassigned parameter -> unknown', async () => {
    const f = await F('function t(a){ a=g(); return use(a) }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'use')).toBe('unknown')
  })
  it('ANCHOR: single-assignment chain keeps precise provenance', async () => {
    const f = await F('function t(a){ const c=a; return helper(c) }', 't.js', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'helper')).toBe('param:a')
  })
})

describe('expression flow honesty — tree-sitter walkers (py/java/cs)', () => {
  it('py self-referential `b = f(b)` -> unknown (not call:f on its own arg)', async () => {
    const f = await F('def t(a):\n    b = wrap(a)\n    b = fspath(b)\n    return consume(b)', 't.py', { name: 't', startLine: 1, endLine: 4 })
    expect(arg0(f, 'fspath')).toBe('unknown')
    expect(arg0(f, 'consume')).toBe('unknown')
  })
  it('py augmented assignment -> unknown', async () => {
    const f = await F('def t(a):\n    r = 0\n    r += a\n    return use(r)', 't.py', { name: 't', startLine: 1, endLine: 4 })
    expect(arg0(f, 'use')).toBe('unknown')
  })
  it('py default value is NOT captured as a parameter', async () => {
    const f = await F('def t(a, b=DEFAULT):\n    return use(b)', 't.py', { name: 't', startLine: 1, endLine: 2 })
    expect(f.params).toEqual(['a', 'b'])
  })
  it('c# compound assignment -> unknown', async () => {
    const f = await F('class X { int t(int a){ int r = 0; r += a; return use(r); } }', 'X.cs', { name: 't', startLine: 1, endLine: 1 })
    expect(arg0(f, 'use')).toBe('unknown')
  })
  it('call-of-call make(a)(b) does not invent a callee named after the arg', async () => {
    const f = await F('def t(a):\n    return make(a)(a)', 't.py', { name: 't', startLine: 1, endLine: 2 })
    expect(f.calls.map((c) => c.name)).toEqual(['make'])
  })
  it('ANCHOR: py single-assignment keeps precise provenance', async () => {
    const f = await F('def t(a):\n    c = a\n    return helper(c)', 't.py', { name: 't', startLine: 1, endLine: 3 })
    expect(arg0(f, 'helper')).toBe('param:a')
  })
})

describe('expression flow — TypeScript params (insp-004 blind-spot)', () => {
  it('default value and TS parameter property keep their binding name', async () => {
    const f = await F('function t(a: string, b: number = 5): void { g(a); h(b) }', 'f.ts', { name: 't', startLine: 1, endLine: 1 })
    expect(f.params).toEqual(['a', 'b'])
    expect(arg0(f, 'h')).toBe('param:b')
  })
  it('TS constructor parameter property is a named param', async () => {
    const f = await F('class C { constructor(private x: number){ use(x) } }', 'C.ts', { name: 'constructor', startLine: 1, endLine: 1 })
    expect(f.params).toEqual(['x'])
    expect(arg0(f, 'use')).toBe('param:x')
  })
  it('true object destructuring stays (pattern) — out of E1 scope, visible', async () => {
    const f = await F('function t({a, b}){ return g(a) }', 'f.js', { name: 't', startLine: 1, endLine: 1 })
    expect(f.params).toEqual(['(pattern)'])
  })
})

describe('expression flow — nested scopes shadow correctly (insp-004 #20)', () => {
  it('a lambda param shadowing an outer param is not attributed to the outer', async () => {
    // lambda body is its own flow; the OUTER use(x) keeps param:x.
    const f = await F('def t(x):\n    fn = lambda x: g(x)\n    return use(x)', 't.py', { name: 't', startLine: 1, endLine: 3 })
    expect(f.calls.find((c) => c.name === 'g')).toBeUndefined()   // lambda body skipped
    expect(arg0(f, 'use')).toBe('param:x')                        // outer unaffected
  })
  it('a comprehension does not leak a false param attribution', async () => {
    const f = await F('def t(items):\n    return [a for a in items]', 't.py', { name: 't', startLine: 1, endLine: 2 })
    expect(f.calls.map((c) => c.name)).toEqual([])
  })
})
