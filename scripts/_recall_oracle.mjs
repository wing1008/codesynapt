// Recall oracle (축2) — runtime trace as independent ground truth for "정적
// 100% (놓침 0)". Runs a Python app under pytracer (sys.setprofile = PRECISE,
// not sampling), then checks every OBSERVED caller→callee edge against the
// static graph: confident (covered), candidate (covered as a dynamic-dispatch
// possibility — honest per the vision), or RECALL MISS (observed but neither =
// the static graph genuinely dropped a real call). No library inflation: only
// edges that actually executed are judged. Usage:
//   node _recall_oracle.mjs <app-dir> <entry.py>
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const sg = require(path.join(root, 'packages/core/lib/symbol-graph.cjs'))
const parsers = require(path.join(root, 'packages/core/lib/symbol-parsers.cjs'))
parsers.registerAll()

const appDir = path.resolve(process.argv[2])
const entry = process.argv[3]
const pytracer = path.join(root, 'packages/core/lib/pytracer.py')

// 1) run under pytracer
const obsFile = path.join(os.tmpdir(), 'recall-obs-' + process.pid + '.jsonl')
const pyExe = ['python', 'python3', 'py'].find((e) => { try { execFileSync(e, ['--version'], { stdio: 'ignore' }); return true } catch { return false } })
if (!pyExe) { console.error('no python'); process.exit(2) }
execFileSync(pyExe, [pytracer, path.join(appDir, entry)], {
  cwd: appDir, env: { ...process.env, CS_PYTRACE_OUT: obsFile, CS_PYTRACE_ROOT: appDir },
})
const observed = fs.readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
try { fs.unlinkSync(obsFile) } catch {}

// 2) static graph of the app
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.pyw?$/.test(e.name)) files.push({ id: path.relative(appDir, p).replace(/\\/g, '/'), ext: 'py', content: fs.readFileSync(p, 'utf8') }) } }
walk(appDir)
const g = new sg.SymbolGraph()
// file imports: naive — every file imports every other (small apps)
const ids = files.map((f) => f.id)
g.fileImports = new Map(ids.map((id) => [id, new Set(ids.filter((o) => o !== id))]))
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()

const confident = new Set(), candidate = new Set()
for (const [s, set] of g.callOut) { const sn = g.nodes.get(s); for (const t of set) { const tn = g.nodes.get(t); if (sn && tn) confident.add(`${sn.file}:${sn.name}->${tn.file}:${tn.name}`) } }
for (const [s, set] of (g.candOut || new Map())) { const sn = g.nodes.get(s); for (const t of set) { const tn = g.nodes.get(t); if (sn && tn) candidate.add(`${sn.file}:${sn.name}->${tn.file}:${tn.name}`) } }

const calleeAt = (file, line) => { for (const n of g.nodes.values()) if (n.file === file && n.startLine === line && n.kind !== 'module') return n; return null }
const callerAt = (file, line) => { let best = null; for (const n of g.nodes.values()) if (n.file === file && n.kind !== 'module' && n.startLine <= line && (n.endLine || n.startLine) >= line) { if (!best || n.startLine > best.startLine) best = n } return best }

let conf = 0, cand = 0, miss = 0
const misses = []
for (const o of observed) {
  const callee = calleeAt(o.ef, o.el); if (!callee) continue
  const caller = callerAt(o.cf, o.cl); if (!caller) continue
  if (caller.name === callee.name && caller.file === callee.file) continue // self/recursion noise
  const key = `${caller.file}:${caller.name}->${callee.file}:${callee.name}`
  if (confident.has(key)) conf++
  else if (candidate.has(key)) cand++
  else { miss++; misses.push(`${caller.name}→${callee.name} (${o.cf}:${o.cl})`) }
}
const totalCovered = conf + cand
const denom = conf + cand + miss
console.log(`\n=== RECALL ORACLE: ${appDir} (observed=${observed.length}, judged=${denom}) ===`)
console.log(`confident(정적 직결): ${conf}  | candidate(동적 후보로 커버): ${cand}  | RECALL MISS(진짜 놓침): ${miss}`)
console.log(`recall(confident만): ${denom ? (100 * conf / denom).toFixed(0) : 0}%  | recall(후보 포함=정직커버): ${denom ? (100 * totalCovered / denom).toFixed(0) : 0}%`)
misses.forEach((m) => console.log('  ✗ ' + m))
