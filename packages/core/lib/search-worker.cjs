// search-worker.cjs — runs in a Node worker_thread, isolated from the main
// thread (which is busy with scanner / chokidar / babel parse).
//
// Protocol (messages from main):
//   { type: 'search', id, files: [{id, absPath}], q, regex, caseSensitive, max, maxPerFile, concurrency, fileTimeoutMs }
//   { type: 'invalidate', id }     — drop one cache entry
//   { type: 'clear' }              — drop all cache
//
// Reply (messages to main):
//   { type: 'result', id, payload: { matches, skipped, filesScanned, filesMatched, ms, cacheStats, truncated } }
//   { type: 'error',  id, error: string }

const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')

if (!parentPort) {
  throw new Error('search-worker.cjs must be loaded as a worker_thread')
}

const _reqId = workerData?.reqId ?? '?'
const _tracePath = workerData?.tracePath
function _trace(msg) {
  if (!_tracePath) return
  try { fs.appendFileSync(_tracePath, `${new Date().toISOString()} [#${_reqId}] [worker] ${msg}\n`) } catch {}
}
_trace('boot')

const DEFAULT_MAX = 100
// 8 is the sweet spot with the size-gate in place (large files are skipped
// without holding threads). Going higher gives diminishing returns.
const DEFAULT_CONCURRENCY = 8
const DEFAULT_FILE_TIMEOUT_MS = 5000
const SNIPPET_CONTEXT = 50
const MAX_CACHE_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
// Files larger than this are SKIPPED entirely (not even attempted).
// Reason: AI model tokenizer JSONs (tens of MB) read slowly enough that
// they hold a libuv thread for seconds, blocking every other concurrent
// task. Better to skip them honestly than hang the whole search.
const MAX_SEARCH_BYTES = 5 * 1024 * 1024  // 5 MB

// Cache: id → { mtime, buf, text? }
const cache = new Map()
let bytesUsed = 0
const cacheStats = { hits: 0, misses: 0, stales: 0, evictions: 0 }

function invalidate(id) {
  const entry = cache.get(id)
  if (entry) {
    bytesUsed -= entry.buf.length
    cache.delete(id)
  }
}
function clearCache() { cache.clear(); bytesUsed = 0 }

function evictUntilFits(needed) {
  for (const [id, entry] of cache) {
    if (bytesUsed + needed <= MAX_CACHE_BYTES) break
    bytesUsed -= entry.buf.length
    cache.delete(id)
    cacheStats.evictions++
  }
}

async function getText(id, absPath) {
  // Fast path: cache hit, no stat call. Chokidar invalidation messages
  // from main keep us honest. Skipping stat saves ~0.5ms × N files.
  const cached = cache.get(id)
  if (cached) {
    cacheStats.hits++
    cache.delete(id); cache.set(id, cached)   // LRU touch
    if (!cached.text) cached.text = cached.buf.toString('utf8')
    return cached.text
  }

  let stat
  try { stat = await fs.promises.stat(absPath) }
  catch (e) { invalidate(id); throw e }

  // Hard size gate — prevents tokenizer.json (50+ MB) from stalling pool.
  if (stat.size > MAX_SEARCH_BYTES) {
    throw new Error(`too-large: ${stat.size} bytes (cap ${MAX_SEARCH_BYTES})`)
  }

  let buf
  try { buf = await fs.promises.readFile(absPath) }
  catch (e) { invalidate(id); throw e }
  cacheStats.misses++

  if (buf.length <= MAX_FILE_BYTES) {
    if (cached) { bytesUsed -= cached.buf.length; cache.delete(id) }
    evictUntilFits(buf.length)
    cache.set(id, { mtime: stat.mtimeMs, buf, text: null })
    bytesUsed += buf.length
  }
  return buf.toString('utf8')
}

function withTimeout(promise, ms, label) {
  let to
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to))
}

function scanContent(text, q, opts, maxPerFile) {
  const matches = []
  if (opts.regex) {
    const flags = opts.caseSensitive ? 'g' : 'gi'
    let re
    try { re = new RegExp(q, flags) } catch { return [] }
    let m
    while ((m = re.exec(text)) !== null) {
      const idx = m.index
      const before = text.lastIndexOf('\n', idx - 1)
      const line = (text.slice(0, idx).match(/\n/g) || []).length + 1
      const col = idx - (before + 1) + 1
      const sStart = Math.max(0, idx - SNIPPET_CONTEXT)
      const sEnd   = Math.min(text.length, idx + m[0].length + SNIPPET_CONTEXT)
      matches.push({ line, col, snippet: text.slice(sStart, sEnd).replace(/\r?\n/g, ' ') })
      if (matches.length >= maxPerFile) break
      if (m.index === re.lastIndex) re.lastIndex++
    }
    return matches
  }
  const needle = opts.caseSensitive ? q : q.toLowerCase()
  const hay    = opts.caseSensitive ? text : text.toLowerCase()
  // Fast reject: most files have no match. One indexOf call vs O(lines).
  if (hay.indexOf(needle) === -1) return []
  let lineStart = 0, lineNo = 1
  while (lineStart < hay.length) {
    let lineEnd = hay.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = hay.length
    let from = lineStart
    while (true) {
      const idx = hay.indexOf(needle, from)
      if (idx === -1 || idx >= lineEnd) break
      const sStart = Math.max(0, idx - SNIPPET_CONTEXT)
      const sEnd   = Math.min(text.length, idx + needle.length + SNIPPET_CONTEXT)
      matches.push({ line: lineNo, col: idx - lineStart + 1, snippet: text.slice(sStart, sEnd).replace(/\r?\n/g, ' ') })
      if (matches.length >= maxPerFile) return matches
      from = idx + needle.length
    }
    lineStart = lineEnd + 1
    lineNo++
  }
  return matches
}

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

