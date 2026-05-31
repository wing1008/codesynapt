// Symbol parsers for Go, Rust, Java/Kotlin, Swift — regex baseline.
//
// These are intentionally simple — they catch top-level declarations
// and obvious method definitions, and resolve calls by name-match
// (preferring same-file matches). Stage 3 (tree-sitter) will replace
// them for accuracy parity with codegraph.
//
// One module exports one parser per language to keep things easy to
// reason about; each parser conforms to the
// { extractSymbols, extractReferences } shape consumed by SymbolGraph.

'use strict'

function mkId(file, name, line) { return `${file}#${name}@${line}` }

// Import-aware resolver: same file → caller's imports → anything.
function makeResolver(fileId, index) {
  return function resolve(name) {
    return index.resolveCall ? index.resolveCall(fileId, name) : null
  }
}

// Build a per-file "which symbol contains this line" lookup.
function makeEnclosingLookup(fileId, index, kinds = ['function', 'method']) {
  const ids = index.byFile.get(fileId)
  if (!ids) return () => null
  const ranges = []
  for (const id of ids) {
    const n = index.nodes.get(id)
    if (!n) continue
    if (kinds && !kinds.includes(n.kind)) continue
    ranges.push({ id, start: n.startLine, end: n.endLine })
  }
  ranges.sort((a, b) => a.start - b.start)
  return function enclosingId(lineNum) {
    let best = null
    for (const r of ranges) {
      if (r.start <= lineNum && lineNum <= r.end) {
        if (!best || r.start > best.start) best = r
      }
    }
    return best?.id || null
  }
}

// Approximate end-line by walking forward tracking brace depth from a
// `{` at the end of `startLine`. Returns startLine if no brace found
// nearby (e.g. struct field, single-line decl).
function braceBlockEnd(lines, startLine) {
  // 1-based startLine → 0-based index
  let i = startLine - 1
  let depth = 0
  let started = false
  while (i < lines.length) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (c === '{') { depth++; started = true }
      else if (c === '}') {
        depth--
        if (started && depth === 0) return i + 1
      }
    }
    i++
  }
  return Math.min(startLine + 50, lines.length)
}

// ─── Go ─────────────────────────────────────────────────────────
// - `func Name(`  or  `func (r *Recv) Name(`
// - `type Name struct/interface`
const RE_GO_FUNC = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[\(\[]/
const RE_GO_TYPE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/

const go = {
  extractSymbols(content, fileId) {
    const lines = content.split('\n')
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const lineNum = i + 1
      let m
      if ((m = ln.match(RE_GO_FUNC))) {
        const recv = m[1]?.trim()
        const name = m[2]
        const receiverType = recv ? recv.replace(/^\*?\s*\w+\s+\*?/, '').replace(/^\*/, '').trim() : null
        const qualifiedName = receiverType ? `${receiverType}.${name}` : name
        out.push({
          id: mkId(fileId, qualifiedName, lineNum),
          name, qualifiedName,
          kind: receiverType ? 'method' : 'function',
          file: fileId,
          startLine: lineNum,
          endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i),
          exported: /^[A-Z]/.test(name),
        })
      } else if ((m = ln.match(RE_GO_TYPE))) {
        const name = m[1]
        out.push({
          id: mkId(fileId, name, lineNum),
          name, qualifiedName: name,
          kind: m[2] === 'struct' ? 'struct' : 'interface',
          file: fileId,
          startLine: lineNum,
          endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i),
          exported: /^[A-Z]/.test(name),
        })
      }
    }
    return out
  },
  extractReferences(content, fileId, index) {
    const lines = content.split('\n')
    const resolve = makeResolver(fileId, index)
    const enclosing = makeEnclosingLookup(fileId, index)
    const edges = []
    const seen = new Set()
    const RE_CALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    for (let i = 0; i < lines.length; i++) {
      const src = enclosing(i + 1)
      if (!src) continue
      RE_CALL.lastIndex = 0
      let m
      while ((m = RE_CALL.exec(lines[i]))) {
        const name = m[1]
        if (GO_KEYWORDS.has(name)) continue
        const target = resolve(name)
        if (!target || target.id === src) continue
        const key = src + '|' + target.id
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source: src, target: target.id, kind: 'call', line: i + 1 })
      }
    }
    return edges
  },
}
const GO_KEYWORDS = new Set([
  'func','for','if','else','range','return','break','continue','switch',
  'case','default','select','go','defer','make','new','len','cap','append',
  'copy','delete','panic','recover','close','print','println','interface',
  'struct','type','var','const','import','package','map','chan','true','false','nil',
])

