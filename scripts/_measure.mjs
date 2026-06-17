// Layer accuracy/speed/token measurement harness (exploratory — insp-004 follow-up).
// Usage: node scripts/_measure.mjs <dir> [--lang ext]
// Independent oracle for "dead but actually called": search file text for call
// patterns (NOT the graph) — a dead symbol whose name appears as `name(` or
// `.name(` elsewhere is a recall-miss SUSPECT (name-based, so homonyms inflate it).
import { performance } from 'perf_hooks'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const sg = require(path.join(root, 'packages/core/lib/symbol-graph.cjs'))
const parsers = require(path.join(root, 'packages/core/lib/symbol-parsers.cjs'))
parsers.registerAll()

const targetDir = process.argv[2] || root
const SUP = parsers.SUPPORTED_EXTS

// Language-group isolation: parsing a SINGLE grammar group per process avoids
// the cross-grammar wasm contamination + memory-accumulation OOM that breaks a
// mixed-language scan (insp follow-up: bash/php got corrupted, swift/cpp OOM'd
// when many grammars loaded in one process). --lang restricts to one group.
const LANG_GROUPS = {
  js: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], py: ['py', 'pyw', 'pyi'],
  java: ['java'], cs: ['cs'], go: ['go'], rust: ['rs'], kotlin: ['kt', 'kts'],
  swift: ['swift'], php: ['php'], cpp: ['c', 'cc', 'cpp', 'h', 'hpp'],
  bash: ['sh', 'bash'], scala: ['scala'], lua: ['lua'], rb: ['rb'], ruby: ['rb'],
}
const langArg = (process.argv.find((a) => a.startsWith('--lang=')) || '').split('=')[1] || null
const asJson = process.argv.includes('--json')
const allowExt = langArg ? new Set(LANG_GROUPS[langArg] || []) : SUP

function collect(dir) {
  const out = []
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build'
          || e.name === 'site-packages' || e.name === '__pycache__' || e.name === 'test' || e.name === 'tests') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { const ext = (e.name.split('.').pop() || '').toLowerCase(); if (allowExt.has(ext)) { try { out.push({ id: path.relative(targetDir, p).replace(/\\/g, '/'), ext, content: fs.readFileSync(p, 'utf8') }) } catch {} } }
    }
  }
  walk(dir)
  return out
}

const files = collect(targetDir)
const t0 = performance.now()
const g = new sg.SymbolGraph()
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()
const scanMs = performance.now() - t0
const acc = g.accounting()

let calls = 0, cands = 0, dyn = 0
for (const [, s] of g.callOut) calls += s.size
for (const [, s] of (g.candOut || new Map())) cands += s.size
for (const [, l] of g.dynamicSites) dyn += l.length
const declines = Object.entries(g.declineReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)

// dead recall-miss suspect: name appears as a call elsewhere
const deadNodes = acc.dead.map((id) => g.nodes.get(id)).filter((n) => n && (n.kind === 'function' || n.kind === 'method') && n.name && n.name !== '<module>' && n.name.length > 3)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let sampled = 0, called = 0, memberCalled = 0
const ex = []
for (const n of deadNodes.slice(0, 80)) {
  const bare = new RegExp('\\b' + esc(n.name) + '\\s*\\(', 'g')
  const member = new RegExp('\\.\\s*' + esc(n.name) + '\\s*\\(')
  let occ = 0, isMember = false
  for (const f of files) { const m = f.content.match(bare); if (m) occ += m.length; if (member.test(f.content)) isMember = true }
  sampled++
  if (occ > 1) { called++; if (isMember) memberCalled++; if (ex.length < 8) ex.push(`${n.name} @${n.file.split('/').pop()}:${n.startLine} — ${occ} occ ${isMember ? '(member)' : '(bare)'}`) }
}

// #M1 quantify: a dead function with a SAME-FILE SAME-NAME sibling that DID get
// callers — the call likely went to the wrong same-named function (nested-scope
// collision), making this one a false-dead. Measured over the dead sample.
const byNameFile = new Map()
for (const n of g.nodes.values()) {
  if (n.kind !== 'function' && n.kind !== 'method') continue
  const k = n.file + '|' + n.name
  if (!byNameFile.has(k)) byNameFile.set(k, [])
  byNameFile.get(k).push(n)
}
let m1Total = 0, m1Collision = 0
const m1ex = []
for (const n of deadNodes) {
  m1Total++
  const sibs = (byNameFile.get(n.file + '|' + n.name) || []).filter((s) => s.id !== n.id)
  const sibWithCallers = sibs.find((s) => (g.inAdj.get(s.id)?.size || 0) > 0)
  if (sibWithCallers) {
    m1Collision++
    if (m1ex.length < 8) m1ex.push(`${n.name} @${n.file.split('/').pop()}:${n.startLine} (dead) ↔ sibling @${sibWithCallers.startLine} has ${g.inAdj.get(sibWithCallers.id).size} callers`)
  }
}

const byExt = {}
for (const f of files) byExt[f.ext] = (byExt[f.ext] || 0) + 1

if (asJson) {
  console.log(JSON.stringify({
    dir: targetDir, lang: langArg, files: files.length, symbols: g.nodes.size,
    msPerFile: +(scanMs / Math.max(1, files.length)).toFixed(1), scanMs: Math.round(scanMs),
    confident: calls, candidates: cands, dynamicSites: dyn,
    dead: acc.deadCount, deadPct: +(100 * acc.deadCount / Math.max(1, g.nodes.size)).toFixed(0),
    unexplained: acc.unexplained,
    declines: Object.fromEntries(declines),
    m1Total, m1Collision, m1Pct: +(100 * m1Collision / Math.max(1, m1Total)).toFixed(0),
    recallSampled: sampled, recallCalled: called,
  }))
  process.exit(0)
}

console.log(`\n=== MEASURE: ${targetDir} ===`)
console.log(`files: ${files.length}  | symbols: ${g.nodes.size}  | scan: ${scanMs.toFixed(0)}ms (${(scanMs / Math.max(1, files.length)).toFixed(1)}ms/file)`)
console.log(`langs: ${Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([e, c]) => `${e}:${c}`).join(' ')}`)
console.log(`\n-- 2층 정직성 --`)
console.log(`confident calls: ${calls}  | candidates(동적후보): ${cands}  | dynamicSites(침묵0): ${dyn}`)
console.log(`accounting: entry+reachable ${acc.entryCount + acc.reachableCount} | possible ${acc.possibleCount} | dead ${acc.deadCount} (${(100 * acc.deadCount / g.nodes.size).toFixed(0)}%) | unexplained ${acc.unexplained}`)
console.log(`decline top: ${declines.map(([k, v]) => `${k}:${v}`).join('  ')}`)
console.log(`\n-- dead recall-miss 의심 (이름기반 oracle, 표본 ${sampled}) --`)
console.log(`dead인데 호출패턴 발견: ${called}/${sampled} (${(100 * called / Math.max(1, sampled)).toFixed(0)}%)  이 중 member: ${memberCalled}`)
ex.forEach((e) => console.log('  • ' + e))
console.log(`\n-- #M1 nested 이름충돌 false-dead 정량화 (dead 함수 표본 ${m1Total}) --`)
console.log(`동명 형제가 callers를 가진 dead: ${m1Collision}/${m1Total} (${(100 * m1Collision / Math.max(1, m1Total)).toFixed(0)}% — 충돌 false-dead 또는 틀린연결 강력 의심)`)
m1ex.forEach((e) => console.log('  • ' + e))
