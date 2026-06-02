// logger.cjs — minimal structured logger (NDJSON file + stderr).
//
// Why not pino: pino adds a runtime dep (we currently have 3 deps total —
// keeping it lean matters). This is a 50-line equivalent for our actual
// needs: ts/level/module/msg as one JSON line per entry, stderr fallback
// for errors, no rotation (callers pick the file path).
//
// Usage:
//   const { createLogger } = require('./logger.cjs')
//   const log = createLogger({ file: '/var/log/cs.jsonl', module: 'search' })
//   log.info('search started', { q: 'foo' })
//   log.warn('cache eviction', { freed: 12345 })
//   log.error('disk full', { errno: 28 })

const fs = require('fs')
const path = require('path')

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

function createLogger(opts = {}) {
  const file = opts.file || null
  const module_ = opts.module || 'cs'
  const minLevel = LEVELS[opts.level || 'info'] || 30
  const echoStderr = opts.echoStderr ?? 'warn'   // 'never' | 'warn' | 'always'

  // Ensure log directory exists once
  if (file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  }

  function emit(level, msg, meta) {
    if (LEVELS[level] < minLevel) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      module: module_,
      msg,
      ...(meta || {}),
    }
    const line = JSON.stringify(entry) + '\n'
    if (file) {
      try { fs.appendFileSync(file, line) }
      catch (e) { process.stderr.write(`[logger] append failed: ${e.message}\n`) }
    }
    const shouldEcho = echoStderr === 'always'
                     || (echoStderr === 'warn' && LEVELS[level] >= LEVELS.warn)
    if (shouldEcho) {
      process.stderr.write(`[${module_}] ${level.toUpperCase()} ${msg}\n`)
    }
  }

  return {
    trace: (m, x) => emit('trace', m, x),
    debug: (m, x) => emit('debug', m, x),
    info:  (m, x) => emit('info',  m, x),
    warn:  (m, x) => emit('warn',  m, x),
    error: (m, x) => emit('error', m, x),
    fatal: (m, x) => emit('fatal', m, x),
    child: (extra) => createLogger({ ...opts, module: extra.module || module_ }),
  }
}

module.exports = { createLogger, LEVELS }