async function doSearch(req) {
  const t0 = Date.now()
  const {
    files, q,
    regex = false, caseSensitive = false,
    max = DEFAULT_MAX, maxPerFile = 10,
    concurrency = DEFAULT_CONCURRENCY, fileTimeoutMs = DEFAULT_FILE_TIMEOUT_MS,
  } = req

  if (!q) throw new Error('q (query) is required')
  if (regex) { try { new RegExp(q) } catch (e) { throw new Error(`invalid regex: ${e.message}`) } }

  const totalFiles = files.length
  const matches = []
  const skipped = []
  let filesScanned = 0, filesMatched = 0, stopFlag = false
  let _completed = 0
  _trace(`doSearch begin: q=${q} totalFiles=${totalFiles} concurrency=${concurrency}`)

  const tasks = files.map((f, taskIdx) => async () => {
    if (stopFlag) return
    let text
    const tRead = Date.now()
    try {
      text = await withTimeout(getText(f.id, f.absPath), fileTimeoutMs, f.id)
    } catch (e) {
      _trace(`  SKIP task[${taskIdx}] ${f.id} after ${Date.now()-tRead}ms — ${e.message}`)
      let reason = 'read-error'
      if (e.message.startsWith('timeout')) reason = 'timeout'
      else if (e.message.startsWith('too-large')) reason = 'too-large'
      skipped.push({ id: f.id, reason })
      return
    }
    const rDur = Date.now() - tRead
    if (rDur > 500) _trace(`  SLOW task[${taskIdx}] ${f.id} read took ${rDur}ms`)
    if (stopFlag) return
    filesScanned++
    let fileMatches
    try {
      fileMatches = scanContent(text, q, { regex, caseSensitive }, maxPerFile)
    } catch {
      skipped.push({ id: f.id, reason: 'scan-error' })
      return
    }
    _completed++
    if (_completed % 200 === 0) _trace(`  progress: ${_completed}/${totalFiles} matches=${matches.length}`)
    if (fileMatches.length === 0) return
    filesMatched++
    for (const m of fileMatches) {
      matches.push({ id: f.id, line: m.line, col: m.col, snippet: m.snippet, totalInFile: fileMatches.length })
      if (matches.length >= max) { stopFlag = true; break }
    }
  })

  _trace(`runConcurrent starting`)
  await runConcurrent(tasks, concurrency, () => stopFlag)
  _trace(`runConcurrent finished: completed=${_completed} matches=${matches.length} skipped=${skipped.length}`)

  return {
    query: q, regex, caseSensitive,
    totalFiles, filesScanned, filesMatched,
    matches, skipped, truncated: stopFlag,
    ms: Date.now() - t0,
    cacheStats: { ...cacheStats, entries: cache.size, bytesMb: +(bytesUsed/1024/1024).toFixed(1) },
  }
}

parentPort.on('message', async (msg) => {
  _trace(`recv ${msg.type}${msg.q ? ` q=${msg.q}`:''}${msg.files ? ` files=${msg.files.length}` : ''}`)
  try {
    if (msg.type === 'search') {
      const t = Date.now()
      const payload = await doSearch(msg)
      _trace(`doSearch returned in ${Date.now() - t}ms — matches=${payload.matches.length} scanned=${payload.filesScanned}`)
      parentPort.postMessage({ type: 'result', id: msg.id, payload })
      _trace('postMessage result done')
    } else if (msg.type === 'invalidate') {
      invalidate(msg.id)
    } else if (msg.type === 'clear') {
      clearCache()
    } else {
      parentPort.postMessage({ type: 'error', id: msg.id, error: `unknown msg type: ${msg.type}` })
    }
  } catch (e) {
    _trace(`error: ${e.message}`)
    parentPort.postMessage({ type: 'error', id: msg.id, error: e.message || String(e) })
  }
})

_trace('parentPort handler set, sending ready')
parentPort.postMessage({ type: 'ready' })
_trace('ready sent')
