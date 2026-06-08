'use strict'
// ── Python sub-engine (BLOCK) ────────────────────────────────────────────────
// Resolves Python calls to their declarations via jedi's goto (follows imports +
// inferred types). TOOLCHAIN-GATED: needs a Python interpreter with `jedi`
// installed (`pip install jedi`) — available() false otherwise -> AST fallback.
//
// IMPORTANT — this block is OPT-IN / background only. jedi runs a goto inference
// per call site, so it is SLOW (~24s on a small repo, minutes on large ones),
// ~15x the TS/Java/C# blocks. Python's AST engine already resolves ~86% of
// jedi-resolvable calls, so the marginal gain is ~13%; enable this only when the
// last slice matters and the latency is acceptable. (pyright would be faster but
// is a much larger LSP integration for the same small gain.)

const cp = require('child_process')
const path = require('path')

const HELPER = path.join(__dirname, 'subengine-python', 'sub.py')

let _py = null   // resolved interpreter command, or false
function py() {
  if (_py !== null) return _py
  for (const cmd of ['python', 'python3', 'py']) {
    try { cp.execFileSync(cmd, ['-c', 'import jedi'], { stdio: 'ignore', timeout: 15000 }); _py = cmd; return _py } catch { /* try next */ }
  }
  _py = false
  return _py
}
function available() { return !!py() }

function resolve(files, rootDir) {
  const cmd = py()
  if (!cmd) return []
  if (!files.some((f) => f.toLowerCase().endsWith('.py'))) return []
  try {
    const out = cp.execFileSync(cmd, [HELPER, rootDir], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 300000 })
    const recs = []
    for (const line of out.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r.declName) recs.push(r) } catch { /* skip */ } }
    return recs
  } catch { return [] }
}

// external: spawns an out-of-process toolchain (python+jedi). heavy: jedi is also
// slow (~24s). enrich() runs this only when BOTH opted in (external && heavy).
module.exports = { exts: ['py'], available, resolve, name: 'python', external: true, heavy: true }
