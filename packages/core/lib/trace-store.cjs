'use strict'
// Shared AI/CLI/MCP session-trace store. Faithfully extracted from the
// desktop implementation in electron/main.cjs (the `emitTrace` / trace-session
// block) so the HEADLESS control server (`cs serve` + the in-process MCP
// backend) records and serves the SAME .jsonl format the desktop does — an AI
// using MCP without the desktop app no longer silently records nothing.
//
// Storage layout (identical to desktop):
//   <root>/.codesynapt/traces/session-{startTs}.jsonl
// One JSON line per event. First line is `{ type:'meta', ... }`. Each session
// id is the unix-ms timestamp of when the session started on that root.
//
// Pure module — no http, no Electron. The control-server creates ONE TraceStore
// per server instance and pushes events into it on write/edit/blast/etc.

const fs = require('fs')
const path = require('path')

const HISTORY_DIR_NAME = '.codesynapt'   // mirror desktop (main.cjs HISTORY_DIR_NAME)
const TRACE_DIR_NAME = 'traces'
const TRACE_MEM_CAP = 10000              // in-memory cap to prevent unbounded growth

function traceDirFor(root) { return path.join(root, HISTORY_DIR_NAME, TRACE_DIR_NAME) }
function traceFileFor(root, sessionId) {
  return path.join(traceDirFor(root), `session-${sessionId}.jsonl`)
}

// Compute stats over an event array. Identical shape to desktop
// computeTraceStats — used by /trace/stats and the session-detail endpoint.
function computeTraceStats(events) {
  const byTool = {}
  const byFile = new Map()
  let firstAt = null, lastAt = null
  for (const e of events) {
    byTool[e.tool] = (byTool[e.tool] || 0) + 1
    byFile.set(e.id, (byFile.get(e.id) || 0) + 1)
    if (firstAt === null || e.ts < firstAt) firstAt = e.ts
    if (lastAt === null || e.ts > lastAt) lastAt = e.ts
  }
  const topFiles = [...byFile.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
  let timeline = []
  if (firstAt !== null && lastAt !== null && lastAt > firstAt) {
    const buckets = 20
    timeline = Array(buckets).fill(0)
    const span = lastAt - firstAt
    for (const e of events) {
      const idx = Math.min(buckets - 1, Math.floor((e.ts - firstAt) / span * buckets))
      timeline[idx]++
    }
  }
  return {
    eventCount: events.length,
    fileCount: byFile.size,
    byTool, topFiles, timeline,
    firstAt, lastAt,
    durationMs: (firstAt && lastAt) ? lastAt - firstAt : 0,
  }
}

function listTraceSessions(root, currentSessionId) {
  if (!root) return []
  const dir = traceDirFor(root)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^session-(\d+)\.jsonl$/)
    if (!m) continue
    const sessionId = parseInt(m[1], 10)
    const full = path.join(dir, name)
    let stat, size = 0, eventCount = 0, endedAt = sessionId
    try { stat = fs.statSync(full); size = stat.size; endedAt = stat.mtimeMs } catch {}
    try {
      const data = fs.readFileSync(full, 'utf8')
      eventCount = Math.max(0, data.split('\n').filter((l) => l.trim()).length - 1)
    } catch {}
    out.push({
      sessionId, startedAt: sessionId, endedAt,
      eventCount, size,
      isCurrent: sessionId === currentSessionId,
    })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function readTraceSession(root, sessionId) {
  if (!root) return null
  const f = traceFileFor(root, sessionId)
  if (!fs.existsSync(f)) return null
  let meta = null
  const events = []
  try {
    const data = fs.readFileSync(f, 'utf8')
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (j.type === 'meta') meta = j
        else events.push(j)
      } catch {}
    }
  } catch { return null }
  return { sessionId, meta, events, eventCount: events.length }
}

