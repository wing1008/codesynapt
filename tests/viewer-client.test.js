// Headless verification of the multi-session VIEWER core (design ④).
// Spins up a REAL control-server over a real socket (listen(0)), registers a
// daemon + session in an isolated CS_HOME, and drives ViewerClient through the
// full lifecycle: attach → bootstrap → delta poll (graph change + session-tagged
// trace) → viewer-lease heartbeat → epoch re-bootstrap → detach. No Electron,
// no renderer — this is the dangerous part of ④ made testable.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'

const require = createRequire(import.meta.url)

// Isolate the registry root BEFORE requiring registry/viewer-client (registry
// caches ROOT at module load from process.env.CS_HOME).
const CS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-viewer-home-'))
process.env.CS_HOME = CS_HOME

const { createControlServer } = require('../packages/core/lib/control-server.cjs')
const registry = require('../packages/core/lib/registry.cjs')
const { listSessions, ViewerClient, httpJson } = require('../packages/core/lib/viewer-client.cjs')

let tmpRoot, scanner, lib, server, port, phash

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-viewer-proj-'))
  fs.mkdirSync(path.join(tmpRoot, 'src'))
  fs.writeFileSync(path.join(tmpRoot, 'src/main.ts'), `import { foo } from './foo'`)
  fs.writeFileSync(path.join(tmpRoot, 'src/foo.ts'), `export const foo = 1`)

  scanner = new Scanner(tmpRoot)
  await new Promise((resolve) => { scanner.once('snapshot', resolve); scanner.start() })
  lib = createControlServer({ scanner, getCurrentRoot: () => tmpRoot })
  server = http.createServer(lib.handleControlRequest)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port

  // Register a live daemon + session in the isolated registry, as `cs serve`
  // and the MCP attach would. The daemon carries the SAME epoch the running
  // control-server reports on /health (lib.epoch).
  phash = registry.projectHash(tmpRoot)
  registry.touch('daemon', phash, {
    projectRoot: registry.canonicalRoot(tmpRoot), port, epoch: lib.epoch, pid: process.pid, startedAt: Date.now(),
  })
  registry.touch('session', 'sess-A', {
    sessionId: 'sess-A', projectRoot: registry.canonicalRoot(tmpRoot),
    port, pid: process.pid, label: 'proj', startedAt: Date.now(),
  })
})

afterAll(() => {
  try { scanner.stop() } catch {}
  try { server.close() } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(CS_HOME, { recursive: true, force: true }) } catch {}
})

describe('viewer-client: registry discovery', () => {
  it('lists the live session enriched with its daemon (port + epoch + alive)', () => {
    const sessions = listSessions()
    const s = sessions.find((x) => x.sessionId === 'sess-A')
    expect(s).toBeTruthy()
    expect(s.projectHash).toBe(phash)
    expect(s.daemonPort).toBe(port)
    expect(s.daemonEpoch).toBe(lib.epoch)
    expect(s.daemonAlive).toBe(true)
  })

  it('drops sessions whose lease is older than the TTL', () => {
    registry.touch('session', 'sess-stale', {
      sessionId: 'sess-stale', projectRoot: registry.canonicalRoot(tmpRoot), port, label: 'old', startedAt: Date.now(),
    })
    // Force its lastSeen far in the past by rewriting the file directly.
    const f = registry.fileFor('session', 'sess-stale')
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'))
    obj.lastSeen = Date.now() - 60_000
    fs.writeFileSync(f, JSON.stringify(obj))
    const ids = listSessions({ ttlMs: 15_000 }).map((s) => s.sessionId)
    expect(ids).not.toContain('sess-stale')
    registry.remove('session', 'sess-stale')
  })
})

