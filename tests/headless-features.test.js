import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'

// lib/control-server.cjs is CommonJS; use createRequire for ESM test.
const require = createRequire(import.meta.url)
const { createControlServer } = require('../packages/core/lib/control-server.cjs')

// These tests verify the previously desktop-only features (trace / tour /
// timeline / changes / diff / symbol explore) are now reachable from the
// HEADLESS control server (the `cs serve` + in-process MCP path).

let tmpRoot, scanner, lib, libWrite

const TOKEN = 'headless-test-token'

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-headless-'))
  fs.mkdirSync(path.join(tmpRoot, 'src'))
  // A small but real call graph so /symbol/explore has something to classify.
  fs.writeFileSync(path.join(tmpRoot, 'src/index.ts'),
    `import { authenticate } from './auth'\nexport function main() { return authenticate('u', 'p') }\n`)
  fs.writeFileSync(path.join(tmpRoot, 'src/auth.ts'),
    `export function authenticate(user: string, pass: string) { return validate(user) }\n` +
    `export function validate(user: string) { return user.length > 0 }\n`)
  fs.writeFileSync(path.join(tmpRoot, 'src/util.ts'), `export const ANSWER = 42\n`)

  scanner = new Scanner(tmpRoot)
  await new Promise((resolve) => { scanner.once('snapshot', resolve); scanner.start() })
  lib = createControlServer({ scanner, getCurrentRoot: () => tmpRoot })
  // A second instance WITH an auth token so we can exercise write → trace.
  libWrite = createControlServer({ scanner, getCurrentRoot: () => tmpRoot, authToken: TOKEN })
})

afterAll(() => {
  try { scanner.stop() } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

// Call helper that returns { status, body } and supports headers (for auth) and
// a JSON body (for POST). Mirrors control-server.test.js's fake req/res but also
// captures the status code (needed for write/trace assertions).
function call(server, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve) => {
    const captured = []
    const fakeReq = {
      method, url: urlPath,
      headers: { host: '127.0.0.1', ...(headers || {}) },
      on(ev, fn) {
        if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') setImmediate(fn)
      },
    }
    const fakeRes = {
      statusCode: 200,
      writeHead(s) { captured.push(s); this.statusCode = s },
      end(b) {
        let parsed
        try { parsed = JSON.parse(b) } catch { parsed = b }
        resolve({ status: captured[0] ?? this.statusCode, body: parsed })
      },
      on() {},
    }
    server.handleControlRequest(fakeReq, fakeRes)
  })
}

