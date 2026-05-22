import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../scanner.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'

// lib/control-server.cjs is CommonJS; use createRequire for ESM test.
const require = createRequire(import.meta.url)
const { createControlServer } = require('../lib/control-server.cjs')

let tmpRoot, scanner, lib

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-srv-'))
  fs.mkdirSync(path.join(tmpRoot, 'src'))
  fs.writeFileSync(path.join(tmpRoot, 'src/main.ts'), `import { foo } from './foo'`)
  fs.writeFileSync(path.join(tmpRoot, 'src/foo.ts'), `export const foo = 1`)
  fs.writeFileSync(path.join(tmpRoot, 'src/db.ts'), `const k = process.env.STRIPE_KEY`)
  fs.writeFileSync(path.join(tmpRoot, '.env'), 'STRIPE_KEY=x\nUNUSED_KEY=y')

  scanner = new Scanner(tmpRoot)
  await new Promise((resolve) => { scanner.once('snapshot', resolve); scanner.start() })
  lib = createControlServer({ scanner, getCurrentRoot: () => tmpRoot })
})

afterAll(() => {
  try { scanner.stop() } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

// Helper: call handleControlRequest with a fake req/res, return parsed json.
function call(method, urlPath, body) {
  return new Promise((resolve) => {
    let captured = ''
    const fakeReq = {
      method, url: urlPath, headers: { host: '127.0.0.1' },
      on(ev, fn) {
        if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body)))
        if (ev === 'end')          setImmediate(fn)
      },
    }
    const fakeRes = {
      writeHead() {}, end(b) { captured = b; resolve(JSON.parse(captured)) },
    }
    lib.handleControlRequest(fakeReq, fakeRes)
  })
}

describe('control-server endpoints', () => {
  it('GET / returns endpoint catalog', async () => {
    const r = await call('GET', '/')
    expect(r.name).toBe('filegraph3d')
    expect(Array.isArray(r.endpoints)).toBe(true)
  })

  it('GET /health', async () => {
    const r = await call('GET', '/health')
    expect(r.ok).toBe(true)
    expect(r.fileCount).toBeGreaterThan(0)
  })

  it('GET /summary returns project shape', async () => {
    const r = await call('GET', '/summary')
    expect(r.fileCount).toBeGreaterThan(0)
    expect(r.meta).toBeDefined()
    expect(r.meta.tokenEstimate).toBeGreaterThan(0)
  })

  it('GET /env cross-references declared vs used', async () => {
    const r = await call('GET', '/env')
    expect(r.vars).toBeDefined()
    const stripe = r.vars.find((v) => v.var === 'STRIPE_KEY')
    expect(stripe).toBeDefined()
    expect(stripe.status).toBe('ok')   // declared + used
    const unused = r.vars.find((v) => v.var === 'UNUSED_KEY')
    expect(unused.status).toBe('unused')
  })

  it('GET /vendors returns candidate list (P1·2)', async () => {
    const r = await call('GET', '/vendors')
    expect(r).toHaveProperty('candidates')
    expect(r).toHaveProperty('count')
  })

  it('GET /blast/:id returns BFS impact', async () => {
    const r = await call('GET', '/blast/src/foo.ts?depth=3&dir=users')
    expect(r.seed).toBe('src/foo.ts')
    expect(r.direction).toBe('users')
    expect(r.totalFiles).toBeGreaterThanOrEqual(1)
  })

  it('GET /safety/:id returns level', async () => {
    const r = await call('GET', '/safety/src/foo.ts')
    expect(['safe', 'caution', 'risky']).toContain(r.level)
  })

  it('GET /preflight returns overall verdict', async () => {
    const r = await call('GET', '/preflight')
    expect(['ok', 'warn', 'fail']).toContain(r.overall)
    expect(Array.isArray(r.checks)).toBe(true)
  })

  it('unknown action via /summary?action=nope (via /preflight is fine — /unknown 404)', async () => {
    const r = await call('GET', '/this-does-not-exist')
    expect(r.error).toBeDefined()
  })
})
