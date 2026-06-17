// Head-to-head precision judge (tool-agnostic). Takes a JSON edge list from ANY
// tool and judges each SAME-FILE call edge against babel's scope ground truth —
// the identical logic _precision_oracle.mjs uses on our own graph, so a
// competitor's edges are judged by the exact same independent oracle (fair
// apples-to-apples on wrong-edge rate).
//
// Usage: node scripts/_judge_edges.mjs <repoDir> <edges.json> [--label NAME]
// edges.json: [{ callerFile, callerStart, callerEnd, calleeName, calleeStart,
//                calleeFile, confidence? }]  (line numbers 1-based)
// Only same-file edges (callerFile === calleeFile) are judged (babel scope is
// file-local exact). A row missing callerEnd falls back to callerStart+400.
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'
const require = createRequire(import.meta.url)
const babel = require('@babel/parser')
const traverse = require('@babel/traverse').default

const repoDir = path.resolve(process.argv[2])
const edgesFile = path.resolve(process.argv[3])
const label = (process.argv.find((a) => a.startsWith('--label=')) || '--label=tool').split('=')[1]
const JS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'])

const contentOf = new Map()
const walk = (d) => {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else {
      const ext = (e.name.split('.').pop() || '').toLowerCase()
      if (JS.has(ext)) { try { contentOf.set(path.relative(repoDir, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')) } catch {} }
    }
  }
}
walk(repoDir)

const PARSE = { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy', 'objectRestSpread'] }
const astCache = new Map()
const astOf = (fileId) => {
  if (astCache.has(fileId)) return astCache.get(fileId)
  let ast = null
  try { ast = babel.parse(contentOf.get(fileId) || '', PARSE) } catch {}
  astCache.set(fileId, ast); return ast
}

const edges = JSON.parse(fs.readFileSync(edgesFile, 'utf8'))
let sameFile = 0, checked = 0, wrong = 0, unprovable = 0, noContent = 0
let hiChecked = 0, hiWrong = 0   // confidence >= 0.8 band
const examples = []
for (const e of edges) {
  const cf = (e.callerFile || '').replace(/\\/g, '/')
  const ef = (e.calleeFile || cf).replace(/\\/g, '/')
  if (cf !== ef) continue           // judge same-file only
  sameFile++
  if (!contentOf.has(cf)) { noContent++; continue }
  const ast = astOf(cf); if (!ast) { unprovable++; continue }
  const cs = +e.callerStart, ce = +(e.callerEnd || e.callerStart + 400)
  const tgtLine = +e.calleeStart
  const hi = typeof e.confidence === 'number' ? e.confidence >= 0.8 : true
  let verdict = null
  traverse(ast, {
    CallExpression(p) {
      if (verdict) return
      const line = p.node.loc?.start.line
      if (!line || line < cs || line > ce) return
      const callee = p.node.callee
      const nm = callee.type === 'Identifier' ? callee.name
        : (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') ? callee.property.name : null
      if (nm !== e.calleeName) return
      const b = p.scope.getBinding(nm)
      if (b && b.path && b.path.node && b.path.node.loc) {
        const defLine = b.path.node.loc.start.line
        verdict = Math.abs(defLine - tgtLine) <= 1 ? 'ok' : 'wrong'
        if (verdict === 'wrong' && examples.length < 12) examples.push(`${e.calleeName}: edge→@${tgtLine} but scope binds @${defLine} (${cf.split('/').pop()}, caller@${cs}${hi ? ', conf≥0.8' : ''})`)
      }
    },
  })
  if (verdict === 'wrong') { checked++; wrong++; if (hi) { hiChecked++; hiWrong++ } }
  else if (verdict === 'ok') { checked++; if (hi) hiChecked++ }
  else unprovable++
}

console.log(`\n=== HEAD-TO-HEAD PRECISION JUDGE [${label}] : ${repoDir} ===`)
console.log(`input edges: ${edges.length} | same-file: ${sameFile} | scope-provable(checked): ${checked} | unprovable: ${unprovable} | file-not-found: ${noContent}`)
console.log(`WRONG edges (went to wrong scope binding): ${wrong}/${checked} (${(100 * wrong / Math.max(1, checked)).toFixed(2)}%)`)
console.log(`  of which confidence>=0.8: ${hiWrong}/${hiChecked} (${(100 * hiWrong / Math.max(1, hiChecked)).toFixed(2)}%)`)
examples.forEach((e) => console.log('  ✗ ' + e))
