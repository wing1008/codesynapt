'use strict'
// ── Java sub-engine (BLOCK) ──────────────────────────────────────────────────
// Resolves Java calls to their declarations with full type info via the javac
// Compiler API (com.sun.source). Unlike TS (typescript is a bundled npm dep),
// this is TOOLCHAIN-GATED: it needs a JDK (javac/java) on the user's machine —
// available() is false otherwise, and the caller falls back to the AST graph.
//
// A tiny Java helper (subengine-java/Sub.java) does the parse + type-attribution
// + call→decl resolution and emits one JSON record per line; it's compiled once
// to a temp cache on first use. Pure (no SymbolGraph knowledge); the merge layer
// maps records to nodes.

const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const HELPER_SRC = path.join(__dirname, 'subengine-java', 'Sub.java')

let _avail = null
function available() {
  if (_avail !== null) return _avail
  try { cp.execFileSync('javac', ['-version'], { stdio: 'ignore' }); _avail = true } catch { _avail = false }
  return _avail
}

let _classDir = null
function ensureCompiled() {
  if (_classDir) return _classDir
  const dir = path.join(os.tmpdir(), 'cs-subengine-java')
  fs.mkdirSync(dir, { recursive: true })
  const cls = path.join(dir, 'Sub.class')
  const stale = !fs.existsSync(cls) || fs.statSync(HELPER_SRC).mtimeMs > fs.statSync(cls).mtimeMs
  if (stale) cp.execFileSync('javac', ['-d', dir, HELPER_SRC], { stdio: 'ignore' })
  _classDir = dir
  return dir
}

function resolve(files, rootDir) {
  if (!available()) return []
  if (!files.some((f) => f.toLowerCase().endsWith('.java'))) return []
  try {
    const dir = ensureCompiled()
    const out = cp.execFileSync('java', ['-cp', dir, 'Sub', rootDir], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const recs = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r.declName) recs.push(r) } catch { /* skip malformed */ }
    }
    return recs
  } catch { return [] }
}

module.exports = { exts: ['java'], available, resolve, name: 'java' }
