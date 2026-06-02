// search-cache.cjs — LRU file content cache for full-text search.
//
// Design goals:
//   1) Zero misses: scanner emits add/change/remove → cache reacts.
//      mtime is also checked on every read as a belt-and-suspenders guard.
//   2) Fast: second search re-reads ~0 files; everything's in memory.
//   3) Bounded: LRU evicts least-recent files when over MAX_BYTES.
//
// Usage:
//   const cache = createSearchCache(scanner, { maxBytes: 100 * 1024 * 1024 })
//   const buf = await cache.read(id, absPath)   // returns Buffer
//   cache.invalidate(id)                         // manual nuke
//   cache.clear()                                 // wipe all
//   cache.stats()                                 // { entries, bytes, hits, misses, evictions }

const fs = require('fs')

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024  // 100 MB
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024  // skip caching files > 2 MB

function createSearchCache(scanner, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES
  const maxFileBytes = opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES

  // id → { mtime, buf, lastAccess }
  const cache = new Map()
  let bytesUsed = 0
  const stats = { hits: 0, misses: 0, evictions: 0, stales: 0 }

  // Hook scanner events for proactive invalidation
  if (scanner && typeof scanner.on === 'function') {
    scanner.on('file-changed', ({ id }) => invalidate(id))
    scanner.on('file-removed', ({ id }) => invalidate(id))
    // file-added: no action — next read will populate
  }

  function invalidate(id) {
    const entry = cache.get(id)
    if (entry) {
      bytesUsed -= entry.buf.length
      cache.delete(id)
    }
  }

  function clear() {
    cache.clear()
    bytesUsed = 0
  }

  function touch(id, entry) {
    // Move to end (most recently used) by re-inserting
    cache.delete(id)
    entry.lastAccess = Date.now()
    cache.set(id, entry)
  }

  function evictUntilFits(needed) {
    // Map iteration order = insertion order; oldest is at the front
    for (const [id, entry] of cache) {
      if (bytesUsed + needed <= maxBytes) break
      bytesUsed -= entry.buf.length
      cache.delete(id)
      stats.evictions++
    }
  }

  async function read(id, absPath) {
    // 1) stat for mtime — ~0.1ms
    let stat
    try { stat = await fs.promises.stat(absPath) }
    catch (e) { invalidate(id); throw e }

    // 2) cache hit if mtime unchanged
    const cached = cache.get(id)
    if (cached && cached.mtime === stat.mtimeMs) {
      stats.hits++
      touch(id, cached)
      return cached.buf
    }
    if (cached) stats.stales++   // mtime differed → stale

    // 3) read fresh
    let buf
    try { buf = await fs.promises.readFile(absPath) }
    catch (e) { invalidate(id); throw e }
    stats.misses++

    // 4) cache the new content if it fits the per-file limit
    if (buf.length <= maxFileBytes) {
      if (cached) {
        bytesUsed -= cached.buf.length
        cache.delete(id)
      }
      if (buf.length <= maxBytes) {
        evictUntilFits(buf.length)
        cache.set(id, { mtime: stat.mtimeMs, buf, lastAccess: Date.now() })
        bytesUsed += buf.length
      }
    } else if (cached) {
      // too big to cache anymore — drop old entry
      bytesUsed -= cached.buf.length
      cache.delete(id)
    }

    return buf
  }

  function getStats() {
    return {
      entries:   cache.size,
      bytes:     bytesUsed,
      bytesMb:   +(bytesUsed / 1024 / 1024).toFixed(1),
      maxBytes,
      hits:      stats.hits,
      misses:    stats.misses,
      stales:    stats.stales,
      evictions: stats.evictions,
      hitRate:   stats.hits + stats.misses === 0 ? null
                  : +(stats.hits / (stats.hits + stats.misses)).toFixed(3),
    }
  }

  // getText — like read, but returns the utf-8 decoded string. Caches the
  // decoded text on the entry so repeat searches skip the (CPU-bound) decode.
  // mtime invalidation also drops the text since the buf is replaced.
  async function getText(id, absPath) {
    const buf = await read(id, absPath)
    const entry = cache.get(id)
    if (entry) {
      if (!entry.text) entry.text = buf.toString('utf8')
      return entry.text
    }
    // Too large to cache — decode without storing
    return buf.toString('utf8')
  }

  return { read, getText, invalidate, clear, stats: getStats }
}

module.exports = { createSearchCache }
