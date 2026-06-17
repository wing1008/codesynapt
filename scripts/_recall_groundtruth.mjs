// Head-to-head RECALL against an independent ground truth (babel scope).
// Ground truth = every same-file call where babel resolves the callee name to a
// same-file definition. Then measure what fraction of THOSE true edges each tool
// actually drew. Same oracle for both tools → fair recall comparison, and it
// pinpoints the exact edges WE miss that the truth (and a competitor) has.
//
// Usage: node scripts/_recall_groundtruth.mjs <repoDir> [gitnexusEdges.json]
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
const babel = require('@babel/parser')
const traverse = require('@babel/traverse').default

const repoDir = path.resolve(process.argv[2])
const gnxFile = process.argv[3] ? path.resolve(process.argv[3]) : null
const JS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'])

// ── collect files ──
const files = []
const walk = (d) => {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else { const ext = (e.name.split('.').pop() || '').toLowerCase(); if (JS.has(ext)) { try { files.push({ id: path.relative(repoDir, p).replace(/\\/g, '/'), ext, content: fs.readFileSync(p, 'utf8') }) } catch {} } }
  }
}
walk(repoDir)
const contentOf = new Map(files.map((f) => [f.id, f.content]))

// ── ground truth: same-file calls babel resolves to a same-file def ──
const PARSE = { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy', 'objectRestSpread'] }
const truth = []   // {file, callLine, name, defLine}
for (const f of files) {
  let ast; try { ast = babel.parse(f.content, PARSE) } catch { continue }
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee
      const name = callee.type === 'Identifier' ? callee.name
        : (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') ? callee.property.name : null
      if (!name) return
      const callLine = p.node.loc?.start.line; if (!callLine) return
      const b = p.scope.getBinding(name)
      if (!b || !b.path?.node?.loc) return            // unresolved / global / import → not same-file-provable
      // must bind to a real same-file CALLABLE def, in THIS file.
      const bn = b.path.node
      const k = bn.type
      // A `const x = require('..')` / `const x = factory()` declarator is an
      // imported/aliased callable, NOT a same-file definition — babel binds the
      // call to the alias, but the real target is cross-file. Counting it tanks
      // recall on require-heavy code (express tests) with edges no same-file
      // graph should draw. Only accept a VariableDeclarator whose init is an
      // actual function/arrow literal.
      if (k === 'VariableDeclarator') {
        const it = bn.init?.type
        if (it !== 'FunctionExpression' && it !== 'ArrowFunctionExpression') return
      } else if (!/Function|Class|ClassMethod|ObjectMethod/.test(k)) return
      truth.push({ file: f.id, callLine, name, defLine: bn.loc.start.line })
    },
  })
}

// ── our graph edges ──
const g = new sg.SymbolGraph()
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()
const ourEdges = []   // {file, cs, ce, name, defLine}
for (const [src, set] of g.callOut) {
  const sn = g.nodes.get(src); if (!sn) continue
  for (const t of set) { const tn = g.nodes.get(t); if (tn && tn.file === sn.file && tn.name) ourEdges.push({ file: sn.file, cs: sn.startLine, ce: sn.endLine || sn.startLine, name: tn.name, defLine: tn.startLine }) }
}

// ── gitnexus edges (optional) ──
let gnxEdges = null
if (gnxFile) {
  const raw = JSON.parse(fs.readFileSync(gnxFile, 'utf8'))
  gnxEdges = raw.filter((e) => (e.callerFile || '') === (e.calleeFile || e.callerFile)).map((e) => ({ file: (e.callerFile || '').replace(/\\/g, '/'), cs: +e.callerStart, ce: +(e.callerEnd || e.callerStart + 400), name: e.calleeName, defLine: +e.calleeStart }))
}

// Dedupe ground truth to unique CALL RELATIONSHIPS (file, callee name, def line).
// Caller identity is deliberately dropped: the two tools attribute a call's
// caller differently (module scope vs the enclosing arrow/callback), so keying
// recall on caller span false-missed every module-level call. Recall here =
// "did the tool draw an edge to this called definition at all, anywhere in the
// file" — caller-attribution-independent, the fair cross-tool measure.
const truthKey = (t) => t.file + '|' + t.name + '|' + t.defLine
const truthSet = new Map()
for (const t of truth) if (!truthSet.has(truthKey(t))) truthSet.set(truthKey(t), t)
const uniqTruth = [...truthSet.values()]

// ── coverage: does a tool have ANY edge to this called def in this file? ──
const covers = (edges, t) => edges.some((e) => e.file === t.file && e.name === t.name && Math.abs(e.defLine - t.defLine) <= 1)

const tally = (edges, label) => {
  let hit = 0; const misses = []
  for (const t of uniqTruth) { if (covers(edges, t)) hit++; else if (misses.length < 15) misses.push(`${t.name} @${t.file.split('/').pop()}→def@${t.defLine}`) }
  console.log(`\n[${label}] recall: ${hit}/${uniqTruth.length} (${(100 * hit / Math.max(1, uniqTruth.length)).toFixed(1)}%)`)
  return misses
}

console.log(`=== RECALL vs babel ground truth: ${repoDir} ===`)
console.log(`ground-truth call relationships (unique file|name|def): ${uniqTruth.length} | raw call sites: ${truth.length} | files: ${files.length}`)
const ourMiss = tally(ourEdges, 'codesynapt')
if (gnxEdges) {
  const gnxMiss = tally(gnxEdges, 'GitNexus')
  // relationships GitNexus covers that WE miss = our concrete recall gap
  const weMiss = uniqTruth.filter((t) => !covers(ourEdges, t) && covers(gnxEdges, t))
  console.log(`\n>>> edges GitNexus gets RIGHT but WE miss (our recall gap): ${weMiss.length}`)
  weMiss.slice(0, 20).forEach((t) => console.log(`  - ${t.name} @${t.file.split('/').pop()}:${t.callLine} → def@${t.defLine}`))
}
console.log('\nour first misses:'); ourMiss.slice(0, 10).forEach((m) => console.log('  ✗ ' + m))
