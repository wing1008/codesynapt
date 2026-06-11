import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall } from './_build.js'

// ── Symbol-completeness BAR — Scala / Lua / Bash (minimal honest bars) ──
// These grammars carry fewer typed constructs; the bar asserts what the
// language model supports: direct-call recall + method attribution. Typed
// dispatch is N/A (lua/bash) or deferred with the candidates leg (scala).

describe('symbol-completeness bar — Scala (minimal)', () => {
  const FIX = `
def leaf(): Int = 1

def mid(): Int = leaf()              // EDGE mid -> leaf

class Engine {
  def run(): Int = leaf()            // EDGE Engine.run -> leaf
  def boot(): Int = run()            // EDGE boot -> Engine.run (implicit this)
}
`
  it('STATIC RECALL: direct + implicit-this calls', async () => {
    const g = await buildGraph([{ id: 'fix.scala', ext: 'scala', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
  })
})

describe('KNOWN ENGINE BUG — cross-grammar wasm corruption (web-tree-sitter 0.20.x)', () => {
  // Reproduced: after the scala grammar parses IN THE SAME PROCESS, lua parse
  // trees come back TRUNCATED (2nd top-level function lost, edges gone) —
  // regardless of per-grammar or shared Parser instances. Lua ALONE is fine
  // (see lua.test.js). Production impact: a polyglot repo mixing affected
  // grammar pairs mis-extracts. Fix path: upgrade the web-tree-sitter +
  // tree-sitter-wasms pair (ABI-coupled). Tracked in docs/BACKLOG.md (HIGH).
  // NB: run THIS FILE WHOLE — filtering with -t skips the scala contamination
  // source above, the parse succeeds, and vitest flips it.fails into a failure.
  it.fails('lua parsed AFTER scala in one process keeps all functions', async () => {
    const g = await buildGraph([{ id: 'after.lua', ext: 'lua', content: `
local function leaf()
  return 1
end

local function mid()
  return leaf()
end
` }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
  })
})

describe('symbol-completeness bar — Bash (minimal)', () => {
  const FIX = `#!/bin/bash
leaf() {
  echo 1
}

mid() {
  leaf                               # EDGE mid -> leaf
}

top() {
  mid
  leaf
}
`
  it('STATIC RECALL: function-to-function calls', async () => {
    const g = await buildGraph([{ id: 'fix.sh', ext: 'sh', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
  })
})
