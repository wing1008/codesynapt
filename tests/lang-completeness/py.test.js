import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCandidate, refExists } from './_build.js'

// ── Symbol-completeness BAR — Python ──
// Known-answer fixture; every call site labelled. Same bar as js.test.js.

const FIX = `
def leaf():
    return 1

def mid():
    return leaf()            # EDGE mid -> leaf

def top():
    return mid() + leaf()    # EDGE top -> mid, top -> leaf

class Worker:
    def run(self):
        return leaf()        # EDGE run -> leaf

    def helper(self):
        return self.run()    # EDGE helper -> run (self call, type known)

def passes_ref():
    return list(map(leaf, [1, 2]))   # REF: leaf passed as a value, NOT called

def uses_callback(cb):
    return cb()              # DYNAMIC: parameter call — no static target

def dispatch(obj, name):
    fn = getattr(obj, name)
    return fn()              # DYNAMIC: reflection — no static target
`

describe('symbol-completeness bar — Python', () => {
  it('STATIC RECALL: every statically-determinable call edge is present', async () => {
    const g = await buildGraph([{ id: 'fix.py', ext: 'py', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'top', 'leaf')).toBe(true)
    expect(hasCall(g, 'run', 'leaf')).toBe(true)
    // self.run() — receiver type IS known (the enclosing class).
    expect(hasCall(g, 'helper', 'run')).toBe(true)
  })

  it('PRECISION: no phantom edges from refs or dynamic sites', async () => {
    const g = await buildGraph([{ id: 'fix.py', ext: 'py', content: FIX }])
    expect(hasCall(g, 'passes_ref', 'leaf')).toBe(false)   // map(leaf) is a ref
    expect(hasCall(g, 'uses_callback', 'leaf')).toBe(false)
    expect(hasCall(g, 'dispatch', 'leaf')).toBe(false)
    // getattr(...)() must not mis-link to any user fn at all.
    expect(hasCall(g, 'dispatch', 'run')).toBe(false)
  })

  it('REF honesty: a function passed as a value is recorded as used', async () => {
    const g = await buildGraph([{ id: 'fix.py', ext: 'py', content: FIX }])
    expect(refExists(g, 'leaf')).toBe(true)
  })
})
