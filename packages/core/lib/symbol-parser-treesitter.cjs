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

// Resolve the grammar wasm dir via Node's module resolution so it works from
// ANY install layout — a hoisted npm install puts tree-sitter-wasms many levels
// away from this file, and the old hard-coded '../../../node_modules' path only
// existed in the dev repo. (insp-004: that path silently disabled Layer-2 for
// every tree-sitter language — Python/Java/C#/… — in every npm install while
// coverage still claimed 100%.) Fallback to the repo-relative path so a
// non-node resolver (or a stripped install) degrades to the old behavior rather
// than throwing at module load.
const WASM_DIR = (() => {
  try {
    return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out')
  } catch {
    return path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out')
  }
})()
function wasmPath(name) { return path.join(WASM_DIR, `tree-sitter-${name}.wasm`) }

// Per-language config. Keys are CodeSynapt file extensions; value is
// the grammar wasm name + the AST node types we care about.
const LANG_CONFIG = {
  js:    { grammar: 'javascript' },
  jsx:   { grammar: 'javascript' },
  mjs:   { grammar: 'javascript' },
  cjs:   { grammar: 'javascript' },
  // tree-sitter-wasms@0.1.13 DOES ship tree-sitter-typescript.wasm /
  // tree-sitter-tsx.wasm. We deliberately route ts/tsx to the babel parser
  // (registered in symbol-parsers.cjs) instead — babel is the oracle-validated
  // path and handles interfaces/types/generics/receiver-type inference. The
  // 'javascript' grammar mapping here is only a tree-sitter fallback and is not
  // used for ts/tsx in practice (babel wins the registry).
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
  // REMOVED (2026-06-08 phantom-config audit) — these were advertised in config
  // but never scanned/registered, AND verified non-functional when actually
  // parsed:
  //   • elm  → tree-sitter-elm.wasm ABI mismatch (language version 12, runtime
  //            needs 13–14) — throws, 0 symbols.
  //   • ex/exs (elixir) → def/call share one `call` node, so the macro keywords
  //            `defmodule`/`def` are themselves extracted as bogus "functions"
  //            and real defs duplicate; needs special-casing we don't have.
  //   • hh (Hack) → no tree-sitter-hack grammar exists; routing to the C++
  //            grammar misparses `<?hh`, async/Awaitable<T>, $vars — emits
  //            phantom symbols (`public`, mislabeled class) and drops methods.
  c:     { grammar: 'c' },
  h:     { grammar: 'c' },
  cpp:   { grammar: 'cpp' },
  cc:    { grammar: 'cpp' },
  hpp:   { grammar: 'cpp' },
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
    call:   ['function_call_expression', 'member_call_expression', 'object_creation_expression'],
  },
  scala: {
    fn:     ['function_definition', 'function_declaration'],
    cls:    ['class_definition', 'object_definition', 'trait_definition', 'enum_definition'],
    call:   ['call_expression', 'generic_function'],
  },
  lua: {
    // Real tree-sitter-lua node names (the previous ones never matched, so
    // every Lua file produced 0 symbols).
    fn:     ['function_definition_statement', 'local_function_definition_statement'],
    cls:    [],  // Lua has no classes (table-based OOP)
    call:   ['call'],
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
    // Dropped 'declaration' — `Calculator c;` is a declaration node and was
    // creating phantom function symbols. Names come via the declarator chain
    // (see nameOf).
    fn:     ['function_definition'],
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
// NB (2026-06-11): do NOT "simplify" this into one shared Parser with
// setLanguage switching — that corrupts even SINGLE-language extraction on
// web-tree-sitter 0.20.x (lua call edges inverted into refs). The separate
// cross-grammar corruption (scala-then-lua truncation, same wasm-era bug
// class) is tracked in BACKLOG; the fix path is upgrading the
// web-tree-sitter + tree-sitter-wasms pair together (ABI-coupled).
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
  // C / C++ function_definition: the name is buried in the declarator chain
  // (function_definition → function_declarator → identifier), possibly wrapped
  // in pointer_/reference_declarator or a qualified_identifier (C++ Foo::bar).
  // Without this every C/C++ function got a null name and was dropped.
  if (node.type === 'function_definition') {
    let d = node.childForFieldName?.('declarator'); let guard = 0
    while (d && guard++ < 8) {
      if (d.type === 'identifier' || d.type === 'field_identifier') return d.text
      if (d.type === 'qualified_identifier') return d.childForFieldName?.('name')?.text || lastIdentText(d)
      d = d.childForFieldName?.('declarator') || null
    }
  }
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
      const propTypes = new Map()
      if (ctx.passTwo && ctx.lang === 'python') harvestPyClassProps(node, propTypes, ctx)
      // bases: the declared parent names, kept on the stack entry so
      // `super().method()` can resolve to the base statically (Python first
      // base = the MRO next class for the common case).
      const supers = ctx.passTwo ? extractInheritance(node, ctx.lang) : []
      ctx.classStack.push({ name, sym, propTypes, bases: supers.map((s) => s.name) })
      pushedCls = true
      // Inheritance edges (pass 2 only — we need every symbol indexed
      // first before we can resolve the parent name).
      if (ctx.passTwo) {
        for (const { name: parentName, kind } of supers) {
          // DOTTED parents (`nn.Module`) must resolve by EXACT qualified name
          // only: the plain resolve path degrades a qualified miss to the bare
          // tail ('Module'), which linked external bases to any same-named
          // LOCAL class — a phantom extends edge that then poisoned the MRO
          // walk into a confident wrong call (reproduced: `net.helper()` →
          // decoy Module.helper). A dotted name that misses → NO edge.
          const target = parentName.includes('.')
            ? (ctx.resolveQualified ? ctx.resolveQualified(parentName) : null)
            : ctx.resolve(parentName, { forCall: true })
          if (!target || target.id === sym.id) continue
          const key = sym.id + '|' + target.id + '|' + kind
          if (ctx.seen.has(key)) continue
          ctx.seen.add(key)
          const edge = { source: sym.id, target: target.id, kind, line: node.startPosition.row + 1 }
          ctx.edges.push(edge)
          // Populate extendsOut NOW so inherited calls in this pass can MRO-walk
          // (dedup in addEdge makes build's later re-add a no-op).
          ctx.index?.addEdge?.(edge)
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
      // A function-like declaration lexically inside a class IS a method — give
      // it a `Class.method` qualifiedName so a call `obj.method()` can resolve
      // to it. Covers every language whose methods nest in the class body
      // (Java/C#/C++/Kotlin/Swift/Rust/Python); Go carries the owner explicitly
      // via the receiver (methodOwner above) instead of lexical nesting.
      const lexicallyMethod = !!cls && (cfg.method?.includes(t) || cfg.fn?.includes(t))
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
      // Declared return type — `def f() -> Foo:` — lets `x = f(); x.m()` and
      // `f().m()` resolve to `Foo.m` (return-type inference). Python only.
      if (ctx.lang === 'python') {
        const rt = pyTypeName(node.childForFieldName?.('return_type'))
        if (rt) sym.returnType = rt
      } else if (ctx.lang === 'go') {
        // `func NewEngine() *Engine` → returnType Engine, so `s := NewEngine()`
        // then `s.Method()` resolves. Multiple returns (a parameter_list) yield
        // null and are skipped.
        const rt = goTypeName(node.childForFieldName?.('result'))
        if (rt) sym.returnType = rt
      }
      ctx.symbols.push(sym)
      ctx.fnStack.push(sym.id)
      if (ctx.varTypeStack) {
        const vmap = new Map()
        if (ctx.passTwo && ctx.lang === 'python') harvestPyFuncTypes(node, vmap, ctx)
        else if (ctx.passTwo && ctx.lang === 'go') goHarvestFuncTypes(node, vmap, ctx)
        else if (ctx.passTwo && RECV_OF[ctx.lang]) genericHarvest(node, vmap, ctx)
        ctx.varTypeStack.push(vmap)
      }
      pushedFn = true
    }
  }
  // Imported-name harvest (pass 2): names brought in by import statements.
  // Used to tell an EXTERNAL bare call (`from x import load; load()` — not a
  // dynamic site, just an external dependency) apart from a genuinely-unknown
  // bare call (function-valued local/param — a real dynamic site). Python
  // grammar: import_from_statement / import_statement with optional aliases.
  if (ctx.passTwo && ctx.importedNames
      && (t === 'import_from_statement' || t === 'import_statement')) {
    const collect = (n) => {
      if (!n) return
      if (n.type === 'dotted_name') { const last = n.namedChild(n.namedChildCount - 1); if (last) ctx.importedNames.add(last.text) }
      else if (n.type === 'aliased_import') { const a = n.childForFieldName?.('alias'); if (a) ctx.importedNames.add(a.text); else collect(n.namedChild(0)) }
      else if (IDENT_TYPES.has(n.type)) ctx.importedNames.add(n.text)
    }
    for (let i = 0; i < node.namedChildCount; i++) collect(node.namedChild(i))
  }
  // Rust `use a::b::{c, d as e};` / PHP `use Ns\Fn;` — harvest every identifier
  // leaf (over-collection is harmless: it only suppresses ledger entries for
  // names that ARE imports, i.e. external calls, not dynamic sites).
  if (ctx.passTwo && ctx.importedNames
      && (t === 'use_declaration' || t === 'namespace_use_declaration')) {
    const collectLeaves = (n, d) => {
      if (!n || d > 6) return
      if (n.namedChildCount === 0) { if (IDENT_TYPES.has(n.type)) ctx.importedNames.add(n.text); return }
      for (let i = 0; i < n.namedChildCount; i++) collectLeaves(n.namedChild(i), d + 1)
    }
    collectLeaves(node, 0)
  }
  // Call expressions (pass 2 only — checked via ctx.passTwo flag)
  if (ctx.passTwo && cfg.call?.includes(t)) {
    const src = ctx.fnStack[ctx.fnStack.length - 1]
    if (src) {
      const calleeName = extractCalleeName(node)
      // Statically-unnameable callee — subscript `arr[i]()`, call-result
      // `getattr(o, n)()`, etc. Previously a SILENT drop; record it so the
      // graph admits the enclosing symbol has a dynamic call site (zero-silence).
      if (!calleeName && ctx.index?.recordDynamicSite) {
        ctx.index.recordDynamicSite(src, node.startPosition.row + 1, 'indirect')
      }
      if (calleeName && !ctx.kwSet?.has(calleeName)) {
        let target = null
        // Type-aware member resolution. When the receiver's class is known —
        // `self`/`cls` (current class), `self.attr` (class property type), or a
        // typed/constructed local var — resolve `Class.method` first. This is
        // exact (qualifiedOnly), so a method name shared across classes still
        // links and is never mis-guessed; unknown receivers fall through to the
        // bare fallback. Recovers real `self.repo.save()`-style edges the
        // untyped path declines.
        let superUnresolved = false
        let typedMiss = false   // receiver type KNOWN but Type.method missing
        if (ctx.lang === 'python' && ctx.resolveQualified) {
          const rc = pyReceiverType(node, ctx)
          if (rc) { target = ctx.resolveQualified(`${rc}.${calleeName}`); if (!target) typedMiss = true }
          // `super().m()` that did NOT resolve (external base like nn.Module,
          // or base extraction missed): the target is the base's m and NOTHING
          // else — the bare fallback and the candidate spray can only produce
          // wrong answers (sibling classes' same-named methods). Suppress both
          // and decline with an explicit reason instead.
          if (!target && pyIsSuperCall(node)) superUnresolved = true
        } else if (ctx.lang === 'go' && ctx.resolveQualified) {
          const rc = goReceiverType(node, ctx)
          if (rc) { target = ctx.resolveQualified(`${rc}.${calleeName}`); if (!target) typedMiss = true }
        } else if (RECV_OF[ctx.lang] && ctx.resolveQualified) {
          const rc = genericReceiverType(node, ctx)
          if (rc) { target = ctx.resolveQualified(`${rc}.${calleeName}`); if (!target) typedMiss = true }
          // `super.m()` / `base.M()` that did not resolve (external/unresolved
          // parent): the target is the parent's m and NOTHING else — suppress
          // the bare fallback and the candidate spray (mirrors Python super()).
          if (!target && isSuperBaseReceiver(node, ctx.lang)) superUnresolved = true
        }
        // Implicit-this bare call: in Java/C#/Kotlin/Swift/Scala/C++ a bare
        // `save()` inside a method means `this.save()` — resolve it to the
        // enclosing class's method (incl. inherited, via the qualified MRO walk).
        // NOT for Python/Rust/Go/PHP/JS, where same-class calls are explicit
        // self/this and a bare name is a free function (the bare-call-method-skip
        // guard depends on that — see flask `dumps()`).
        if (!target && ctx.resolveQualified && IMPLICIT_THIS_LANGS.has(ctx.lang) && !isMemberCallNode(node)) {
          const cls = ctx.classStack[ctx.classStack.length - 1]
          if (cls) target = ctx.resolveQualified(`${cls.name}.${calleeName}`)
        }
        // Else: fallback. A bare `foo()` allows the cross-file unique-production
        // guess; an untyped `obj.method()` does NOT (unknown receiver → that
        // guess is a phantom), so member calls resolve same-file/imported only
        // + reject builtin method names. Matches the babel parser, precision-
        // first. Typed members were already resolved above (Python qualified).
        if (!target && !superUnresolved) {
          const member = isMemberCallNode(node)
          // Typed-receiver MISS must not degrade a MEMBER call to the bare-name
          // path: "type known, method not found" grabbing a same-file/imported
          // same-named method is exactly the babel B-2 phantom class
          // (reproduced here: `net: Net; net.helper()` confidently linked to a
          // decoy class's helper). Candidates below still surface the honest
          // "could be one of these" set.
          // Rust: an untyped MEMBER call (`x.method()` / `Vec::with`) whose
          // receiver type we couldn't resolve is almost always a std-library
          // method (the std surface is huge — iter/to_owned/unwrap/with_capacity
          // /…), and bare-resolving it grabs a coincidentally same-named user
          // method (measured: `slice.iter()` -> `Map.iter`, `s.to_owned()` ->
          // `RawValue.to_owned`). Refuse — typed receivers already resolved
          // above via the qualified path. Bare FUNCTION calls `foo()` still
          // resolve (member=false).
          if (typedMiss && member) { /* no bare degrade for typed misses (see comment above) */ }
          else if (ctx.lang === 'rust' && member) { /* no bare-fallback for untyped Rust member calls */ }
          else target = ctx.resolve(calleeName, { forCall: !member, memberCall: member })
        }
        if (target && target.id !== src) {
          const key = src + '|' + target.id + '|call'
          if (!ctx.seen.has(key)) {
            ctx.seen.add(key)
            ctx.edges.push({
              source: src, target: target.id, kind: 'call',
              line: node.startPosition.row + 1,
            })
          }
        } else if (superUnresolved) {
          // Honest decline — counted, never silently dropped, and NO candidate
          // spray (the real target — the external/unresolved base's method — is
          // not among any user-code candidates, so a spray would violate the
          // "real target is among these" guarantee).
          ctx.index?._decline?.('super-external', calleeName, ctx.fileId)
        } else if (!target && ctx.candidates) {
          // Dynamic candidate leg: no single static target → expose the maximal
          // honest candidate set as isolated `call-candidate` edges (not in the
          // confident call graph). resolveCall declined to assert one; this keeps
          // the real target visible as a "could be" instead of blank.
          const member = isMemberCallNode(node)
          const { candidates, capped } = ctx.candidates(calleeName, { memberCall: member })
          const ln = node.startPosition.row + 1
          // Zero-silence: a BARE call whose name resolves to NOTHING anywhere
          // (no symbol, no candidate) was previously fully silent — not even a
          // decline (the byName miss short-circuits). For tree-sitter languages
          // (no scope analysis) that bare-unknown class is dominated by
          // function-valued locals/params (`cb()`, Go `fns[k]()` mis-grammared
          // as a generic call) — record it. Member calls are excluded: they are
          // overwhelmingly external library calls and would flood the ledger.
          if (!member && candidates.length === 0 && ctx.index?.recordDynamicSite
              && !(ctx.importedNames && ctx.importedNames.has(calleeName))) {
            // Imported-but-unresolved names are EXTERNAL calls, not dynamic
            // sites — recording them floods the ledger (measured: 913 of 936
            // on one ML repo) and cries wolf. Only genuinely-unknown bare
            // names (function-valued locals/params) are recorded.
            ctx.index.recordDynamicSite(src, ln, 'unresolved-name')
          }
          for (const c of candidates) {
            if (c.id === src) continue
            const key = src + '|' + c.id + '|call-candidate'
            if (ctx.seen.has(key)) continue
            ctx.seen.add(key)
            ctx.edges.push({ source: src, target: c.id, kind: 'call-candidate', line: ln, candidate: true, ambiguity: candidates.length, capped: capped || undefined })
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
            parent.type === 'simple_value_definition' ||
            // C/C++ the function's own name sits in the declarator chain, not
            // directly under function_definition — without this the name token
            // emitted a phantom self/same-name ref edge.
            parent.type === 'function_declarator'
          )
        // Skip if parent is a call_expression and we're the callee, OR a
        // member/navigation access (`u.save` — the `save` property is resolved
        // by the call pass, not a free reference to a same-named function;
        // otherwise it emits a phantom ref edge).
        const isCallee = parent && (cfg.call?.includes(parent.type) || NAV_TYPES.has(parent.type))
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

  if (pushedFn) { ctx.fnStack.pop(); if (ctx.varTypeStack) ctx.varTypeStack.pop() }
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
    } else if (ct === 'delegation_specifier') {
      // Kotlin — `class Alpha : Greeter` (one specifier per parent; a
      // constructor-invocation parent wraps the type one level deeper, which
      // walkType already unwraps). Without this Kotlin had NO inheritance
      // edges at all — interface dispatch candidates never fired.
      const name = walkType(c)
      if (name) out.push({ name, kind: 'implements' })
    } else if (ct === 'base_list') {
      // C# — `class Alpha : Base, IGreeter` puts everything in one base_list;
      // class-vs-interface is not syntactically distinguishable. Label the
      // first entry extends and the rest implements (C# allows one base class,
      // listed first). The graph indexes both kinds identically (extendsOut),
      // so the label only affects display, never resolution/dispatch.
      let first = true
      for (let j = 0; j < c.namedChildCount; j++) {
        const name = walkType(c.namedChild(j))
        if (name) { out.push({ name, kind: first ? 'extends' : 'implements' }); first = false }
      }
    } else if (ct === 'argument_list' && lang === 'python') {
      // Python `class Foo(Bar, Baz):` — base classes as `argument_list`.
      // DOTTED bases (`nn.Module`) keep their FULL text: collapsing to the
      // last segment ('Module') made super().__init__() resolve CONFIDENTLY
      // to any same-named USER class — a reproduced phantom edge (violates
      // the "no wrong edges" rule). The full dotted name never matches a
      // local qualifiedName, so super() on an external base now takes the
      // honest `super-external` decline path instead.
      for (let j = 0; j < c.namedChildCount; j++) {
        const child = c.namedChild(j)
        const name = (child && child.type === 'attribute') ? child.text : walkType(child)
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
  'name',  // PHP function-call callee is a `name` node
  'word',  // Bash command name is a `word` node
])
const NAV_TYPES = new Set([
  'member_expression', 'selector_expression', 'field_expression',
  'navigation_expression', 'method_invocation',
  // Python `obj.method()` — the call's `function` field is an `attribute`
  // node. Without this, every Python method call yielded a null callee name
  // and was dropped, so only bare `foo()` calls were detected (≈6× under-
  // count on method-heavy code like PyQt apps). See docs/SYMBOL-MODE-PLAN.md.
  'attribute',
  'scoped_identifier', 'scoped_type_identifier',  // Rust  Engine::new()
  'member_access_expression',                     // C#    obj.Method()
  'command_name',                                 // Bash  command name wrapper
  'variable',                                     // Lua   M.process / self.process
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

// ── Python receiver-type inference ───────────────────────────────────────────
// Mirrors the babel parser's type-aware resolution: track the KNOWN type of a
// receiver (a local var, a param, or a `self.attr`) so `recv.method()` resolves
// to `Type.method`. Only types we actually know (a `: Type` annotation or a
// `Type(...)` construction) are recorded — never a guess — so the qualified
// resolution this enables stays precision-safe.

// Base type name from a Python type node. Conservative: simple identifier or
// `module.Class`; containers/generics (`List[Foo]`, `Optional[Foo]`) are NOT
// unwrapped because `xs.method()` would be the container's method, not Foo's.
function pyTypeName(typeNode) {
  if (!typeNode) return null
  const tt = typeNode.type
  if (tt === 'type') return pyTypeName(typeNode.namedChild(0))
  if (tt === 'identifier') return typeNode.text
  if (tt === 'attribute') { const a = typeNode.childForFieldName?.('attribute'); return a?.text || null }
  return null
}
// `Foo(...)` construction → 'Foo' (a PascalCase identifier callee). `Foo.x()`
// factories are skipped (could return a different type) to stay precise.
function pyConstructType(valueNode) {
  if (!valueNode || valueNode.type !== 'call') return null
  const fn = valueNode.childForFieldName?.('function')
  if (fn && fn.type === 'identifier' && /^[A-Z]/.test(fn.text)) return fn.text
  return null
}
// Walk a subtree collecting assignments, without descending into nested
// function/class/lambda scopes (their locals are not ours).
function pyScanAssignments(node, onAssign) {
  if (!node) return
  const t = node.type
  if (t === 'function_definition' || t === 'class_definition' || t === 'lambda') return
  if (t === 'assignment') onAssign(node)
  for (let i = 0; i < node.childCount; i++) pyScanAssignments(node.child(i), onAssign)
}
// Type a Python expression evaluates to, if known: `Foo(...)` construction or
// a call whose target declares a `-> Foo` return type. Never a guess.
function pyValueType(valueNode, ctx) {
  if (!valueNode) return null
  const ct = pyConstructType(valueNode)
  if (ct) return ct
  if (valueNode.type === 'call') { const n = pyResolveCalledNode(valueNode, ctx); return n?.returnType || null }
  return null
}
// Local var types inside a function: typed params + `x = Foo()` / `x: T = …` /
// `x = factory()` where factory declares a return type.
function harvestPyFuncTypes(fnNode, map, ctx) {
  const params = fnNode.childForFieldName?.('parameters')
  if (params) for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i)
    if (p.type === 'typed_parameter') {
      const idn = p.namedChild(0)
      const tn = pyTypeName(p.childForFieldName?.('type'))
      if (idn && idn.type === 'identifier' && tn) map.set(idn.text, tn)
    }
  }
  pyScanAssignments(fnNode.childForFieldName?.('body'), (a) => {
    const left = a.childForFieldName?.('left')
    if (left?.type !== 'identifier') return
    const tn = pyTypeName(a.childForFieldName?.('type')) || pyValueType(a.childForFieldName?.('right'), ctx)
    if (tn) map.set(left.text, tn)
  })
}
// Class property types: class-level `x: T` / `x = Foo()` and `__init__`'s
// `self.x = Foo()` / `self.x: T`.
function harvestPyClassProps(classNode, map, ctx) {
  const body = classNode.childForFieldName?.('body')
  if (!body) return
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i)
    if (stmt.type === 'expression_statement') {
      const a = stmt.namedChild(0)
      if (a?.type === 'assignment') {
        const left = a.childForFieldName?.('left')
        if (left?.type === 'identifier') {
          const tn = pyTypeName(a.childForFieldName?.('type')) || pyValueType(a.childForFieldName?.('right'), ctx)
          if (tn) map.set(left.text, tn)
        }
      }
    } else if (stmt.type === 'function_definition' && nameOf(stmt) === '__init__') {
      pyScanAssignments(stmt.childForFieldName?.('body'), (a) => {
        const left = a.childForFieldName?.('left')
        if (left?.type !== 'attribute') return
        const o = left.childForFieldName?.('object')
        const attr = left.childForFieldName?.('attribute')
        if (o?.type === 'identifier' && (o.text === 'self' || o.text === 'cls') && attr?.type === 'identifier') {
          const tn = pyTypeName(a.childForFieldName?.('type')) || pyValueType(a.childForFieldName?.('right'), ctx)
          if (tn) map.set(attr.text, tn)
        }
      })
    }
  }
}
// Known class of a receiver expression, or null.
//   self / cls          → enclosing class
//   self.attr           → class property type
//   var                 → local var / param type
//   a call `f()`        → f's declared return type (chains: `f().method()`)
function pyObjType(obj, ctx) {
  if (!obj) return null
  if (obj.type === 'identifier') {
    if (obj.text === 'self' || obj.text === 'cls') return ctx.classStack[ctx.classStack.length - 1]?.name || null
    const st = ctx.varTypeStack
    if (st) for (let i = st.length - 1; i >= 0; i--) { const ty = st[i].get(obj.text); if (ty) return ty }
    return null
  }
  if (obj.type === 'attribute') {
    const oo = obj.childForFieldName?.('object')
    const attr = obj.childForFieldName?.('attribute')
    if (oo?.type === 'identifier' && (oo.text === 'self' || oo.text === 'cls') && attr?.type === 'identifier') {
      return ctx.classStack[ctx.classStack.length - 1]?.propTypes?.get(attr.text) || null
    }
    return null
  }
  if (obj.type === 'call') {
    // `super().method()` — the receiver IS statically known: the enclosing
    // class's first base (Python MRO next for the common case). Lets every
    // `super().__init__()` resolve precisely instead of spraying candidates
    // to every class's __init__ (measured: 3009/4377 candidates on one repo —
    // and a GUARANTEE VIOLATION when the base is external, since the real
    // target was not among the sprayed user candidates).
    const fnNode = obj.childForFieldName?.('function')
    if (fnNode?.type === 'identifier' && fnNode.text === 'super') {
      return ctx.classStack[ctx.classStack.length - 1]?.bases?.[0] || null
    }
    const n = pyResolveCalledNode(obj, ctx); return n?.returnType || null
  }
  return null
}

// Is this Python call `super().something(...)`?
function pyIsSuperCall(callNode) {
  const fn = callNode.childForFieldName?.('function')
  if (!fn || fn.type !== 'attribute') return false
  const obj = fn.childForFieldName?.('object')
  if (!obj || obj.type !== 'call') return false
  const inner = obj.childForFieldName?.('function')
  return !!inner && inner.type === 'identifier' && inner.text === 'super'
}
// Symbol node a call resolves to (one receiver level; bounded by AST depth for
// chains). Used only for reading the target's return type — precision-safe
// (a known receiver class + exact qualified lookup, or a bare call).
function pyResolveCalledNode(callNode, ctx) {
  const fnName = extractCalleeName(callNode)
  if (!fnName) return null
  const fn = callNode.childForFieldName?.('function')
  if (fn?.type === 'attribute') {
    const recv = pyObjType(fn.childForFieldName?.('object'), ctx)
    if (recv && ctx.resolveQualified) return ctx.resolveQualified(`${recv}.${fnName}`)
    return null
  }
  return ctx.resolve ? ctx.resolve(fnName, { forCall: true }) : null
}
// Known class of a call's receiver, for resolving `recv.method()`.
function pyReceiverType(callNode, ctx) {
  const fn = callNode.childForFieldName?.('function')
  if (!fn || fn.type !== 'attribute') return null
  return pyObjType(fn.childForFieldName?.('object'), ctx)
}

// ── Go receiver-type inference ───────────────────────────────────────────────
// Go methods are already indexed as `Type.method` (extractGoReceiver), but a
// call `s.Method()` only resolves if we know `s`'s type. Mirrors the Python
// machinery: track the KNOWN type of a local from its declaration —
//   var s Engine | s := Engine{} | s := &Engine{} | s := NewEngine() |
//   func (e *Engine) m() | func f(s *Engine)
// then resolve `Type.method` via qualifiedOnly (exact, never a guess). This also
// fixes the BUILTIN_NAMES over-block: a typed `s.Get()` resolves qualified,
// bypassing the bare-member builtin guard that was dropping Get/Set/Save/Find.

// Type name from a Go type node. `*Engine`→Engine, `pkg.Type`→Type, plain ident
// as-is. Composite/slice/map/func types yield null (not a method-owning struct).
function goTypeName(typeNode) {
  if (!typeNode) return null
  const t = typeNode.type
  if (t === 'type_identifier') return typeNode.text
  if (t === 'pointer_type') return goTypeName(typeNode.namedChild(0))
  if (t === 'qualified_type') { const n = typeNode.childForFieldName?.('name'); return n?.text || lastIdentText(typeNode) }
  return null
}
// Type a Go expression evaluates to: `Engine{}` / `&Engine{}` construction, or a
// call whose target declares a (single) return type.
function goValueType(valueNode, ctx) {
  if (!valueNode) return null
  let v = valueNode
  if (v.type === 'unary_expression') v = v.namedChild(0)   // &Engine{}
  if (v && v.type === 'composite_literal') return goTypeName(v.childForFieldName?.('type'))
  if (v && v.type === 'call_expression') { const n = goResolveCalledNode(v, ctx); return n?.returnType || null }
  return null
}
// Symbol node a Go call resolves to (one level) — only to read its returnType.
function goResolveCalledNode(callNode, ctx) {
  const fnName = extractCalleeName(callNode)
  if (!fnName) return null
  const fn = callNode.childForFieldName?.('function')
  if (fn?.type === 'selector_expression') {
    const recv = goObjType(fn.childForFieldName?.('operand'), ctx)
    if (recv && ctx.resolveQualified) return ctx.resolveQualified(`${recv}.${fnName}`)
    return null
  }
  return ctx.resolve ? ctx.resolve(fnName, { forCall: true }) : null
}
// Known type of a Go receiver expression.
function goObjType(obj, ctx) {
  if (!obj) return null
  if (obj.type === 'identifier') {
    const st = ctx.varTypeStack
    if (st) for (let i = st.length - 1; i >= 0; i--) { const ty = st[i].get(obj.text); if (ty) return ty }
    return null
  }
  if (obj.type === 'call_expression') { const n = goResolveCalledNode(obj, ctx); return n?.returnType || null }
  return null
}
function goReceiverType(callNode, ctx) {
  const fn = callNode.childForFieldName?.('function')
  if (!fn || fn.type !== 'selector_expression') return null
  return goObjType(fn.childForFieldName?.('operand'), ctx)
}
// Record `name → type` for every identifier in a Go parameter/receiver list.
function goWalkParams(plist, map) {
  if (!plist) return
  for (let i = 0; i < plist.namedChildCount; i++) {
    const pd = plist.namedChild(i)
    if (pd.type !== 'parameter_declaration') continue
    const tn = goTypeName(pd.childForFieldName?.('type'))
    if (!tn) continue
    for (let j = 0; j < pd.namedChildCount; j++) {
      const c = pd.namedChild(j)
      if (c.type === 'identifier') map.set(c.text, tn)
    }
  }
}
// Pair a Go `:=` / `=` left list with its right list, typing each name.
function goPairAssign(left, right, map, ctx) {
  if (!left) return
  const list = (n) => n.type === 'expression_list'
    ? Array.from({ length: n.namedChildCount }, (_, i) => n.namedChild(i)) : [n]
  const names = list(left), vals = right ? list(right) : []
  for (let i = 0; i < names.length; i++) {
    if (names[i].type !== 'identifier') continue
    const v = vals.length === names.length ? vals[i] : (vals.length === 1 ? vals[0] : null)
    const tn = v ? goValueType(v, ctx) : null
    if (tn) map.set(names[i].text, tn)
  }
}
// Scan a Go function body for local declarations, without descending into nested
// function literals (their locals are not ours).
function goScanDecls(node, map, ctx) {
  if (!node) return
  const t = node.type
  if (t === 'func_literal' || t === 'function_declaration' || t === 'method_declaration') return
  if (t === 'short_var_declaration') {
    goPairAssign(node.childForFieldName?.('left'), node.childForFieldName?.('right'), map, ctx)
  } else if (t === 'var_spec') {
    const tn = goTypeName(node.childForFieldName?.('type'))
    const val = node.childForFieldName?.('value')
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)
      if (c.type === 'identifier') { const ty = tn || (val ? goValueType(val, ctx) : null); if (ty) map.set(c.text, ty) }
    }
  }
  for (let i = 0; i < node.childCount; i++) goScanDecls(node.child(i), map, ctx)
}
function goHarvestFuncTypes(fnNode, map, ctx) {
  goWalkParams(fnNode.childForFieldName?.('receiver'), map)
  goWalkParams(fnNode.childForFieldName?.('parameters'), map)
  goScanDecls(fnNode.childForFieldName?.('body'), map, ctx)
}

