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

// Built-ins / globals to skip when emitting identifier-reference
// edges. Otherwise every `console.log`, `Math.max`, `Array.from` etc.
// would generate a spurious edge to a same-named user symbol.
const JS_BUILTINS = new Set([
  'console','window','document','globalThis','process','require','module',
  'exports','__dirname','__filename','Buffer','Math','Object','Array',
  'String','Number','Boolean','Date','RegExp','Error','TypeError',
  'RangeError','SyntaxError','Promise','Symbol','Map','Set','WeakMap',
  'WeakSet','JSON','Reflect','Proxy','Function','undefined','null','true',
  'false','NaN','Infinity','this','self','super','arguments','typeof',
  'instanceof','void','delete','new','in','of','yield','await','async',
  'function','class','const','let','var','if','else','for','while','do',
  'switch','case','break','continue','return','throw','try','catch',
  'finally','default','export','import','from','as','static','public',
  'private','protected','readonly','abstract','enum','interface','type',
  'namespace','module','declare','React','setTimeout','setInterval',
  'clearTimeout','clearInterval','fetch','URL','URLSearchParams',
  'parseInt','parseFloat','isNaN','isFinite','encodeURI','decodeURI',
  'encodeURIComponent','decodeURIComponent',
])

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

// Resolve a type-position node to its top identifier name.
//   `Bar`                            → "Bar"
//   `Bar.Baz`                        → "Baz"   (rightmost segment)
//   `Generic<T>` (TSTypeReference)   → "Generic"
//   `Foo extends Bar` superClass     → handled by caller's recursion
function extractTypeName(node) {
  if (!node) return null
  switch (node.type) {
    case 'Identifier':              return node.name
    case 'MemberExpression':        return extractTypeName(node.property)
    case 'TSTypeReference':         return extractTypeName(node.typeName)
    case 'TSQualifiedName':         return extractTypeName(node.right)
    case 'TSExpressionWithTypeArguments': return extractTypeName(node.expression)
    case 'CallExpression':          return extractTypeName(node.callee)  // mixin patterns
  }
  return null
}

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

  // Two modes mirroring the tree-sitter parser. Calls allow the
  // any-file fallback (`foo()` is a strong signal); plain references
  // stay strict (same-file or imported file only) so noise edges
  // don't proliferate when a local variable shares a name with
  // some unrelated user symbol.
  function resolveCall(name) {
    return index.resolveCall ? index.resolveCall(fileId, name, { allowAny: true })  : null
  }
  function resolveRef(name) {
    return index.resolveCall ? index.resolveCall(fileId, name, { allowAny: false }) : null
  }

  function pushEnclosing(name, startLine) {
    enclosing.push(mkId(fileId, name, startLine))
  }

  // Per-function variable → type maps. Pushed/popped with enclosing
  // so a `const user = new User()` only affects calls inside that
  // function. Best-effort: `new X()` and TS `let x: X = ...`.
  const typeStack = []
  function pushTypes() { typeStack.push(new Map()) }
  function popTypes()  { typeStack.pop() }
  function topTypes()  { return typeStack[typeStack.length - 1] || null }
  function lookupVarType(name) {
    for (let i = typeStack.length - 1; i >= 0; i--) {
      const t = typeStack[i].get(name)
      if (t) return t
    }
    return null
  }
  function harvestTypesFrom(fnNode) {
    const types = topTypes()
    if (!types) return
    // 1) TypeScript parameter annotations: `function f(user: User)`
    //    Also catches destructured/rest patterns when the annotation
    //    is on the simple identifier directly.
    if (Array.isArray(fnNode.params)) {
      for (const p of fnNode.params) {
        if (p?.type === 'Identifier') {
          const ann = p.typeAnnotation?.typeAnnotation
          const annName = extractTypeName(ann)
          if (annName) types.set(p.name, annName)
        }
        // `function f({ name }: User)` — destructured param with type
        if (p?.type === 'ObjectPattern' && p.typeAnnotation) {
          const annName = extractTypeName(p.typeAnnotation.typeAnnotation)
          for (const prop of p.properties || []) {
            if (prop.value?.type === 'Identifier' && annName) {
              types.set(prop.value.name, annName)
            }
          }
        }
      }
    }
    // 2) Body-level declarations
    const body = fnNode.body?.body
    if (!Array.isArray(body)) return
    for (const stmt of body) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const d of stmt.declarations || []) {
        if (d.id?.type !== 'Identifier') continue
        const varName = d.id.name
        // TS annotation: `let user: User`
        const ann = d.id.typeAnnotation?.typeAnnotation
        const annName = extractTypeName(ann)
        if (annName) { types.set(varName, annName); continue }
        // `new User()` / `new User(args)` initializer
        if (d.init?.type === 'NewExpression') {
          const cls = extractTypeName(d.init.callee)
          if (cls) { types.set(varName, cls); continue }
        }
        // 3) `const u = User.find(...)` / `User.create(...)` — assume
        //    static factory returns the same type. Heuristic but
        //    extremely common in ORM/DDD code.
        if (d.init?.type === 'CallExpression'
            && d.init.callee?.type === 'MemberExpression'
            && d.init.callee.object?.type === 'Identifier'
            && /^[A-Z]/.test(d.init.callee.object.name)
            && /^(find|findOne|findFirst|findMany|create|build|new|of|from|get|fetch)/.test(
                 d.init.callee.property?.name || '')) {
          types.set(varName, d.init.callee.object.name)
        }
        // 4) `const u = makeUser()` / `getUser()` — heuristic on
        //    factory names that contain a capitalised noun: `makeUser`
        //    → User, `getOrder` → Order.
        if (d.init?.type === 'CallExpression'
            && d.init.callee?.type === 'Identifier') {
          const fnName = d.init.callee.name
          const m = fnName.match(/^(?:make|create|build|get|fetch|find|new|of|to)?([A-Z][a-zA-Z0-9]+)$/)
          if (m) types.set(varName, m[1])
        }
      }
    }
  }

  traverse(ast, {
    FunctionDeclaration: {
      enter(path) {
        const n = path.node
        // babel/traverse rejects any non-undefined return from a
        // visitor enter/exit — `return x.push(...)` (number) and
        // `return x.pop()` (element) both throw "Unexpected return
        // value". Use bare `return` instead.
        if (!n.id?.name || !n.loc) { enclosing.push(null); return }
        pushEnclosing(n.id.name, n.loc.start.line)
        pushTypes(); harvestTypesFrom(n)
      },
      exit() { enclosing.pop(); popTypes() },
    },
    ClassDeclaration: {
      enter(path) {
        const n = path.node
        currentClass = n.id?.name || null
        if (currentClass && n.loc) {
          const classId = mkId(fileId, currentClass, n.loc.start.line)
          // `class Foo extends Bar` / `extends Bar.Baz` / `extends Generic<T>`
          const superName = extractTypeName(n.superClass)
          if (superName) {
            const t = resolveCall(superName)
            if (t) edges.push({ source: classId, target: t.id, kind: 'extends', line: n.loc.start.line })
          }
          // TypeScript `class Foo implements IFoo, IBar`
          if (Array.isArray(n.implements)) {
            for (const imp of n.implements) {
              const name = extractTypeName(imp.expression || imp)
              if (!name) continue
              const t = resolveCall(name)
              if (t) edges.push({ source: classId, target: t.id, kind: 'implements', line: n.loc.start.line })
            }
          }
        }
      },
      exit() { currentClass = null },
    },
    // TS `interface Foo extends Bar, Baz`
    TSInterfaceDeclaration: {
      enter(path) {
        const n = path.node
        if (!n.id || !n.loc) return
        const ifaceId = mkId(fileId, n.id.name, n.loc.start.line)
        if (Array.isArray(n.extends)) {
          for (const ext of n.extends) {
            const name = extractTypeName(ext.expression || ext)
            if (!name) continue
            const t = resolveCall(name)
            if (t) edges.push({ source: ifaceId, target: t.id, kind: 'extends', line: n.loc.start.line })
          }
        }
      },
    },
    ClassMethod: {
      enter(path) {
        const n = path.node
        if (!n.key || !n.loc) { enclosing.push(null); return }
        const name = n.key.name || n.key.value || '(method)'
        const qualified = currentClass ? `${currentClass}.${name}` : name
        pushEnclosing(qualified, n.loc.start.line)
        pushTypes(); harvestTypesFrom(n)
      },
      exit() { enclosing.pop(); popTypes() },
    },
    ArrowFunctionExpression: {
      enter(path) {
        const parent = path.parentPath?.node
        if (parent?.type !== 'VariableDeclarator') { enclosing.push(null); return }
        const name = parent.id?.name
        if (!name || !path.node.loc) { enclosing.push(null); return }
        pushEnclosing(name, path.node.loc.start.line)
        pushTypes(); harvestTypesFrom(path.node)
      },
      exit(path) {
        const parent = path.parentPath?.node
        if (parent?.type !== 'VariableDeclarator') { enclosing.pop(); return }
        const name = parent.id?.name
        if (name && path.node.loc) { enclosing.pop(); popTypes() }
        else enclosing.pop()
      },
    },
    CallExpression(path) {
      const src = enclosing.top()
      if (!src) return
      const callee = path.node.callee
      let name = null
      let receiverClass = null
      if (callee.type === 'Identifier') name = callee.name
      else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
        name = callee.property.name
        // Type-aware: receiver is `user` → look up `user`'s declared
        // type → resolve `User.method` qualified name first.
        const obj = callee.object
        if (obj?.type === 'Identifier') {
          const t = lookupVarType(obj.name)
          if (t) receiverClass = t
        } else if (obj?.type === 'ThisExpression' && currentClass) {
          receiverClass = currentClass
        }
      }
      if (!name) return
      // Resolve. A bare call `foo()` may resolve loosely (same-file /
      // imported / unique-production) — no receiver, so it's a strong
      // signal for an in-scope or module-level function. A member call
      // `obj.foo()` resolves ONLY when we know the receiver's type
      // (→ qualified `Type.foo`); we do NOT fall back to a bare-name
      // lookup for it. `.add()` / `.get()` on an untyped receiver would
      // otherwise mis-link to an unrelated same-named free function
      // (B-2 caught `visited.add()` → a same-file `add`). Empty beats
      // wrong — see docs/SYMBOL-MODE-PLAN.md §5.
      const isMemberCall = callee.type === 'MemberExpression'
      let target = null
      if (receiverClass) {
        // Typed member call: exact `Type.method` match only — no bare-name
        // degrade (qualifiedOnly), so `visited.add()` → 'Set.add' (no such
        // symbol) stays unresolved instead of grabbing a same-file `add`.
        target = index.resolveCall
          ? index.resolveCall(fileId, `${receiverClass}.${name}`, { allowAny: true, qualifiedOnly: true })
          : null
      }
      if (!target && !isMemberCall) target = resolveCall(name)
      if (!target || target.id === src) return
      edges.push({
        source: src,
        target: target.id,
        kind: 'call',
        line: path.node.loc?.start.line || 0,
      })
    },
    // Expression-level references — non-call identifier usage. Lets us
    // see "Foo is used here" even when it's not being invoked
    // (passed as argument, assigned, type-annotated, etc.). codegraph
    // counts every identifier as a node; we instead emit a `ref` edge
    // to the matched symbol, which keeps the graph file-cheap.
    Identifier(path) {
      const src = enclosing.top()
      if (!src) return
      const name = path.node.name
      if (!name || JS_BUILTINS.has(name)) return
      // Skip identifiers that are the *declaration* itself (parameter
      // names, the var/let/const id, the function/class name) — only
      // count usages.
      const parent = path.parent
      if (!parent) return
      if (parent.type === 'VariableDeclarator' && parent.id === path.node) return
      if (parent.type === 'FunctionDeclaration' && parent.id === path.node) return
      if (parent.type === 'ClassDeclaration' && parent.id === path.node) return
      if (parent.type === 'Identifier') return  // shouldn't happen but guard
      if ((parent.type === 'CallExpression' || parent.type === 'NewExpression')
          && parent.callee === path.node) return  // already counted as call
      if (parent.type === 'MemberExpression' && parent.property === path.node && !parent.computed) return
      if (parent.type === 'ObjectProperty' && parent.key === path.node && !parent.computed) return
      if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return
      if (parent.type === 'FunctionExpression' && parent.id === path.node) return
      if (parent.type === 'ArrowFunctionExpression') return  // params handled below
      if (parent.type === 'AssignmentPattern' || parent.type === 'RestElement') return
      // Skip parameters of the enclosing function.
      const fnParent = path.findParent((p) => p.isFunction?.() || p.isClassMethod?.())
      if (fnParent && fnParent.node.params?.some?.((p) => p === path.parent || p === path.node)) return
      const target = resolveRef(name)
      if (!target || target.id === src) return
      edges.push({ source: src, target: target.id, kind: 'ref', line: path.node.loc?.start.line || 0 })
    },
    // Member access (`obj.method`) where `method` matches a known
    // symbol — we treat it as a reference even without an invocation
    // (e.g. `const x = obj.method` or `passing obj.method as cb`).
    MemberExpression(path) {
      const src = enclosing.top()
      if (!src) return
      if (path.parent?.type === 'CallExpression' && path.parent.callee === path.node) return
      const prop = path.node.property
      if (!prop || prop.type !== 'Identifier') return
      // Type-aware, mirroring CallExpression: emit a ref only when we know
      // the receiver's type (→ qualified `Type.prop`). An untyped `e.t`
      // must not link to a same-named free function (B-2: `e.t` → i18n `t`).
      const obj = path.node.object
      let receiverClass = null
      if (obj?.type === 'Identifier') { const ty = lookupVarType(obj.name); if (ty) receiverClass = ty }
      else if (obj?.type === 'ThisExpression' && currentClass) receiverClass = currentClass
      if (!receiverClass) return
      const target = index.resolveCall
        ? index.resolveCall(fileId, `${receiverClass}.${prop.name}`, { qualifiedOnly: true })
        : null
      if (!target || target.id === src) return
      edges.push({ source: src, target: target.id, kind: 'ref', line: path.node.loc?.start.line || 0 })
    },
    // JSX `<Component … />` — the element name is a symbol reference.
    JSXIdentifier(path) {
      const src = enclosing.top()
      if (!src) return
      const name = path.node.name
      // Tag names that start lowercase are HTML primitives, not React
      // components. React component naming convention catches the rest.
      if (!name || !/^[A-Z]/.test(name)) return
      const target = resolveRef(name)
      if (!target || target.id === src) return
      edges.push({ source: src, target: target.id, kind: 'jsx-ref', line: path.node.loc?.start.line || 0 })
    },
    // TypeScript type annotations / generic params — `x: Foo`,
    // `Array<Foo>`, `function f(): Foo`, etc.
    TSTypeReference(path) {
      const src = enclosing.top()
      if (!src) return
      const name = path.node.typeName?.name
              || path.node.typeName?.right?.name      // qualified Name
      if (!name) return
      const target = resolveRef(name)
      if (!target || target.id === src) return
      edges.push({ source: src, target: target.id, kind: 'type-ref', line: path.node.loc?.start.line || 0 })
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