describe('viewer-client: attach lifecycle', () => {
  let vc, graphs, symbols, traces, statuses
  beforeEach(() => { graphs = []; symbols = []; traces = []; statuses = [] })
  afterEach(async () => { if (vc) { await vc.detach(); vc = null } })

  function makeVC(extra = {}) {
    return new ViewerClient({
      viewerId: 'view-1', pollMs: 40, leaseTtl: 15_000,
      onGraph: (g) => graphs.push(g),
      onSymbol: (s) => symbols.push(s),
      onTraces: (t) => traces.push(...t),
      onStatus: (s) => statuses.push(s),
      ...extra,
    })
  }

  it('bootstraps the full graph and writes a viewer lease on attach', async () => {
    vc = makeVC()
    const session = listSessions().find((s) => s.sessionId === 'sess-A')
    const r = await vc.attach(session)
    expect(r.epoch).toBe(lib.epoch)
    expect(graphs.length).toBe(1)               // full graph snapshot delivered
    expect(graphs[0]).toBeTruthy()
    expect(statuses.some((s) => s.phase === 'attached')).toBe(true)
    // viewer lease exists, bound to this project hash
    const viewers = registry.readLive('viewer', { ttlMs: 15_000 })
    const me = viewers.find((v) => v.viewerId === 'view-1')
    expect(me).toBeTruthy()
    expect(me.attachedProjectHash).toBe(phash)
  })

  it('refreshes the viewer lease on each poll (heartbeat rides the poll)', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    const f = registry.fileFor('viewer', 'view-1')
    const t1 = JSON.parse(fs.readFileSync(f, 'utf8')).lastSeen
    await new Promise((r) => setTimeout(r, 120))   // ≥2 poll ticks at 40ms
    const t2 = JSON.parse(fs.readFileSync(f, 'utf8')).lastSeen
    expect(t2).toBeGreaterThan(t1)
  })

  it('delivers a session-tagged trace via the delta poll, filtered to the session', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    graphs.length = 0; traces.length = 0
    // Record a trace tagged to OUR session, and one tagged to ANOTHER session.
    await httpJson(port, '/node/' + encodeURIComponent('src/foo.ts'), { sessionId: 'sess-A' })
    await httpJson(port, '/node/' + encodeURIComponent('src/main.ts'), { sessionId: 'sess-OTHER' })
    await new Promise((r) => setTimeout(r, 120))
    // We should see our own trace, never the other session's.
    expect(traces.length).toBeGreaterThan(0)
    expect(traces.every((t) => !t.csSession || t.csSession === 'sess-A')).toBe(true)
    expect(traces.some((t) => t.csSession === 'sess-OTHER')).toBe(false)
  })

  it('re-fetches the graph when the daemon reports graphChanged', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    graphs.length = 0
    // Simulate a graph mutation: bump the scanner's snapshot version so /delta
    // reports graphChanged against the viewer's cursor.
    scanner.snapshotVersion = (scanner.snapshotVersion || 0) + 1
    await new Promise((r) => setTimeout(r, 120))
    expect(graphs.length).toBeGreaterThan(0)    // re-fetched the new snapshot
  })

  it('re-bootstraps when the daemon epoch changes (restart)', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    graphs.length = 0; statuses.length = 0
    // Pretend the daemon restarted: force the client's recorded epoch to differ
    // from what /delta now reports (lib.epoch is stable, so stale the client).
    vc.epoch = 'stale-epoch-xyz'
    await new Promise((r) => setTimeout(r, 120))
    expect(statuses.some((s) => s.phase === 're-bootstrap')).toBe(true)
    expect(graphs.length).toBeGreaterThan(0)    // full re-fetch
    expect(vc.epoch).toBe(lib.epoch)            // resynced to the live epoch
  })

  it('removes the viewer lease on detach', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    expect(registry.readLive('viewer', { ttlMs: 15_000 }).some((v) => v.viewerId === 'view-1')).toBe(true)
    await vc.detach()
    vc = null
    expect(registry.readLive('viewer', { ttlMs: 15_000 }).some((v) => v.viewerId === 'view-1')).toBe(false)
  })

  it('detaches the old attachment before attaching a new one (project switch)', async () => {
    vc = makeVC()
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-A'))
    // Register a 2nd session/daemon (same project here, but a distinct session)
    // and switch to it — the single viewer lease must remain singular.
    registry.touch('session', 'sess-B', {
      sessionId: 'sess-B', projectRoot: registry.canonicalRoot(tmpRoot), port, label: 'proj2', startedAt: Date.now(),
    })
    await vc.attach(listSessions().find((s) => s.sessionId === 'sess-B'))
    expect(vc.session.sessionId).toBe('sess-B')
    const mine = registry.readLive('viewer', { ttlMs: 15_000 }).filter((v) => v.viewerId === 'view-1')
    expect(mine.length).toBe(1)
    registry.remove('session', 'sess-B')
  })

  it('cleans up (rejects, not attached, no lease) when bootstrap fails', async () => {
    vc = makeVC()
    // Session pointing at a dead port → /health connect refused → bootstrap throws.
    const dead = { sessionId: 'sess-dead', projectRoot: registry.canonicalRoot(tmpRoot), projectHash: phash, daemonPort: 59991 }
    await expect(vc.attach(dead)).rejects.toThrow()
    expect(vc.isAttached()).toBe(false)                  // no zombie attached state
    expect(registry.readLive('viewer', { ttlMs: 15_000 }).some((v) => v.viewerId === 'view-1')).toBe(false) // no orphan lease
  })
})
