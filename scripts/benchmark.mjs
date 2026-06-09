// CodeSynapt benchmark — speed + tokens, reproducible.
//
//   node scripts/benchmark.mjs <targetRepoPath> [--runs N] [--json]
//
// Measures, on a real codebase:
//   1. Cold scan      — Scanner start → first complete snapshot (median of N).
//   2. Incremental    — add a file → next snapshot, then remove → next snapshot
//                       (the real watcher path: chokidar awaitWriteFinish +
//                       snapshot debounce). Median of N. Non-destructive (uses a
//                       temp probe file; never touches your sources).
//   3. Endpoint p50/p95 — over a real localhost socket, 12 iters each.
//   4. Tokens         — the value prop: the cs answer's token cost vs the tokens
//                       an agent would spend READING the files to answer the same
//                       question. Token estimate = JSON/text length / 4 chars —
//                       the SAME estimator cs uses (meta.tokenEstimate), applied
//                       to both sides so the ratio is apples-to-apples. (Exact
//                       counts vary by model tokenizer; this is a consistent
//                       estimate, not a per-model number.)
//
// Honest by construction: every number here is produced by running the real
// Scanner / control-server on the target — nothing is hard-coded.
import { Scanner } from '../packages/core/scanner.js'
import { createRequire } from 'module'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
const require = createRequire(import.meta.url)
const { createControlServer } = require('../packages/core/lib/control-server.cjs')

const args = process.argv.slice(2)
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.')
const RUNS = parseInt((args.find((a) => a.startsWith('--runs=')) || '--runs=5').split('=')[1], 10) || 5
const asJson = args.includes('--json')
if (!fs.existsSync(root)) { console.error('path not found:', root); process.exit(1) }

const tok = (s) => Math.ceil(String(s).length / 4)          // matches estimateTokens()
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] }
const ms1 = (n) => Math.round(n)

function scanOnce(r) {
  return new Promise((resolve) => {
    const s = new Scanner(r)
    const t0 = performance.now()
    s.once('snapshot', (snap) => resolve({ ms: performance.now() - t0, snap, s }))
    s.start()
  })
}
const nextSnap = (s) => new Promise((res) => { const t0 = performance.now(); s.once('snapshot', () => res(performance.now() - t0)) })

const out = { target: root, runs: RUNS }

// ── 1. Cold scan (median of RUNS) ──
const cold = []
let live = null, baseSnap = null
for (let i = 0; i < RUNS; i++) {
  const { ms, snap, s } = await scanOnce(root)
  cold.push(ms)
  if (i === RUNS - 1) { live = s; baseSnap = snap } else { try { s.stop() } catch {} }
}
out.files = baseSnap.files.length
out.edges = baseSnap.edges.length
out.coldScanMs = { median: ms1(med(cold)), min: ms1(Math.min(...cold)), max: ms1(Math.max(...cold)) }

// ── 2. Incremental latency (add probe → snapshot, remove → snapshot) ──
const probe = path.join(root, '__cs_bench_probe__.ts')
const addL = [], rmL = []
for (let i = 0; i < RUNS; i++) {
  const pa = nextSnap(live); fs.writeFileSync(probe, `export const p${i} = ${i}\n`); addL.push(await pa)
  const pr = nextSnap(live); fs.rmSync(probe, { force: true }); rmL.push(await pr)
}
try { live.stop() } catch {}
out.incrementalMs = { addMedian: ms1(med(addL)), removeMedian: ms1(med(rmL)) }

// ── start an in-process control-server over a real socket ──
let curRoot = root
const lib = createControlServer({ scanner: (await scanOnce(root)).s, getCurrentRoot: () => curRoot })
const server = http.createServer(lib.handleControlRequest)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const get = (p) => new Promise((resolve, reject) => {
  const t0 = performance.now()
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ ms: performance.now() - t0, json: (() => { try { return JSON.parse(b) } catch { return null } })(), raw: b }))
  }).on('error', reject)
})
// wait for the server's own scanner to finish (initialScanComplete)
for (let i = 0; i < 200; i++) { const h = await get('/health'); if (h.json && h.json.initialScanComplete) break; await new Promise((r) => setTimeout(r, 50)) }

