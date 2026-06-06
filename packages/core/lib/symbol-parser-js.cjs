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

// Harvest known property types of a class so `this.prop.method()` can resolve
// to `PropType.method`. Only records types we actually KNOW (a TS annotation or
// a `new X()` initializer / assignment) — never a guess, so the qualified
// resolution it enables stays precision-safe. Sources:
//   • class field `collection: Collection` / `collection = new Collection()`
//   • TS parameter property `constructor(private collection: Collection)`
//   • constructor body `this.collection = new Collection()`
function harvestClassProps(classNode, map) {
  const body = classNode.body?.body
  if (!Array.isArray(body)) return
  for (const m of body) {
    const mt = m.type
    if ((mt === 'ClassProperty' || mt === 'PropertyDefinition' || mt === 'ClassPrivateProperty') && m.key) {
      const pname = m.key.name || m.key.id?.name
      if (!pname) continue
      const annT = extractTypeName(m.typeAnnotation?.typeAnnotation)
      if (annT) { map.set(pname, annT); continue }
      if (m.value?.type === 'NewExpression') {
        const c = extractTypeName(m.value.callee)
        if (c) map.set(pname, c)
      }
      continue
    }
    if (mt === 'ClassMethod' && m.kind === 'constructor') {
      for (const p of m.params || []) {
        const id = p?.type === 'TSParameterProperty' ? p.parameter : p
        if (id?.type === 'Identifier') {
          const t = extractTypeName(id.typeAnnotation?.typeAnnotation)
          if (t) map.set(id.name, t)
        }
      }
      const stmts = m.body?.body
      if (Array.isArray(stmts)) for (const s of stmts) {
        const a = s.type === 'ExpressionStatement' ? s.expression : null
        if (a?.type === 'AssignmentExpression'
            && a.left?.type === 'MemberExpression'
            && a.left.object?.type === 'ThisExpression'
            && a.left.property?.type === 'Identifier'
            && a.right?.type === 'NewExpression') {
          const c = extractTypeName(a.right.callee)
          if (c) map.set(a.left.property.name, c)
        }
      }
    }
  }
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
  const cjsExports = new Set()   // names assigned to module.exports / exports.X

  // Module-scope pseudo-symbol: the source for top-level / module-init calls
  // (`export const X = factory(...)`) and callbacks whose nearest named
  // enclosing IS the module. Without a module source those calls have no
  // enclosing symbol and are dropped — measured as the single biggest
  // static-completeness gap (zod: ~1036 module-level/callback calls lost).
  symbols.push({
    id: mkId(fileId, '<module>', 1), name: '<module>', qualifiedName: '<module>',
    kind: 'module', file: fileId, startLine: 1, endLine: 1, signature: '', doc: '', exported: false,
  })

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
        returnType: extractTypeName(n.returnType?.typeAnnotation),
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
        returnType: extractTypeName(n.returnType?.typeAnnotation),
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
        returnType: extractTypeName(init.returnType?.typeAnnotation),
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
    // Object-literal functions: `{ foo() {}, bar: () => {} }` — extremely
    // common in JS/TS (config objects, handler maps, module-export objects)
    // and the single biggest call-target recall gap (entry.js: ~3.5k missed).
    // Indexed by key name so `obj.foo()` resolves to them.
    ObjectMethod(path) {
      const n = path.node
      if (!n.key || !n.loc) return
      const name = String(n.key.name ?? n.key.value ?? '')
      if (!name) return
      symbols.push({
        id: mkId(fileId, name, n.loc.start.line), name, qualifiedName: name,
        kind: 'method', file: fileId, startLine: n.loc.start.line, endLine: n.loc.end.line,
        signature: signatureOf(n, content), doc: docOf(n), exported: false,
      })
    },
    ObjectProperty(path) {
      const n = path.node
      if (!n.key || !n.value || !n.loc || n.computed) return
      const t = n.value.type
      if (t !== 'ArrowFunctionExpression' && t !== 'FunctionExpression') return
      const name = String(n.key.name ?? n.key.value ?? '')
      if (!name) return
      symbols.push({
        id: mkId(fileId, name, n.loc.start.line), name, qualifiedName: name,
        kind: 'function', file: fileId, startLine: n.loc.start.line, endLine: n.loc.end.line,
        signature: signatureOf(n, content), doc: docOf(n), exported: false,
      })
    },
    // CommonJS exports: `module.exports = foo`, `module.exports = { foo, bar }`,
    // `module.exports.foo = …`, `exports.foo = …`. The visitors above default
    // exported:false and only knew ES `export`, so CJS-exported functions were
    // all mislabelled un-exported.
    AssignmentExpression(path) {
      const { left, right } = path.node
      if (left?.type !== 'MemberExpression') return
      const o = left.object, p = left.property
      const isModuleExports = (node) => node?.type === 'MemberExpression'
        && node.object?.type === 'Identifier' && node.object.name === 'module'
        && node.property?.type === 'Identifier' && node.property.name === 'exports'
      // exports.foo = … / module.exports.foo = …
      if (((o?.type === 'Identifier' && o.name === 'exports') || isModuleExports(o)) && p?.type === 'Identifier') {
        cjsExports.add(p.name)
        if (right?.type === 'Identifier') cjsExports.add(right.name)
        return
      }
      // module.exports = foo | module.exports = { foo, bar }
      if (isModuleExports(left)) {
        if (right?.type === 'Identifier') cjsExports.add(right.name)
        else if (right?.type === 'ObjectExpression') for (const pr of (right.properties || [])) {
          if (pr.key?.type === 'Identifier') cjsExports.add(pr.key.name)
          if (pr.value?.type === 'Identifier') cjsExports.add(pr.value.name)
        }
      }
    },
  })

  for (const s of symbols) if (cjsExports.has(s.name)) s.exported = true

  return symbols
}

