'use strict'
// Expression layer E1 — per-function dataflow facts (JS family, lazy).
// Design: docs/design-expression-layer.md. PRECISION-FIRST and bounded:
// only flows that are CERTAIN are attributed —
//   - an identifier argument that IS a parameter, or reaches one through a
//     simple const/let re-binding chain (`const c = a`),
//   - literals,
//   - call results (`const r = helper(x)` → r carries `call:helper`).
// Everything else (object properties, mutations, destructuring, closures) is
// `unknown` and COUNTED in `unresolvedFlows` — zero-silence, never a guess.
// Facts are computed lazily for ONE function at a time; nothing is built
// project-wide (the AST-node-explosion ban in the design doc).

const babelParser = require('@babel/parser')

const PARSE_OPTS = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: [
    'jsx', 'typescript', 'classProperties', 'classPrivateProperties',
    'classPrivateMethods', 'decorators-legacy', 'dynamicImport',
    'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread',
    'topLevelAwait', 'importMeta',
  ],
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ObjectMethod'])
const MAX_FACTS = 200   // per-function cap — honesty over flooding

// Find the function node matching the Layer-2 symbol (name + start line).
function findFunction(ast, sym) {
  let found = null
  const visit = (node) => {
    if (!node || typeof node.type !== 'string' || found) return
    if (FN_TYPES.has(node.type) && node.loc && node.loc.start.line === sym.startLine) {
      const name = node.id?.name || node.key?.name || null
      if (!sym.name || !name || name === sym.name || sym.name.endsWith('.' + name)) { found = node; return }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) { for (const c of v) visit(c) }
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast)
  return found
}

function calleeNameOf(callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name
  return null
}

// extractFlow(source, fileId, symbol) → {
//   params, calls: [{name, line, args: [{index, from}]}],
//   returns: [{line, from}], unresolvedFlows, capped }
// `from` ∈ 'param:<name>' | 'call:<name>' | 'literal' | 'unknown'
function extractFlow(source, fileId, sym) {
  const out = { params: [], calls: [], returns: [], unresolvedFlows: 0, capped: false }
  let ast
  try { ast = babelParser.parse(source, PARSE_OPTS) } catch { return out }
  const fn = findFunction(ast.program || ast, sym)
  if (!fn) return out

  for (const p of fn.params || []) {
    if (p.type === 'Identifier') out.params.push(p.name)
    else out.params.push('(pattern)')   // destructured — out of E1 scope, visible
  }
  const paramSet = new Set(out.params)

  // Local binding provenance: name → 'param:x' | 'call:name' | 'literal' | 'unknown'
  const locals = new Map()
  const sourceOf = (node) => {
    if (!node) return 'unknown'
    if (node.type === 'Identifier') {
      if (paramSet.has(node.name)) return 'param:' + node.name
      if (locals.has(node.name)) return locals.get(node.name)
      return 'unknown'
    }
    if (/Literal$/.test(node.type) || node.type === 'TemplateLiteral') return 'literal'
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const n = calleeNameOf(node.callee)
      return n ? 'call:' + n : 'unknown'
    }
    return 'unknown'
  }

  let facts = 0
  const walk = (node, isRoot) => {
    if (!node || typeof node.type !== 'string' || out.capped) return
    // Don't descend into NESTED functions — their flows are their own facts.
    if (!isRoot && FN_TYPES.has(node.type)) return

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const src = sourceOf(node.init)
      locals.set(node.id.name, src)
      if (src === 'unknown' && node.init) out.unresolvedFlows++
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeNameOf(node.callee)
      if (name) {
        const args = (node.arguments || []).map((a, i) => {
          const from = sourceOf(a)
          if (from === 'unknown') out.unresolvedFlows++
          return { index: i, from }
        })
        out.calls.push({ name, line: node.loc?.start.line || 0, args })
        if (++facts >= MAX_FACTS) { out.capped = true; return }
      }
    }
    if (node.type === 'ReturnStatement') {
      const from = node.argument ? sourceOf(node.argument) : 'literal'
      if (from === 'unknown') out.unresolvedFlows++
      out.returns.push({ line: node.loc?.start.line || 0, from })
      if (++facts >= MAX_FACTS) { out.capped = true; return }
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) { for (const c of v) walk(c, false) }
      else if (v && typeof v.type === 'string') walk(v, false)
    }
  }
  walk(fn.body, true)
  return out
}

module.exports = { extractFlow }
