import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, refExists, dynamicSiteForms } from './_build.js'

// ── Symbol-completeness BAR — JavaScript (the template language) ──
// A known-answer fixture: every call site is labelled. The built call graph must
// match EXACTLY. This is the committed, reproducible anchor — "JS passes" means
// `npm test` is green, not an assistant's claim. See docs/design-symbol-
// completeness.md. The other symbol languages follow this shape.

const FIX = `
function leaf() { return 1 }
function mid() { return leaf() }            // EDGE mid -> leaf
function top() { return mid() + leaf() }    // EDGE top -> mid, top -> leaf
const arrow = () => leaf()                  // EDGE arrow -> leaf
function usesCallback(cb) { return cb() }   // DYNAMIC SITE: local-callback
function passesRef() { return [1].map(leaf) } // REF: leaf passed as a value, NOT called
function dispatch() {
  const o = { go() { return leaf() } }      // EDGE go -> leaf
  const k = 'go'
  return o[k]()                             // DYNAMIC SITE: computed-member
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
    expect(hasCall(g, 'passesRef', 'leaf')).toBe(false)   // map(leaf) is a ref
    expect(hasCall(g, 'usesCallback', 'leaf')).toBe(false)
    expect(hasCall(g, 'dispatch', 'leaf')).toBe(false)
    // o[k]() must NOT resolve via the subscript variable name `k`.
    expect(hasCall(g, 'dispatch', 'k')).toBe(false)
  })

  it('REF honesty: a function passed as a value is recorded as used (not dead)', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    expect(refExists(g, 'leaf')).toBe(true)
  })

  it('ZERO SILENCE: every dynamic call site is recorded, none dropped', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    expect(dynamicSiteForms(g, 'usesCallback')).toContain('local-callback')
    expect(dynamicSiteForms(g, 'dispatch')).toContain('computed-member')
  })
})