// ─── Rust ───────────────────────────────────────────────────────
// - `fn name(`  /  `pub fn name(`  /  `async fn …`
// - `struct/enum/trait Name`
// - `impl …` blocks (we tag methods inside as kind:'method')
const RE_RS_FN     = /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/
const RE_RS_STRUCT = /^\s*(?:pub(?:\([\w:]+\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/
const RE_RS_ENUM   = /^\s*(?:pub(?:\([\w:]+\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/
const RE_RS_TRAIT  = /^\s*(?:pub(?:\([\w:]+\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/
const RE_RS_IMPL   = /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_][\w:<>]*)/

const rust = {
  extractSymbols(content, fileId) {
    const lines = content.split('\n')
    const out = []
    let implFor = null    // type name we're currently impl'ing, or null
    let implEndLine = 0
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const lineNum = i + 1
      let m
      if ((m = ln.match(RE_RS_IMPL))) {
        implFor = m[1].replace(/<.*$/, '')   // strip generic params
        implEndLine = braceBlockEnd(lines, lineNum)
        continue
      }
      if (lineNum > implEndLine) implFor = null
      if ((m = ln.match(RE_RS_FN))) {
        const name = m[1]
        const qn = implFor ? `${implFor}.${name}` : name
        out.push({
          id: mkId(fileId, qn, lineNum),
          name, qualifiedName: qn,
          kind: implFor ? 'method' : 'function',
          file: fileId,
          startLine: lineNum,
          endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '///'),
          exported: ln.includes('pub '),
        })
      } else if ((m = ln.match(RE_RS_STRUCT)) || (m = ln.match(RE_RS_ENUM)) || (m = ln.match(RE_RS_TRAIT))) {
        const name = m[1]
        const kind = ln.match(/struct/) ? 'struct' : (ln.match(/enum/) ? 'enum' : 'interface')
        out.push({
          id: mkId(fileId, name, lineNum),
          name, qualifiedName: name, kind,
          file: fileId,
          startLine: lineNum,
          endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '///'),
          exported: ln.includes('pub '),
        })
      }
    }
    return out
  },
  extractReferences(content, fileId, index) {
    return genericReferences(content, fileId, index, RS_KEYWORDS)
  },
}
const RS_KEYWORDS = new Set([
  'fn','let','mut','if','else','while','for','loop','match','return','break',
  'continue','use','mod','pub','crate','self','super','impl','trait','struct',
  'enum','type','as','where','async','await','dyn','ref','move','in','Box',
  'Vec','String','Some','None','Ok','Err','Result','Option','true','false',
  'unsafe','extern','static','const',
])

// ─── Java / Kotlin ──────────────────────────────────────────────
const RE_JAVA_CLASS = /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+|sealed\s+)*\s*(?:class|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
// method: visibility + (static)? + type + name(
const RE_JAVA_METHOD = /^\s*(?:public|private|protected|static|final|synchronized|abstract|default)(?:\s+(?:public|private|protected|static|final|synchronized|abstract|default))*\s+(?:<[^>]+>\s+)?[A-Za-z_][\w<>\[\],?\s.]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const RE_KT_FN = /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|override\s+|open\s+|inline\s+|suspend\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/

const javaKt = {
  extractSymbols(content, fileId) {
    const ext = (fileId.split('.').pop() || '').toLowerCase()
    const lines = content.split('\n')
    const out = []
    const classStack = []   // [{ name, endLine }]
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const lineNum = i + 1
      while (classStack.length && lineNum > classStack[classStack.length - 1].endLine) {
        classStack.pop()
      }
      let m
      if ((m = ln.match(RE_JAVA_CLASS))) {
        const name = m[1]
        const end = braceBlockEnd(lines, lineNum)
        out.push({
          id: mkId(fileId, name, lineNum),
          name, qualifiedName: classStack.map((c) => c.name).concat(name).join('.'),
          kind: ln.includes('interface') ? 'interface' : (ln.includes('enum') ? 'enum' : 'class'),
          file: fileId, startLine: lineNum, endLine: end,
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '//'),
          exported: ln.includes('public'),
        })
        classStack.push({ name, endLine: end })
        continue
      }
      const re = ext === 'kt' ? RE_KT_FN : RE_JAVA_METHOD
      if ((m = ln.match(re))) {
        const name = m[1]
        if (JAVA_KEYWORDS.has(name)) continue
        const cls = classStack[classStack.length - 1]?.name
        const qn = cls ? `${cls}.${name}` : name
        out.push({
          id: mkId(fileId, qn, lineNum),
          name, qualifiedName: qn,
          kind: cls ? 'method' : 'function',
          file: fileId, startLine: lineNum, endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '//'),
          exported: ln.includes('public'),
        })
      }
    }
    return out
  },
  extractReferences(content, fileId, index) {
    return genericReferences(content, fileId, index, JAVA_KEYWORDS)
  },
}
const JAVA_KEYWORDS = new Set([
  'if','else','while','for','do','switch','case','break','continue','return',
  'new','this','super','try','catch','finally','throw','throws','class',
  'interface','enum','extends','implements','public','private','protected',
  'static','final','abstract','synchronized','volatile','transient','native',
  'void','int','long','short','byte','char','boolean','float','double',
  'String','Object','Integer','Long','Boolean','true','false','null','var',
  'import','package','assert','instanceof','default','record','sealed','permits',
  // Kotlin
  'fun','val','val','val','val','val','val','val','val','val',
])

// ─── Swift ──────────────────────────────────────────────────────
const RE_SW_FUNC = /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|static\s+|class\s+|override\s+|final\s+|@\w+\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/
const RE_SW_TYPE = /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+|indirect\s+|@\w+\s+)*(class|struct|enum|protocol|extension|actor)\s+([A-Za-z_][A-Za-z0-9_]*)/

