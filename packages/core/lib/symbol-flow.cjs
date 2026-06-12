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

  // Pre-pass: find every binding whose value is NOT a single certain source —
  // reassigned (`c = …`), augmented (`c += …` / `c++`), declared more than once,
  // or a parameter that is later reassigned. Such a name is flow-insensitive
  // here, so attributing it to its first/last write would be a WRONG claim
  // (insp-004: `let c = a; c = 5; use(c)` reported use(param:a); `+=` accumulators
  // reported the seed). These resolve to `unknown` and are COUNTED — never
  // guessed. Only single-assignment bindings keep a precise provenance.
  const assignCount = new Map()
  const augmented = new Set()
  const precount = (node, isRoot) => {
    if (!node || typeof node.type !== 'string') return
    if (!isRoot && FN_TYPES.has(node.type)) return
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      assignCount.set(node.id.name, (assignCount.get(node.id.name) || 0) + 1)
    }
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      assignCount.set(node.left.name, (assignCount.get(node.left.name) || 0) + 1)
      if (node.operator !== '=') augmented.add(node.left.name)
    }
    if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') augmented.add(node.argument.name)
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) { for (const c of v) precount(c, false) }
      else if (v && typeof v.type === 'string') precount(v, false)
    }
  }
  precount(fn.body, true)
  const uncertain = new Set(augmented)
  for (const [n, c] of assignCount) if (c > 1) uncertain.add(n)
  for (const n of assignCount.keys()) if (paramSet.has(n)) uncertain.add(n)  // a reassigned parameter

  // Local binding provenance: name → 'param:x' | 'call:name' | 'literal' | 'unknown'
  const locals = new Map()
  const sourceOf = (node) => {
    if (!node) return 'unknown'
    if (node.type === 'Identifier') {
      if (uncertain.has(node.name)) return 'unknown'   // multiply-written: not a single certain source
      if (paramSet.has(node.name)) return 'param:' + node.name
      if (locals.has(node.name)) return locals.get(node.name)
      return 'unknown'
    }
    // A template literal with interpolations is NOT a literal — its value
    // depends on the embedded expressions (insp-004: `\`${a}\`` claimed literal).
    if (node.type === 'TemplateLiteral') return (node.expressions && node.expressions.length) ? 'unknown' : 'literal'
    if (/Literal$/.test(node.type)) return 'literal'
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
      const src = uncertain.has(node.id.name) ? 'unknown' : sourceOf(node.init)
      locals.set(node.id.name, src)
      if (src === 'unknown' && node.init) out.unresolvedFlows++
    }
    // Reassignment / augmented assignment of a local. The variable was already
    // marked uncertain in the pre-pass; record the unresolved flow so the
    // mutation is counted rather than silently lost (insp-004: `+=` was invisible).
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
      locals.set(node.left.name, 'unknown')
      out.unresolvedFlows++
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

// E2 — argument-level blast: starting from (function, param), follow E1 flow
// facts across CONFIDENT Layer-2 call edges: param → call arg → the target
// function's parameter at that index → recurse. PRECISION-FIRST walk rules:
//   - only confident `call` edges (g.calleesOf) are followed;
//   - a call whose target is ambiguous (0 or ≥2 same-named confident callees)
//     STOPS the walk and increments unresolvedTargets — counted, not guessed;
//   - bounded depth + visited-set (cycles) + fan-out cap.
function argBlast(g, readFile, sym, paramName, opts = {}) {
  const maxDepth = Math.min(8, Math.max(1, opts.depth || 4))
  const out = { seed: { fn: sym.name, param: paramName }, impacted: [], unresolvedTargets: 0, returnsParam: false, truncated: false }
  const flowCache = new Map()
  const factsOf = (node) => {
    if (flowCache.has(node.id)) return flowCache.get(node.id)
    let facts = null
    try {
      const src = readFile(node.file)
      if (src != null) facts = extractFlow(src, node.file, { name: node.name, startLine: node.startLine, endLine: node.endLine })
    } catch {}
    flowCache.set(node.id, facts)
    return facts
  }
  const visited = new Set()
  const queue = [{ node: sym, param: paramName, depth: 0 }]
  while (queue.length) {
    if (out.impacted.length >= 100) { out.truncated = true; break }
    const { node, param, depth } = queue.shift()
    const key = node.id + '|' + param
    if (visited.has(key)) continue
    visited.add(key)
    const facts = factsOf(node)
    if (!facts) continue
    const want = 'param:' + param
    if (depth === 0 && facts.returns.some((r) => r.from === want)) out.returnsParam = true
    for (const call of facts.calls) {
      const carrying = call.args.filter((a) => a.from === want)
      if (!carrying.length) continue
      // Resolve the call to ONE confident Layer-2 callee by name — the bare
      // short name (qualified tails count). 0 or ≥2 ⇒ stop + count.
      const callees = (g.calleesOf ? g.calleesOf(node.id) : [])
        .filter((c) => c.name === call.name || (c.qualifiedName || '').endsWith('.' + call.name))
      if (callees.length !== 1) { out.unresolvedTargets++; continue }
      const target = callees[0]
      const tFacts = factsOf(target)
      for (const a of carrying) {
        const tParam = tFacts && tFacts.params ? tFacts.params[a.index] : undefined
        out.impacted.push({
          fn: target.name, qualifiedName: target.qualifiedName || target.name,
          file: target.file, line: call.line,
          param: tParam || `(arg${a.index})`, argIndex: a.index, depth: depth + 1,
        })
        if (tParam && depth + 1 < maxDepth) queue.push({ node: target, param: tParam, depth: depth + 1 })
      }
    }
  }
  return out
}

