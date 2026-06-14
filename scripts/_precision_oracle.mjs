// Precision oracle (축2) — confirm whether a confident SAME-FILE call edge went
// to the CORRECT scope binding, using babel's own scope analysis as the
// independent ground truth (NOT the graph). A same-file edge src->tgt is WRONG
// if, at the call site inside src, babel resolves the callee name to a binding
// defined at a DIFFERENT line than tgt (the #M1 nested-collision bug). This
// turns the name-based #M1 estimate into a confirmed false-edge count. JS family
// only (babel scope is exact); other languages need their own scope oracle.
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

const targetDir = process.argv[2] || root
const JS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'])

const files = []
const walk = (d) => {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else { const ext = (e.name.split('.').pop() || '').toLowerCase(); if (JS.has(ext)) { try { files.push({ id: path.relative(targetDir, p).replace(/\\/g, '/'), ext, content: fs.readFileSync(p, 'utf8'), abs: p }) } catch {} } }
  }
}
walk(targetDir)

const g = new sg.SymbolGraph()
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractSymbols) for (const s of (await p.extractSymbols(f.content, f.id)) || []) g.addNode(s) }
for (const f of files) { const p = sg.PARSERS[f.ext]; if (p?.extractReferences) for (const e of (await p.extractReferences(f.content, f.id, g)) || []) g.addEdge(e) }
g.finalizeDispatchCandidates()
const byId = (id) => g.nodes.get(id)
const contentOf = new Map(files.map((f) => [f.id, f.content]))

// confident same-file call edges
const edges = []
for (const [src, set] of g.callOut) {
  const sn = byId(src); if (!sn) continue
  for (const t of set) { const tn = byId(t); if (tn && tn.file === sn.file && tn.name) edges.push({ sn, tn }) }
}

// babel scope ground truth: at a call to `name` inside src's body, what line is
// the binding defined at? Compare to tgt's line.
const PARSE = { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy', 'objectRestSpread'] }
const astCache = new Map()
function astOf(fileId) {
  if (astCache.has(fileId)) return astCache.get(fileId)
  let ast = null
  try { ast = babel.parse(contentOf.get(fileId) || '', PARSE) } catch {}
  astCache.set(fileId, ast); return ast
}

let checked = 0, wrong = 0, unprovable = 0
const examples = []
for (const { sn, tn } of edges.slice(0, 600)) {
  const ast = astOf(sn.file); if (!ast) { unprovable++; continue }
  let verdict = null  // 'ok' | 'wrong' | null(unprovable)
  traverse(ast, {
    CallExpression(p) {
      if (verdict) return
      const line = p.node.loc?.start.line
      if (!line || line < sn.startLine || line > (sn.endLine || sn.startLine)) return
      const callee = p.node.callee
      const name = callee.type === 'Identifier' ? callee.name
        : (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') ? callee.property.name : null
      if (name !== tn.name) return
      const b = p.scope.getBinding(name)
      if (b && b.path && b.path.node && b.path.node.loc) {
        const defLine = b.path.node.loc.start.line
        // binding defined in THIS file at defLine — is it tgt's line (±1 for decl vs fn)?
        verdict = Math.abs(defLine - tn.startLine) <= 1 ? 'ok' : 'wrong'
        if (verdict === 'wrong' && examples.length < 8) examples.push(`${sn.name}@${sn.startLine}→${tn.name}@${tn.startLine} but scope binds @${defLine} (${sn.file.split('/').pop()})`)
      }
    },
  })
  if (verdict === 'wrong') { checked++; wrong++ }
  else if (verdict === 'ok') checked++
  else unprovable++
}

console.log(`\n=== PRECISION ORACLE (scope ground truth): ${targetDir} ===`)
console.log(`confident same-file call edges: ${edges.length}  | checked(scope-provable): ${checked}  | unprovable: ${unprovable}`)
console.log(`WRONG edges (went to wrong scope binding = #M1 confirmed): ${wrong}/${checked} (${(100 * wrong / Math.max(1, checked)).toFixed(1)}%)`)
examples.forEach((e) => console.log('  ✗ ' + e))
