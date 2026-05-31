// JS/TS symbol parser — uses @babel/parser (already a project dep).
//
// Extracts: function declarations, class declarations, methods, exports,
// const-assigned arrow functions (`const foo = () => …`), TS interfaces
// and types. Skips overlapping anonymous IIFEs and inline lambdas.
//
// References: every CallExpression inside a tracked function/method
// becomes an edge (source = enclosing symbol, target = best-match by name).
// Method calls (`obj.method()`) match by method name across the project.
// Cross-file resolution borrows the file-mode imports — if `foo` was
// imported, we prefer symbols in the imported file.

'use strict'

const parser = require('@babel/parser')
const traverse = require('@babel/traverse').default

const JS_PLUGINS = [
  'jsx', 'typescript', 'classProperties', 'classPrivateProperties',
  'classPrivateMethods', 'decorators-legacy', 'topLevelAwait',
  'optionalChaining', 'nullishCoalescingOperator', 'logicalAssignment',
  'numericSeparator', 'dynamicImport', 'importMeta',
  'exportDefaultFrom', 'exportNamespaceFrom',
]

function parseAst(content, ext) {
  // tsx/jsx need their respective plugin to actually parse JSX.
  const plugins = JS_PLUGINS.filter((p) =>
    !(p === 'typescript' && (ext === 'js' || ext === 'jsx')))
  try {
    return parser.parse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins,
    })
  } catch {
    return null
  }
}

function mkId(file, name, line) { return `${file}#${name}@${line}` }

// Extract a one-line signature from a function/class declaration.
function signatureOf(node, content) {
  if (!node?.loc) return ''
  const startIdx = node.start ?? 0
  // Cut at first '{' or ';' (signature only), max 200 chars
  let end = content.indexOf('{', startIdx)
  if (end < 0 || end - startIdx > 200) end = startIdx + 200
  return content.slice(startIdx, end).trim().replace(/\s+/g, ' ')
}

// Best-guess docstring: the comment block immediately above `node`.
function docOf(node) {
  if (!node?.leadingComments) return ''
  const last = node.leadingComments[node.leadingComments.length - 1]
  if (!last) return ''
  return last.value.replace(/^\s*\*\s?/gm, '').trim().slice(0, 400)
}

// Enclosing symbol id while traversing. We push/pop as we enter/leave
// function/method/class scopes so a CallExpression knows its source.
function makeEnclosingStack() {
  const stack = []
  return {
    push: (id) => stack.push(id),
    pop:  () => stack.pop(),
    top:  () => stack[stack.length - 1] || null,
  }
}

function extractSymbols(content, fileId) {
  const ext = (fileId.split('.').pop() || '').toLowerCase()
  const ast = parseAst(content, ext)
  if (!ast) return []
  const symbols = []
  let currentClass = null

  traverse(ast, {
    FunctionDeclaration(path) {
      const n = path.node
      const name = n.id?.name || '(anonymous)'
      if (!n.loc) return
      symbols.push({
        id: mkId(fileId, name, n.loc.start.line),
        name,
        qualifiedName: name,
        kind: 'function',
        file: fileId,
        startLine: n.loc.start.line,
        endLine: n.loc.end.line,
        signature: signatureOf(n, content),
        doc: docOf(n),
        exported: path.parent?.type?.startsWith('Export') ?? false,
      })
    },
    ClassDeclaration: {
      enter(path) {
        const n = path.node
        if (!n.id || !n.loc) return
        currentClass = n.id.name
        symbols.push({
          id: mkId(fileId, n.id.name, n.loc.start.line),
          name: n.id.name,
          qualifiedName: n.id.name,
          kind: 'class',
          file: fileId,
          startLine: n.loc.start.line,
          endLine: n.loc.end.line,
          signature: signatureOf(n, content),
          doc: docOf(n),
          exported: path.parent?.type?.startsWith('Export') ?? false,
        })
      },
      exit() { currentClass = null },
    },
    ClassMethod(path) {
      const n = path.node
      if (!n.key || !n.loc) return
      const name = n.key.name || n.key.value || '(method)'
      const qualifiedName = currentClass ? `${currentClass}.${name}` : name
      symbols.push({
        id: mkId(fileId, qualifiedName, n.loc.start.line),
        name,
        qualifiedName,
        kind: name === 'constructor' ? 'function' : 'method',
        file: fileId,
        startLine: n.loc.start.line,
        endLine: n.loc.end.line,
        signature: signatureOf(n, content),
        doc: docOf(n),
        exported: false,
      })
    },
    VariableDeclarator(path) {
      const n = path.node
      // const foo = () => {} | const foo = function() {}
      const init = n.init
      if (!init || !n.loc) return
      const t = init.type
      if (t !== 'ArrowFunctionExpression' && t !== 'FunctionExpression') return
      const name = n.id?.name
      if (!name) return
      symbols.push({
        id: mkId(fileId, name, n.loc.start.line),
        name,
        qualifiedName: name,
        kind: 'function',
        file: fileId,
        startLine: n.loc.start.line,
        endLine: n.loc.end.line,
        signature: signatureOf(n, content),
        doc: docOf(path.parentPath?.parent),
        exported: false,
      })
    },
    TSInterfaceDeclaration(path) {
      const n = path.node
      if (!n.loc || !n.id) return
      symbols.push({
        id: mkId(fileId, n.id.name, n.loc.start.line),
        name: n.id.name,
        qualifiedName: n.id.name,
        kind: 'interface',
        file: fileId,
        startLine: n.loc.start.line,
        endLine: n.loc.end.line,
        signature: signatureOf(n, content),
        doc: docOf(n),
        exported: path.parent?.type?.startsWith('Export') ?? false,
      })
    },
    TSTypeAliasDeclaration(path) {
      const n = path.node
      if (!n.loc || !n.id) return
      symbols.push({
        id: mkId(fileId, n.id.name, n.loc.start.line),
        name: n.id.name,
        qualifiedName: n.id.name,
        kind: 'type',
        file: fileId,
        startLine: n.loc.start.line,
        endLine: n.loc.end.line,
        signature: signatureOf(n, content),
        doc: docOf(n),
        exported: path.parent?.type?.startsWith('Export') ?? false,
      })
    },
  })

  return symbols
}