// ── Generic receiver-type inference (Java/C#/Kotlin/Swift/Rust/PHP/C/C++) ─────
// The same idea as Python/Go but driven by a per-language config, since the
// statically-typed languages all index methods as `Type.method` (lexical class
// nesting) yet a call `obj.method()` only resolves once we know obj's type. We
// learn types from declarations + constructors + typed params, then resolve
// `Type.method` via qualifiedOnly (exact, precision-safe, bypasses the builtin
// guard). Only KNOWN types are recorded — never a guess.

// Name text of a receiver expression node (PHP `$x` is variable_name>name).
function recvName(node) {
  if (!node) return null
  if (node.type === 'self' || node.type === 'this') return 'self'   // Rust/Swift `self`, etc.
  if (node.type === 'variable_name') { const n = node.childForFieldName?.('name') || node.namedChild(0); return n?.text || null }
  if (IDENT_TYPES.has(node.type)) return node.text
  return null
}
// Type name from a declared-type node (type_identifier, user_type wrapper,
// pointer/qualified). Reuses goTypeName + a user_type peek (Kotlin/Swift).
function typeNameOf(node) {
  if (!node) return null
  if (node.type === 'user_type') return typeNameOf(node.namedChild(0))
  // PHP `Engine $e` → named_type(name) / ?Engine → optional_type — unwrap.
  if (node.type === 'named_type' || node.type === 'optional_type') return typeNameOf(node.namedChild(0))
  // Rust `&T` / `&mut T` / `*const T` — unwrap to the referenced type so a
  // `s: &Service` parameter types `s` as Service (was: null → no harvest →
  // every reference-typed param call fell to the untyped path).
  if (node.type === 'reference_type' || node.type === 'pointer_type' && node.namedChildCount) {
    for (let i = node.namedChildCount - 1; i >= 0; i--) { const r = typeNameOf(node.namedChild(i)); if (r) return r }
    return null
  }
  if (node.type === 'type_annotation') { for (let i = 0; i < node.namedChildCount; i++) { const r = typeNameOf(node.namedChild(i)); if (r) return r } return null }
  const g = goTypeName(node)
  if (g) return g
  if (IDENT_TYPES.has(node.type)) return node.text
  return null
}
// Constructed type from a value node: `new Foo()`, `Foo()` (PascalCase),
// `Foo::new()` (Rust), `Foo{}`/`&Foo{}`. Never a non-Capitalized guess.
function ctorTypeName(valueNode) {
  if (!valueNode) return null
  let v = valueNode
  if (v.type === 'unary_expression' || v.type === 'parenthesized_expression') v = v.namedChild(0)
  if (!v) return null
  if (v.type === 'object_creation_expression' || v.type === 'new_expression') {
    const tf = v.childForFieldName?.('type')
    if (tf) return typeNameOf(tf)
    for (let i = 0; i < v.namedChildCount; i++) { const c = v.namedChild(i); if (c.type === 'type_identifier' || c.type === 'name' || c.type === 'identifier' || c.type === 'scoped_type_identifier' || c.type === 'qualified_type') return typeNameOf(c) || c.text }
    return null
  }
  if (v.type === 'call_expression' || v.type === 'call') {
    const callee = v.childForFieldName?.('function') || v.namedChild(0)
    if (!callee) return null
    if (callee.type === 'scoped_identifier' || callee.type === 'scoped_type_identifier') { const first = callee.namedChild(0); return first && /^[A-Z]/.test(first.text) ? first.text : null }
    if ((callee.type === 'simple_identifier' || callee.type === 'identifier' || callee.type === 'type_identifier') && /^[A-Z]/.test(callee.text)) return callee.text
  }
  return null
}
// Per-language: extract the receiver expression node of a member call.
const RECV_OF = {
  java:    (c) => c.childForFieldName?.('object'),
  c_sharp: (c) => { const m = c.childForFieldName?.('function') || c.namedChild(0); return m && m.type === 'member_access_expression' ? (m.childForFieldName?.('expression') || m.namedChild(0)) : null },
  php:     (c) => c.childForFieldName?.('object') || c.namedChild(0),
  rust:    (c) => { const fe = c.childForFieldName?.('function') || c.namedChild(0); if (!fe) return null; if (fe.type === 'field_expression') return fe.childForFieldName?.('value') || fe.namedChild(0); if (fe.type === 'scoped_identifier') return fe.childForFieldName?.('path') || fe.namedChild(0); return null },
  kotlin:  (c) => { const n = c.namedChild(0); return n && n.type === 'navigation_expression' ? n.namedChild(0) : null },
  swift:   (c) => { const n = c.namedChild(0); return n && n.type === 'navigation_expression' ? n.namedChild(0) : null },
  cpp:     (c) => { const fe = c.childForFieldName?.('function') || c.namedChild(0); return fe && fe.type === 'field_expression' ? (fe.childForFieldName?.('argument') || fe.namedChild(0)) : null },
}
RECV_OF.c = RECV_OF.cpp
// Languages where a bare `m()` inside a method means `this.m()` (implicit
// receiver). Excludes Python/Rust/Go (explicit self/Self) and PHP/JS ($this/
// this required).
const IMPLICIT_THIS_LANGS = new Set(['java', 'c_sharp', 'kotlin', 'swift', 'scala', 'cpp', 'c'])
// Per-language: list of (name,type) bound by a declaration statement node.
const BIND_OF = {
  java(n) { if (n.type !== 'local_variable_declaration') return []; const tn = typeNameOf(n.childForFieldName?.('type')); const out = []; for (let i = 0; i < n.namedChildCount; i++) { const d = n.namedChild(i); if (d.type === 'variable_declarator') { const nm = d.childForFieldName?.('name'); const ty = tn || ctorTypeName(d.childForFieldName?.('value')); if (nm && ty) out.push({ name: nm.text, type: ty }) } } return out },
  c_sharp(n) { if (n.type !== 'local_declaration_statement') return []; const vd = n.namedChild(0); if (!vd || vd.type !== 'variable_declaration') return []; const tf = vd.childForFieldName?.('type'); const tn = (tf && tf.type !== 'implicit_type') ? typeNameOf(tf) : null; const out = []; for (let i = 0; i < vd.namedChildCount; i++) { const d = vd.namedChild(i); if (d.type === 'variable_declarator') { const nm = d.namedChild(0); let val = null; for (let j = 0; j < d.namedChildCount; j++) { const c = d.namedChild(j); if (c.type === 'equals_value_clause') val = c.namedChild(c.namedChildCount - 1) } const ty = tn || ctorTypeName(val); if (nm && ty) out.push({ name: nm.text, type: ty }) } } return out },
  php(n) { if (n.type !== 'assignment_expression') return []; const left = n.childForFieldName?.('left') || n.namedChild(0); const right = n.childForFieldName?.('right') || n.namedChild(n.namedChildCount - 1); const nm = recvName(left); const ty = ctorTypeName(right); return (nm && ty) ? [{ name: nm, type: ty }] : [] },
  rust(n) { if (n.type !== 'let_declaration') return []; const nm = n.childForFieldName?.('pattern') || n.namedChild(0); const tf = n.childForFieldName?.('type'); const val = n.childForFieldName?.('value'); const ty = typeNameOf(tf) || ctorTypeName(val); return (nm && IDENT_TYPES.has(nm.type) && ty) ? [{ name: nm.text, type: ty }] : [] },
  kotlin(n) { if (n.type !== 'property_declaration') return []; let nm = null, tn = null, val = null; for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type === 'variable_declaration') { nm = c.namedChild(0); for (let j = 0; j < c.namedChildCount; j++) { const u = c.namedChild(j); if (u.type === 'user_type') tn = typeNameOf(u) } } else if (c.type === 'user_type') tn = typeNameOf(c); else if (c.type === 'call_expression' || c.type === 'navigation_expression') val = c } const ty = tn || ctorTypeName(val); return (nm && ty) ? [{ name: nm.text, type: ty }] : [] },
  swift(n) { if (n.type !== 'property_declaration') return []; let nm = null, tn = null, val = null; for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type === 'pattern') nm = c.namedChild(0) || c; else if (c.type === 'type_annotation') tn = typeNameOf(c); else if (c.type === 'call_expression') val = c } const ty = tn || ctorTypeName(val); return (nm && ty) ? [{ name: recvName(nm) || nm.text, type: ty }] : [] },
  cpp(n) {
    if (n.type !== 'declaration') return []
    const tn = typeNameOf(n.childForFieldName?.('type'))
    const out = []
    // `Foo* p`, `Foo& r`, `Foo a[]` wrap the name in a (pointer|reference|array)
    // _declarator chain — descend to the inner identifier.
    const declIdent = (d) => {
      let g = d, guard = 0
      while (g && guard++ < 6) {
        if (IDENT_TYPES.has(g.type)) return g.text
        g = g.childForFieldName?.('declarator') || g.namedChild(0)
      }
      return null
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const d = n.namedChild(i)
      if (d.type === 'identifier') { if (tn) out.push({ name: d.text, type: tn }) }
      else if (d.type === 'pointer_declarator' || d.type === 'reference_declarator' || d.type === 'array_declarator') {
        const nm = declIdent(d); if (nm && tn) out.push({ name: nm, type: tn })
      } else if (d.type === 'init_declarator') {
        const nm = declIdent(d.childForFieldName?.('declarator') || d.namedChild(0))
        const val = d.childForFieldName?.('value') || d.namedChild(d.namedChildCount - 1)
        const ty = tn || ctorTypeName(val)
        if (nm && ty) out.push({ name: nm, type: ty })
      }
    }
    return out
  },
}
BIND_OF.c = BIND_OF.cpp
// Per-language param list extraction → (name,type).
function genericWalkParams(fnNode, map, lang) {
  // params live under different fields; scan all descendants for param nodes.
  const PARAM = { java: 'formal_parameter', c_sharp: 'parameter', rust: 'parameter', php: 'simple_parameter', cpp: 'parameter_declaration', c: 'parameter_declaration', kotlin: 'parameter', swift: 'parameter' }
  const pt = PARAM[lang]
  if (!pt) return
  const visit = (n, depth) => {
    if (!n || depth > 4) return
    if (n.type === pt) {
      // Kotlin's `parameter` (and some other grammars) exposes NO `type`
      // field — fall back to the last named child that resolves to a type
      // name, so `e: Engine` harvests e→Engine like everywhere else.
      const tf = n.childForFieldName?.('type') || null
      let tn = typeNameOf(tf)
      if (!tn) {
        for (let i = n.namedChildCount - 1; i >= 1; i--) { tn = typeNameOf(n.namedChild(i)); if (tn) break }
      }
      if (tn) {
        // Param NAME may hide inside a declarator wrapper (C++ `Engine& e` →
        // reference_declarator(identifier), pointers likewise) — search a few
        // levels deep for the first identifier-ish node.
        const findIdent = (x, d) => {
          if (!x || d > 3) return null
          if (IDENT_TYPES.has(x.type) || x.type === 'variable_name' || x.type === 'simple_identifier') return x
          for (let i = 0; i < x.namedChildCount; i++) { const r = findIdent(x.namedChild(i), d + 1); if (r) return r }
          return null
        }
        const nm = n.childForFieldName?.('name')
          || n.childForFieldName?.('declarator')
          || (() => { for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c !== tf && (IDENT_TYPES.has(c.type) || c.type === 'variable_name' || c.type === 'simple_identifier' || /declarator/.test(c.type))) return c } return null })()
        const name = recvName(nm) || recvName(findIdent(nm, 0))
        if (name) map.set(name, tn)
      }
      return
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), depth + 1)
  }
  // Only descend the parameter clause region, not the body. C/C++ nest the
  // parameter_list one level down inside function_declarator — peek there too.
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const c = fnNode.namedChild(i)
    if (/param/i.test(c.type)) { visit(c, 0); continue }
    if (/declarator/.test(c.type)) {
      for (let j = 0; j < c.namedChildCount; j++) { const cc = c.namedChild(j); if (/param/i.test(cc.type)) visit(cc, 0) }
    }
  }
}
const LAMBDA_TYPES = new Set(['lambda', 'lambda_expression', 'lambda_literal', 'closure_expression', 'anonymous_function', 'func_literal', 'arrow_function', 'function_literal'])
function genericScanDecls(node, map, ctx, lang) {
  if (!node) return
  const t = node.type
  // Don't descend into a NESTED function/method declaration or a lambda (its
  // locals aren't ours). Must use the cfg lists + lambda set, NOT a name regex —
  // a regex on "function" wrongly matched Kotlin/Swift `function_body` (the
  // body WRAPPER) and stopped harvest before it reached the declarations.
  const cfg = ctx.types
  if (node !== ctx._harvestRoot && (cfg.fn?.includes(t) || cfg.method?.includes(t) || LAMBDA_TYPES.has(t))) return
  const binder = BIND_OF[lang]
  if (binder) { const binds = binder(node); for (const b of binds) map.set(b.name, b.type) }
  for (let i = 0; i < node.childCount; i++) genericScanDecls(node.child(i), map, ctx, lang)
}
function genericHarvest(fnNode, map, ctx) {
  const lang = ctx.lang
  genericWalkParams(fnNode, map, lang)
  ctx._harvestRoot = fnNode
  genericScanDecls(fnNode, map, ctx, lang)
}
// Is this member call's receiver the parent-class keyword (`super.m()` in
// Java/Kotlin, `base.M()` in C#)? Mirrors the Python super() handling.
function isSuperBaseReceiver(callNode, lang) {
  const rf = RECV_OF[lang]
  if (!rf) return false
  const r = rf(callNode)
  if (!r) return false
  return r.type === 'super' || r.type === 'super_expression' || r.type === 'base_expression'
      || r.text === 'super' || r.text === 'base'
}
function genericReceiverType(callNode, ctx) {
  const rf = RECV_OF[ctx.lang]
  if (!rf) return null
  const recv = rf(callNode)
  // `super.m()` / `base.M()`: the receiver IS statically known — the enclosing
  // class's first declared parent (kept on the class stack). Without this the
  // call fell to the bare fallback and sprayed candidates to every same-named
  // method (the same guarantee violation the Python super() fix closed).
  if (recv && (recv.type === 'super' || recv.type === 'super_expression' || recv.type === 'base_expression'
               || recv.text === 'super' || recv.text === 'base')) {
    return ctx.classStack[ctx.classStack.length - 1]?.bases?.[0] || null
  }
  const nm = recvName(recv)
  if (!nm) return null
  if (nm === 'this' || nm === 'self') return ctx.classStack[ctx.classStack.length - 1]?.name || null
  const st = ctx.varTypeStack
  if (st) for (let i = st.length - 1; i >= 0; i--) { const ty = st[i].get(nm); if (ty) return ty }
  // Static call `ClassName.method()` — the receiver IS the type. Only for a
  // PascalCase receiver (class-name convention); resolveQualified is exact, so
  // a non-class name just yields null — never a wrong edge.
  if (/^[A-Z]/.test(nm)) return nm
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
  // The five 2026-06-11 bar languages previously had NO kwSet at all, so their
  // stdlib bare calls (PHP count/strlen/…) flooded the zero-silence ledger —
  // the exact "cries wolf" class the Python import filter was built to stop.
  php:        new Set(['if','else','elseif','for','foreach','while','do','switch','case','break','continue','return','function','class','interface','trait','extends','implements','new','echo','print','isset','unset','empty','require','require_once','include','include_once','use','namespace','public','private','protected','static','const','true','false','null','array','count','strlen','strtolower','strtoupper','substr','str_replace','sprintf','printf','implode','explode','in_array','array_map','array_filter','array_merge','array_keys','array_values','json_encode','json_decode','preg_match','preg_replace','trim','intval','floatval','strval','is_array','is_string','is_int','is_null','die','exit','list','compact','extract']),
  cpp:        new Set(['if','else','for','while','do','switch','case','break','continue','return','new','delete','class','struct','enum','union','template','typename','namespace','using','public','private','protected','virtual','override','static','const','constexpr','inline','void','int','long','short','char','bool','float','double','auto','true','false','nullptr','this','sizeof','printf','fprintf','sprintf','malloc','calloc','realloc','free','memcpy','memset','strlen','strcmp','strcpy','assert','throw','try','catch','operator','std','move','forward','make_unique','make_shared']),
  scala:      new Set(['if','else','for','while','do','match','case','return','def','val','var','class','object','trait','extends','with','new','import','package','implicit','override','private','protected','sealed','final','lazy','yield','true','false','null','this','super','println','print','require','assert','Some','None','Nil','List','Map','Set','Seq','Vector','Option','Either','Future','toString','apply','unapply']),
  lua:        new Set(['if','then','else','elseif','end','for','while','repeat','until','do','function','local','return','break','and','or','not','in','true','false','nil','print','pairs','ipairs','next','type','tostring','tonumber','require','error','pcall','xpcall','assert','select','unpack','rawget','rawset','setmetatable','getmetatable','table','string','math','io','os','coroutine']),
  bash:       new Set(['if','then','else','elif','fi','for','while','until','do','done','case','esac','function','return','break','continue','echo','printf','read','cd','exit','export','local','set','unset','shift','source','eval','exec','trap','test','true','false','let','declare','readonly','wait','kill','pwd','dirname','basename','grep','sed','awk','cat','ls','rm','cp','mv','mkdir','touch','chmod','curl','git','npm','node']),
}
KEYWORDS.c = KEYWORDS.cpp
KEYWORDS.sh = KEYWORDS.bash

