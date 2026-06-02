// Python symbol parser — regex + brace/indent depth, no AST.
//
// Extracts:
//   - top-level `def`/`async def`/`class` declarations
//   - methods (def inside a class block; tracked by indent)
//   - module-level constants written ALL_CAPS = …
//
// References (call edges) are detected by regex on `name(` inside
// the body of each tracked function/method; resolution prefers
// same-file matches first, then any project-wide name match.

'use strict'

const RE_DEF   = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const RE_CLASS = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]/
const RE_CONST = /^[A-Z_][A-Z0-9_]+\s*[:=]/      // ALL_CAPS module constant
const RE_DOC_TRIPLE = /^\s*(?:"""|''')(.*?)(?:"""|''')\s*$/

function mkId(file, name, line) { return `${file}#${name}@${line}` }

function leadingDocstring(lines, startLine) {
  // startLine is 1-based — Python convention is the first statement
  // of a def/class body, which is the next non-blank line after the
  // signature. The signature itself may span multiple lines (with
  // trailing `,\n` in arguments) so we scan forward up to 8 lines for
  // the first `"""` or `'''` block.
  for (let i = startLine; i < Math.min(startLine + 8, lines.length); i++) {
    const t = (lines[i] || '').trim()
    if (!t) continue
    if (t.startsWith('"""') || t.startsWith("'''")) {
      // Single-line docstring
      const m = t.match(RE_DOC_TRIPLE)
      if (m) return m[1].trim().slice(0, 400)
      // Multi-line — collect until closing
      const quote = t.slice(0, 3)
      const body = [t.slice(3)]
      for (let j = i + 1; j < Math.min(j + 30, lines.length); j++) {
        const tj = lines[j] || ''
        const close = tj.indexOf(quote)
        if (close >= 0) {
          body.push(tj.slice(0, close))
          return body.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400)
        }
        body.push(tj)
      }
      return body.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400)
    }
    break  // first non-blank non-docstring line — no docstring
  }
  return ''
}

// Compute end-line of a def/class block by walking forward until the
// indent returns to ≤ the def's own indent (or EOF). Simple, not
// perfect (no triple-quoted block edge-cases) but good enough.
function blockEnd(lines, startIdx, baseIndent) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue        // blank lines don't terminate
    const indent = line.match(/^(\s*)/)[1].length
    if (indent <= baseIndent) return i  // 1-based caller adds +1 if needed
  }
  return lines.length
}

function extractSymbols(content, fileId) {
  const lines = content.split('\n')
  const symbols = []
  // Stack of currently-open classes, by indent → name
  const classStack = []   // [{ name, indent, line }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // pop classes whose indent is now equal-or-greater than current line
    const lineIndent = line.match(/^(\s*)/)[1].length
    while (classStack.length && lineIndent <= classStack[classStack.length - 1].indent && line.trim()) {
      classStack.pop()
    }

    let m
    if ((m = line.match(RE_CLASS))) {
      const indent = m[1].length
      const name = m[2]
      const end = blockEnd(lines, i, indent)
      symbols.push({
        id: mkId(fileId, name, lineNum),
        name,
        qualifiedName: classStack.map((c) => c.name).concat(name).join('.'),
        kind: 'class',
        file: fileId,
        startLine: lineNum,
        endLine: end,
        signature: line.trim().replace(/:$/, ''),
        doc: leadingDocstring(lines, lineNum),
        exported: !name.startsWith('_'),
      })
      classStack.push({ name, indent, line: lineNum })
      continue
    }
    if ((m = line.match(RE_DEF))) {
      const indent = m[1].length
      const name = m[2]
      const enclosingClass = classStack.length
        ? classStack[classStack.length - 1]
        : null
      // A def inside a class (indent > class indent) is a method.
      const isMethod = enclosingClass && indent > enclosingClass.indent
      const end = blockEnd(lines, i, indent)
      const qualifiedName = isMethod
        ? `${classStack.map((c) => c.name).join('.')}.${name}`
        : name
      symbols.push({
        id: mkId(fileId, isMethod ? qualifiedName : name, lineNum),
        name,
        qualifiedName,
        kind: isMethod ? 'method' : 'function',
        file: fileId,
        startLine: lineNum,
        endLine: end,
        signature: line.trim().replace(/:$/, ''),
        doc: leadingDocstring(lines, lineNum),
        exported: !name.startsWith('_'),
      })
      continue
    }
    if (lineIndent === 0 && RE_CONST.test(line)) {
      const name = line.match(/^([A-Z_][A-Z0-9_]+)/)[1]
      symbols.push({
        id: mkId(fileId, name, lineNum),
        name,
        qualifiedName: name,
        kind: 'const',
        file: fileId,
        startLine: lineNum,
        endLine: lineNum,
        signature: line.trim().slice(0, 120),
        doc: '',
        exported: !name.startsWith('_'),
      })
    }
  }
  return symbols
}

function extractReferences(content, fileId, index) {
  // Build a per-file map of symbol-id → [startLine, endLine] so we can
  // attribute each call to the enclosing function.
  const fileSyms = index.byFile.get(fileId)
  if (!fileSyms) return []
  const ranges = []
  for (const id of fileSyms) {
    const n = index.nodes.get(id)
    if (!n) continue
    if (n.kind !== 'function' && n.kind !== 'method') continue
    ranges.push({ id, start: n.startLine, end: n.endLine })
  }
  ranges.sort((a, b) => a.start - b.start)

  function enclosingId(lineNum) {
    // Pick the innermost (largest start that is <= lineNum) range that
    // contains lineNum. Linear scan is fine — usually <500 ranges/file.
    let best = null
    for (const r of ranges) {
      if (r.start <= lineNum && lineNum <= r.end) {
        if (!best || r.start > best.start) best = r
      }
    }
    return best?.id || null
  }

  // Python regex parser only emits `call` edges (no expression-level
  // ref pass yet), so it always wants the loose any-file fallback.
  function resolve(name) {
    return index.resolveCall ? index.resolveCall(fileId, name, { allowAny: true }) : null
  }

  const lines = content.split('\n')
  const edges = []
  const seen = new Set()
  const RE_CALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  // Python keywords / builtins to skip — they aren't user-defined symbols.
  const SKIP = new Set([
    'if','elif','while','for','in','not','and','or','is','return','print',
    'len','range','int','str','float','bool','list','dict','set','tuple',
    'isinstance','type','super','self','cls','open','sorted','enumerate',
    'zip','map','filter','any','all','sum','min','max','abs','round',
    'getattr','setattr','hasattr','format','repr','hash','id','iter','next',
    'object','property','staticmethod','classmethod','None','True','False',
    'except','raise','try','finally','with','as','from','import','def','class',
    'lambda','yield','pass','break','continue','global','nonlocal',
  ])

  for (let i = 0; i < lines.length; i++) {
    const src = enclosingId(i + 1)
    if (!src) continue
    const line = lines[i]
    let m
    RE_CALL.lastIndex = 0
    while ((m = RE_CALL.exec(line))) {
      const name = m[1]
      if (SKIP.has(name)) continue
      const target = resolve(name)
      if (!target || target.id === src) continue
      const key = src + '|' + target.id + '|call'
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: src, target: target.id, kind: 'call', line: i + 1 })
    }
  }
  return edges
}

module.exports = { extractSymbols, extractReferences }
