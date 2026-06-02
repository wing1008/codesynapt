// Tree-sitter symbol parsers — exact AST instead of regex.
// Reaches parity with codegraph for the supported languages.
//
// One generic walker; per-language config tells it which AST node types
// represent functions / classes / methods / calls, and what field gives
// the symbol name. Resolver is the same name-based lookup the other
// parsers use (file-mode imports get folded in later by Stage 3.5).
//
// Loaded lazily on first /symbol/scan after a project loads; per-
// language Parser instances are cached across scans.

'use strict'

const fs = require('fs')
const path = require('path')

let _Parser = null              // web-tree-sitter Parser class (after init)
let _initPromise = null

async function getParser() {
  if (_Parser) return _Parser
  if (!_initPromise) {
    _initPromise = (async () => {
      const Parser = require('web-tree-sitter')
      await Parser.init()
      _Parser = Parser
      return Parser
    })()
  }
  return _initPromise
}

const WASM_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out')
function wasmPath(name) { return path.join(WASM_DIR, `tree-sitter-${name}.wasm`) }

// Per-language config. Keys are CodeSynapt file extensions; value is
// the grammar wasm name + the AST node types we care about.
const LANG_CONFIG = {
  js:    { grammar: 'javascript' },
  jsx:   { grammar: 'javascript' },
  mjs:   { grammar: 'javascript' },
  cjs:   { grammar: 'javascript' },
  // TypeScript wasms aren't in tree-sitter-wasms@0.1.13; fall back to
  // the JS grammar (works for type annotations as stripped syntax).
  ts:    { grammar: 'javascript' },
  tsx:   { grammar: 'javascript' },
  py:    { grammar: 'python' },
  go:    { grammar: 'go' },
  rs:    { grammar: 'rust' },
  java:  { grammar: 'java' },
  kt:    { grammar: 'kotlin' },
  kts:   { grammar: 'kotlin' },
  swift: { grammar: 'swift' },
  // Phase B-3 — wider language reach. tree-sitter-wasms@0.1.13 ships
  // grammars for all of these; we just register them.
  cs:    { grammar: 'c_sharp' },
  rb:    { grammar: 'ruby' },
  php:   { grammar: 'php' },
  scala: { grammar: 'scala' },
  lua:   { grammar: 'lua' },
  sh:    { grammar: 'bash' },
  bash:  { grammar: 'bash' },
  dart:  { grammar: 'dart' },
  elm:   { grammar: 'elm' },
  ex:    { grammar: 'elixir' },
  exs:   { grammar: 'elixir' },
  c:     { grammar: 'c' },
  h:     { grammar: 'c' },
  cpp:   { grammar: 'cpp' },
  cc:    { grammar: 'cpp' },
  hpp:   { grammar: 'cpp' },
  hh:    { grammar: 'cpp' },
}

