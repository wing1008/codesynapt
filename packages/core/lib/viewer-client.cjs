// Viewer client — the desktop app as a PURE CLIENT of a shared detached daemon.
// See docs/design-multi-session.md ④ (and ② "MCP·뷰어는 순수 클라이언트").
//
// In the multi-session model the desktop does NOT run its own scanner; it picks
// an "active session" from the registry, attaches to that session's per-project
// daemon (`cs serve`), bootstraps the full graph over HTTP, then polls /delta
// for (epoch, seq) cursor deltas. This module is the headless-testable core:
// pure Node + http, no Electron, no renderer. main.cjs drives it and re-emits
// the results through the SAME ipc channels the renderer already consumes
// (`snapshot`, `control:trace`), so the renderer barely changes.
//
// Lifecycle contract (design ③ + 수명):
//   attach(session)  → write viewers/<id>.json lease, GET /health (epoch+cursor),
//                      bootstrap /graph + /symbol/graph, start poll loop.
//   poll  (pollMs)   → refresh the viewer lease (heartbeat rides the poll),
//                      GET /delta?sinceGraph=&sinceTrace=&sessionId= →
//                        epoch changed  → re-bootstrap (daemon restarted),
//                        traces present → onTraces (already session-filtered),
//                        graphChanged   → re-fetch /graph (+/symbol), advance cursor.
//   detach()         → stop the loop, remove the viewer lease (old detach before
//                      a new attach — design "프로젝트 전환 = old detach + new attach").
'use strict'
const http = require('http')
const registry = require('./registry.cjs')

const POLL_MS = 1500
const LEASE_TTL = 15000   // matches the daemon's _LEASE_TTL (bin/codesynapt.cjs)
const HTTP_TIMEOUT_MS = 8000

// Live (TTL-fresh) Claude Code sessions, each enriched with the project's
// canonical hash and the live daemon that actually serves its graph. A session
// records the daemon port it attached to, but the daemon entry is the source of
// truth for (port, epoch) — a session may outlive the exact port if the daemon
// restarted, so prefer the daemon's port and fall back to the session's.
function listSessions({ ttlMs = LEASE_TTL } = {}) {
  const sessions = registry.readLive('session', { ttlMs })
  return sessions.map((s) => {
    let phash = null
    try { phash = registry.projectHash(s.projectRoot) } catch { /* unresolved root */ }
    const daemon = phash ? registry.readDaemon(phash, ttlMs) : null
    return {
      sessionId: s.sessionId,
      projectRoot: s.projectRoot,
      label: s.label || s.projectRoot,
      projectHash: phash,
      port: s.port,
      daemonPort: daemon ? daemon.port : s.port,
      daemonEpoch: daemon ? daemon.epoch : null,
      daemonAlive: !!daemon,
      startedAt: s.startedAt,
      lastSeen: s.lastSeen,
    }
  })
}