function makeResolver(fileId, index) {
  // Two modes. `forCall=true` permits the loose "any same-named
  // symbol" fallback — the `foo()` syntax is a strong-enough hint
  // that the name is a real call target, and skipping the fallback
  // misses too many cross-file calls. `forCall=false` (default,
  // for plain identifier references) stays strict — same file or
  // a file the caller actually imports — so local variables that
  // happen to share a name with some unrelated function elsewhere
  // don't produce a noise edge.
  return function resolve(name, { forCall = false, memberCall = false } = {}) {
    return index.resolveCall
      ? index.resolveCall(fileId, name, { allowAny: forCall, memberCall })
      : null
  }
}

// Is this call a member/navigation call (`obj.method()`) rather than a bare
// `foo()`? The callee node is a navigation/attribute type. Member calls on an
// untyped receiver must pass memberCall so resolveCall rejects builtin method
// names (.map/.get/.then…) instead of grabbing a same-file free function of
// that name — the same guard the babel JS parser uses.
function isMemberCallNode(callNode) {
  // Lua wraps EVERY callee in a variable node - a bare call is variable >
  // single identifier, a member/colon call has a deeper shape. Without this,
  // all Lua calls counted as member calls: the zero-silence ledger was MUTE
  // for Lua and the builtin guard rejected plain user calls (2026-06-05 bug,
  // confirmed in the round-2 inspection).
  {
    const fn0 = callNode.childForFieldName?.("function") || callNode.namedChild(0)
    if (fn0 && fn0.type === "variable" && fn0.namedChildCount === 1
        && IDENT_TYPES.has(fn0.namedChild(0).type)) return false
  }
  // Bash: a `command` is a bare invocation `funcname args` — the command_name
  // is the callee, there is no receiver, so it is NOT a member call. (It used to
  // be misclassified as a member call and only resolved because resolveCall then
  // grabbed a same-named free function; the insp-004 member-call guard removed
  // that crutch, so classify it correctly here.)
  {
    const fn0 = callNode.childForFieldName?.('function') || callNode.namedChild(0)
    if (fn0 && fn0.type === 'command_name') return false
  }
  const fn = callNode.childForFieldName?.('function') || callNode.childForFieldName?.('name')
  if (fn && NAV_TYPES.has(fn.type)) return true
  for (let i = 0; i < callNode.namedChildCount; i++) {
    const c = callNode.namedChild(i)
    if (IDENT_TYPES.has(c.type)) return false
    if (NAV_TYPES.has(c.type)) return true
  }
  return false
}

