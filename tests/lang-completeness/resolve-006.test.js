import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCandidate } from './_build.js'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sv = require(path.resolve(__dirname, '../../packages/core/lib/symbol-views.cjs'))
const js = (id, content) => ({ id, ext: 'js', content })

// insp-004 #49 — a namespace member call to a builtin-named export resolves.
describe('#49 namespace member call to a builtin-named export', () => {
  it('registry.remove() resolves to the module export (not declined as builtin)', async () => {
    const g = await buildGraph([
      js('registry.cjs', 'function remove(k,i){}\nfunction touch(){}\nmodule.exports={remove,touch}\n'),
      js('user.cjs', "const registry=require('./registry.cjs')\nfunction cleanup(){ registry.remove('v',1); registry.touch() }\n"),
    ], { 'user.cjs': ['registry.cjs'] })
    expect(hasCall(g, 'cleanup', 'remove')).toBe(true)
    expect(hasCall(g, 'cleanup', 'touch')).toBe(true)
  })
  it('an unknown-receiver .remove() is still NOT resolved (no false edge)', async () => {
    const g = await buildGraph([
      js('a.cjs', 'function remove(x){}\nmodule.exports={remove}\n'),
      js('b.cjs', 'function f(set){ set.remove(1) }\n'),
    ], { 'b.cjs': ['a.cjs'] })
    expect(hasCall(g, 'f', 'remove')).toBe(false)
  })
})

// insp-004 #50 — candidate (dynamic-dispatch) edges never cross languages.
describe('#50 candidates do not cross languages', () => {
  it('a JS call name does not pull Java/Python same-named symbols as candidates', async () => {
    const g = await buildGraph([
      js('a.js', 'function walk(){ handlers[x]() }\n'),
      { id: 'Sub.java', ext: 'java', content: 'class Sub { void walk(){} void main(){ walk(); } }\n' },
      { id: 'sub.py', ext: 'py', content: 'def walk():\n    pass\n' },
    ])
    const c = g.candidatesFor('a.js', 'walk')
    expect(c.candidates.every((n) => n.file.endsWith('.js'))).toBe(true)
  })
})

// insp-004 #41 — a dynamic-only function surfaces its dynamic sites in callees.
describe('#41 dynamic call sites visible in the callees view', () => {
  it('handlers[name]() shows dynamicSites instead of a bare empty callee list', async () => {
    const g = await buildGraph([js('d.js', 'function dispatch(name){ return handlers[name]() }\n')])
    let id = null
    for (const n of g.nodes.values()) if (n.name === 'dispatch') id = n.id
    const r = sv.handleSymbolView(g, 'callees', { id }, {})
    expect(r.body.callees.length).toBe(0)
    expect(r.body.dynamicSites).toBe(1)
    expect(r.body.dynamicNote).toMatch(/dynamic call site/i)
  })
})

// insp-004 #51 — inline callbacks defined as values are not dead.
describe('#51 inline value callbacks are possible, not dead', () => {
  it('object-property/method callbacks (and what they call) are not in the dead set', async () => {
    const g = await buildGraph([js('server.js',
      'export function start(){ makeServer({ verifyClient: (info) => ok(info), onOpen: function(){ log() } }) }\n' +
      'function ok(i){ return true }\nfunction log(){}\nfunction reallyDead(){ return 1 }\n')])
    const dead = g.accounting().dead.map((id) => g.nodes.get(id)?.name)
    expect(dead).not.toContain('verifyClient')   // inline arrow callback
    expect(dead).not.toContain('onOpen')         // inline function-expression callback
    expect(dead).not.toContain('ok')             // called BY a callback — propagates
    expect(dead).not.toContain('log')
    expect(dead).toContain('reallyDead')         // genuinely unused free function stays dead
  })
})