// Node types per grammar.
const NODE_TYPES = {
  javascript: {
    fn:     ['function_declaration', 'function', 'arrow_function', 'generator_function_declaration'],
    method: ['method_definition'],
    cls:    ['class_declaration'],
    call:   ['call_expression', 'new_expression'],
  },
  python: {
    fn:     ['function_definition'],
    cls:    ['class_definition'],
    call:   ['call'],
  },
  go: {
    fn:     ['function_declaration'],
    method: ['method_declaration'],
    // Use `type_spec` (the actual name+kind carrier), not its outer
    // `type_declaration` wrapper. nameOf() can't extract a name from
    // the wrapper (its only named child is the type_spec), so before
    // this change every Go file produced zero struct/interface symbols
    // and gin showed `byKind: { function: 1311 }` — no methods, no
    // structs.
    cls:    ['type_spec'],
    call:   ['call_expression'],
  },
  rust: {
    fn:     ['function_item'],
    cls:    ['struct_item', 'enum_item', 'trait_item'],
    impl:   ['impl_item'],
    call:   ['call_expression', 'macro_invocation'],
  },
  java: {
    fn:     ['method_declaration', 'constructor_declaration'],
    cls:    ['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'],
    call:   ['method_invocation', 'object_creation_expression'],
  },
  kotlin: {
    // Includes secondary constructors, property accessors (getter/setter
    // bodies), and anonymous-initializer bodies — all of which contain
    // call sites we were missing before.
    fn:     ['function_declaration', 'secondary_constructor',
             'getter', 'setter', 'anonymous_initializer'],
    cls:    ['class_declaration', 'object_declaration', 'interface_declaration'],
    call:   ['call_expression', 'infix_expression'],
  },
  swift: {
    // tree-sitter-swift already maps `extension X { ... }` to a
    // `class_declaration` node (with a `user_type` wrapper for the
    // target type), so we don't enroll extension_declaration
    // separately — it would double-count and break enclosing scopes.
    fn:     ['function_declaration', 'init_declaration', 'deinit_declaration',
             'subscript_declaration', 'computed_property'],
    cls:    ['class_declaration', 'protocol_declaration'],
    call:   ['call_expression'],
  },
  c_sharp: {
    fn:     ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    cls:    ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration'],
    call:   ['invocation_expression', 'object_creation_expression'],
  },
  ruby: {
    fn:     ['method', 'singleton_method'],
    cls:    ['class', 'module'],
    call:   ['call', 'method_call', 'identifier'],  // Ruby calls often look like identifiers
  },
  php: {
    fn:     ['function_definition', 'method_declaration'],
    cls:    ['class_declaration', 'interface_declaration', 'trait_declaration'],
    call:   ['function_call_expression', 'method_call_expression', 'object_creation_expression'],
  },
  scala: {
    fn:     ['function_definition', 'function_declaration'],
    cls:    ['class_definition', 'object_definition', 'trait_definition', 'enum_definition'],
    call:   ['call_expression', 'generic_function'],
  },
  lua: {
    fn:     ['function_declaration', 'function_definition', 'local_function'],
    cls:    [],  // Lua has no classes (table-based OOP)
    call:   ['function_call'],
  },
  bash: {
    fn:     ['function_definition'],
    cls:    [],
    call:   ['command'],
  },
  dart: {
    fn:     ['function_signature', 'function_body'],
    cls:    ['class_definition', 'mixin_declaration', 'extension_declaration'],
    call:   ['method_invocation'],
  },
  elm: {
    fn:     ['function_declaration_left'],
    cls:    ['type_declaration', 'type_alias_declaration'],
    call:   ['function_call_expr'],
  },
  elixir: {
    fn:     ['call'],  // Elixir uses macros for `def`
    cls:    [],
    call:   ['call'],
  },
  c: {
    fn:     ['function_definition'],
    cls:    ['struct_specifier', 'union_specifier', 'enum_specifier'],
    call:   ['call_expression'],
  },
  cpp: {
    fn:     ['function_definition', 'declaration'],
    cls:    ['class_specifier', 'struct_specifier'],
    call:   ['call_expression'],
  },
}

// Cache: grammar name → loaded Parser.Language (web-tree-sitter)
const _langCache = new Map()
async function loadLang(grammar) {
  if (_langCache.has(grammar)) return _langCache.get(grammar)
  const Parser = await getParser()
  const buf = fs.readFileSync(wasmPath(grammar))
  const Lang = await Parser.Language.load(buf)
  _langCache.set(grammar, Lang)
  return Lang
}

// Cache: grammar name → Parser instance (Parser instances are stateful
// but cheap to reuse since we always call setLanguage anyway).
const _parserCache = new Map()
async function parserFor(grammar) {
  if (_parserCache.has(grammar)) return _parserCache.get(grammar)
  const Parser = await getParser()
  const p = new Parser()
  p.setLanguage(await loadLang(grammar))
  _parserCache.set(grammar, p)
  return p
}

function mkId(file, name, line) { return `${file}#${name}@${line}` }

function nameOf(node) {
  // Try standard field first (Go, JS, Java have it). Kotlin & Swift
  // function_declaration doesn't expose a `name` field — the function
  // identifier lands as a direct `simple_identifier` child instead,
  // so we walk children for any identifier-shaped node as a fallback.
  // For Swift `extension X { … }` the type lands inside `user_type`
  // (a one-level wrapper around `type_identifier`); we peek through.
  const named = node.childForFieldName?.('name')
  if (named) return named.text
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c.type === 'identifier'
     || c.type === 'simple_identifier'
     || c.type === 'type_identifier'
     || c.type === 'field_identifier'
     || c.type === 'property_identifier') return c.text
    if (c.type === 'user_type') {
      // user_type → type_identifier (Swift extension's target type).
      for (let j = 0; j < c.childCount; j++) {
        const g = c.child(j)
        if (g.type === 'type_identifier' || g.type === 'simple_identifier') return g.text
      }
    }
  }
  return null
}

