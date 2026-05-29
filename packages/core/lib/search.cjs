// search.cjs — full-text search over the scanner's file list.
//
// Concurrency / safety:
//   - concurrency-limited (default 32) instead of all-at-once Promise.all
//     → bounds libuv thread-pool queue depth, avoids stall on big repos.
//   - per-file timeout (default 5s) → if a single file's read or scan hangs
//     (OS lock, pathological regex), we skip it and continue.
//   - skipped files are reported in the response so the caller knows what
//     wasn't searched.

const DEFAULT_MAX = 100
const DEFAULT_CONCURRENCY = 32
const DEFAULT_FILE_TIMEOUT_MS = 5000
const SNIPPET_CONTEXT = 50

function scanContent(text, q, opts, maxPerFile) {
  const matches = []
  if (opts.regex) {
    const flags = opts.caseSensitive ? 'g' : 'gi'
    let re
    try { re = new RegExp(q, flags) }
    catch { return [] }
    let m
    while ((m = re.exec(text)) !== null) {
      const idx = m.index
      const before = text.lastIndexOf('\n', idx - 1)
      const line = (text.slice(0, idx).match(/\n/g) || []).length + 1
      const col = idx - (before + 1) + 1
      const sStart = Math.max(0, idx - SNIPPET_CONTEXT)
      const sEnd   = Math.min(text.length, idx + m[0].length + SNIPPET_CONTEXT)
      matches.push({
        line, col,
        snippet: text.slice(sStart, sEnd).replace(/\r?\n/g, ' '),
      })
      if (matches.length >= maxPerFile) break
      if (m.index === re.lastIndex) re.lastIndex++
    }
    return matches
  }

  const needle = opts.caseSensitive ? q : q.toLowerCase()
  const hay    = opts.caseSensitive ? text : text.toLowerCase()
  let lineStart = 0
  let lineNo = 1
  while (lineStart < hay.length) {
    let lineEnd = hay.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = hay.length
    let from = lineStart
    while (true) {
      const idx = hay.indexOf(needle, from)
      if (idx === -1 || idx >= lineEnd) break
      const sStart = Math.max(0, idx - SNIPPET_CONTEXT)
      const sEnd   = Math.min(text.length, idx + needle.length + SNIPPET_CONTEXT)
      matches.push({
        line: lineNo,
        col:  idx - lineStart + 1,
        snippet: text.slice(sStart, sEnd).replace(/\r?\n/g, ' '),
      })
      if (matches.length >= maxPerFile) return matches
      from = idx + needle.length
    }
    lineStart = lineEnd + 1
    lineNo++
  }
  return matches
}

function withTimeout(promise, ms, label) {
  let to
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to))
}

// Run `tasks` with at most `concurrency` in flight at once.
// Stops accepting new tasks once `shouldStop()` returns true.
async function runConcurrent(tasks, concurrency, shouldStop) {
  let i = 0
  async function worker() {
    while (i < tasks.length) {
      if (shouldStop && shouldStop()) return
      const idx = i++
      await tasks[idx]()
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  await Promise.all(workers)
}

async function search(scanner, cache, opts) {
  const t0 = Date.now()
  const q = opts.q
  if (!q || typeof q !== 'string') throw new Error('q (query string) is required')

  const max = opts.max ?? DEFAULT_MAX
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const fileTimeoutMs = opts.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS
  const regex = !!opts.regex
  const caseSensitive = !!opts.caseSensitive
  const maxPerFile = opts.maxPerFile ?? 10
  const debug = !!opts.debug

  if (regex) {
    try { new RegExp(q) }
    catch (e) { throw new Error(`invalid regex: ${e.message}`) }
  }

  const tFilesStart = Date.now()
  const files = [...scanner.files.values()]
  const totalFiles = files.length
  const filesEnumMs = Date.now() - tFilesStart

  const matches = []
  const skipped = []
  let filesScanned = 0
  let filesMatched = 0
  let stopFlag = false

  // Timing buckets per file (debug only)
  const timings = debug ? { readMs: [], scanMs: [] } : null

  const tasks = files.map((f) => async () => {
    if (stopFlag) return
    let text
    const tRead = debug ? Date.now() : 0
    try {
      text = await withTimeout(
        cache.getText(f.id, f.absPath),
        fileTimeoutMs,
        f.id,
      )
    } catch (e) {
      skipped.push({ id: f.id, reason: e.message.startsWith('timeout') ? 'timeout' : 'read-error' })
      return
    }
    if (debug) timings.readMs.push(Date.now() - tRead)
    if (stopFlag) return

    filesScanned++
    const tScan = debug ? Date.now() : 0
    let fileMatches
    try {
      fileMatches = scanContent(text, q, { regex, caseSensitive }, maxPerFile)
    } catch (e) {
      skipped.push({ id: f.id, reason: 'scan-error' })
      return
    }
    if (debug) timings.scanMs.push(Date.now() - tScan)
    if (fileMatches.length === 0) return

    filesMatched++
    for (const m of fileMatches) {
      matches.push({ id: f.id, line: m.line, col: m.col, snippet: m.snippet, totalInFile: fileMatches.length })
      if (matches.length >= max) {
        stopFlag = true
        break
      }
    }
  })

  const tConcStart = Date.now()
  await runConcurrent(tasks, concurrency, () => stopFlag)
  const concMs = Date.now() - tConcStart

  const result = {
    query: q,
    regex, caseSensitive,
    totalFiles,
    filesScanned,
    filesMatched,
    matches,
    skipped,
    truncated: stopFlag,
    ms: Date.now() - t0,
    cacheStats: cache.stats(),
  }

  if (debug) {
    const sum = (a) => a.reduce((s, x) => s + x, 0)
    const sorted = (a) => [...a].sort((x, y) => x - y)
    const pctile = (a, p) => { const s = sorted(a); return s[Math.min(s.length-1, Math.floor(p * s.length))] || 0 }
    result.debug = {
      concurrency,
      filesEnumMs,
      runConcurrentMs: concMs,
      reads: {
        count: timings.readMs.length,
        sumMs: sum(timings.readMs),
        avgMs: timings.readMs.length ? +(sum(timings.readMs) / timings.readMs.length).toFixed(2) : 0,
        p50:   pctile(timings.readMs, 0.5),
        p95:   pctile(timings.readMs, 0.95),
        p99:   pctile(timings.readMs, 0.99),
        max:   Math.max(0, ...timings.readMs),
      },
      scans: {
        count: timings.scanMs.length,
        sumMs: sum(timings.scanMs),
        avgMs: timings.scanMs.length ? +(sum(timings.scanMs) / timings.scanMs.length).toFixed(2) : 0,
        p50:   pctile(timings.scanMs, 0.5),
        p95:   pctile(timings.scanMs, 0.95),
        p99:   pctile(timings.scanMs, 0.99),
        max:   Math.max(0, ...timings.scanMs),
      },
    }
  }

  return result
}

module.exports = { search }