const swift = {
  extractSymbols(content, fileId) {
    const lines = content.split('\n')
    const out = []
    const typeStack = []
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const lineNum = i + 1
      while (typeStack.length && lineNum > typeStack[typeStack.length - 1].endLine) {
        typeStack.pop()
      }
      let m
      if ((m = ln.match(RE_SW_TYPE))) {
        const name = m[2]
        const end = braceBlockEnd(lines, lineNum)
        const kindWord = m[1]
        out.push({
          id: mkId(fileId, name, lineNum),
          name, qualifiedName: typeStack.map((t) => t.name).concat(name).join('.'),
          kind: kindWord === 'protocol' ? 'interface'
              : kindWord === 'struct'   ? 'struct'
              : kindWord === 'enum'     ? 'enum'
              : 'class',
          file: fileId, startLine: lineNum, endLine: end,
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '//'),
          exported: ln.match(/\b(public|open)\b/) ? true : false,
        })
        typeStack.push({ name, endLine: end })
        continue
      }
      if ((m = ln.match(RE_SW_FUNC))) {
        const name = m[1]
        const t = typeStack[typeStack.length - 1]?.name
        const qn = t ? `${t}.${name}` : name
        out.push({
          id: mkId(fileId, qn, lineNum),
          name, qualifiedName: qn,
          kind: t ? 'method' : 'function',
          file: fileId, startLine: lineNum, endLine: braceBlockEnd(lines, lineNum),
          signature: ln.trim().replace(/\{?\s*$/, ''),
          doc: leadingLineComments(lines, i, '//'),
          exported: ln.match(/\b(public|open)\b/) ? true : false,
        })
      }
    }
    return out
  },
  extractReferences(content, fileId, index) {
    return genericReferences(content, fileId, index, SWIFT_KEYWORDS)
  },
}
const SWIFT_KEYWORDS = new Set([
  'if','else','for','in','while','repeat','do','switch','case','break','continue',
  'return','throw','throws','try','catch','rethrows','defer','guard','where',
  'as','is','let','var','func','class','struct','enum','protocol','extension',
  'import','self','super','init','deinit','static','final','public','private',
  'internal','open','fileprivate','true','false','nil','some','any','Self',
  'Optional','print','String','Int','Bool','Double','Float','Array','Dictionary',
])

// ─── Shared helpers ─────────────────────────────────────────────
function leadingLineComments(lines, i, prefix = '//') {
  const parts = []
  let j = i - 1
  while (j >= 0) {
    const t = lines[j].trim()
    if (!t) break
    if (t.startsWith(prefix)) parts.unshift(t.slice(prefix.length).trim())
    else break
    j--
  }
  return parts.join(' ').slice(0, 400)
}

function genericReferences(content, fileId, index, kwSet) {
  const lines = content.split('\n')
  const resolve = makeResolver(fileId, index)
  const enclosing = makeEnclosingLookup(fileId, index)
  const edges = []
  const seen = new Set()
  const RE_CALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  for (let i = 0; i < lines.length; i++) {
    const src = enclosing(i + 1)
    if (!src) continue
    RE_CALL.lastIndex = 0
    let m
    while ((m = RE_CALL.exec(lines[i]))) {
      const name = m[1]
      if (kwSet && kwSet.has(name)) continue
      const target = resolve(name)
      if (!target || target.id === src) continue
      const key = src + '|' + target.id
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: src, target: target.id, kind: 'call', line: i + 1 })
    }
  }
  return edges
}

module.exports = { go, rust, javaKt, swift }
