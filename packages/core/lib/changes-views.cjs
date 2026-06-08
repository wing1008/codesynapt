'use strict'
// Shared "what changed / where do I start" views. Faithfully ported from the
// desktop electron/main.cjs helpers so the HEADLESS control server can serve
// the same data:
//   - SessionChangeLog + getChangeDiff + makeLineDiff  (/changes, /changes/:id)
//   - buildTour                                         (/tour)
//   - buildTimeline                                     (/timeline)
//
// Pure-ish: no http, no Electron. Git is invoked via an injected exec function
// (the control server passes one built on child_process.execFile) so this stays
// testable and so the offline rule is honoured — git is a local tool, never a
// network call.

const fs = require('fs')
const path = require('path')

function isInsideRoot(root, full) {
  const r = path.resolve(root)
  const f = path.resolve(full)
  return f === r || f.startsWith(r + path.sep)
}

// ─── Session change log ────────────────────────────────────────
// Tracks every file modification observed during this server's lifetime. The
// control server feeds it from the same write/edit handlers that already exist.
// Captures first-seen content so we can diff a file's net change over the
// session. Mirrors desktop sessionChanges / trackChange / listSessionChanges.
class SessionChangeLog {
  constructor() {
    this.changes = new Map()  // id -> { firstAt, lastAt, count, firstSeen, ... }
  }

  // Record a change. `content` is the file's content AT THIS MOMENT (after the
  // write). On first sight we keep it as the "before" baseline for later diffs.
  track(id, content) {
    const existing = this.changes.get(id)
    const now = Date.now()
    const loc = content ? content.split('\n').length : 0
    const size = Buffer.byteLength(content || '', 'utf8')
    if (existing) {
      existing.lastAt = now
      existing.count += 1
      existing.currentSize = size
      existing.currentLoc = loc
    } else {
      this.changes.set(id, {
        firstAt: now, lastAt: now, count: 1,
        firstSeen: content || '',
        firstSeenSize: size, firstSeenLoc: loc,
        currentSize: size, currentLoc: loc,
      })
    }
  }

  list() {
    const items = []
    for (const [id, c] of this.changes.entries()) {
      items.push({
        id,
        firstAt: c.firstAt, lastAt: c.lastAt, count: c.count,
        sizeBefore: c.firstSeenSize, sizeAfter: c.currentSize,
        locBefore: c.firstSeenLoc, locAfter: c.currentLoc,
        sizeDelta: c.currentSize - c.firstSeenSize,
        locDelta: c.currentLoc - c.firstSeenLoc,
      })
    }
    items.sort((a, b) => b.lastAt - a.lastAt)
    return items
  }

  // Diff a recorded file's net change. Reads the CURRENT content from disk as
  // "after" and diffs against the first-seen baseline. Returns null when the
  // file was never recorded (→ caller emits 404, desktop parity).
  diff(id, root) {
    const c = this.changes.get(id)
    if (!c) return null
    let after = null
    try {
      if (!root) return null
      const full = path.join(root, id)
      if (!isInsideRoot(root, full)) return null
      const stat = fs.statSync(full)
      if (stat.size > 2_000_000) return { error: 'file too large' }
      after = fs.readFileSync(full, 'utf8')
    } catch (e) { return { error: e.message } }
    return {
      id, firstAt: c.firstAt, lastAt: c.lastAt, count: c.count,
      before: c.firstSeen,
      after,
      lines: makeLineDiff(c.firstSeen, after),
    }
  }
}

// Tiny LCS-based unified diff. Returns array of { tag:'eq'|'add'|'del', a?, b?, text }.
// Identical to desktop makeLineDiff.
function makeLineDiff(before, after) {
  const A = (before || '').split('\n')
  const B = (after || '').split('\n')
  const n = A.length, m = B.length
  if (n * m > 2_000_000) return [{ tag: 'note', text: 'file too large to diff line-by-line' }]
  const dp = new Uint32Array((n + 1) * (m + 1))
  const W = m + 1
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ tag: 'eq', a: i + 1, b: j + 1, text: A[i] }); i++; j++ }
    else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { out.push({ tag: 'del', a: i + 1, text: A[i] }); i++ }
    else { out.push({ tag: 'add', b: j + 1, text: B[j] }); j++ }
  }
  while (i < n) { out.push({ tag: 'del', a: i + 1, text: A[i] }); i++ }
  while (j < m) { out.push({ tag: 'add', b: j + 1, text: B[j] }); j++ }
  return out
}

