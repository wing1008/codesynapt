// TypeScript-compiler-API symbol parser.
//
// Uses the real `typescript` package (Program + TypeChecker) instead
// of Babel AST walking. The win: every CallExpression resolves to the
// declaring symbol via the checker, so `user.save()` lands on the
// exact User.save() method even when several classes define save().
//
// Trade-off: heavier — the TS Program loads every file in the project
// once. For huge monorepos this is slower than the regex/babel path.
// We register this parser for .ts/.tsx only, and only when the host
// opts in (CS_SYMBOL_PARSER=tsc, or the default when typescript is
// installed AND there's a tsconfig.json at the project root).
//
// Pass 1 (extractSymbols) and Pass 2 (extractReferences) both rely on
// a single Program built per-project on the first call; subsequent
// per-file calls reuse it. The host clears it on project swap.

'use strict'

const fs = require('fs')
const path = require('path')

let ts = null
function loadTS() {
  if (ts) return ts
  try { ts = require('typescript') }
  catch { ts = null }
  return ts
}

// Cache: rootAbs → { program, checker, files: Set<id> }
const _programCache = new Map()

function clearProgramFor(rootAbs) { _programCache.delete(rootAbs) }
function clearAllPrograms() { _programCache.clear() }

function loadProgramFor(rootAbs, allFileIds) {
  const cached = _programCache.get(rootAbs)
  if (cached) return cached
  const t = loadTS()
  if (!t) return null
  // Find tsconfig.json (or jsconfig.json) — use compiler options if
  // present, otherwise reasonable defaults.
  let compilerOptions = {
    allowJs: true,
    target: t.ScriptTarget.ES2020,
    module: t.ModuleKind.ESNext,
    jsx: t.JsxEmit.ReactJSX,
    moduleResolution: t.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    noEmit: true,
    isolatedModules: true,
  }
  try {
    const configPath = ['tsconfig.json', 'jsconfig.json']
      .map((c) => path.join(rootAbs, c))
      .find((p) => fs.existsSync(p))
    if (configPath) {
      const raw = fs.readFileSync(configPath, 'utf8')
      const parsed = t.parseConfigFileTextToJson(configPath, raw)
      if (!parsed.error && parsed.config?.compilerOptions) {
        const co = t.convertCompilerOptionsFromJson(
          parsed.config.compilerOptions, path.dirname(configPath))
        if (co.options) Object.assign(compilerOptions, co.options)
      }
    }
  } catch {}
  // Build the Program over the TS/TSX/JS/JSX files we know about.
  const rootNames = [...allFileIds]
    .filter((id) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(id))
    .map((id) => path.join(rootAbs, id))
  if (rootNames.length === 0) return null
  let program
  try {
    program = t.createProgram(rootNames, compilerOptions)
  } catch (e) { return null }
  const checker = program.getTypeChecker()
  const result = { program, checker, files: new Set(allFileIds), rootAbs }
  _programCache.set(rootAbs, result)
  return result
}

function mkId(file, name, line) { return `${file}#${name}@${line}` }

function idForDeclaration(decl, rootAbs) {
  if (!decl) return null
  const sf = decl.getSourceFile?.()
  if (!sf) return null
  const fileId = path.relative(rootAbs, sf.fileName).split(path.sep).join('/')
  const t = loadTS()
  if (!t) return null
  const name = declarationName(decl, t)
  if (!name) return null
  const line = sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1
  // Qualify methods by their enclosing class.
  let qualified = name
  const cls = findEnclosingClass(decl, t)
  if (cls?.name) qualified = `${cls.name.text}.${name}`
  return mkId(fileId, qualified, line)
}

function findEnclosingClass(node, t) {
  let cur = node.parent
  while (cur) {
    if (cur.kind === t.SyntaxKind.ClassDeclaration
     || cur.kind === t.SyntaxKind.InterfaceDeclaration) return cur
    cur = cur.parent
  }
  return null
}

