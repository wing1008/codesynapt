import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCandidate } from './_build.js'

// ── insp-004: two resolveCall / reachability honesty fixes ──
// (1) an untyped member call `x.foo()` must NOT confidently resolve to an
//     imported/same-file FREE function `foo` — wrong dataflow edge.
// (2) a class constructed via `new C()` must not have its constructor (nor the
//     super() chain) labelled dead — the `new` edge lands on the class node.

const js = (id, content) => ({ id, ext: 'js', content })

describe('resolveCall — untyped member call never grabs a free function', () => {
  it('sock.encode(p) is NOT a confident call to the imported free encode', async () => {
    const g = await buildGraph([
      js('codec.js', 'function encode(v){ return v }\nmodule.exports = { encode }\n'),
      js('main.js',
        "const { encode } = require('./codec.js')\n" +
        "function send(payload, sock){ encode('h'); return sock.encode(payload) }\n" +
        "function sendOnly(payload, sock2){ return sock2.encode(payload) }\n" +
        'module.exports = { send, sendOnly }\n'),
    ], { 'main.js': ['codec.js'] })
    expect(hasCall(g, 'sendOnly', 'encode')).toBe(false)   // the wrong edge
    expect(hasCandidate(g, 'sendOnly', 'encode')).toBe(true) // surfaced honestly instead
    expect(hasCall(g, 'send', 'encode')).toBe(true)         // a real bare call still resolves
  })

  it('CJS namespace `ns.fn()` still resolves (no regression)', async () => {
    const g = await buildGraph([
      js('x.cjs', 'function build(o){ return {} }\nmodule.exports = { build }\n'),
      js('c.cjs', "const x = require('./x.cjs')\nfunction startC(){ return x.build({}) }\n"),
    ], { 'c.cjs': ['x.cjs'] })
    expect(hasCall(g, 'startC', 'build')).toBe(true)
  })
})

describe('reachability — a constructed class keeps its constructor alive', () => {
  it('new C() does not leave C.constructor (or its super chain) dead', async () => {
    const g = await buildGraph([
      js('base.js', 'class Shape { constructor(t){ this.t=t }\n  area(){ return 0 } }\nmodule.exports = { Shape }\n'),
      js('circle.js', "const { Shape } = require('./base.js')\nclass Circle extends Shape { constructor(r){ super('circle'); this.r=r } }\nmodule.exports = { Circle }\n"),
      js('app.js', "const { Circle } = require('./circle.js')\nexport function runApp(){ return new Circle(2) }\n"),
    ], { 'circle.js': ['base.js'], 'app.js': ['circle.js'] })
    const dead = g.accounting().dead.map((id) => g.nodes.get(id)?.qualifiedName || id)
    expect(dead.some((d) => /Circle\.constructor/.test(d))).toBe(false)
    expect(dead.some((d) => /Shape\.constructor/.test(d))).toBe(false)
    // genuinely-unused method is still reported (proves we didn't blanket-revive)
    expect(dead.some((d) => /Shape\.area/.test(d))).toBe(true)
  })
})

// insp-004 measure #M1 — a call resolves to the NESTED same-named function
// (scope-exact), not a module-level shadowed one.
describe('#M1 nested-scope shadow resolves to the right function', () => {
  it('call inside outer goes to the nested definition, module-level one stays dead', async () => {
    const g = await buildGraph([js('a.js',
      'export function makeWalker(){\n  function walk(){ return 1 }\n  return walk()\n}\n' +
      'function walk(){ return 2 }\n')])
    const dead = g.accounting().dead.map((id) => { const n = g.nodes.get(id); return n ? n.name + '@' + n.startLine : id })
    expect(dead).toContain('walk@5')        // module-level shadowed, never called
    expect(dead).not.toContain('walk@2')    // nested, called by makeWalker (scope-exact)
  })
})

// insp-004 measure #M1 — tree-sitter languages (position-based scope shadow).
describe('#M1 nested-scope shadow — tree-sitter (py)', () => {
  it('py call inside outer goes to the nested def, not the module-level one', async () => {
    const g = await buildGraph([{ id: 'a.py', ext: 'py', content: 'def make():\n    def walk():\n        return 1\n    return walk()\ndef walk():\n    return 2\n' }])
    let tgt = null
    for (const [s, set] of g.callOut) { const sn = g.nodes.get(s); if (sn && sn.name === 'make') for (const t of set) { const tn = g.nodes.get(t); if (tn && tn.name === 'walk') tgt = tn.startLine } }
    expect(tgt).toBe(2)   // nested walk@2, not module walk@5
  })
})