// libWrite has an authToken → EVERY request (read + write) needs the Bearer
// header. This helper injects it so we exercise trace/changes state on the
// same (authenticated) instance the writes went through.
function callW(method, urlPath, opts = {}) {
  // Convenience: callW('/path') defaults to GET; callW('POST', '/path', opts).
  if (typeof method === 'string' && method.startsWith('/')) { opts = urlPath || {}; urlPath = method; method = 'GET' }
  return call(libWrite, method, urlPath, {
    ...opts,
    headers: { authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  })
}

describe('headless: endpoint catalog advertises ported routes', () => {
  it('GET / lists trace/tour/timeline/changes/explore', async () => {
    const { body } = await call(lib, 'GET', '/')
    const eps = body.endpoints.join(' ')
    expect(eps).toContain('GET /trace')
    expect(eps).toContain('GET /trace/stats')
    expect(eps).toContain('GET /trace/sessions')
    expect(eps).toContain('GET /tour')
    expect(eps).toContain('GET /timeline')
    expect(eps).toContain('GET /changes')
    expect(eps).toContain('GET /symbol/explore?q=')
  })
})

describe('headless: TRACE (record on write, then serve all 6 routes)', () => {
  it('write through the server records a trace entry visible at GET /trace', async () => {
    const target = 'src/util.ts'
    const newContent = 'export const ANSWER = 43\n'
    const w = await call(libWrite, 'POST', '/write/' + target, {
      body: { content: newContent },
      headers: { authorization: 'Bearer ' + TOKEN },
    })
    expect(w.status).toBe(200)
    expect(w.body.ok).toBe(true)

    const t = await callW('/trace')
    expect(t.status).toBe(200)
    expect(Array.isArray(t.body.events)).toBe(true)
    const entry = t.body.events.find((e) => e.id === target && e.tool === 'write')
    expect(entry).toBeDefined()
    expect(typeof entry.ts).toBe('number')
    // restore file
    fs.writeFileSync(path.join(tmpRoot, target), 'export const ANSWER = 42\n')
  })

  it('GET /trace/stats reflects the recorded write', async () => {
    const r = await callW('/trace/stats')
    expect(r.status).toBe(200)
    expect(r.body.eventCount).toBeGreaterThanOrEqual(1)
    expect(r.body.byTool.write).toBeGreaterThanOrEqual(1)
    expect(typeof r.body.sessionId).toBe('number')
  })

  it('GET /trace/sessions lists the on-disk session .jsonl', async () => {
    const r = await callW('/trace/sessions')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.sessions)).toBe(true)
    expect(r.body.sessions.length).toBeGreaterThanOrEqual(1)
    expect(r.body.sessions[0]).toHaveProperty('sessionId')
    expect(r.body.sessions[0]).toHaveProperty('eventCount')
    // The .jsonl exists on disk in the mirrored desktop location.
    const traceDir = path.join(tmpRoot, '.codesynapt', 'traces')
    const files = fs.readdirSync(traceDir).filter((f) => /^session-\d+\.jsonl$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /trace/session/:id reads a session back with stats', async () => {
    const list = await callW('/trace/sessions')
    const id = list.body.sessions[0].sessionId
    const r = await callW('/trace/session/' + id)
    expect(r.status).toBe(200)
    expect(r.body.sessionId).toBe(id)
    expect(Array.isArray(r.body.events)).toBe(true)
    expect(r.body.stats).toBeDefined()
    expect(r.body.meta).toBeDefined() // meta line parsed
  })

  it('POST /trace/export?path= writes a JSON export', async () => {
    const out = path.join(tmpRoot, 'trace-export.json')
    const r = await callW('POST', '/trace/export?path=' + encodeURIComponent(out))
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(fs.existsSync(out)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(parsed).toHaveProperty('events')
    expect(parsed).toHaveProperty('stats')
  })

  it('POST /trace/clear rolls a new session', async () => {
    const before = await callW('/trace')
    const r = await callW('POST', '/trace/clear')
    expect(r.status).toBe(200)
    expect(typeof r.body.newSessionId).toBe('number')
    expect(r.body.newSessionId).not.toBe(before.body.sessionId)
    const after = await callW('/trace')
    expect(after.body.events.length).toBe(0) // in-memory cleared
  })
})

describe('headless: CHANGES + DIFF', () => {
  it('write through the server appears in GET /changes', async () => {
    const target = 'src/util.ts'
    await call(libWrite, 'POST', '/write/' + target, {
      body: { content: 'export const ANSWER = 99\n' },
      headers: { authorization: 'Bearer ' + TOKEN },
    })
    const r = await callW('/changes')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    const ch = r.body.find((c) => c.id === target)
    expect(ch).toBeDefined()
    expect(ch).toHaveProperty('count')
    expect(ch).toHaveProperty('sizeDelta')
  })

  it('GET /changes/:id returns a line diff', async () => {
    const target = 'src/util.ts'
    // mutate again so before != after for a non-trivial diff
    await call(libWrite, 'POST', '/write/' + target, {
      body: { content: 'export const ANSWER = 100\nexport const EXTRA = 1\n' },
      headers: { authorization: 'Bearer ' + TOKEN },
    })
    const r = await callW('/changes/' + target)
    expect(r.status).toBe(200)
    expect(r.body.id).toBe(target)
    expect(typeof r.body.before).toBe('string')
    expect(typeof r.body.after).toBe('string')
    expect(Array.isArray(r.body.lines)).toBe(true)
    expect(r.body.lines.some((l) => l.tag === 'add')).toBe(true)
    fs.writeFileSync(path.join(tmpRoot, target), 'export const ANSWER = 42\n')
  })

  it('GET /changes/:id 404s for a file never changed', async () => {
    const r = await call(lib, 'GET', '/changes/src/never-touched.ts')
    expect(r.status).toBe(404)
  })
})

describe('headless: TOUR', () => {
  it('GET /tour returns a stop list', async () => {
    const r = await call(lib, 'GET', '/tour')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.stops)).toBe(true)
    expect(r.body.totalFiles).toBeGreaterThan(0)
    // index.ts should be detected as an entry stop.
    const entry = r.body.stops.find((s) => s.kind === 'entry')
    expect(entry).toBeDefined()
    expect(entry.id).toContain('index')
  })
})

