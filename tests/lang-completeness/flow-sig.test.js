import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { buildGraph } from './_build.js'

// ── ⑦ v1 BAR — signature-change detection → argument-blast alert feed ──
// "You changed f's parameters — these callers/downstream sites receive it."
// Fixture-first. Keys are file+qualifiedName (NOT symbol ids — ids embed the
// line number, which shifts on every edit above the function).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const flow = require(path.resolve(__dirname, '../../packages/core/lib/symbol-flow.cjs'))

const V1 = `
function helper(x) { return x }
function target(a, b) { return helper(a) }
function caller() { return target(1, 2) }
`
// target gains a param `c`; helper untouched; an unrelated edit shifts lines.
const V2 = `
// a new comment shifts every line below
function helper(x) { return x }
function target(a, b, c) { return helper(a) }
function caller() { return target(1, 2) }
`

describe('signature delta (⑦ v1)', () => {
  it('detects a changed signature across rebuilds, line-shift-proof', async () => {
    const g1 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V1 }])
    const prev = flow.collectSignatures(g1)
    const g2 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V2 }])
    const delta = flow.signatureDelta(prev, g2)
    expect(delta.length).toBe(1)                       // ONLY target changed
    expect(delta[0].name).toBe('target')
    expect(delta[0].before).toContain('(a, b)')
    expect(delta[0].after).toContain('(a, b, c)')
  })

  it('PRECISION: unchanged functions never appear (line shift alone is not a change)', async () => {
    const g1 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V1 }])
    const prev = flow.collectSignatures(g1)
    const g2 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V2 }])
    const delta = flow.signatureDelta(prev, g2)
    expect(delta.some((d) => d.name === 'helper')).toBe(false)
    expect(delta.some((d) => d.name === 'caller')).toBe(false)
  })

  it('carries caller count + the changed symbol id for downstream argBlast', async () => {
    const g1 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V1 }])
    const prev = flow.collectSignatures(g1)
    const g2 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V2 }])
    const delta = flow.signatureDelta(prev, g2)
    expect(delta[0].callers).toBe(1)                   // caller() calls target
    expect(g2.nodes.has(delta[0].id)).toBe(true)       // resolvable for argBlast
  })

  it('new/removed functions are NOT signature changes (different concern)', async () => {
    const g1 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V1 }])
    const prev = flow.collectSignatures(g1)
    const V3 = V1 + '\nfunction brandNew(z) { return z }\n'
    const g3 = await buildGraph([{ id: 'fix.js', ext: 'js', content: V3 }])
    expect(flow.signatureDelta(prev, g3).length).toBe(0)
  })
})

describe('signature delta — key-collision precision (round-2 of the live e2e)', () => {
  it('multiple same-named object methods in one file are EXCLUDED, not false-flagged', async () => {
    const A = `
const menu = [
  { click: () => one() },
  { click: () => two() },
]
function real(a) { return a }
`
    const B = `
const menu = [
  { click: () => one() },
  { click: () => twoChanged() },
]
function real(a, b) { return a }
`
    const flow2 = (await import('module')).createRequire(import.meta.url)(
      (await import('path')).resolve('packages/core/lib/symbol-flow.cjs'))
    const g1 = await buildGraph([{ id: 'm.js', ext: 'js', content: A }])
    const prev = flow2.collectSignatures(g1)
    const g2 = await buildGraph([{ id: 'm.js', ext: 'js', content: B }])
    const delta = flow2.signatureDelta(prev, g2)
    // colliding `click` keys never appear; the REAL change still does
    expect(delta.some((d) => d.name === 'click')).toBe(false)
    expect(delta.some((d) => d.name === 'real')).toBe(true)
  })
})