function declarationName(decl, t) {
  if (decl.name) return decl.name.text || decl.name.getText?.()
  if (decl.kind === t.SyntaxKind.Constructor) return 'constructor'
  return null
}

function classKindFor(node, t) {
  switch (node.kind) {
    case t.SyntaxKind.ClassDeclaration:     return 'class'
    case t.SyntaxKind.InterfaceDeclaration: return 'interface'
    case t.SyntaxKind.EnumDeclaration:      return 'enum'
    case t.SyntaxKind.TypeAliasDeclaration: return 'type'
    default:                                 return 'class'
  }
}

function fnKindFor(node, t) {
  if (node.kind === t.SyntaxKind.MethodDeclaration
   || node.kind === t.SyntaxKind.MethodSignature) return 'method'
  if (node.kind === t.SyntaxKind.Constructor) return 'method'
  return 'function'
}

function isExported(node, t) {
  return !!(node.modifiers || []).some((m) =>
    m.kind === t.SyntaxKind.ExportKeyword)
}

// Pass 1 — symbols
function extractSymbolsFor(fileId, rootAbs, allFileIds) {
  const prog = loadProgramFor(rootAbs, allFileIds)
  if (!prog) return []
  const t = loadTS()
  const sf = prog.program.getSourceFile(path.join(rootAbs, fileId))
  if (!sf) return []
  const out = []
  const visit = (node) => {
    let push = null
    switch (node.kind) {
      case t.SyntaxKind.FunctionDeclaration: {
        const name = node.name?.text
        if (name) push = { name, kind: 'function', node }
        break
      }
      case t.SyntaxKind.ClassDeclaration:
      case t.SyntaxKind.InterfaceDeclaration:
      case t.SyntaxKind.EnumDeclaration:
      case t.SyntaxKind.TypeAliasDeclaration: {
        const name = node.name?.text
        if (name) push = { name, kind: classKindFor(node, t), node }
        break
      }
      case t.SyntaxKind.MethodDeclaration:
      case t.SyntaxKind.MethodSignature:
      case t.SyntaxKind.Constructor: {
        const name = node.name?.text || (node.kind === t.SyntaxKind.Constructor ? 'constructor' : null)
        if (name) {
          const cls = findEnclosingClass(node, t)
          const qn = cls?.name?.text ? `${cls.name.text}.${name}` : name
          push = { name, qualifiedName: qn, kind: 'method', node }
        }
        break
      }
      case t.SyntaxKind.VariableStatement: {
        for (const d of node.declarationList.declarations) {
          if (!d.name?.text) continue
          const init = d.initializer
          if (init && (init.kind === t.SyntaxKind.ArrowFunction
                    || init.kind === t.SyntaxKind.FunctionExpression)) {
            out.push(buildSym(fileId, d.name.text, d.name.text, 'function', d, t, init))
          }
        }
        break
      }
    }
    if (push) out.push(buildSym(fileId, push.name, push.qualifiedName || push.name, push.kind, push.node, t))
    t.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function buildSym(fileId, name, qualifiedName, kind, node, t, bodyNode) {
  const sf = node.getSourceFile()
  const startLine = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const endLine = sf.getLineAndCharacterOfPosition((bodyNode || node).getEnd()).line + 1
  return {
    id: mkId(fileId, qualifiedName, startLine),
    name, qualifiedName, kind,
    file: fileId,
    startLine, endLine,
    signature: node.getText().slice(0, 200).split('\n')[0],
    doc: '',
    exported: isExported(node, t),
  }
}

// Pass 2 — references (call edges resolved by the checker)
function extractReferencesFor(fileId, rootAbs, allFileIds, index) {
  const prog = loadProgramFor(rootAbs, allFileIds)
  if (!prog) return []
  const t = loadTS()
  const sf = prog.program.getSourceFile(path.join(rootAbs, fileId))
  if (!sf) return []
  const edges = []
  const seen = new Set()
  const fnStack = []     // enclosing symbol ids

  const visit = (node) => {
    let pushed = false
    if (node.kind === t.SyntaxKind.FunctionDeclaration
     || node.kind === t.SyntaxKind.MethodDeclaration
     || node.kind === t.SyntaxKind.Constructor
     || node.kind === t.SyntaxKind.ArrowFunction
     || node.kind === t.SyntaxKind.FunctionExpression) {
      const id = idForDeclaration(node, rootAbs) || idForArrowParent(node, rootAbs, t)
      if (id) { fnStack.push(id); pushed = true }
    }
    if (node.kind === t.SyntaxKind.CallExpression) {
      const src = fnStack[fnStack.length - 1]
      if (src) {
        // checker.getSymbolAtLocation on the callee gives us the
        // declaration symbol — far more precise than name matching.
        const callee = node.expression
        let sym = prog.checker.getSymbolAtLocation(callee)
        // For `obj.method()` getSymbolAtLocation on the whole
        // expression doesn't always resolve; try the property name.
        if (!sym && callee.kind === t.SyntaxKind.PropertyAccessExpression) {
          sym = prog.checker.getSymbolAtLocation(callee.name)
        }
        if (sym?.declarations?.length) {
          const decl = sym.declarations[0]
          const targetId = idForDeclaration(decl, rootAbs)
          if (targetId && targetId !== src && index.nodes.has(targetId)) {
            const key = src + '|' + targetId + '|call'
            if (!seen.has(key)) {
              seen.add(key)
              const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
              edges.push({ source: src, target: targetId, kind: 'call', line })
            }
          }
        }
      }
    }
    if (node.kind === t.SyntaxKind.NewExpression) {
      const src = fnStack[fnStack.length - 1]
      if (src) {
        const sym = prog.checker.getSymbolAtLocation(node.expression)
        if (sym?.declarations?.length) {
          const targetId = idForDeclaration(sym.declarations[0], rootAbs)
          if (targetId && targetId !== src && index.nodes.has(targetId)) {
            const key = src + '|' + targetId + '|call'
            if (!seen.has(key)) {
              seen.add(key)
              const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
              edges.push({ source: src, target: targetId, kind: 'call', line })
            }
          }
        }
      }
    }
    t.forEachChild(node, visit)
    if (pushed) fnStack.pop()
  }
  visit(sf)
  return edges
}

function idForArrowParent(node, rootAbs, t) {
  // `const handler = () => { ... }` — id is the variable name.
  const p = node.parent
  if (p?.kind === t.SyntaxKind.VariableDeclaration && p.name?.text) {
    const sf = node.getSourceFile()
    const fileId = path.relative(rootAbs, sf.fileName).split(path.sep).join('/')
    const line = sf.getLineAndCharacterOfPosition(p.getStart()).line + 1
    return mkId(fileId, p.name.text, line)
  }
  return null
}

// Build the parser shape expected by symbol-graph. Per-extension
// factory so we can stamp out a parser for .ts/.tsx/.js/.jsx.
function makeParser() {
  return {
    extractSymbols(content, fileId) {
      // Resolve rootAbs from the host's process.cwd? No — we get it
      // from the cached program. fileId is relative to root, so use
      // the most recent program's root.
      const lastRoot = [..._programCache.keys()].pop()
      if (!lastRoot) return []
      const allFileIds = _programCache.get(lastRoot)?.files || new Set()
      return extractSymbolsFor(fileId, lastRoot, allFileIds)
    },
    extractReferences(content, fileId, index) {
      const lastRoot = [..._programCache.keys()].pop()
      if (!lastRoot) return []
      const allFileIds = _programCache.get(lastRoot)?.files || new Set()
      return extractReferencesFor(fileId, lastRoot, allFileIds, index)
    },
  }
}

module.exports = {
  makeParser,
  loadProgramFor,
  clearProgramFor,
  clearAllPrograms,
  isAvailable() { return loadTS() !== null },
}