// ─── External-URL aggregation (used by buildTour) ──────────────
// Mirrors getExternalUrls in both servers. Kept local so buildTour is
// self-contained, but the control server passes its OWN getExternalUrls in to
// avoid double-computation; this is the fallback.
function getExternalUrls(scanner) {
  if (!scanner) return { domains: [], totalCalls: 0 }
  const byDomain = new Map()
  const add = (rawUrl, fileId, methodHint) => {
    const m = rawUrl.match(/^(https?|wss?):\/\/([^/:?#]+)/i)
    if (!m) return
    const proto = m[1].toLowerCase()
    const domain = m[2].toLowerCase()
    let bucket = byDomain.get(domain)
    if (!bucket) { bucket = { domain, proto, callers: [] }; byDomain.set(domain, bucket) }
    bucket.callers.push({ file: fileId, url: rawUrl, method: methodHint || (proto.startsWith('ws') ? 'WS' : 'GET') })
  }
  for (const f of scanner.files.values()) {
    if (f.apiCalls && f.apiCalls.length) {
      for (const c of f.apiCalls) if (/^https?:\/\//i.test(c.url)) add(c.url, f.id, c.method || 'GET')
    }
    if (f.externalUrls && f.externalUrls.length) {
      for (const u of f.externalUrls) add(u.url, f.id, null)
    }
  }
  for (const bucket of byDomain.values()) {
    const seen = new Set()
    bucket.callers = bucket.callers.filter((c) => {
      const k = c.file + '|' + c.url + '|' + c.method
      if (seen.has(k)) return false
      seen.add(k); return true
    })
  }
  let total = 0
  for (const b of byDomain.values()) total += b.callers.length
  const domains = [...byDomain.values()].sort((a, b) => b.callers.length - a.callers.length)
  return { domains, totalCalls: total }
}

// Heuristic-only onboarding tour. Identical logic to desktop buildTour.
//   ctx: { scanner, getExternalUrls?: () => {domains,...} }
function buildTour(scanner, externalUrls) {
  if (!scanner) return null
  const files = [...scanner.files.values()]
  const stops = []
  const seen = new Set()
  const entryRe = /^(?:src\/)?(?:index|main|app|server|cli|bin)(?:\.[a-z]+)+$/i
  const entries = files.filter((f) => entryRe.test(f.id)).sort((a, b) => a.id.length - b.id.length).slice(0, 3)
  for (const f of entries) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    stops.push({
      id: f.id,
      kind: 'entry',
      hint: `Entry point — likely where execution starts. ${(f.ext || '').toUpperCase()} file, ${f.loc} LOC.`,
    })
  }
  const inCount = new Map()
  for (const e of scanner.edges) inCount.set(e.t, (inCount.get(e.t) || 0) + 1)
  const hubs = files
    .map((f) => ({ ...f, inCount: inCount.get(f.id) || 0 }))
    .filter((f) => f.inCount >= 2 && !seen.has(f.id))
    .sort((a, b) => b.inCount - a.inCount)
    .slice(0, 5)
  for (const f of hubs) {
    seen.add(f.id)
    stops.push({
      id: f.id,
      kind: 'hub',
      hint: `Hub file — ${f.inCount} other files import this. Core utility or shared module.`,
    })
  }
  const ext = externalUrls || getExternalUrls(scanner)
  const topCallers = new Map()
  for (const d of ext.domains) {
    for (const c of d.callers) topCallers.set(c.file, (topCallers.get(c.file) || 0) + 1)
  }
  const apiFiles = [...topCallers.entries()]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  for (const [id, count] of apiFiles) {
    seen.add(id)
    stops.push({
      id, kind: 'api',
      hint: `External API integration — calls ${count} different external URL${count === 1 ? '' : 's'}.`,
    })
  }
  return { stops, totalFiles: scanner.files.size }
}

// Git-backed file-creation timeline. Identical to desktop buildTimeline, except
// git is invoked through an injected `pExecFile(cmd, args, opts) => {stdout}`
// promise (so this module has no child_process dependency and is unit-testable).
// `cache` is an optional { root, data, building } object the caller persists
// between calls (desktop keeps timelineCache module-level).
async function buildTimeline(root, scanner, pExecFile, cache = {}) {
  if (!root) return { error: 'no folder loaded', isGit: false }
  if (cache.root === root && cache.data) return cache.data
  if (cache.building) return { error: 'building', isGit: true, building: true }
  cache.building = true
  try {
    await pExecFile('git', ['rev-parse', '--git-dir'], { cwd: root })
  } catch {
    cache.building = false
    return { error: 'not a git repository', isGit: false }
  }
  try {
    const { stdout } = await pExecFile(
      'git',
      ['log', '--reverse', '--diff-filter=A', '--name-only', '--format=__C__%H|%at|%s'],
      { cwd: root, maxBuffer: 100 * 1024 * 1024 }
    )
    const points = []
    let cur = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('__C__')) {
        const [hash, atStr, ...subj] = line.slice(5).split('|')
        cur = { hash, ts: parseInt(atStr, 10) * 1000, subject: subj.join('|'), addedFiles: [] }
        points.push(cur)
      } else if (line && cur) {
        const id = line.replace(/\\/g, '/')
        if (scanner && scanner.files && scanner.files.has(id)) cur.addedFiles.push(id)
      }
    }
    const filtered = points.filter((p) => p.addedFiles.length > 0)
    const data = {
      isGit: true,
      points: filtered,
      firstAt: filtered[0]?.ts || Date.now(),
      lastAt: filtered[filtered.length - 1]?.ts || Date.now(),
      commitCount: filtered.length,
    }
    cache.root = root; cache.data = data; cache.building = false
    return data
  } catch (e) {
    cache.building = false
    return { error: e.message, isGit: true }
  }
}

module.exports = {
  SessionChangeLog,
  makeLineDiff,
  buildTour,
  buildTimeline,
  getExternalUrls,
}