function extractReferences(content, fileId, index) {
  const ext = (fileId.split('.').pop() || '').toLowerCase()
  const ast = parseAst(content, ext)
  if (!ast) return []
  const edges = []
  const enclosing = makeEnclosingStack()
  let currentClass = null

  // Use the SymbolGraph's import-aware resolver: same file first,
  // then any file the caller actually imports, then anything.
  function resolveByName(name) {
    return index.resolveCall ? index.resolveCall(fileId, name) : null
  }

  function pushEnclosing(name, startLine) {
    enclosing.push(mkId(fileId, name, startLine))
  }

  traverse(ast, {
    FunctionDeclaration: {
      enter(path) {
        const n = path.node
        if (!n.id?.name || !n.loc) return enclosing.push(null)
        pushEnclosing(n.id.name, n.loc.start.line)
      },
      exit() { enclosing.pop() },
    },
    ClassDeclaration: {
      enter(path) {
        const n = path.node
        currentClass = n.id?.name || null
        // class itself doesn't act as the enclosing function — its
        // methods do, so we don't push to the stack here.
        if (n.superClass?.type === 'Identifier' && currentClass && n.loc) {
          const target = resolveByName(n.superClass.name)
          if (target) {
            edges.push({
              source: mkId(fileId, currentClass, n.loc.start.line),
              target: target.id,
              kind: 'extends',
              line: n.loc.start.line,
            })
          }
        }
      },
      exit() { currentClass = null },
    },
    ClassMethod: {
      enter(path) {
        const n = path.node
        if (!n.key || !n.loc) return enclosing.push(null)
        const name = n.key.name || n.key.value || '(method)'
        const qualified = currentClass ? `${currentClass}.${name}` : name
        pushEnclosing(qualified, n.loc.start.line)
      },
      exit() { enclosing.pop() },
    },
    ArrowFunctionExpression: {
      enter(path) {
        const parent = path.parentPath?.node
        if (parent?.type !== 'VariableDeclarator') return enclosing.push(null)
        const name = parent.id?.name
        if (!name || !path.node.loc) return enclosing.push(null)
        pushEnclosing(name, path.node.loc.start.line)
      },
      exit(path) {
        const parent = path.parentPath?.node
        if (parent?.type !== 'VariableDeclarator') return enclosing.pop()
        const name = parent.id?.name
        if (name && path.node.loc) enclosing.pop()
        else enclosing.pop()
      },
    },
    CallExpression(path) {
      const src = enclosing.top()
      if (!src) return
      const callee = path.node.callee
      let name = null
      if (callee.type === 'Identifier') name = callee.name
      else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
        name = callee.property.name
      }
      if (!name) return
      const target = resolveByName(name)
      if (!target || target.id === src) return
      edges.push({
        source: src,
        target: target.id,
        kind: 'call',
        line: path.node.loc?.start.line || 0,
      })
    },
  })
  // De-dup (same source→target multiple times is noise)
  const seen = new Set()
  const dedup = []
  for (const e of edges) {
    const key = e.source + '|' + e.target + '|' + e.kind
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(e)
  }
  return dedup
}

module.exports = { extractSymbols, extractReferences }
