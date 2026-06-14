// Session/daemon/viewer registry + heartbeat-lease.
// See docs/design-multi-session.md ① for the contract and WHY.
//
// Three lease dirs under ~/.codesynapt/:
//   sessions/<sessionId>.json   { sessionId, projectRoot, port, pid, label, startedAt, lastSeen }
//   daemons/<projectHash>.json  { port, epoch, pid, startedAt, lastSeen }   ← also the spawn-lock
//   viewers/<viewerId>.json     { viewerId, attachedProjectHash, lastSeen }
//
// Liveness is purely file-based: every participant rewrites its own file's
// lastSeen every N seconds; readers treat an entry as alive only while
// (now - lastSeen) < ttl. No +1/-1 counter (it breaks on kill -9). No shared
// json (write race). Writes are temp+rename atomic; readers tolerate a torn
// read by skipping that entry for the tick.
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const ROOT = process.env.CS_HOME || path.join(os.homedir(), '.codesynapt')
const DIRS = { session: 'sessions', daemon: 'daemons', viewer: 'viewers' }

// Canonicalise a project root so the same project always hashes the same,
// regardless of symlinks / trailing slash / separator / Windows drive case.
function canonicalRoot(p) {
  let r = path.resolve(p)
  try { r = fs.realpathSync.native(r) } catch { /* path may not exist yet */ }
  r = r.replace(/[\\/]+$/, '') || r            // strip trailing sep (keep root like C:\)
  if (process.platform === 'win32') {
    r = r.replace(/\//g, '\\')                 // normalise separator
    r = r.toLowerCase()                        // case-insensitive FS (drive + path)
  }
  return r
}
function projectHash(root) {
  return crypto.createHash('sha256').update(canonicalRoot(root)).digest('hex').slice(0, 16)
}

function dirFor(type) {
  const d = path.join(ROOT, DIRS[type])
  fs.mkdirSync(d, { recursive: true })
  return d
}
function fileFor(type, id) { return path.join(dirFor(type), id + '.json') }

// Atomic write: temp + rename (rename is atomic on the same filesystem).
// WINDOWS CAVEAT (root cause of the 2026-06-11 zombie-daemon incident): a
// rename ONTO a file another process currently has open for reading fails
// with EPERM — and lease files are read every few seconds by every CLI /
// daemon (resolvePort, reap ticks). Under concurrency the rename throws,
// the lease update is LOST (a trace run's lease silently stops refreshing →
// daemon reaps mid-run) and the .tmp litters the dir. Strategy: retry the
// rename once, then fall back to a PLAIN overwrite — readers already
// tolerate a torn read (they skip-and-retry next tick), so a rare non-atomic
// write is strictly better than a silently dropped lease. Always remove the
// tmp on failure.
function writeAtomic(file, obj) {
  const data = JSON.stringify(obj)
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    fs.writeFileSync(tmp, data)
    try {
      fs.renameSync(tmp, file)
      return
    } catch {
      try { fs.renameSync(tmp, file); return } catch { /* retry lost too */ }
    }
    // Fallback: plain overwrite (torn reads are tolerated by readers).
    fs.writeFileSync(file, data)
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* litter guard */ }
  }
}

// Create/refresh a lease, stamping lastSeen. Merges over any existing fields.
function touch(type, id, patch = {}) {
  const file = fileFor(type, id)
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* new or torn */ }
  const next = { ...cur, ...patch, id, lastSeen: Date.now() }
  writeAtomic(file, next)
  return next
}
function remove(type, id) { try { fs.unlinkSync(fileFor(type, id)) } catch { /* gone */ } }

// All live (fresh) leases of a type, optionally filtered.
function readLive(type, { ttlMs = Infinity, filter = null } = {}) {
  const d = dirFor(type)
  const now = Date.now()
  const out = []
  let names
  try { names = fs.readdirSync(d) } catch { return out }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    let e
    try { e = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')) } catch { continue } // torn → skip tick
    if (now - (e.lastSeen || 0) >= ttlMs) continue
    if (filter && !filter(e)) continue
    out.push(e)
  }
  return out
}

// Delete TTL-expired files of a type (housekeeping; called by daemon tick / any client).
function cleanStale(type, ttlMs, excludeId) {
  const d = dirFor(type)
  const now = Date.now()
  let names
  try { names = fs.readdirSync(d) } catch { return 0 }
  let removed = 0
  for (const n of names) {
    const file = path.join(d, n)
    // Orphaned atomic-write temp files (rename failed under Windows read
    // contention) — sweep anything older than a minute by its embedded stamp.
    if (n.endsWith('.tmp')) {
      const m = n.match(/\.(\d+)\.tmp$/)
      const ts = m ? parseInt(m[1], 10) : 0
      if (now - ts > 60000) { try { fs.unlinkSync(file); removed++ } catch {} }
      continue
    }
    if (!n.endsWith('.json')) continue
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (excludeId && e.id === excludeId) continue   // never reap the caller's own entry (e.g. a daemon sweeping its own type)
      if (now - (e.lastSeen || 0) >= ttlMs) { fs.unlinkSync(file); removed++ }
    } catch { /* unreadable/torn — leave for a later pass */ }
  }
  return removed
}

// Daemon spawn-lock = atomic O_EXCL create of daemons/<projectHash>.json.
//   { won:true,  file }                  → we acquired it; caller binds a port then setPort()
//   { won:false, existing }              → a LIVE daemon already owns this project; attach to it
// A stale (TTL-expired) existing entry is broken and re-raced. lastSeen is
// stamped at create time (before the port is known) so a crash mid-spawn
// leaves a reclaimable entry instead of a permanent ghost.
function acquireDaemonLock(projectHashId, info, ttlMs) {
  const file = fileFor('daemon', projectHashId)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')   // O_CREAT | O_EXCL | O_WRONLY
      try {
        fs.writeSync(fd, JSON.stringify({ ...info, id: projectHashId, port: null, lastSeen: Date.now() }))
      } finally { fs.closeSync(fd) }
      return { won: true, file }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let cur = null
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* torn — treat as breakable */ }
      const stale = !cur || (Date.now() - (cur.lastSeen || 0) >= ttlMs)
      if (!stale) return { won: false, existing: cur }
      try { fs.unlinkSync(file) } catch { /* someone else broke it — retry */ }
    }
  }
  let cur = null
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  return { won: false, existing: cur }
}

// Winner publishes its bound port (and refreshes lastSeen). Loser polls
// readLive('daemon', …) until port !== null before attaching.
function setDaemonPort(projectHashId, port) {
  return touch('daemon', projectHashId, { port })
}
function readDaemon(projectHashId, ttlMs = Infinity) {
  const live = readLive('daemon', { ttlMs, filter: (e) => e.id === projectHashId })
  return live[0] || null
}

module.exports = {
  ROOT, DIRS,
  canonicalRoot, projectHash,
  fileFor, touch, remove, readLive, cleanStale,
  acquireDaemonLock, setDaemonPort, readDaemon,
}
