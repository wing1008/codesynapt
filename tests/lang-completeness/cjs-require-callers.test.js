import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── insp-004: CJS destructure-require calls produce caller edges ──
// `const { f } = require('./mod'); f()` is the dominant CommonJS import-and-call
// form (Express/Electron/CLI codebases). It was misfiled as a local-callback
// dynamic site — the binding kind is 'const' (an ESM import is 'module' and
// bypassed the guard), so a function reachable through destructure-require
// reported ZERO callers / zero function-blast impact. The fix lets a
// require()-initialized binding resolve cross-file like an ESM named import,
// WITHOUT loosening the local-callback guard for genuine value bindings.

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { buildGraph, hasCall } = await import(path.resolve(__dirname, './_build.js'))

const cjs = (id, content) => ({ id, ext: 'cjs', content })

describe('CJS require — destructure call sites are real callers', () => {
  it('destructure-require call links to the imported function', async () => {
    const g = await buildGraph([
      cjs('x.cjs', 'function createControlServer(o){ return {} }\nmodule.exports = { createControlServer }\n'),
      cjs('b.cjs', "const { createControlServer } = require('./x.cjs')\nfunction startB(){ return createControlServer({}) }\n"),
    ], { 'b.cjs': ['x.cjs'] })
    expect(hasCall(g, 'startB', 'createControlServer')).toBe(true)
  })

  it('namespace-require member call still links (no regression)', async () => {
    const g = await buildGraph([
      cjs('x.cjs', 'function createControlServer(o){ return {} }\nmodule.exports = { createControlServer }\n'),
      cjs('c.cjs', "const x = require('./x.cjs')\nfunction startC(){ return x.createControlServer({}) }\n"),
    ], { 'c.cjs': ['x.cjs'] })
    expect(hasCall(g, 'startC', 'createControlServer')).toBe(true)
  })

  it('a genuine callback PARAMETER of the same name does NOT cross-file link (no false edge)', async () => {
    const g = await buildGraph([
      cjs('p.cjs', 'function handler(){ return 1 }\nmodule.exports = { handler }\n'),
      cjs('q.cjs', 'function run(handler){ return handler() }\n'),
    ], { 'q.cjs': ['p.cjs'] })
    expect(hasCall(g, 'run', 'handler')).toBe(false)
  })

  it('a require()-initialized binding that is NOT imported elsewhere does not invent an edge', async () => {
    // require of an external/unknown module — no project symbol of that name.
    const g = await buildGraph([
      cjs('z.cjs', "const { join } = require('path')\nfunction useJoin(){ return join('a', 'b') }\n"),
    ], { 'z.cjs': [] })
    // 'join' is not a project symbol -> no confident call edge fabricated.
    expect(hasCall(g, 'useJoin', 'join')).toBe(false)
  })
})

// insp-004 0.0.8 — aliased import/require call sites resolve to the real export.
describe('aliased import resolves to the original export', () => {
  it('CJS `const { orig: local } = require(); local()` links to orig', async () => {
    const g = await buildGraph([
      cjs('x.cjs', 'function createControlServer(o){}\nmodule.exports={createControlServer}\n'),
      cjs('d.cjs', "const { createControlServer: mk } = require('./x.cjs')\nfunction startD(){ return mk({}) }\n"),
    ], { 'd.cjs': ['x.cjs'] })
    expect(hasCall(g, 'startD', 'createControlServer')).toBe(true)
  })
  it('a same-named LOCAL value (not an import) does not over-resolve', async () => {
    const g = await buildGraph([
      cjs('x.cjs', 'function createControlServer(o){}\nmodule.exports={createControlServer}\n'),
      cjs('c.cjs', 'function f(){ const mk = 5; return mk }\n'),
    ])
    expect(hasCall(g, 'f', 'createControlServer')).toBe(false)
  })
})
