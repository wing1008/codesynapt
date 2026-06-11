import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, refExists, dynamicSiteForms } from './_build.js'

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
    return getattr(obj, name)()   # DYNAMIC SITE: call-result callee (reflection)
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

  it('ZERO SILENCE: getattr(...)() dynamic site is recorded, not dropped', async () => {
    const g = await buildGraph([{ id: 'fix.py', ext: 'py', content: FIX }])
    expect(dynamicSiteForms(g, 'dispatch')).toContain('indirect')
  })
})

describe('symbol-completeness bar — Python super() resolution (Leg A)', () => {
  const SUPER_FIX = `
class Base:
    def setup(self):
        return 1

class Child(Base):
    def init(self):
        return super().setup()      # EDGE init -> Base.setup (statically known)

class FromExternal(SomeExternalLib):
    def __init__(self):
        super().__init__()          # base is EXTERNAL: decline honestly,
                                    # NEVER spray candidates to sibling __init__s

class Sibling:
    def __init__(self):
        pass
`
  it('super().method() resolves PRECISELY to the base class method', async () => {
    const g = await buildGraph([{ id: 'sup.py', ext: 'py', content: SUPER_FIX }])
    expect(hasCall(g, 'init', 'Base.setup')).toBe(true)
  })

  it('external-base super(): no phantom, no candidate spray, counted decline', async () => {
    const g = await buildGraph([{ id: 'sup.py', ext: 'py', content: SUPER_FIX }])
    // No confident edge to anything (the real target is external).
    expect(hasCall(g, 'FromExternal.__init__', 'Sibling.__init__')).toBe(false)
    // CRITICAL: no candidate to the sibling's __init__ either — the real
    // target is NOT among user candidates, so a spray would be a lie.
    let sprayed = false
    for (const [src, set] of g.candOut) {
      const sn = g.nodes.get(src)
      if (sn?.qualifiedName !== 'FromExternal.__init__') continue
      for (const t of set) if (g.nodes.get(t)?.qualifiedName === 'Sibling.__init__') sprayed = true
    }
    expect(sprayed).toBe(false)
    // Counted, not silent.
    expect(g.stats().declineReasons['super-external']).toBeGreaterThanOrEqual(1)
  })
})

describe('Python super() — dotted external base (inspection fix #2)', () => {
  const FIX = `
class Module:
    def __init__(self):
        pass

class Net(nn.Module):
    def __init__(self):
        super().__init__()
`
  it('never phantom-links super() on nn.Module to a same-named USER class', async () => {
    const g = await buildGraph([{ id: 'net.py', ext: 'py', content: FIX }])
    expect(hasCall(g, 'Net.__init__', 'Module.__init__')).toBe(false)
    expect(g.stats().declineReasons['super-external']).toBeGreaterThanOrEqual(1)
  })
})

describe('Python dotted base — extends phantom (round-2 inspection)', () => {
  const FIX = `
class Module:
    def helper(self):
        return 1

class Net(nn.Module):
    def __init__(self):
        pass

def use():
    net: Net = Net()
    return net.helper()
`
  it('nn.Module never creates an extends edge to a same-named USER class (nor MRO phantom calls)', async () => {
    const g = await buildGraph([{ id: 'net.py', ext: 'py', content: FIX }])
    let phantomExtends = false
    for (const e of g.edges) {
      if (e.kind !== 'extends') continue
      const s = g.nodes.get(e.source), t = g.nodes.get(e.target)
      if (s?.name === 'Net' && t?.name === 'Module') phantomExtends = true
    }
    expect(phantomExtends).toBe(false)
    // downstream: net.helper() must NOT confidently resolve to decoy Module.helper
    expect(hasCall(g, 'use', 'Module.helper')).toBe(false)
  })
})
