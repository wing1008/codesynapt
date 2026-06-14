// Position-based precision oracle (축2, 다언어) — judges #M1 from graph
// structure + symbol positions ALONE (no re-parse), so it works for every
// language. A confident same-file edge src->tgt is WRONG when src CONTAINS a
// same-named nested definition (defined inside src's line span) but the edge
// went to a DIFFERENT same-named definition outside src — the nested one shadows
// it, so the call must mean the inner one (the #M1 pattern). Validated against
// the exact babel-scope oracle on JS.
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

const LANG_GROUPS = {
  js: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], py: ['py', 'pyw', 'pyi'], java: ['java'], cs: ['cs'],
  go: ['go'], rust: ['rs'], kotlin: ['kt', 'kts'], swift: ['swift'], php: ['php'],
  cpp: ['c', 'cc', 'cpp', 'h', 'hpp'], bash: ['sh', 'bash'], scala: ['scala'], lua: ['lua'],
}
const targetDir = process.argv[2] || root
const langArg = (process.argv.find((a) => a.startsWith('--lang=')) || '').split('=')[1] || null
const allow = langArg ? new Set(LANG_GROUPS[langArg] || []) : parsers.SUPPORTED_EXTS

const files = []
const walk = (d) => {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === 'site-packages' || e.name === '__pycache__') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else { const ext = (e.name.split('.').pop() || '').toLowerCase(); if (allow.has(ext)) { try { files.push({ id: path.relative(targetDir, p).replace(/\\/g, '/'), ext, content: fs.readFileSync(p, 'utf8') }) } catch {} } }
  }
}
walk(targetDir)

const g = new sg.SymbolGraph()
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()

// index same-file same-name definitions
const byFileName = new Map()
for (const n of g.nodes.values()) {
  if (n.kind !== 'function' && n.kind !== 'method') continue
  const k = n.file + '|' + n.name
  if (!byFileName.has(k)) byFileName.set(k, [])
  byFileName.get(k).push(n)
}

let total = 0, wrong = 0
const ex = []
for (const [src, set] of g.callOut) {
  const sn = g.nodes.get(src); if (!sn || !sn.endLine) continue
  for (const t of set) {
    const tn = g.nodes.get(t); if (!tn || tn.file !== sn.file) continue
    const sibs = byFileName.get(tn.file + '|' + tn.name) || []
    if (sibs.length < 2) continue   // unique name -> can't be #M1
    total++
    // definitions nested INSIDE src (src's body shadows them)
    const nested = sibs.filter((d) => d.startLine > sn.startLine && d.startLine <= sn.endLine)
    if (nested.length > 0 && !nested.some((d) => d.id === tn.id)) {
      wrong++
      if (ex.length < 8) ex.push(`${sn.name}@${sn.startLine}→${tn.name}@${tn.startLine} but src nests ${tn.name}@${nested.map((d) => d.startLine).join(',')} (${sn.file.split('/').pop()})`)
    }
  }
}

const lbl = langArg || 'all'
console.log(`PRECISION(pos) ${lbl}: same-file edges w/ ambiguous name: ${total}  | WRONG(#M1): ${wrong} (${(100 * wrong / Math.max(1, total)).toFixed(1)}%)`)
ex.forEach((e) => console.log('  ✗ ' + e))