function signatureOf(node, content, maxLen = 200) {
  if (!node) return ''
  const start = node.startIndex ?? 0
  let end = content.indexOf('{', start)
  if (end < 0 || end - start > maxLen) end = start + maxLen
  return content.slice(start, end).trim().replace(/\s+/g, ' ')
}

function docOf(node, content) {
  // Walk backwards through siblings; collect line comments / block
  // comments directly above `node`.
  let prev = node.previousSibling
  const blocks = []
  while (prev && (prev.type === 'comment' || prev.type === 'line_comment' || prev.type === 'block_comment')) {
    blocks.unshift(prev.text)
    prev = prev.previousSibling
  }
  if (!blocks.length) return ''
  return blocks.join(' ').replace(/^\s*[/*#]+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 400)
}

// Generic walker. Tracks the enclosing class/impl for method
// qualification and the enclosing function for call attribution.
function walk(node, ctx) {
  if (!node) return
  const t = node.type
  const cfg = ctx.types
  let pushedFn = false, pushedCls = false, pushedImpl = false

  // Class-like declarations
  if (cfg.cls?.includes(t)) {
    const name = nameOf(node)
    if (name) {
      const sym = {
        id: mkId(ctx.fileId, name, node.startPosition.row + 1),
        name,
        qualifiedName: name,
        kind: classKind(t, node),
        file: ctx.fileId,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: signatureOf(node, ctx.content),
        doc: docOf(node, ctx.content),
        exported: isExported(node, ctx.content),
      }
      ctx.symbols.push(sym)
      ctx.classStack.push({ name, sym })
      pushedCls = true
      // Inheritance edges (pass 2 only — we need every symbol indexed
      // first before we can resolve the parent name).
      if (ctx.passTwo) {
        const supers = extractInheritance(node, ctx.lang)
        for (const { name: parentName, kind } of supers) {
          const target = ctx.resolve(parentName, { forCall: true })
          if (!target || target.id === sym.id) continue
          const key = sym.id + '|' + target.id + '|' + kind
          if (ctx.seen.has(key)) continue
          ctx.seen.add(key)
          ctx.edges.push({
            source: sym.id, target: target.id, kind,
            line: node.startPosition.row + 1,
          })
        }
      }
    }
  }
  // Rust impl blocks — track the target type so methods get qualified
  else if (cfg.impl?.includes(t)) {
    const targetType = node.childForFieldName?.('type')?.text
                    || node.children.find((c) => c.type === 'type_identifier')?.text
    if (targetType) {
      ctx.classStack.push({ name: targetType, sym: null })
      pushedImpl = true
    }
  }
  // Function/method declarations
  else if (cfg.fn?.includes(t) || cfg.method?.includes(t)) {
    const name = nameOf(node)
    if (name) {
      // Go methods carry their receiver type in a `receiver` field
      // rather than being lexically nested inside the type — without
      // this, `func (e *Engine) handleHTTPRequest()` shows up as a
      // bare function with no link back to Engine.
      let methodOwner = null
      if (ctx.lang === 'go' && cfg.method?.includes(t)) {
        methodOwner = extractGoReceiver(node)
      }
      const cls = ctx.classStack[ctx.classStack.length - 1]
      const lexicallyMethod = !!cls && (cfg.method?.includes(t)
        || ctx.lang === 'python' || ctx.lang === 'kotlin'
        || ctx.lang === 'swift'  || ctx.lang === 'rust')
      const isMethod = !!methodOwner || lexicallyMethod
      const qn = methodOwner ? `${methodOwner}.${name}`
                 : (lexicallyMethod ? `${cls.name}.${name}` : name)
      const sym = {
        id: mkId(ctx.fileId, qn, node.startPosition.row + 1),
        name,
        qualifiedName: qn,
        kind: isMethod ? 'method' : 'function',
        file: ctx.fileId,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: signatureOf(node, ctx.content),
        doc: docOf(node, ctx.content),
        exported: isExported(node, ctx.content),
      }
      ctx.symbols.push(sym)
      ctx.fnStack.push(sym.id)
      pushedFn = true
    }
  }
  // Call expressions (pass 2 only — checked via ctx.passTwo flag)
  if (ctx.passTwo && cfg.call?.includes(t)) {
    const src = ctx.fnStack[ctx.fnStack.length - 1]
    if (src) {
      const calleeName = extractCalleeName(node)
      if (calleeName && !ctx.kwSet?.has(calleeName)) {
        // Use the loose any-file fallback for calls (`foo()` is a
        // strong signal); references below stay strict.
        const target = ctx.resolve(calleeName, { forCall: true })
        if (target && target.id !== src) {
          const key = src + '|' + target.id + '|call'
          if (!ctx.seen.has(key)) {
            ctx.seen.add(key)
            ctx.edges.push({
              source: src, target: target.id, kind: 'call',
              line: node.startPosition.row + 1,
            })
          }
        }
      }
    }
  }
  // Plain identifier references (Phase 2-extra). Type identifiers
  // get a separate `type-ref` kind so explore can prefer `call`/`ref`
  // when picking entry points and type annotations don't dominate
  // the edge count.
  if (ctx.passTwo
      && (t === 'identifier' || t === 'simple_identifier' || t === 'type_identifier' || t === 'field_identifier')) {
    const src = ctx.fnStack[ctx.fnStack.length - 1]
    if (src) {
      const name = node.text
      if (name && !ctx.kwSet?.has(name) && name.length > 1) {
        // Skip if parent is a declaration node that owns this identifier
        const parent = node.parent
        const isDeclaration =
          parent && (
            cfg.fn?.includes(parent.type) ||
            cfg.method?.includes(parent.type) ||
            cfg.cls?.includes(parent.type) ||
            parent.type === 'parameter' ||
            parent.type === 'function_value_parameters' ||
            parent.type === 'value_definition' ||
            parent.type === 'simple_value_definition'
          )
        // Skip if parent is a call_expression and we're the callee
        const isCallee = parent && cfg.call?.includes(parent.type)
        if (!isDeclaration && !isCallee) {
          const target = ctx.resolve(name)
          if (target && target.id !== src) {
            const edgeKind = t === 'type_identifier' ? 'type-ref' : 'ref'
            const key = src + '|' + target.id + '|' + edgeKind
            if (!ctx.seen.has(key)) {
              ctx.seen.add(key)
              ctx.edges.push({
                source: src, target: target.id, kind: edgeKind,
                line: node.startPosition.row + 1,
              })
            }
          }
        }
      }
    }
  }

  // Recurse
  for (let i = 0; i < node.childCount; i++) walk(node.child(i), ctx)

  if (pushedFn) ctx.fnStack.pop()
  if (pushedCls || pushedImpl) ctx.classStack.pop()
}

// Pull inheritance targets from a class-like node. Per-language node
// names vary; this is best-effort and silently skips unknown shapes.
// Returns [{ name: 'Bar', kind: 'extends' | 'implements' }].
function extractInheritance(node, lang) {
  const out = []
  const walkType = (n) => {
    if (!n) return null
    if (n.type === 'type_identifier' || n.type === 'identifier' || n.type === 'simple_identifier') return n.text
    // Member / qualified — take last identifier
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const r = walkType(n.namedChild(i))
      if (r) return r
    }
    return null
  }
  // Standard fields when grammars expose them
  const superField = node.childForFieldName?.('superclass')
                  || node.childForFieldName?.('parent_class')
  if (superField) {
    const name = walkType(superField)
    if (name) out.push({ name, kind: 'extends' })
  }
  // Walk named children for inheritance-related sub-nodes.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    const ct = c.type
    if (ct === 'superclass' || ct === 'extends_type_clause' || ct === 'class_inheritance_modifiers') {
      const name = walkType(c)
      if (name) out.push({ name, kind: 'extends' })
    } else if (ct === 'super_interfaces' || ct === 'implements_clause' || ct === 'super_interface_specification') {
      // Java/Kotlin — may contain multiple type_identifier children
      for (let j = 0; j < c.namedChildCount; j++) {
        const name = walkType(c.namedChild(j))
        if (name) out.push({ name, kind: 'implements' })
      }
    } else if (ct === 'inheritance_specifier') {
      // Swift — single base type or protocol
      const name = walkType(c)
      if (name) out.push({ name, kind: 'extends' })
    } else if (ct === 'argument_list' && lang === 'python') {
      // Python `class Foo(Bar, Baz):` — base classes as `argument_list`
      for (let j = 0; j < c.namedChildCount; j++) {
        const name = walkType(c.namedChild(j))
        if (name) out.push({ name, kind: 'extends' })
      }
    } else if (ct === 'type_spec_list' && lang === 'go') {
      // Go interface embedding: `type Foo interface { Bar }`
      for (let j = 0; j < c.namedChildCount; j++) {
        const name = walkType(c.namedChild(j))
        if (name) out.push({ name, kind: 'extends' })
      }
    }
  }
  return out
}

// Walk a Go method_declaration's `receiver` field to find the type
// the method hangs off of. Receivers look like `(e *Engine)` or
// `(c Context)`; the type can be wrapped in a `pointer_type`.
function extractGoReceiver(node) {
  const recv = node.childForFieldName?.('receiver')
  if (!recv) return null
  function findType(n) {
    if (!n) return null
    if (n.type === 'type_identifier') return n.text
    for (let i = 0; i < n.namedChildCount; i++) {
      const r = findType(n.namedChild(i))
      if (r) return r
    }
    return null
  }
  return findType(recv)
}

function classKind(nodeType, node = null) {
  if (nodeType.includes('interface')) return 'interface'
  if (nodeType.includes('trait'))     return 'interface'
  if (nodeType.includes('protocol'))  return 'interface'
  if (nodeType.includes('struct'))    return 'struct'
  if (nodeType.includes('enum'))      return 'enum'
  if (nodeType.includes('record'))    return 'class'
  // Go `type_spec` wraps the actual struct_type / interface_type /
  // map_type / etc — descend one level to recover the real kind.
  // Without this, every `type Foo struct {…}` shows up as kind:'class'.
  if (nodeType === 'type_spec' && node) {
    for (let i = 0; i < node.childCount; i++) {
      const ct = node.child(i).type
      if (ct === 'struct_type')    return 'struct'
      if (ct === 'interface_type') return 'interface'
    }
    return 'class'
  }
  return 'class'
}

function isExported(node, content) {
  // Heuristic: any leading 'pub', 'public', 'export' keyword in the
  // first ~120 chars of the node's text. Good enough across languages.
  const head = content.slice(node.startIndex, Math.min(node.startIndex + 120, node.endIndex))
  if (/\b(pub|public|export|open)\b/.test(head)) return true
  // Go: PascalCase identifiers are exported.
  const m = head.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (m && /^[A-Z]/.test(m[1])) return true
  return false
}

// Identifier-shaped node names across grammars.
const IDENT_TYPES = new Set([
  'identifier', 'simple_identifier', 'field_identifier', 'type_identifier',
  'property_identifier', 'shorthand_property_identifier',
])
const NAV_TYPES = new Set([
  'member_expression', 'selector_expression', 'field_expression',
  'navigation_expression', 'method_invocation',
])

function lastIdentText(node) {
  // Walk to the rightmost identifier-ish node — `foo.bar.baz` → "baz".
  if (!node) return null
  if (IDENT_TYPES.has(node.type)) return node.text
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const t = lastIdentText(node.namedChild(i))
    if (t) return t
  }
  return null
}

function extractCalleeName(callNode) {
  // 1) Try named fields first — Java has `name`, JS has `function`,
  //    Python/Ruby have `function`. These are the cleanest path when
  //    the grammar provides them.
  const fn = callNode.childForFieldName?.('function')
          || callNode.childForFieldName?.('name')
  if (fn) {
    if (IDENT_TYPES.has(fn.type)) return fn.text
    if (NAV_TYPES.has(fn.type)) return lastIdentText(fn)
  }
  // 2) Java method_invocation: object.name(args) — `name` is a direct
  //    field even when `function` isn't set.
  const j = callNode.childForFieldName?.('name')
  if (j && IDENT_TYPES.has(j.type)) return j.text
  // 3) Fallback — Swift/Kotlin call_expression has no field but its
  //    first named child is the callee (simple_identifier or
  //    navigation_expression). Walk all named children once.
  for (let i = 0; i < callNode.namedChildCount; i++) {
    const c = callNode.namedChild(i)
    if (IDENT_TYPES.has(c.type)) return c.text
    if (NAV_TYPES.has(c.type)) return lastIdentText(c)
  }
  return null
}

// Keywords to skip when matching call expressions.
const KEYWORDS = {
  javascript: new Set(['if','else','for','while','return','new','typeof','instanceof','await','async','function','class','const','let','var','true','false','null','undefined','console','require','import','export']),
  python:     new Set(['if','elif','else','while','for','return','def','class','import','from','None','True','False','self','print','len','range','int','str','float','bool','list','dict','set','tuple','isinstance','type','super','open','sorted','enumerate','zip','map','filter','any','all','sum','min','max','abs','round','getattr','setattr','hasattr','format','repr','hash','id','object','property','staticmethod','classmethod']),
  go:         new Set(['if','else','for','range','return','break','continue','switch','case','func','type','var','const','package','import','interface','struct','map','chan','make','new','len','cap','append','copy','delete','panic','recover','close','true','false','nil','print','println']),
  rust:       new Set(['fn','let','mut','if','else','while','for','loop','match','return','break','continue','use','mod','pub','crate','self','super','impl','trait','struct','enum','type','as','where','async','await','dyn','ref','move','Some','None','Ok','Err','true','false','unsafe','extern','static','const','Box','Vec','String','format!','println!','print!','vec!']),
  java:       new Set(['if','else','while','for','do','switch','case','break','continue','return','new','this','super','try','catch','finally','throw','throws','class','interface','enum','extends','implements','public','private','protected','static','final','abstract','synchronized','void','int','long','short','byte','char','boolean','float','double','String','true','false','null','import','package','var']),
  kotlin:     new Set(['if','else','for','while','do','when','return','break','continue','fun','val','var','class','object','interface','enum','sealed','data','companion','public','private','internal','protected','open','final','abstract','override','suspend','inline','crossinline','noinline','this','super','it','true','false','null']),
  swift:      new Set(['if','else','for','in','while','repeat','do','switch','case','break','continue','return','throw','throws','try','catch','rethrows','defer','guard','where','as','is','let','var','func','class','struct','enum','protocol','extension','import','self','super','init','deinit','static','final','public','private','internal','open','fileprivate','true','false','nil','some','any','Self','Optional','print','String','Int','Bool','Double','Float','Array','Dictionary']),
}

function makeResolver(fileId, index) {
  // Two modes. `forCall=true` permits the loose "any same-named
  // symbol" fallback — the `foo()` syntax is a strong-enough hint
  // that the name is a real call target, and skipping the fallback
  // misses too many cross-file calls. `forCall=false` (default,
  // for plain identifier references) stays strict — same file or
  // a file the caller actually imports — so local variables that
  // happen to share a name with some unrelated function elsewhere
  // don't produce a noise edge.
  return function resolve(name, { forCall = false } = {}) {
    return index.resolveCall
      ? index.resolveCall(fileId, name, { allowAny: forCall })
      : null
  }
}

// Public per-extension wrapper used by symbol-graph's parser registry.
function makeParser(ext) {
  const cfg = LANG_CONFIG[ext]
  if (!cfg) return null
  const lang = cfg.grammar
  const types = NODE_TYPES[lang]
  const kwSet = KEYWORDS[lang]

  return {
    async extractSymbolsAsync(content, fileId) {
      try {
        const parser = await parserFor(lang)
        const tree = parser.parse(content)
        const ctx = {
          fileId, content, types, lang,
          symbols: [], classStack: [], fnStack: [],
          passTwo: false,
        }
        walk(tree.rootNode, ctx)
        tree.delete?.()
        return ctx.symbols
      } catch (e) { return [] }
    },
    async extractReferencesAsync(content, fileId, index) {
      try {
        const parser = await parserFor(lang)
        const tree = parser.parse(content)
        const ctx = {
          fileId, content, types, lang,
          symbols: [], classStack: [], fnStack: [],
          edges: [], seen: new Set(),
          kwSet,
          resolve: makeResolver(fileId, index),
          passTwo: true,
        }
        walk(tree.rootNode, ctx)
        tree.delete?.()
        return ctx.edges
      } catch (e) { return [] }
    },
    // Sync stubs — registry expects sync extractSymbols/extractReferences
    // but SymbolGraph.build() can also await them since it's already async.
    extractSymbols(content, fileId) { return this.extractSymbolsAsync(content, fileId) },
    extractReferences(content, fileId, index) { return this.extractReferencesAsync(content, fileId, index) },
  }
}

// Probe which grammars actually ship in tree-sitter-wasms (some are
// optional). Returns the list of extensions whose wasm exists.
function availableExtensions() {
  const out = []
  for (const ext of Object.keys(LANG_CONFIG)) {
    const grammar = LANG_CONFIG[ext].grammar
    if (fs.existsSync(wasmPath(grammar))) out.push(ext)
  }
  return out
}

module.exports = { makeParser, availableExtensions, LANG_CONFIG }