// ⑦ v1 — signature-change detection (feeds the realtime issue alerts).
// Keys are file + qualifiedName, NOT symbol ids: ids embed the start line,
// which shifts whenever anything above the function is edited — keying by id
// would report every function below an edit as "changed".
const SIG_COLLIDED = ' collided'   // >=2 symbols share the key — identity untrackable
function collectSignatures(g) {
  const map = new Map()
  for (const n of g.nodes.values()) {
    if (n.kind === 'module' || !n.signature) continue
    const key = n.file + ' ' + (n.qualifiedName || n.name)
    // Same key twice (e.g. multiple object-literal click handlers in one
    // file) - WHICH one changed cannot be tracked by name; diffing them
    // produced a false "changed" alert on every rebuild (reproduced on
    // electron/main.cjs menu items). Precision-first: mark and exclude.
    map.set(key, map.has(key) ? SIG_COLLIDED : n.signature)
  }
  return map
}

// Compare a previous collectSignatures() map against the CURRENT graph.
// Returns ONLY functions present in both whose signature text changed —
// additions/removals are a different concern (accounting/dead diff covers
// removals). Each entry carries the current symbol id + caller count so the
// alert layer can run argBlast / show blast size without re-walking.
function signatureDelta(prevMap, g) {
  const out = []
  const curMap = collectSignatures(g)   // collision-aware view of NOW
  for (const n of g.nodes.values()) {
    if (n.kind === 'module' || !n.signature) continue
    const key = n.file + ' ' + (n.qualifiedName || n.name)
    const before = prevMap.get(key)
    if (before === undefined || before === SIG_COLLIDED || curMap.get(key) === SIG_COLLIDED) continue
    if (before === n.signature) continue
    out.push({
      id: n.id, name: n.name, qualifiedName: n.qualifiedName || n.name,
      file: n.file, line: n.startLine,
      before: before.slice(0, 100), after: n.signature.slice(0, 100),
      callers: (g.callersOf ? g.callersOf(n.id).length : 0),
    })
    if (out.length >= 20) break   // alert feed, not a report — cap
  }
  return out
}

// Language-routing entry: JS family -> the sync babel walker; py/java/cs ->
// the tree-sitter walker (symbol-flow-ts.cjs); others -> unsupported note.
async function extractFlowAuto(source, fileId, sym) {
  const ext = (fileId.split(".").pop() || "").toLowerCase()
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return extractFlow(source, fileId, sym)
  let tsf
  try { tsf = require("./symbol-flow-ts.cjs") } catch { tsf = null }
  const lang = tsf && tsf.TS_FLOW_EXT[ext]
  if (lang) return tsf.extractFlowTS(source, lang, sym)
  return { params: [], calls: [], returns: [], unresolvedFlows: 0, capped: false, unsupported: true }
}

module.exports = { extractFlow, extractFlowAuto, argBlast, collectSignatures, signatureDelta }
