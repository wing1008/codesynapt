// Language-isolated measurement orchestrator (measurement infra — 축1+축3).
// Runs _measure.mjs ONCE PER LANGUAGE GROUP in a SEPARATE process, so each
// process loads only one grammar → no cross-grammar wasm contamination, and the
// process exits between languages → no grammar-accumulation OOM. The dead/recall
// numbers are still measured the same way; only the grammar isolation changes.
// Usage: node scripts/_measure_iso.mjs <dir> [--lang=js,py,...]
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const measure = path.join(__dirname, '_measure.mjs')
const targetDir = process.argv[2]
if (!targetDir) { console.error('usage: _measure_iso.mjs <dir>'); process.exit(2) }

const LANG_GROUPS = {
  js: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], py: ['py', 'pyw', 'pyi'],
  java: ['java'], cs: ['cs'], go: ['go'], rust: ['rs'], kotlin: ['kt', 'kts'],
  swift: ['swift'], php: ['php'], cpp: ['c', 'cc', 'cpp', 'h', 'hpp'],
  bash: ['sh', 'bash'], scala: ['scala'], lua: ['lua'],
}
const only = (process.argv.find((a) => a.startsWith('--lang=')) || '').split('=')[1]
const onlySet = only ? new Set(only.split(',')) : null

// Which language groups actually have files in this corpus?
const present = new Set()
const walk = (d) => {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === 'site-packages' || e.name === '__pycache__') continue
    if (e.isDirectory()) walk(path.join(d, e.name))
    else { const ext = (e.name.split('.').pop() || '').toLowerCase(); for (const [g, es] of Object.entries(LANG_GROUPS)) if (es.includes(ext)) present.add(g) }
  }
}
walk(targetDir)

const langs = [...present].filter((g) => !onlySet || onlySet.has(g))
const rows = []
for (const g of langs) {
  try {
    const out = execFileSync(process.execPath, ['--max-old-space-size=4096', measure, targetDir, `--lang=${g}`, '--json'],
      { encoding: 'utf8', maxBuffer: 1e8 })
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
    rows.push({ lang: g, ...JSON.parse(line) })
  } catch (e) {
    rows.push({ lang: g, error: (e.message || '').split('\n')[0].slice(0, 50) })
  }
}

console.log(`\n=== ISOLATED MEASURE: ${targetDir} (${langs.length} langs, separate processes) ===`)
console.log('lang   files  sym    ms/f  dead%  #M1%  conf   cand    unexp  status')
for (const r of rows) {
  if (r.error) { console.log(`${r.lang.padEnd(6)} ERROR: ${r.error}`); continue }
  console.log(
    `${r.lang.padEnd(6)} ${String(r.files).padStart(5)} ${String(r.symbols).padStart(6)} ` +
    `${String(r.msPerFile).padStart(5)} ${String(r.deadPct + '%').padStart(5)} ${String(r.m1Pct + '%').padStart(5)} ` +
    `${String(r.confident).padStart(6)} ${String(r.candidates).padStart(7)} ${String(r.unexplained).padStart(5)}  ` +
    `${r.unexplained === 0 ? 'ok' : 'UNEXPLAINED!'}`)
}
const ok = rows.filter((r) => !r.error).length
console.log(`\n${ok}/${rows.length} langs measured cleanly (no contamination/OOM via isolation)`)
