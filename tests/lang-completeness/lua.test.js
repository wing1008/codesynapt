import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall } from './_build.js'

// ── Symbol-completeness BAR — Lua (minimal) ──
// Own file ON PURPOSE: lua extraction is correct alone, but parsing lua AFTER
// scala in the same process hits the cross-grammar wasm corruption documented
// in misc-langs.test.js (it.fails) + BACKLOG. A separate file = separate
// vitest worker process = clean wasm heap.

const FIX = `
local function leaf()
  return 1
end

local function mid()
  return leaf()                      -- EDGE mid -> leaf
end

local function top()
  return mid() + leaf()              -- EDGE top -> mid, top -> leaf
end
`

describe('symbol-completeness bar — Lua (minimal)', () => {
  it('STATIC RECALL: direct calls', async () => {
    const g = await buildGraph([{ id: 'fix.lua', ext: 'lua', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
  })
})
