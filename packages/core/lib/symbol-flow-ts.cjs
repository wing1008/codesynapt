'use strict'
// Reference-4 multilang expression flow (Python / Java / C#) — a generic
// tree-sitter walker behind the SAME bar as the JS template in
// symbol-flow.cjs. Per-language node tables; CERTAIN flows only (direct
// identifiers + simple assignment chains); everything else is counted in
// unresolvedFlows, never guessed. Async because wasm grammars init lazily.

const MAX_FACTS = 200

const TS_FLOW_CFG = {
  python: {
    grammar: 'python',
    fnTypes: new Set(['function_definition']),
    paramsTypes: new Set(['parameters']),
    assignTypes: new Set(['assignment']),
    callTypes: new Set(['call']),
    returnTypes: new Set(['return_statement']),
    identTypes: new Set(['identifier']),
    literalTypes: new Set(['integer', 'float', 'string', 'true', 'false', 'none']),
    selfNames: new Set(['self', 'cls']),
  },
  java: {
    grammar: 'java',
    fnTypes: new Set(['method_declaration', 'constructor_declaration']),
    paramsTypes: new Set(['formal_parameters']),
    assignTypes: new Set(['variable_declarator', 'assignment_expression']),
    callTypes: new Set(['method_invocation', 'object_creation_expression']),
    returnTypes: new Set(['return_statement']),
    identTypes: new Set(['identifier']),
    literalTypes: new Set(['decimal_integer_literal', 'hex_integer_literal', 'decimal_floating_point_literal', 'string_literal', 'character_literal', 'true', 'false', 'null_literal']),
    selfNames: new Set(['this']),
  },
  c_sharp: {
    grammar: 'c_sharp',
    fnTypes: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']),
    paramsTypes: new Set(['parameter_list']),
    assignTypes: new Set(['variable_declarator', 'assignment_expression']),
    callTypes: new Set(['invocation_expression', 'object_creation_expression']),
    returnTypes: new Set(['return_statement']),
    identTypes: new Set(['identifier']),
    literalTypes: new Set(['integer_literal', 'real_literal', 'string_literal', 'character_literal', 'boolean_literal', 'null_literal']),
    selfNames: new Set(['this']),
  },
}
const TS_FLOW_EXT = { py: 'python', pyw: 'python', pyi: 'python', java: 'java', cs: 'c_sharp' }

function tsCalleeName(node, cfg) {
  const fn = node.childForFieldName?.('function') || node.childForFieldName?.('name')
  if (fn) {
    if (cfg.identTypes.has(fn.type)) return fn.text
    let last = null
    const walk = (n, d) => {
      if (!n || d > 4) return
      if (cfg.identTypes.has(n.type)) last = n.text
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i), d + 1)
    }
    walk(fn, 0)
    return last
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (cfg.identTypes.has(c.type)) return c.text
  }
  return null
}