// One trace session bound to a single project root. The control server owns
// one instance; it starts a session lazily on the first emit (mirroring how the
// desktop calls startTraceSession when a folder is loaded) and re-keys to a new
// session if the root changes (project switch via POST /load).
class TraceStore {
  // scanner is optional — only used to attach per-file trust meta (confidence /
  // dynamic patterns), exactly like desktop's traceMetaFor.
  constructor({ getCurrentRoot, scanner } = {}) {
    this.getCurrentRoot = getCurrentRoot
    this.scanner = scanner
    this.sessionId = null
    this.startedAt = null
    this.root = null
    this.log = []
    this.writeStream = null
  }

  _root() {
    return (typeof this.getCurrentRoot === 'function') ? this.getCurrentRoot() : this.root
  }

  // Trust metadata for a touched file (desktop traceMetaFor parity).
  _metaFor(id) {
    const files = this.scanner && this.scanner.files
    const f = files && files.get && files.get(id)
    if (!f) return null
    const dyn = (f.dynamicPatterns || [])
    return { conf: f.confidence || 'high', dyn: dyn.length ? dyn : undefined }
  }

  _closeStream() {
    if (this.writeStream) {
      try { this.writeStream.end() } catch {}
      this.writeStream = null
    }
  }

  // Start (or restart) a session on the current root. Returns the session id.
  startSession() {
    const root = this._root()
    this.sessionId = Date.now()
    this.startedAt = this.sessionId
    this.root = root
    this.log = []
    this._closeStream()
    if (!root) return this.sessionId
    try {
      fs.mkdirSync(traceDirFor(root), { recursive: true })
      const stream = fs.createWriteStream(traceFileFor(root, this.sessionId), { flags: 'a' })
      // The stream opens its fd ASYNCHRONOUSLY. If the project dir is removed
      // before that open completes (e.g. a short-lived test root, or a project
      // switch), the deferred open throws an 'error' event that — without a
      // listener — crashes the process as an unhandled exception. Swallow it:
      // trace persistence is best-effort and must never take the server down.
      stream.on('error', () => { if (this.writeStream === stream) this.writeStream = null })
      this.writeStream = stream
      stream.write(JSON.stringify({
        type: 'meta', sessionId: this.sessionId, root, startedAt: this.startedAt,
      }) + '\n')
    } catch (e) {
      if (process.env.CS_DBG) console.error('[cs] trace startSession:', e && e.message)
      this.writeStream = null
    }
    return this.sessionId
  }

  // Lazily ensure a session exists and is bound to the current root. If the
  // root changed (project switch), roll a fresh session so the .jsonl lands in
  // the new project — never mixing traces across roots.
  _ensureSession() {
    const root = this._root()
    if (this.sessionId === null || this.root !== root) this.startSession()
  }

  // Append one event. Mirrors desktop emitTrace EXACTLY (same field order /
  // meta-merge semantics). `meta` overrides the auto file-trust meta when the
  // caller has richer data (e.g. blast impact stats).
  emit(tool, id, meta, extra) {
    if (!id) return
    this._ensureSession()
    const ts = Date.now()
    // `extra` is always merged (e.g. { csSession } for per-session attribution),
    // unlike `meta` which replaces the auto _metaFor() when provided.
    const ev = { tool, id, ts, ...(meta || this._metaFor(id) || {}), ...(extra || {}) }
    this.log.push(ev)
    if (this.log.length > TRACE_MEM_CAP) this.log.splice(0, this.log.length - TRACE_MEM_CAP)
    if (this.writeStream) {
      try { this.writeStream.write(JSON.stringify(ev) + '\n') } catch (e) { if (process.env.CS_DBG) console.error('[cs] trace write:', e && e.message) }
    }
    return ev
  }

  // Soft clear: drop in-memory log + start a NEW session on disk (old file
  // preserved). Desktop /trace/clear parity.
  clear() {
    this.log = []
    this.startSession()
    return this.sessionId
  }
}

module.exports = {
  TraceStore,
  computeTraceStats,
  listTraceSessions,
  readTraceSession,
  traceDirFor,
  traceFileFor,
  HISTORY_DIR_NAME,
  TRACE_DIR_NAME,
}
