// Recall oracle on REAL executed library code (stdlib). A driver imports+uses
// several stdlib modules; pytracer (precise) records every in-stdlib caller→
// callee that actually ran. We then build the static graph of ONLY the files
// that executed and check each observed IN-STDLIB edge: confident / candidate /
// RECALL MISS. No library inflation (only executed code is judged), real code
// (not synthetic). Usage: node _recall_stdlib.mjs
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
const pytracer = path.join(root, 'packages/core/lib/pytracer.py')

const pyExe = ['python', 'python3', 'py'].find((e) => { try { execFileSync(e, ['--version'], { stdio: 'ignore' }); return true } catch { return false } })
const stdlib = execFileSync(pyExe, ['-c', "import sysconfig;print(sysconfig.get_paths()['stdlib'])"], { encoding: 'utf8' }).trim()

// driver that exercises a spread of stdlib modules
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-std-'))
const driver = path.join(tmp, 'drive.py')
fs.writeFileSync(driver, `
import argparse, json, collections, configparser, csv, io, textwrap, string, difflib
p = argparse.ArgumentParser(description='d'); p.add_argument('--x', type=int, default=1); p.add_argument('--y', action='store_true')
p.parse_args(['--x', '5', '--y'])
json.dumps({'a': [1, 2, {'b': 3}], 'c': 'x'}); json.loads('{"k": [1, 2], "n": null}')
c = collections.OrderedDict(); c['a'] = 1; collections.Counter('abracadabra').most_common(2)
collections.defaultdict(list)['z'].append(1); collections.namedtuple('P', 'x y')(1, 2)
cp = configparser.ConfigParser(); cp.read_string('[s]\\nk=v\\n'); cp.get('s', 'k')
r = csv.reader(io.StringIO('a,b\\n1,2')); list(r); csv.writer(io.StringIO()).writerow([1, 2])
textwrap.fill('long ' * 20, width=30); textwrap.dedent('  x\\n  y')
string.Template('$a-$b').substitute(a='1', b='2')
list(difflib.unified_diff(['a', 'b'], ['a', 'c']))
`)

const obsFile = path.join(tmp, 'obs.jsonl')
execFileSync(pyExe, [pytracer, driver], { cwd: tmp, env: { ...process.env, CS_PYTRACE_OUT: obsFile, CS_PYTRACE_ROOT: stdlib } })
const observed = fs.readFileSync(obsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

// in-stdlib edges only (both caller & callee inside stdlib, not the driver)
const stdEdges = observed.filter((o) => !o.cf.includes('drive.py') && !o.ef.includes('drive.py'))
const filesNeeded = new Set()
for (const o of stdEdges) { filesNeeded.add(o.cf); filesNeeded.add(o.ef) }

// build static graph of just those executed files
const fileObjs = []
for (const rel of filesNeeded) {
  const abs = path.join(stdlib, rel)
  try { if (fs.existsSync(abs)) fileObjs.push({ id: rel, ext: 'py', content: fs.readFileSync(abs, 'utf8') }) } catch {}
}
const g = new sg.SymbolGraph()
// Precise import map from the RUNTIME trace: a cross-file caller→callee that
// actually executed IS an import relation. This replaces the naive "every file
// imports every file" (which over-imports and can over-resolve, inflating
// recall). Note: uses observed for both the import map and the recall judgment,
// so it measures "if the import map is exact, what can resolve" — the resolve
// logic's ceiling, not a self-fulfilling pass (resolve still fails on namespace/
// alias/compound patterns even with the import present).
const preciseFI = new Map()
for (const o of [...filesNeeded].map((f) => f)) preciseFI.set(o, new Set())
for (const o of stdEdges) { if (o.cf !== o.ef) { if (!preciseFI.has(o.cf)) preciseFI.set(o.cf, new Set()); preciseFI.get(o.cf).add(o.ef) } }
g.fileImports = preciseFI
for (const f of fileObjs) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of fileObjs) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()

const confident = new Set(), candidate = new Set()
for (const [s, set] of g.callOut) { const sn = g.nodes.get(s); for (const t of set) { const tn = g.nodes.get(t); if (sn && tn) confident.add(`${sn.file}:${sn.name}->${tn.file}:${tn.name}`) } }
for (const [s, set] of (g.candOut || new Map())) { const sn = g.nodes.get(s); for (const t of set) { const tn = g.nodes.get(t); if (sn && tn) candidate.add(`${sn.file}:${sn.name}->${tn.file}:${tn.name}`) } }
const calleeAt = (file, line) => { for (const n of g.nodes.values()) if (n.file === file && n.startLine === line && n.kind !== 'module') return n; return null }
const callerAt = (file, line) => { let b = null; for (const n of g.nodes.values()) if (n.file === file && n.kind !== 'module' && n.startLine <= line && (n.endLine || n.startLine) >= line) { if (!b || n.startLine > b.startLine) b = n } return b }

const isDunder = (n) => /^__.+__$/.test(n)
// free = bare-callable free function (결정가능분, 정적 100% 목표).
// member = method (obj.method() → 타입불명 = 동적, 후보로 커버해야).
const grp = { free: { c: 0, cand: 0, m: 0 }, member: { c: 0, cand: 0, m: 0 } }
let dunderSkip = 0, unmatched = 0
const freeMiss = [], memberMiss = []
for (const o of stdEdges) {
  const callee = calleeAt(o.ef, o.el); const caller = callerAt(o.cf, o.cl)
  if (!callee || !caller) { unmatched++; continue }
  if (caller.id === callee.id) continue
  if (isDunder(callee.name)) { dunderSkip++; continue }   // operator/protocol, not a named call
  const isMember = callee.kind === 'method' || (callee.qualifiedName && callee.qualifiedName.includes('.') && callee.qualifiedName !== callee.name)
  const G = isMember ? grp.member : grp.free
  const key = `${caller.file}:${caller.name}->${callee.file}:${callee.name}`
  if (confident.has(key)) G.c++
  else if (candidate.has(key)) G.cand++
  else { G.m++; (isMember ? memberMiss : freeMiss).push(`${caller.name}→${callee.name} (${o.cf.split('/').pop()}:${o.cl})`) }
}
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

const fd = grp.free.c + grp.free.cand + grp.free.m
const md = grp.member.c + grp.member.cand + grp.member.m
console.log(`\n=== RECALL ORACLE (실행 stdlib 실코드, ${filesNeeded.size}파일) — 정제: 결정가능분 vs 동적 ===`)
console.log(`관측 ${stdEdges.length} | dunder/연산자 제외: ${dunderSkip} | unmatched(파싱갭): ${unmatched}`)
console.log(`\n[결정가능분 = free function 호출 → 이상향 "정적 100%" 목표]`)
console.log(`  confident: ${grp.free.c}  miss: ${grp.free.m}  → RECALL: ${fd ? (100 * grp.free.c / fd).toFixed(0) : 0}% (${grp.free.c}/${fd})`)
console.log(`\n[동적 = member call obj.method() → 타입불명 → "후보 최대치" 영역]`)
console.log(`  confident: ${grp.member.c}  candidate(후보커버): ${grp.member.cand}  miss(후보도못함): ${grp.member.m}  → 커버: ${md ? (100 * (grp.member.c + grp.member.cand) / md).toFixed(0) : 0}%`)
if (freeMiss.length) { console.log(`\n결정가능분 miss (진짜 정적 놓침 — 버그 후보):`); freeMiss.slice(0, 10).forEach((m) => console.log('  ✗ ' + m)) }