describe('headless: TIMELINE', () => {
  it('GET /timeline returns a git-shaped result (isGit flag present)', async () => {
    const r = await call(lib, 'GET', '/timeline')
    expect(r.status).toBe(200)
    // The temp project is NOT a git repo → faithful "not a git repository"
    // shape (isGit:false). This is the same response the desktop returns;
    // we assert the shape, not a fabricated commit list.
    expect(r.body).toHaveProperty('isGit')
    if (r.body.isGit === false) {
      expect(r.body.error).toMatch(/not a git repository|no folder loaded/)
    } else {
      expect(Array.isArray(r.body.points)).toBe(true)
      expect(r.body).toHaveProperty('commitCount')
    }
  })

  it('GET /timeline on a real git repo returns commit points', async () => {
    // Build a tiny throwaway git repo to prove the git path works end-to-end.
    const { execFileSync } = require('child_process')
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-git-'))
    let gitOk = true
    try {
      const run = (args) => execFileSync('git', args, { cwd: gitRoot, stdio: 'pipe' })
      run(['init'])
      run(['config', 'user.email', 't@t.t'])
      run(['config', 'user.name', 'T'])
      fs.writeFileSync(path.join(gitRoot, 'a.ts'), 'export const a = 1\n')
      run(['add', '.'])
      run(['commit', '-m', 'add a'])
    } catch { gitOk = false }
    if (!gitOk) { try { fs.rmSync(gitRoot, { recursive: true, force: true }) } catch {}; return }

    const gscanner = new Scanner(gitRoot)
    await new Promise((resolve) => { gscanner.once('snapshot', resolve); gscanner.start() })
    const glib = createControlServer({ scanner: gscanner, getCurrentRoot: () => gitRoot })
    const r = await call(glib, 'GET', '/timeline')
    expect(r.status).toBe(200)
    expect(r.body.isGit).toBe(true)
    expect(Array.isArray(r.body.points)).toBe(true)
    expect(r.body.commitCount).toBeGreaterThanOrEqual(1)
    expect(r.body.points[0].addedFiles).toContain('a.ts')
    try { gscanner.stop() } catch {}
    try { fs.rmSync(gitRoot, { recursive: true, force: true }) } catch {}
  })
})

describe('headless: SYMBOL EXPLORE (offline keyword fallback)', () => {
  it('GET /symbol/explore?q= returns the classify shape', async () => {
    const r = await call(lib, 'GET', '/symbol/explore?q=' + encodeURIComponent('authenticate'))
    expect(r.status).toBe(200)
    expect(r.body.mode).toBe('classify')
    expect(Array.isArray(r.body.keywords)).toBe(true)
    expect(r.body.keywords.length).toBeGreaterThan(0)
    expect(r.body.groups).toBeDefined()
    expect(r.body.counts).toBeDefined()
    expect(Array.isArray(r.body.snippets)).toBe(true)
    // offline: embeddings were never loaded → embeddingReady is false.
    expect(r.body.embeddingReady).toBe(false)
    // The 'authenticate' symbol should surface somewhere in the grouped output.
    const allEntries = Object.values(r.body.groups).flat()
    const hit = allEntries.find((e) => (e.name || '').toLowerCase() === 'authenticate')
    expect(hit).toBeDefined()
  })

  it('GET /symbol/explore with no usable keywords returns the empty-classify note', async () => {
    const r = await call(lib, 'GET', '/symbol/explore?q=' + encodeURIComponent('the a of'))
    expect(r.status).toBe(200)
    expect(r.body.mode).toBe('classify')
    expect(r.body.note).toMatch(/no usable keywords/)
  })
})