// ── 3. Endpoint latency ──
const eps = ['/health', '/summary', '/graph?limit=100', '/external', '/preflight', '/symbol/summary']
out.endpoints = {}
for (const ep of eps) {
  await get(ep) // warm
  const lat = []
  for (let i = 0; i < 12; i++) lat.push((await get(ep)).ms)
  out.endpoints[ep] = { p50: ms1(med(lat)), p95: ms1(p95(lat)) }
}

// ── 4. Token benchmark ──
// (a) Project map: cs /summary vs reading every source file to map structure.
const sum = await get('/summary')
let totalSrcTokens = 0
for (const f of baseSnap.files) {
  try { totalSrcTokens += tok(fs.readFileSync(path.join(root, f.id.split('/').join(path.sep)), 'utf8')) } catch {}
}
const summaryTokens = (sum.json && sum.json.meta && sum.json.meta.tokenEstimate) || tok(sum.raw)
out.tokens = { projectMap: { csSummary: summaryTokens, readAllSources: totalSrcTokens, ratio: +(totalSrcTokens / summaryTokens).toFixed(1) } }

// (b) Impact analysis: "what breaks if I change <hub>?". Pick the most-imported
// internal file (max DIRECT importers from the graph), then compare cs_blast's
// answer against reading the whole transitive blast radius (reverse-BFS depth 3),
// which is what an agent does to judge full impact.
const revAdj = new Map()        // target → [sources that import it]
const directImp = new Map()     // target → Set<source>
for (const e of baseSnap.edges) {
  if (!revAdj.has(e.t)) revAdj.set(e.t, [])
  revAdj.get(e.t).push(e.s)
  if (!directImp.has(e.t)) directImp.set(e.t, new Set())
  directImp.get(e.t).add(e.s)
}
let hub = null, hubN = 0
for (const [id, set] of directImp) if (set.size > hubN) { hub = id; hubN = set.size }
if (hub) {
  const seen = new Set()
  let frontier = [hub]
  for (let d = 0; d < 3; d++) {
    const next = []
    for (const id of frontier) for (const s of (revAdj.get(id) || [])) if (!seen.has(s)) { seen.add(s); next.push(s) }
    frontier = next
  }
  let readTokens = 0
  for (const id of seen) { try { readTokens += tok(fs.readFileSync(path.join(root, id.split('/').join(path.sep)), 'utf8')) } catch {} }
  const blast = await get('/blast/' + hub.split('/').map(encodeURIComponent).join('/') + '?depth=3')
  const blastTokens = (blast.json && blast.json.meta && blast.json.meta.tokenEstimate) || tok(blast.raw)
  out.tokens.impact = {
    hub, directImporters: hubN, blastRadiusFiles: seen.size,
    csBlast: blastTokens,
    readBlastRadius: readTokens,
    ratio: readTokens && blastTokens ? +(readTokens / blastTokens).toFixed(1) : null,
  }
}

try { server.close() } catch {}

// ── report ──
if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
const r = out
console.log(`\n📊 CodeSynapt benchmark — ${r.target}`)
console.log(`   ${r.files} files · ${r.edges} edges · ${RUNS} runs · token est. = chars/4 (matches cs meta)\n`)
console.log(`SPEED`)
console.log(`  cold scan          ${r.coldScanMs.median} ms median  (${r.coldScanMs.min}–${r.coldScanMs.max})`)
console.log(`  incremental add    ${r.incrementalMs.addMedian} ms median   (file saved → new snapshot)`)
console.log(`  incremental remove ${r.incrementalMs.removeMedian} ms median`)
console.log(`  endpoint            p50 / p95 ms`)
for (const [ep, v] of Object.entries(r.endpoints)) console.log(`    ${ep.padEnd(22)} ${String(v.p50).padStart(4)} / ${v.p95}`)
console.log(`\nTOKENS  (cs answer vs reading files for the same question)`)
console.log(`  project map   cs_summary ${r.tokens.projectMap.csSummary} tok  vs  read all sources ${r.tokens.projectMap.readAllSources} tok   →  ${r.tokens.projectMap.ratio}× smaller`)
if (r.tokens.impact) {
  const t = r.tokens.impact
  console.log(`  impact "${t.hub}"  (${t.directImporters} direct importers, ${t.blastRadiusFiles} files in 3-hop blast radius)`)
  console.log(`    cs_blast ${t.csBlast} tok  vs  read whole blast radius ${t.readBlastRadius} tok   →  ${t.ratio}× smaller`)
}
console.log()