function extractReferences(content, fileId, index) {
  const ext = (fileId.split('.').pop() || '').toLowerCase()
  const ast = parseAst(content, ext)
  if (!ast) return []
  const edges = []
  const enclosing = makeEnclosingStack()
  // Seed the stack with the module pseudo-symbol so a call at top level (or in
  // a callback whose nearest named enclosing is the module) attributes to the
  // module instead of being dropped. Never popped — it is the base.
  enclosing.push(mkId(fileId, '<module>', 1))
  let currentClass = null
  let currentPropTypes = null   // class property name → known type (for this.x.m())

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
  // Resolve a CallExpression's STATIC return type — the TS return annotation on
  // the called function/method (now carried on every symbol node). This is what
  // turns member-call DATA FLOW into edges: `const s = make(); s.parse()` and
  // the chain `make().parse()` both need to know `make()` yields a `Schema` so
  // `.parse()` resolves to `Schema.parse`. Unlike the name heuristics below this
  // is a RESOLVED type (read off the callee's real signature), so it is exact —
  // no wrong edge. Returns a type name or null. `seen` guards mutual recursion.
  function callReturnType(callNode, seen) {
    if (!callNode) return null
    if (callNode.type === 'NewExpression') return extractTypeName(callNode.callee)  // new X() : X
    if (callNode.type !== 'CallExpression' || !index.resolveCall) return null
    const callee = callNode.callee
    if (!callee) return null
    let resolved = null
    if (callee.type === 'Identifier') {
      resolved = index.resolveCall(fileId, callee.name, { allowAny: true })
    } else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
      let recv = null
      const obj = callee.object
      if (obj?.type === 'Identifier') recv = lookupVarType(obj.name)
      else if (obj?.type === 'ThisExpression' && currentClass) recv = currentClass
      else if ((obj?.type === 'CallExpression' || obj?.type === 'NewExpression')) {
        // chain `a().b().c()` — bound recursion so a cycle can't loop forever
        if (!seen || seen < 8) recv = callReturnType(obj, (seen || 0) + 1)
      }
      if (recv) resolved = index.resolveCall(fileId, `${recv}.${callee.property.name}`, { allowAny: true, qualifiedOnly: true })
    }
    return resolved?.returnType || null
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
        // `new User()` / `const s = make()` / `factory()` — RESOLVED return
        // type (the TS return annotation on the called fn). Exact (read off the
        // callee's real signature), so it precedes the name-based guesses below.
        if (d.init?.type === 'NewExpression' || d.init?.type === 'CallExpression') {
          const rt = callReturnType(d.init)
          if (rt) { types.set(varName, rt); continue }
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
        currentPropTypes = currentClass ? new Map() : null
        if (currentPropTypes) harvestClassProps(n, currentPropTypes)
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
      exit() { currentClass = null; currentPropTypes = null },
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
    // Object-literal method `{ foo() { … } }` — now an extracted symbol, so its
    // body's calls must be attributed to it. Without this they fell back to the
    // outer enclosing (null for the very common module-level config object
    // `Entry.X = { onLoad() { bar() } }`) and were discarded.
    ObjectMethod: {
      enter(path) {
        const n = path.node
        const name = n.key && (n.key.name != null || n.key.value != null) ? String(n.key.name ?? n.key.value) : null
        if (name && n.loc) pushEnclosing(name, n.loc.start.line)
        else enclosing.push(enclosing.top())
        pushTypes(); harvestTypesFrom(n)
      },
      exit() { enclosing.pop(); popTypes() },
    },
    ArrowFunctionExpression: {
      enter(path) {
        const parent = path.parentPath?.node
        // Named arrow — `const f = () => …` OR object property `{ f: () => … }`.
        // Both are extracted symbols (same id = parent node's start line), so
        // attribute their body's calls to them.
        let name = null
        if (parent?.type === 'VariableDeclarator') name = parent.id?.name
        else if (parent?.type === 'ObjectProperty' && !parent.computed) {
          name = parent.key?.name ?? (parent.key?.value != null ? String(parent.key.value) : null)
        }
        if (name && parent.loc) {
          pushEnclosing(name, parent.loc.start.line)
          pushTypes(); harvestTypesFrom(path.node)
          return
        }
        // Anonymous arrow used as a callback (`arr.map(x => foo(x))`,
        // `.then(() => foo())`, event handlers). Not its own symbol, but the
        // calls inside it belong to the nearest NAMED enclosing function —
        // inherit that id instead of dropping to null. Pushing null made
        // `enclosing.top()` null so every call routed through a callback was
        // discarded: the dominant JS/TS recall leak. At module scope top() is
        // still null, so nothing is mis-attributed.
        enclosing.push(enclosing.top())
      },
      exit(path) {
        const parent = path.parentPath?.node
        let named = false
        if (parent?.type === 'VariableDeclarator') named = !!parent.id?.name
        else if (parent?.type === 'ObjectProperty' && !parent.computed) named = parent.key?.name != null || parent.key?.value != null
        if (named && parent.loc) { enclosing.pop(); popTypes() }
        else enclosing.pop()
      },
    },
    // FunctionExpression mirrors ArrowFunctionExpression. Named via a const
    // (`const f = function () {}`) or object property (`{ f: function () {} }`)
    // is an extracted symbol — attribute its body's calls to it; anonymous
    // (`arr.forEach(function () { … })`) inherits the nearest named enclosing.
    FunctionExpression: {
      enter(path) {
        const parent = path.parentPath?.node
        let name = null
        if (parent?.type === 'VariableDeclarator') name = parent.id?.name
        else if (parent?.type === 'ObjectProperty' && !parent.computed) {
          name = parent.key?.name ?? (parent.key?.value != null ? String(parent.key.value) : null)
        }
        if (name && parent.loc) {
          pushEnclosing(name, parent.loc.start.line)
          pushTypes(); harvestTypesFrom(path.node)
          return
        }
        enclosing.push(enclosing.top())
      },
      exit(path) {
        const parent = path.parentPath?.node
        let named = false
        if (parent?.type === 'VariableDeclarator') named = !!parent.id?.name
        else if (parent?.type === 'ObjectProperty' && !parent.computed) named = parent.key?.name != null || parent.key?.value != null
        if (named && parent.loc) { enclosing.pop(); popTypes() }
        else enclosing.pop()
      },
    },
    // Also handles `new X()` — the babel parser previously had no NewExpression
    // handler, so every constructor call was dropped (measured: 202 missed on
    // zod). `new X()`'s callee is the class, which resolves like any bare call.
    'CallExpression|NewExpression'(path) {
      const src = enclosing.top()
      if (!src) return
      const callee = path.node.callee
      let name = null
      let receiverClass = null
      let memberViaImport = false   // `ns.fn()` where ns is `import * as ns` / default import
      if (callee.type === 'Identifier') name = callee.name
      else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
        name = callee.property.name
        // Type-aware: receiver is `user` → look up `user`'s declared
        // type → resolve `User.method` qualified name first.
        const obj = callee.object
        if (obj?.type === 'Identifier') {
          const t = lookupVarType(obj.name)
          if (t) receiverClass = t
          else {
            // `ns.fn()` where `ns` is a namespace/default import → `fn` lives in
            // the IMPORTED module, not same-file. Resolve imported-only so it
            // doesn't grab a same-file function of that name (was a phantom).
            const b = path.scope.getBinding(obj.name)
            if (b && b.path && (b.path.isImportNamespaceSpecifier?.() || b.path.isImportDefaultSpecifier?.())) memberViaImport = true
          }
        } else if (obj?.type === 'ThisExpression' && currentClass) {
          receiverClass = currentClass
        } else if (obj?.type === 'MemberExpression'
                   && obj.object?.type === 'ThisExpression'
                   && obj.property?.type === 'Identifier'
                   && currentPropTypes) {
          // `this.collection.method()` — resolve via the class's known
          // property type (`this.collection: Collection`). Type is known, so
          // qualified resolution stays precise.
          const t = currentPropTypes.get(obj.property.name)
          if (t) receiverClass = t
        } else if (obj?.type === 'CallExpression' || obj?.type === 'NewExpression') {
          // `make().method()` / `getRepo().find()` — receiver is itself a call;
          // its STATIC return type (TS annotation on the callee) gives the type.
          // This is the dominant member-call data-flow gap (e.g. `z.object().parse()`).
          const t = callReturnType(obj)
          if (t) receiverClass = t
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
      let target = null
      if (receiverClass) {
        // Typed member call: exact `Type.method` match only — no bare-name
        // degrade (qualifiedOnly), so `visited.add()` → 'Set.add' (no such
        // symbol) stays unresolved instead of grabbing a same-file `add`.
        target = index.resolveCall
          ? index.resolveCall(fileId, `${receiverClass}.${name}`, { allowAny: true, qualifiedOnly: true })
          : null
      }
      // Bare-name fallback. A bare `foo()` is a strong signal → allowAny (incl.
      // the unique-production cross-file guess). An UNTYPED `obj.foo()` is NOT:
      // the receiver type is unknown, so a cross-file unique-production guess
      // mis-links it to an unrelated same-named object-method/free function
      // (measured: ~23 phantom edges on zod). So untyped member calls resolve
      // only same-file / imported (allowAny:false) — precision over the guess
      // ("a wrong edge is worse than a missing one"). Typed member calls were
      // already resolved above via the qualified `Type.method` path. memberCall
      // also rejects builtin method names before the same-file lookup.
      const isMemberCall = callee.type === 'MemberExpression'
      // A bare call `name()` whose name is a LOCAL binding — a parameter, or a
      // local var/const/let that is NOT itself a function — refers to that local
      // (a callback/value), not a module function. Don't cross-file-guess it.
      // (zod: `fn()` where `fn` is a callback parameter mis-linked to an
      // unrelated module `fn`.) babel's own scope analysis tells us this.
      if (!isMemberCall && callee.type === 'Identifier') {
        const b = path.scope.getBinding(name)
        if (b) {
          const initPath = b.path && b.path.get && b.path.get('init')
          const isFnLocal = (b.path && b.path.isFunctionDeclaration && b.path.isFunctionDeclaration())
            || (b.path && b.path.isClassDeclaration && b.path.isClassDeclaration())
            || (initPath && initPath.isFunction && initPath.isFunction())
          if (!isFnLocal && (b.kind === 'param' || b.kind === 'const' || b.kind === 'let' || b.kind === 'var')) return
        }
      }
      if (!target && index.resolveCall) {
        target = memberViaImport
          ? index.resolveCall(fileId, name, { importedOnly: true, memberCall: true })
          : index.resolveCall(fileId, name, { allowAny: !isMemberCall, memberCall: isMemberCall })
      }
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