// Languages whose parser has already emitted a failure warning — so a broken
// grammar (wasm ABI mismatch, throw) surfaces ONCE instead of being silently
// swallowed to [] for every file (which is how Ruby/Dart breakage stayed
// invisible until an audit caught it).
const _parserWarned = new Set()

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
        // Module-scope pseudo-symbol (parity with the babel parser): the source
        // for top-level / module-init calls so they aren't dropped for lack of
        // an enclosing function.
        ctx.symbols.push({ id: mkId(fileId, '<module>', 1), name: '<module>', qualifiedName: '<module>', kind: 'module', file: fileId, startLine: 1, endLine: 1, signature: '', doc: '', exported: false })
        tree.delete?.()
        return ctx.symbols
      } catch (e) {
        if (!_parserWarned.has(lang)) { _parserWarned.add(lang); console.error(`[symbol] ${lang} parser failed — L2 disabled for this language: ${e && e.message}`) }
        return []
      }
    },
    async extractReferencesAsync(content, fileId, index) {
      try {
        const parser = await parserFor(lang)
        const tree = parser.parse(content)
        const ctx = {
          fileId, content, types, lang,
          symbols: [], classStack: [], fnStack: [], varTypeStack: [],
          edges: [], seen: new Set(),
          importedNames: new Set(),   // names brought in by imports (external-call filter)
          kwSet,
          resolve: makeResolver(fileId, index),
          // Dynamic candidate set (parity with babel) — maximal honest set of
          // production callables for a call with no single static target.
          candidates: (name, opts) => (index.candidatesFor ? index.candidatesFor(fileId, name, opts) : { candidates: [], capped: false }),
          // Qualified resolver for `self.method()` → `Class.method` (exact
          // qualifiedName match only — no bare-name degrade). Lets an ambiguous
          // method name still link when the receiver is unambiguously `self`.
          resolveQualified: (qn) => (index.resolveCall
            ? index.resolveCall(fileId, qn, { allowAny: true, qualifiedOnly: true })
            : null),
          // Live graph handle: inheritance edges are added to the index AS the
          // class is entered (not just collected) so the class-hierarchy (MRO)
          // walk can resolve inherited calls LATER in the same pass — extendsOut
          // is otherwise only built after extractReferences returns, so
          // `init()` inheriting from a base resolved to nothing.
          index,
          passTwo: true,
        }
        // Module base so top-level / module-scope calls attribute to <module>
        // instead of being dropped (parity with the babel parser).
        ctx.fnStack.push(mkId(fileId, '<module>', 1))
        walk(tree.rootNode, ctx)
        tree.delete?.()
        return ctx.edges
      } catch (e) {
        if (!_parserWarned.has(lang)) { _parserWarned.add(lang); console.error(`[symbol] ${lang} parser failed — L2 disabled for this language: ${e && e.message}`) }
        return []
      }
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

// parserFor is exported for the expression-flow walker (symbol-flow.cjs):
// it needs RAW trees, not the symbol/reference extraction pipeline.
// Extensions whose tree-sitter grammar failed to load/parse at runtime, so
// Layer-2 is actually disabled for them THIS session — honest coverage must not
// count these as covered (insp-004: a failed parser load otherwise still
// reported coverage 100%). Empty in a healthy install.
function degradedExts() {
  if (!_parserWarned.size) return []
  const out = []
  for (const [ext, cfg] of Object.entries(LANG_CONFIG)) {
    if (cfg && _parserWarned.has(cfg.grammar)) out.push(ext)
  }
  return out
}

module.exports = { makeParser, availableExtensions, LANG_CONFIG, parserFor, wasmPath, WASM_DIR, degradedExts }