// Minimal GET → parsed JSON against the local daemon. Tags the request with the
// viewer's active sessionId (X-CS-Session) so the daemon can session-filter the
// trace view (the graph stays shared — design ③ asymmetry).
function httpJson(port, pathname, { sessionId } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (sessionId) headers['X-CS-Session'] = sessionId
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${pathname}`))
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error(`bad JSON from ${pathname}: ${e.message}`)) }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`timeout for ${pathname}`)))
    req.end()
  })
}

// One viewer = one attachment at a time (the desktop is a singleton). Re-attach
// to switch projects/sessions; the previous attachment is torn down first.
class ViewerClient {
  constructor({ viewerId, onGraph, onSymbol, onTraces, onStatus, pollMs = POLL_MS, leaseTtl = LEASE_TTL } = {}) {
    this.viewerId = viewerId || ('viewer-' + process.pid)
    this.onGraph = onGraph || (() => {})
    this.onSymbol = onSymbol || (() => {})
    this.onTraces = onTraces || (() => {})
    this.onStatus = onStatus || (() => {})
    this.pollMs = pollMs
    this.leaseTtl = leaseTtl
    this._reset()
  }

  _reset() {
    this.session = null
    this.port = null
    this.phash = null
    this.epoch = null
    this.cursor = { graph: 0, trace: 0 }
    this._timer = null
    this._polling = false
    this._stopped = true
  }

  isAttached() { return !!this.session }

  // Attach to a session (as returned by listSessions, or any object carrying
  // {sessionId, projectRoot, projectHash?, daemonPort?, port}). Old attachment
  // is detached first. Returns the bootstrap cursor.
  async attach(session) {
    await this.detach()
    this._stopped = false
    this.session = session
    this.phash = session.projectHash
      || (() => { try { return registry.projectHash(session.projectRoot) } catch { return null } })()
    this.port = session.daemonPort || session.port
    if (!this.port) throw new Error('attach: no daemon port for session')
    this._writeLease()
    await this._bootstrap()
    if (this._stopped) return null   // detached during bootstrap
    this._scheduleNext()
    return { epoch: this.epoch, port: this.port, cursor: { ...this.cursor } }
  }

  // Viewer lease — file-based refcount participant (design 수명). Written at
  // attach and refreshed on every poll so the daemon counts this viewer as
  // alive and won't self-exit while we're watching.
  _writeLease() {
    try { registry.touch('viewer', this.viewerId, { viewerId: this.viewerId, attachedProjectHash: this.phash }) }
    catch (e) { if (process.env.CS_DBG) console.error('[cs-viewer] lease write:', e && e.message) }
  }

  // Cold attach = full snapshot fetch (graph is *state*, not a log → no since=0
  // delta). Records (epoch, cursor) for subsequent delta polling.
  async _bootstrap() {
    const health = await httpJson(this.port, '/health')
    if (this._stopped) return
    this.epoch = health.epoch
    this.cursor.graph = health.graphVersion || 0
    this.cursor.trace = health.traceVersion || 0
    const graph = await httpJson(this.port, '/graph')
    if (this._stopped) return
    this.onGraph(graph)
    try {
      const sym = await httpJson(this.port, '/symbol/graph')
      if (this._stopped) return
      this.onSymbol(sym)
    } catch (e) { /* symbol graph may 404 (no L2 yet) — non-fatal */ }
    this.onStatus({ phase: 'attached', epoch: this.epoch, port: this.port, sessionId: this.session && this.session.sessionId })
  }

  _scheduleNext() {
    if (this._stopped) return
    this._timer = setTimeout(() => { this._poll() }, this.pollMs)
    if (this._timer && this._timer.unref) this._timer.unref()
  }

  async _poll() {
    if (this._stopped) return
    if (this._polling) { this._scheduleNext(); return }
    this._polling = true
    try {
      this._writeLease()   // heartbeat rides the poll (design ③)
      const sid = this.session && this.session.sessionId
      const q = `/delta?sinceGraph=${this.cursor.graph}&sinceTrace=${this.cursor.trace}`
        + (sid != null ? `&sessionId=${encodeURIComponent(sid)}` : '')
      const d = await httpJson(this.port, q, { sessionId: sid })
      if (this._stopped) return
      // epoch mismatch = daemon restarted → cursors are meaningless, re-bootstrap.
      if (d.epoch && this.epoch && d.epoch !== this.epoch) {
        this.onStatus({ phase: 're-bootstrap', reason: 'epoch-changed', epoch: d.epoch })
        await this._bootstrap()
        return
      }
      // Traces are already session-filtered by the daemon; advance the cursor to
      // the full log length regardless (other sessions' entries are skipped, not
      // re-delivered).
      if (typeof d.traceVersion === 'number') {
        const traces = Array.isArray(d.traces) ? d.traces : []
        this.cursor.trace = d.traceVersion
        if (traces.length) this.onTraces(traces)
      }
      // Graph is shared state: a single bit (graphChanged) → re-fetch the snapshot.
      if (d.graphChanged) {
        const graph = await httpJson(this.port, '/graph')
        if (this._stopped) return
        this.onGraph(graph)
        try {
          const sym = await httpJson(this.port, '/symbol/graph')
          if (this._stopped) return
          this.onSymbol(sym)
        } catch (e) { /* symbol 404 — non-fatal */ }
        this.cursor.graph = d.graphVersion || this.cursor.graph
      }
    } catch (e) {
      this.onStatus({ phase: 'error', error: e && e.message })
    } finally {
      this._polling = false
      this._scheduleNext()
    }
  }

  // Stop polling and drop the viewer lease so the daemon's refcount no longer
  // counts us (it may then self-exit if no sessions remain).
  async detach() {
    const had = this.session
    this._stopped = true
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this.viewerId) {
      try { registry.remove('viewer', this.viewerId) }
      catch (e) { if (process.env.CS_DBG) console.error('[cs-viewer] lease remove:', e && e.message) }
    }
    this._reset()
    if (had) this.onStatus({ phase: 'detached' })
  }
}

module.exports = { listSessions, ViewerClient, httpJson, POLL_MS, LEASE_TTL }