async function extractFlowTS(source, lang, sym) {
  const out = { params: [], calls: [], returns: [], unresolvedFlows: 0, capped: false }
  const cfg = TS_FLOW_CFG[lang]
  if (!cfg) return out
  let tsMod
  try { tsMod = require('./symbol-parser-treesitter.cjs') } catch { return out }
  let tree
  try {
    const parser = await tsMod.parserFor(cfg.grammar)
    tree = parser.parse(source)
  } catch { return out }

  let fn = null
  const find = (n) => {
    if (!n || fn) return
    if (cfg.fnTypes.has(n.type) && n.startPosition.row + 1 === sym.startLine) { fn = n; return }
    for (let i = 0; i < n.namedChildCount; i++) find(n.namedChild(i))
  }
  find(tree.rootNode)
  if (!fn) { tree.delete?.(); return out }

  // Params: binding names only — typed wrappers take the LAST identifier
  // (Java/C# `int a` -> a, py `a: int` -> a); self/this skipped.
  const pickParams = (n, d) => {
    if (!n || d > 3) return
    if (cfg.paramsTypes.has(n.type)) {
      for (let i = 0; i < n.namedChildCount; i++) {
        const p = n.namedChild(i)
        if (cfg.identTypes.has(p.type)) { if (!cfg.selfNames.has(p.text)) out.params.push(p.text); continue }
        let name = null
        for (let j = 0; j < p.namedChildCount; j++) {
          const c = p.namedChild(j)
          if (cfg.identTypes.has(c.type)) name = c.text
        }
        if (name && !cfg.selfNames.has(name)) out.params.push(name)
      }
      return
    }
    for (let i = 0; i < n.namedChildCount; i++) pickParams(n.namedChild(i), d + 1)
  }
  pickParams(fn, 0)
  const paramSet = new Set(out.params)

  const locals = new Map()
  const sourceOf = (node) => {
    if (!node) return 'unknown'
    if (cfg.identTypes.has(node.type)) {
      if (paramSet.has(node.text)) return 'param:' + node.text
      if (locals.has(node.text)) return locals.get(node.text)
      return 'unknown'
    }
    if (cfg.literalTypes.has(node.type)) return 'literal'
    if (cfg.callTypes.has(node.type)) {
      const n = tsCalleeName(node, cfg)
      return n ? 'call:' + n : 'unknown'
    }
    return 'unknown'
  }

  let facts = 0
  const body = fn.childForFieldName?.('body') || fn
  const walk = (node, isRoot) => {
    if (!node || out.capped) return
    if (!isRoot && cfg.fnTypes.has(node.type)) return   // nested fns own their flows

    if (cfg.assignTypes.has(node.type)) {
      const left = node.childForFieldName?.('left') || node.childForFieldName?.('name')
        || (() => { for (let i = 0; i < node.namedChildCount; i++) { const c = node.namedChild(i); if (cfg.identTypes.has(c.type)) return c } return null })()
      let right = node.childForFieldName?.('right') || node.childForFieldName?.('value')
      if (!right) {
        // C# variable_declarator wraps the value in equals_value_clause
        // (no field name) — unwrap to its last named child.
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i)
          if (c.type === 'equals_value_clause' && c.namedChildCount) { right = c.namedChild(c.namedChildCount - 1); break }
        }
      }
      if (left && right && cfg.identTypes.has(left.type)) {
        const src = sourceOf(right)
        locals.set(left.text, src)
        if (src === 'unknown') out.unresolvedFlows++
      }
    }
    if (cfg.callTypes.has(node.type)) {
      const name = tsCalleeName(node, cfg)
      if (name) {
        const argList = node.childForFieldName?.('arguments')
          || (() => { for (let i = 0; i < node.namedChildCount; i++) { const c = node.namedChild(i); if (/argument/.test(c.type)) return c } return null })()
        const args = []
        if (argList) {
          let idx = 0
          for (let i = 0; i < argList.namedChildCount; i++) {
            let a = argList.namedChild(i)
            // C# wraps each value in an `argument` node — unwrap one level.
            if (a && a.type === 'argument' && a.namedChildCount) a = a.namedChild(a.namedChildCount - 1)
            const from = sourceOf(a)
            if (from === 'unknown') out.unresolvedFlows++
            args.push({ index: idx++, from })
          }
        }
        out.calls.push({ name, line: node.startPosition.row + 1, args })
        if (++facts >= MAX_FACTS) { out.capped = true }
      }
    }
    if (cfg.returnTypes.has(node.type)) {
      const arg = node.namedChildCount ? node.namedChild(0) : null
      const from = arg ? sourceOf(arg) : 'literal'
      if (from === 'unknown') out.unresolvedFlows++
      out.returns.push({ line: node.startPosition.row + 1, from })
      if (++facts >= MAX_FACTS) { out.capped = true }
    }

    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), false)
  }
  walk(body, true)
  tree.delete?.()
  return out
}

module.exports = { extractFlowTS, TS_FLOW_EXT }
