import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'

// lib/control-server.cjs is CommonJS; use createRequire for ESM test.
const require = createRequire(import.meta.url)
const { createControlServer } = require('../packages/core/lib/control-server.cjs')

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

describe('control-server auth + audit (P4·6)', () => {
  it('rejects requests without Bearer when authToken set', async () => {
    const lib2 = createControlServer({
      scanner, getCurrentRoot: () => tmpRoot,
      authToken: 'secret-token-xyz',
    })
    const res = await new Promise((resolve) => {
      const captured = []
      lib2.handleControlRequest(
        { method: 'GET', url: '/health', headers: { host: '127.0.0.1' }, on() {} },
        { writeHead(s) { captured.push(s) }, end(b) { resolve({ status: captured[0], body: b }) },
          on() {} },
      )
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with matching Bearer token', async () => {
    const lib2 = createControlServer({
      scanner, getCurrentRoot: () => tmpRoot,
      authToken: 'secret-token-xyz',
    })
    const res = await new Promise((resolve) => {
      const captured = []
      lib2.handleControlRequest(
        { method: 'GET', url: '/health', headers: { host: '127.0.0.1', authorization: 'Bearer secret-token-xyz' }, on() {} },
        { writeHead(s) { captured.push(s) }, end(b) { resolve({ status: captured[0], body: JSON.parse(b) }) },
          on() {} },
      )
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('writes audit log when auditLogDir is set', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-audit-'))
    const lib2 = createControlServer({
      scanner, getCurrentRoot: () => tmpRoot,
      auditLogDir: auditDir,
    })
    // fake req/res with finish hook
    const listeners = []
    await new Promise((resolve) => {
      lib2.handleControlRequest(
        { method: 'GET', url: '/health', headers: { host: '127.0.0.1' }, on() {} },
        {
          statusCode: 200,
          writeHead(s) { this.statusCode = s },
          end() { for (const fn of listeners) fn(); resolve() },
          on(ev, fn) { if (ev === 'finish') listeners.push(fn) },
        },
      )
    })
    // give the audit append a tick
    await new Promise((r) => setTimeout(r, 10))
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    const content = fs.readFileSync(path.join(auditDir, files[0]), 'utf8').trim()
    const entry = JSON.parse(content.split('\n')[0])
    expect(entry.path).toBe('/health')
    expect(entry.method).toBe('GET')
    expect(entry.status).toBe(200)
    try { fs.rmSync(auditDir, { recursive: true, force: true }) } catch {}
  })
})

describe('control-server endpoints', () => {
  it('GET / returns endpoint catalog', async () => {
    const r = await call('GET', '/')
    expect(r.name).toBe('codesynapt')
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

  it('GET /safety/:id?locale=ko returns Korean reasons (P3·2)', async () => {
    const r = await call('GET', '/safety/src/foo.ts?locale=ko')
    expect(['safe', 'caution', 'risky']).toContain(r.level)
    const text = (r.reasons || []).join(' ') + ' ' + (r.advice || '')
    expect(text).toMatch(/[가-힣]/)
  })

  it('GET /preflight?locale=ko returns Korean check titles (P3·2)', async () => {
    const r = await call('GET', '/preflight?locale=ko')
    const text = (r.checks || []).map((c) => (c.title || '') + ' ' + (c.detail || '')).join(' ')
    expect(text).toMatch(/[가-힣]/)
  })

  it('GET /safety/:id default locale = en', async () => {
    const r = await call('GET', '/safety/src/foo.ts')
    const text = (r.reasons || []).join(' ') + ' ' + (r.advice || '')
    expect(text).not.toMatch(/[가-힣]/)
  })

  it('GET /suggest default = English advice', async () => {
    const r = await call('GET', '/suggest?top=20')
    const text = (r.suggestions || []).map((s) => (s.title || '') + ' ' + (s.advice || '')).join(' ')
    expect(text).not.toMatch(/[가-힣]/)
  })

  it('GET /suggest?locale=ko = Korean advice (P3·2 ext)', async () => {
    const r = await call('GET', '/suggest?top=20&locale=ko')
    const text = (r.suggestions || []).map((s) => (s.title || '') + ' ' + (s.advice || '')).join(' ')
    expect(text).toMatch(/[가-힣]/)
  })

  it('GET /file/:id includes SHA-256 contentHash (P4·3)', async () => {
    const r = await call('GET', '/file/src/foo.ts')
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
    // hash matches actual content
    const expected = require('crypto').createHash('sha256').update(r.content).digest('hex')
    expect(r.contentHash).toBe(expected)
  })

  it('GET /node/:id includes contentHash', async () => {
    const r = await call('GET', '/node/src/foo.ts')
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
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
