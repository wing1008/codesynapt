import fs from 'fs'
import path from 'path'
import { parse as babelParse } from '@babel/parser'
import traverseModule from '@babel/traverse'
const traverse = traverseModule.default || traverseModule

// ─── Public API ───────────────────────────────────────────────
// Returns { imports, routes?, apiCalls? }
//   imports  — file-to-file static dependency edges (see resolveImport)
//   routes   — server-side route declarations { method, path } in this file
//   apiCalls — client-side HTTP calls         { method, url }   from this file
// Routes + apiCalls are used to draw "full-stack" edges between client code
// that calls an URL and the server file that handles that URL.
export function parseFile(absPath, content, ext) {
  if (!content) return { imports: [] }
  try {
    let r
    switch (ext) {
      case 'js': case 'jsx': case 'mjs': case 'cjs':
      case 'ts': case 'tsx':
        r = parseJS(content); break
      case 'vue': case 'svelte': case 'astro':
        r = parseComponentFile(content); break
      case 'py': case 'pyw': case 'pyi':
        r = parsePython(content); break
      case 'ipynb': {
        // Jupyter notebook = JSON wrapper. Extract code cells and parse
        // them as Python (typical) / generic (R/Julia/etc). Bypass the
        // shared trailing logic because we MUST source routes/apiCalls/
        // URLs from the extracted code only — the raw JSON contains
        // hundreds of registry URLs from `metadata` that drown out
        // real API hosts.
        const ipy = parseIpynb(content)
        return {
          imports: ipy.imports,
          routes:        extractPyRoutes(ipy.codeContent),
          apiCalls:      extractPyApiCalls(ipy.codeContent),
          externalUrls:  extractExternalUrls(ipy.codeContent),
          dynamicPatterns: detectDynamicPatterns(ipy.codeContent, 'py'),
          envUsage:      extractEnvUsage(ipy.codeContent, 'py'),
        }
      }
      case 'lsp': case 'dcl': case 'lisp': case 'el':
        r = parseLisp(content); break
      case 'css': case 'scss': case 'sass': case 'less': case 'styl':
        r = parseCSS(content); break
      case 'html': case 'htm':
        r = parseHTML(content); break
      case 'md': case 'mdx':
        r = parseMarkdown(content); break
      case 'rs':
        r = parseRust(content); break
      case 'go':
        r = parseGo(content); break
      case 'java': case 'kt':
        r = parseJavaKotlin(content); break
      case 'cs':
        r = parseCSharp(content); break
      case 'swift':
        r = parseSwift(content); break
      case 'dart':
        r = parseDart(content); break
      case 'c': case 'cc': case 'cpp': case 'h': case 'hpp':
        r = parseC(content); break
      case 'rb':
        r = parseRuby(content); break
      case 'php':
        r = parsePHP(content); break
      case 'sh': case 'bash': case 'zsh':
        r = parseShell(content); break
      case 'ps1':
        r = parsePS1(content); break
      case 'clj': case 'scm':
        r = parseClojure(content); break
      case 'rst':
        r = parseRst(content); break
      case 'prisma':
        // Prisma schema file: no imports we'd track, but we DO want
        // db model extraction below. Return empty imports.
        r = { imports: [] }; break
      case 'json': case 'yaml': case 'yml': case 'toml': case 'xml': case 'sql':
        // Skip URL grep on these — package-lock.json and YAML lockfiles
        // contain hundreds of registry URLs that drown out real API hosts.
        return { imports: [] }
      default: {
        const g = parseGeneric(content)
        g.externalUrls = extractExternalUrls(content)
        return g
      }
    }
    // Layer on routes / apiCalls where applicable. Cheap regex passes —
    // false positives are filtered downstream during route↔call matching.
    if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs'
        || ext === 'ts' || ext === 'tsx') {
      r.routes   = extractJSRoutes(content)
      r.apiCalls = extractJSApiCalls(content)
    } else if (ext === 'py' || ext === 'pyw') {
      r.routes   = extractPyRoutes(content)
      r.apiCalls = extractPyApiCalls(content)
    } else if (ext === 'vue' || ext === 'svelte' || ext === 'astro') {
      // Component files: only the <script> block was passed to parseJS;
      // re-scan raw content for routes/apiCalls too (covers SFC <script setup>).
      r.routes   = extractJSRoutes(content)
      r.apiCalls = extractJSApiCalls(content)
    }
    r.externalUrls = extractExternalUrls(content)
    r.dynamicPatterns = detectDynamicPatterns(content, ext)
    r.envUsage = extractEnvUsage(content, ext)
    r.dbModels = extractDbModels(content, ext)
    // Cross-language / FFI edges — append to the regular imports list
    // so the existing edge-building pipeline picks them up.
    let ffi = []
    if (['js','jsx','mjs','cjs','ts','tsx'].includes(ext)) ffi = extractJsFfi(content)
    else if (ext === 'py' || ext === 'pyw') ffi = extractPyFfi(content)
    else if (ext === 'java' || ext === 'kt') ffi = extractJavaFfi(content)
    else if (ext === 'rs') ffi = extractRustFfi(content)
    if (ffi.length) {
      r.imports = (r.imports || []).concat(ffi.filter((e) => e.kind === 'ffi'))
    }
    r.confidence = confidenceFor(r.dynamicPatterns, content, ext)
    return r
  } catch {
    const g = parseGeneric(content)
    g.externalUrls = extractExternalUrls(content)
    g.dynamicPatterns = detectDynamicPatterns(content, ext)
    g.envUsage = extractEnvUsage(content, ext)
    g.dbModels = extractDbModels(content, ext)
    g.confidence = confidenceFor(g.dynamicPatterns, content, ext)
    return g
  }
}

// Graph completeness signal per file. Three buckets so the AI can
// decide how much to trust the import graph for this file:
//   - high   : pure static imports, no dynamic patterns
//   - medium : dynamic patterns present but bounded
//              (require(expr) / import(expr) / template literal)
//   - low    : reflection / eval / Function-constructor / DI markers —
//              the graph likely misses real edges from this file
//
// DI markers (NestJS/Angular decorators, tsyringe inject) are also
// strong "graph incomplete" signals because DI resolves dependencies
// at runtime via metadata.
function confidenceFor(dynamicPatterns, content, ext) {
  const patterns = dynamicPatterns || []
  // 1. Hard "low" signals from dynamic patterns
  const HARD = new Set(['eval', 'new Function', 'Reflect', 'exec'])
  if (patterns.some((p) => HARD.has(p))) return 'low'
  // 2. DI framework hints (low even with zero dynamic patterns) — JS/TS only
  const jsLike = ['js','jsx','mjs','cjs','ts','tsx','vue','svelte','astro'].includes(ext)
  if (jsLike && content) {
    // NestJS / Angular decorators: @Injectable / @Component (with parens)
    // also React's bare @Component but those are typed-decorators of classes.
    if (/@\s*(?:Injectable|Module|Controller)\s*\(/.test(content)) return 'low'
    if (/@\s*Component\s*\(/.test(content) &&
        /(?:^|\s)import[^;]*(?:@angular|@nestjs)\b/.test(content)) return 'low'
    // tsyringe / typed-inject: `inject<T>('TOKEN')` or `container.resolve(...)`
    if (/\b(?:container|resolver)\.(?:resolve|inject)\s*\(/.test(content)) return 'low'
    if (/\binject\s*<[^>]+>\s*\(/.test(content)) return 'low'
  }
  // 3. Other dynamic patterns → medium
  if (patterns.length > 0) return 'medium'
  // 4. Pure static → high
  return 'high'
}

// Detect patterns where modules/files are loaded dynamically — these
// resist static analysis, so a file with `hasDynamicResolution: true`
// should NEVER be treated as orphan with high confidence and any
// imports it makes are likely incomplete in our graph.
function detectDynamicPatterns(content, ext) {
  const found = []
  const jsLike = ['js','jsx','mjs','cjs','ts','tsx','vue','svelte','astro'].includes(ext)
  const pyLike = ['py','pyw'].includes(ext)
  if (jsLike) {
    // require(<expression>) where the arg isn't a plain string literal
    if (/\brequire\s*\(\s*(?!['"`][^'"`]*['"`]\s*\))/g.test(content)) found.push('require(expr)')
    // import(<expression>) - dynamic import
    if (/\bimport\s*\(\s*(?!['"`][^'"`]*['"`]\s*\))/g.test(content)) found.push('import(expr)')
    // Template literal in require/import that interpolates variables
    if (/\b(?:require|import)\s*\(\s*`[^`]*\$\{/g.test(content)) found.push('require/import template literal')
    // eval / new Function
    if (/\beval\s*\(/g.test(content)) found.push('eval')
    if (/\bnew\s+Function\s*\(/g.test(content)) found.push('new Function')
    // Reflection
    if (/\bReflect\s*\.\s*(?:get|apply|construct|ownKeys|invoke)/.test(content)) found.push('Reflect')
    // Computed property bracket access on require/import result (very rough)
    if (/\b(?:globalThis|window|self)\s*\[\s*[^'"\]]+\]/.test(content)) found.push('dynamic global access')
  }
  if (pyLike) {
    if (/\bimportlib\b/.test(content)) found.push('importlib')
    if (/\b__import__\s*\(/.test(content)) found.push('__import__')
    if (/\beval\s*\(/.test(content)) found.push('eval')
    if (/\bexec\s*\(/.test(content)) found.push('exec')
    if (/\bgetattr\s*\(/.test(content)) found.push('getattr')
  }
  return found  // empty array = no dynamic patterns
}

// Best-effort static string extraction for a Babel node. Catches:
//   - 'foo'                          StringLiteral
//   - `./foo`                        TemplateLiteral with no expressions
//   - VAR  where  const VAR = 'foo'  one-deep scope lookup (const binding only)
// Returns the resolved string or null.
function staticStringValue(node, scope) {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('')
  }
  if (node.type === 'Identifier' && scope) {
    const binding = scope.getBinding?.(node.name)
    if (!binding || binding.kind !== 'const') return null
    const init = binding.path?.node?.init
    if (init?.type === 'StringLiteral') return init.value
    if (init?.type === 'TemplateLiteral' && init.expressions.length === 0) {
      return init.quasis.map((q) => q.value.cooked).join('')
    }
  }
  return null
}

// ─── JS / TS via Babel ────────────────────────────────────────
function parseJS(content) {
  const imports = []
  let ast
  try {
    ast = babelParse(content, {
      sourceType: 'unambiguous',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx', 'typescript', 'decorators-legacy',
        'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator',
        'topLevelAwait', 'importMeta', 'numericSeparator',
      ],
    })
  } catch {
    return parseJSRegex(content)
  }

  try {
    traverse(ast, {
      ImportDeclaration(p) {
        imports.push({ spec: p.node.source.value, kind: 'import' })
      },
      ExportNamedDeclaration(p) {
        if (p.node.source) imports.push({ spec: p.node.source.value, kind: 'reexport' })
      },
      ExportAllDeclaration(p) {
        if (p.node.source) imports.push({ spec: p.node.source.value, kind: 'reexport' })
      },
      CallExpression(p) {
        const c = p.node.callee
        const args = p.node.arguments
        // require('...')  or  require(`./foo`)  or  require(CONST)
        if (c.type === 'Identifier' && c.name === 'require') {
          const spec = staticStringValue(args[0], p.scope)
          if (spec) imports.push({ spec, kind: 'import' })
        }
        // import('...') — JS dynamic import
        if (c.type === 'Import') {
          const spec = staticStringValue(args[0], p.scope)
          if (spec) imports.push({ spec, kind: 'dynamic' })
        }
        // jest.mock('./x') / vi.mock('./x') / proxyquire('./x', ...)
        if (c.type === 'MemberExpression'
            && c.property?.type === 'Identifier'
            && c.property.name === 'mock'
            && (c.object?.name === 'jest' || c.object?.name === 'vi')) {
          const spec = staticStringValue(args[0], p.scope)
          if (spec) imports.push({ spec, kind: 'mock' })
        }
      },
    })
  } catch {
    return parseJSRegex(content)
  }
  return { imports }
}

function parseJSRegex(content) {
  const imports = []
  const patterns = [
    [/import\s+(?:[^'"`;]*\s+from\s+)?['"]([^'"]+)['"]/g, 'import'],
    [/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'dynamic'],
    [/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'import'],
    [/export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g, 'reexport'],
  ]
  for (const [re, kind] of patterns) {
    let m
    while ((m = re.exec(content))) imports.push({ spec: m[1], kind })
  }
  return { imports }
}

// ─── Vue / Svelte / Astro (extract <script> + parse) ──────────
function parseComponentFile(content) {
  // Pull out <script>...</script> blocks (approximate)
  const scripts = []
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = scriptRe.exec(content))) scripts.push(m[1])
  const combined = scripts.join('\n')
  return parseJS(combined)
}

// ─── Python ───────────────────────────────────────────────────
function parsePython(content) {
  const imports = []
  const lines = content.split('\n')
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue
    let m
    // from X import Y   (X can include leading dots for relative)
    if ((m = line.match(/^\s*from\s+(\.+|[.\w]+)\s+import/))) {
      imports.push({ spec: m[1], kind: 'import' })
    }
    // import X, Y as Z
    else if ((m = line.match(/^\s*import\s+([\w.][\w.\s,]*)/))) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0].trim()
        if (clean) imports.push({ spec: clean, kind: 'import' })
      }
    }
    // importlib.import_module('foo') / __import__('foo') — string-arg
    // dynamic imports that are still statically resolvable.
    const dyn = line.match(/\b(?:importlib\.import_module|__import__)\(\s*['"]([^'"]+)['"]/)
    if (dyn) imports.push({ spec: dyn[1], kind: 'dynamic' })
  }
  return { imports }
}

// ─── Jupyter notebook (.ipynb) ────────────────────────────────
// Parse a notebook's code cells. Returns { imports, codeContent }
// where codeContent is the concatenated source of every code cell —
// the caller uses it for URL / route / apiCall extraction so the raw
// JSON metadata doesn't pollute those signals.
function parseIpynb(content) {
  let nb
  try { nb = JSON.parse(content) } catch { return { imports: [], codeContent: '' } }
  if (!nb || !Array.isArray(nb.cells)) return { imports: [], codeContent: '' }
  const lang = (nb.metadata?.kernelspec?.language || 'python').toLowerCase()
  const parts = []
  for (const cell of nb.cells) {
    if (cell.cell_type !== 'code') continue
    const src = cell.source
    if (typeof src === 'string') parts.push(src)
    else if (Array.isArray(src)) parts.push(src.join(''))
  }
  const codeContent = parts.join('\n')
  // Strip IPython magics (% / !) so parsePython doesn't get confused.
  // `%matplotlib inline`, `!pip install foo` etc. aren't imports we want.
  const cleaned = codeContent.split('\n')
    .filter((l) => !/^\s*[%!]/.test(l))
    .join('\n')
  // Most notebooks are Python; R/Julia fall back to generic (URL only).
  const r = lang.startsWith('python') ? parsePython(cleaned) : parseGeneric(cleaned)
  return { imports: r.imports || [], codeContent: cleaned }
}

// ─── Lisp / AutoLISP ──────────────────────────────────────────
function parseLisp(content) {
  const imports = []
  const patterns = [
    /\(\s*load\s+"([^"]+)"/g,
    /\(\s*vl-arx-import\s+"([^"]+)"/g,
    /\(\s*autoload\s+"([^"]+)"/g,
    /\(\s*require\s+(?:'|")([^"')]+)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  }
  return { imports }
}

// ─── CSS family ───────────────────────────────────────────────
function parseCSS(content) {
  const imports = []
  const patterns = [
    /@import\s+(?:url\()?['"]([^'")]+)['"]/g,
    /@use\s+['"]([^'"]+)['"]/g,       // SCSS
    /@forward\s+['"]([^'"]+)['"]/g,
    /url\(\s*['"]([^'")]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  }
  return { imports }
}

// ─── HTML ─────────────────────────────────────────────────────
function parseHTML(content) {
  const imports = []
  const patterns = [
    /<script\s+[^>]*src\s*=\s*['"]([^'"]+)['"]/gi,
    /<link\s+[^>]*href\s*=\s*['"]([^'"]+)['"]/gi,
    /<img\s+[^>]*src\s*=\s*['"]([^'"]+)['"]/gi,
    /<iframe\s+[^>]*src\s*=\s*['"]([^'"]+)['"]/gi,
    /<video\s+[^>]*src\s*=\s*['"]([^'"]+)['"]/gi,
    /<source\s+[^>]*src\s*=\s*['"]([^'"]+)['"]/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(content))) {
      const spec = m[1]
      if (spec.startsWith('http://') || spec.startsWith('https://') ||
          spec.startsWith('//') || spec.startsWith('data:')) continue
      imports.push({ spec, kind: 'asset' })
    }
  }
  return { imports }
}

// ─── Markdown ─────────────────────────────────────────────────
function parseMarkdown(content) {
  const imports = []
  // ![alt](path) and [text](path)  — exclude URLs
  const re = /\[(?:[^\]]*)\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(content))) {
    const spec = m[1].trim().split(/\s+/)[0]
    if (!spec || /^https?:\/\//.test(spec) || spec.startsWith('#')
        || spec.startsWith('mailto:')) continue
    imports.push({ spec, kind: 'ref' })
  }
  return { imports }
}

// ─── Rust / Go / Java / C / Ruby / PHP / Shell ────────────────
function parseRust(content) {
  // mod X;  use crate::X::Y;  use super::X;
  const imports = []
  const re = /^\s*(?:mod\s+(\w+)|use\s+([\w:]+))/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1] || m[2], kind: 'import' })
  return { imports }
}

function parseGo(content) {
  const imports = []
  // import "pkg"  or  import ( "a" "b" )
  const single = /import\s+"([^"]+)"/g
  const block = /import\s*\(\s*([\s\S]*?)\)/g
  let m
  while ((m = single.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  while ((m = block.exec(content))) {
    const inner = m[1]
    const innerRe = /"([^"]+)"/g
    let mm
    while ((mm = innerRe.exec(inner))) imports.push({ spec: mm[1], kind: 'import' })
  }
  return { imports }
}

function parseJavaKotlin(content) {
  const imports = []
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  return { imports }
}

function parseC(content) {
  const imports = []
  const re = /#\s*include\s+[<"]([^>"]+)[>"]/g
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  return { imports }
}

function parseRuby(content) {
  const imports = []
  const re = /^\s*(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  return { imports }
}

function parsePHP(content) {
  const imports = []
  const re = /(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  return { imports }
}

function parseShell(content) {
  const imports = []
  const re = /^\s*(?:source|\.)\s+(['"]?)([^\s'";]+)\1/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[2], kind: 'import' })
  return { imports }
}

// C# — `using Namespace;`, `using static System.Math;`, `using Alias = Path;`
function parseCSharp(content) {
  const imports = []
  // Three forms; capture the namespace path in group 1
  const re = /^\s*using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'using' })
  return { imports }
}

// Swift — `import Module`, `@_exported import Module`,
//   `import struct ModuleA.Foo`, `@testable import ModuleB`
function parseSwift(content) {
  const imports = []
  const re = /^\s*(?:@\w+\s+)?import\s+(?:(?:class|struct|enum|protocol|typealias|func|var|let)\s+)?([A-Za-z_][\w.]*)/gm
  let m
  while ((m = re.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  return { imports }
}

// Dart — `import 'package:foo/bar.dart';`, `import 'src/foo.dart';`,
//   `export 'src/x.dart';`, `part 'foo.g.dart';`, `part of 'main.dart';`
// All four are recorded; resolveImport handles `dart:` / `package:` /
// relative resolution. The `part of` directive lands here too — its
// spec points back at the parent library file, which is a legitimate
// dependency edge in our graph.
function parseDart(content) {
  const imports = []
  const re = /^\s*(import|export|part(?:\s+of)?)\s+['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(content))) {
    const kw = m[1].split(/\s+/)[0]  // 'part of' → 'part'
    imports.push({ spec: m[2], kind: kw })
  }
  return { imports }
}

// PowerShell — `. ./path.ps1` (dot-source), `Import-Module Name`,
//   `Import-Module ./local/Mod.psm1`, `using module ./path`
function parsePS1(content) {
  const imports = []
  // dot-source: . <path>
  const dotRe = /^\s*\.\s+(?:&\s*)?(['"]?)([^\s'";|]+)\1/gm
  let m
  while ((m = dotRe.exec(content))) {
    if (m[2] && m[2] !== '..') imports.push({ spec: m[2], kind: 'source' })
  }
  // Import-Module Name [-Name] (handles -Name flag)
  const impRe = /(?:Import-Module|using\s+module)\s+(?:-Name\s+)?(['"]?)([^\s'";|,]+)\1/gi
  while ((m = impRe.exec(content))) {
    imports.push({ spec: m[2], kind: 'import-module' })
  }
  return { imports }
}

// Clojure / Scheme — `(require '[ns :as alias])`, `(use 'ns)`,
//   `(:require [ns ...] [ns2 ...])`, `(:use ns)`
function parseClojure(content) {
  const imports = []
  // Step 1: locate each require/use/import form's body.
  const formRe = /\((?::?(?:require|use|import))\s+([\s\S]*?)\)/g
  let block
  while ((block = formRe.exec(content))) {
    const body = block[1]
    // Step 2a: vector form — `[ns :as alias]` or `[ns :refer [...]]`
    const vecRe = /\[\s*([a-zA-Z][\w.\-]*)/g
    let v
    while ((v = vecRe.exec(body))) imports.push({ spec: v[1], kind: 'require' })
    // Step 2b: quoted symbol form — `'ns`
    const symRe = /'([a-zA-Z][\w.\-]+)/g
    let s
    while ((s = symRe.exec(body))) imports.push({ spec: s[1], kind: 'require' })
  }
  return { imports }
}

// reStructuredText — `.. include:: path`, `.. literalinclude:: path`,
//   `:doc:\`path\``
function parseRst(content) {
  const imports = []
  const incRe = /^\.\.\s*(?:include|literalinclude|figure|image)\s*::\s*(\S+)/gm
  let m
  while ((m = incRe.exec(content))) imports.push({ spec: m[1], kind: 'include' })
  // :doc:`path` cross-reference
  const docRe = /:doc:`([^`<]+)`/g
  while ((m = docRe.exec(content))) {
    imports.push({ spec: m[1].trim(), kind: 'doc' })
  }
  return { imports }
}

function parseGeneric(content) {
  // Last-resort: catch obviously-relative path-looking string literals
  // (kept restrictive to avoid noise)
  return { imports: [] }
}

// ─── Full-stack: route + API call extraction ────────────────
//
// We do NOT try to perfectly understand every framework. We capture the
// dominant patterns (Express/Fastify/Koa/Hono on Node, Flask/FastAPI on
// Python) with regex. Anything trickier (route mounting via app.use,
// generated routes, file-based routing) is out of scope — false positives
// are filtered later because we only emit an edge if both sides exist.

const HTTP_METHODS = ['get','post','put','patch','delete','head','options','all']

function extractJSRoutes(content) {
  const routes = []
  // First pass: collect Express-style mount prefixes within this file.
  // Example:
  //   const usersRouter = express.Router()
  //   usersRouter.get('/list', ...)              ← path is '/list'
  //   app.use('/api/users', usersRouter)         ← gives prefix '/api/users'
  // → emit one route { method:'GET', path:'/api/users/list' }
  //
  // Same-file only — cross-file router mount resolution would need
  // a global pass (deferred).
  const mountRe = /\b(?:app|server|router|api)\.use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*(\w+)\s*\)/g
  const mounts = new Map()  // varName -> prefix
  let mm
  while ((mm = mountRe.exec(content))) {
    const prefix = mm[1].replace(/\/$/, '')   // strip trailing slash
    mounts.set(mm[2], prefix)
  }

  // Method handlers — capture the receiver name too so we can resolve
  // its mount prefix from `mounts`. The trailing capture grabs whatever
  // follows the path string up to the closing `)` so we can pluck a
  // named handler identifier (`getUserHandler` in
  // `app.get('/u', getUserHandler)`).
  const methodRe = new RegExp(
    `\\b(\\w+)\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,([^)]*)\\)`,
    'g'
  )
  // Only treat the call as a route if the receiver looks like a
  // router/app variable. We accept:
  //   - well-known names: app, router, server, api, fastify, hono, express, route
  //   - any variable that is the target of a `<name>.use('/prefix', X)`
  //     mount (those *receive* sub-routes after mounting)
  //   - any variable assigned from `express.Router()` / `Router()` / `Hono()` / `new Hono()`
  const knownReceivers = new Set(['app', 'router', 'server', 'api', 'fastify', 'hono', 'express', 'route'])
  const factoryRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+)?(?:express\.Router|Router|Hono)\s*\(/g
  let fm
  while ((fm = factoryRe.exec(content))) knownReceivers.add(fm[1])
  // mounted variables (X in app.use('/p', X)) are also valid receivers
  for (const v of mounts.keys()) knownReceivers.add(v)

  let m
  while ((m = methodRe.exec(content))) {
    const receiver = m[1]
    if (!knownReceivers.has(receiver)) continue
    const method = m[2].toUpperCase()
    const localPath = m[3]
    // If this receiver is a mounted router, prepend its prefix
    const prefix = mounts.get(receiver) || ''
    const full = prefix && localPath.startsWith('/')
      ? prefix + (localPath === '/' ? '' : localPath)
      : localPath
    // Pull a named handler identifier from the remaining args, if any.
    // Catches `app.get('/u', getUser)` and `app.get('/u', auth, getUser)`
    // but skips inline arrows / function expressions which can't be
    // matched to a symbol anyway.
    const handlerStr = (m[4] || '').trim()
    let handler = null
    const handlerMatch = handlerStr.match(/([A-Za-z_$][\w$]*)\s*$/)
    if (handlerMatch && !/(=>|function|\{)/.test(handlerStr)) {
      handler = handlerMatch[1]
    }
    routes.push({ method, path: full, handler })
  }
  // Fastify object form: fastify.route({ method: 'GET', url: '/users' })
  const fastifyObjRe = /\.route\s*\(\s*\{[^}]*?method\s*:\s*['"`](\w+)['"`][^}]*?url\s*:\s*['"`]([^'"`]+)['"`]/g
  while ((m = fastifyObjRe.exec(content))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] })
  }
  return routes
}

// Generic "find every http(s)/ws(s) URL string in source" pass. Catches
// URLs that the specific apiCall extractors miss: variable-built URLs,
// SDK constants, WebSocket connects, HTML <img src=...>, comments-as-doc,
// etc. We grep liberally — false positives (e.g. README URLs in
// comments) are acceptable here because the goal is "what external hosts
// could this project ever talk to". The renderer/CLI groups by domain so
// duplicates collapse naturally.
const EXT_URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+|wss?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g
const URL_TRIM_RE = /[.,;:'"`)\]}>\\]+$/
// ─── DB schema extractors ─────────────────────────────────────
// Three ORM/schema dialects, all heuristic regex (no full parsing):
//   - Prisma (.prisma)        `model X { name Type }`
//   - Drizzle (TS/JS)         `pgTable('x', { ... })`
//   - SQLAlchemy (Python)     `class X(Base): __tablename__ = '...'`
// Returns: [{ kind, name, tableName?, fields: [{name,type}] }]

function parsePrismaSchema(content) {
  const models = []
  // model Foo { ... } and enum Foo { ... }
  const re = /\b(model|enum)\s+(\w+)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(content))) {
    const kind = m[1]  // 'model' | 'enum'
    const name = m[2]
    const fields = []
    for (const raw of m[3].split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      // For enums, each non-empty line is a value
      if (kind === 'enum') { fields.push({ name: line.split(/\s+/)[0], type: 'enum-value' }); continue }
      const fm = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/)
      if (fm) fields.push({ name: fm[1], type: fm[2] + (fm[3] || '') + (fm[4] || '') })
    }
    models.push({ kind: 'prisma-' + kind, name, fields })
  }
  return models
}

function extractDrizzleTables(content) {
  if (!/(?:pg|mysql|sqlite)Table\s*\(/.test(content)) return []
  const tables = []
  // pgTable('users', { id: serial('id').primaryKey(), ... })
  // We grab the table name then walk braces manually to handle nested {}.
  const re = /(?:export\s+(?:const|let|var)\s+(\w+)\s*=\s*)?(?:pg|mysql|sqlite)Table\s*\(\s*['"`](\w+)['"`]\s*,\s*\{/g
  let m
  while ((m = re.exec(content))) {
    const varName = m[1] || m[2]
    const tableName = m[2]
    // Find matching }
    const start = re.lastIndex
    let depth = 1, i = start
    while (i < content.length && depth > 0) {
      const c = content[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    const body = content.slice(start, i - 1)
    const fields = []
    const fre = /(\w+)\s*:\s*(\w+)\(/g
    let fm
    while ((fm = fre.exec(body))) fields.push({ name: fm[1], type: fm[2] })
    tables.push({ kind: 'drizzle', name: varName, tableName, fields })
  }
  return tables
}

function extractSQLAlchemyModels(content) {
  // class X(Base) or class X(db.Model) or class X(sa.orm.DeclarativeBase)
  if (!/class\s+\w+\s*\(\s*(?:Base|db\.Model|DeclarativeBase|orm\.DeclarativeBase)/.test(content)) return []
  const models = []
  // Split on each `class ` start so the per-class body (including blank
  // lines) is captured cleanly, rather than trying to write a regex
  // that handles empty lines + dedent boundaries.
  const chunks = content.split(/(?=^class\s)/m)
  for (const chunk of chunks) {
    const head = chunk.match(/^class\s+(\w+)\s*\(\s*(?:Base|db\.Model|sa\.orm\.DeclarativeBase|DeclarativeBase|orm\.DeclarativeBase)[^)]*\)\s*:/)
    if (!head) continue
    const name = head[1]
    const body = chunk.slice(head[0].length)
    const fields = []
    const fre = /^\s+(\w+)\s*(?::\s*[\w[\],\s]+)?\s*=\s*(?:Column|mapped_column|Mapped|relationship)\s*\(\s*(\w+)?/gm
    let fm
    while ((fm = fre.exec(body))) fields.push({ name: fm[1], type: fm[2] || 'unknown' })
    let tableName = null
    const tn = body.match(/__tablename__\s*=\s*['"](\w+)['"]/)
    if (tn) tableName = tn[1]
    // Skip empty marker classes (like a project's own `class Base(DeclarativeBase)`)
    if (fields.length === 0 && !tableName) continue
    models.push({ kind: 'sqlalchemy', name, tableName, fields })
  }
  return models
}

// Cross-language / FFI imports — point at a non-source artefact
// that another file in the repo provides (WASM / .node addon /
// shared library). Returns extra `imports` entries with
// kind: 'ffi' so the regular resolver can link them when the
// target file is indexed.
function extractJsFfi(content) {
  const out = []
  // WebAssembly:  fetch('x.wasm') / readFileSync('x.wasm')
  //               WebAssembly.compile(await fetch('x.wasm').then(r=>r.arrayBuffer()))
  const wasmRe = /['"`]([^'"`]+\.wasm)['"`]/g
  let m
  while ((m = wasmRe.exec(content))) out.push({ spec: m[1], kind: 'ffi' })
  // Native node addons:   require('./build/Release/foo.node')
  const nodeRe = /['"`]([^'"`]+\.node)['"`]/g
  while ((m = nodeRe.exec(content))) out.push({ spec: m[1], kind: 'ffi' })
  // node-bindings:        require('bindings')('foo')
  const bindingsRe = /require\s*\(\s*['"`]bindings['"`]\s*\)\s*\(\s*['"`]([^'"`]+)['"`]/g
  while ((m = bindingsRe.exec(content))) out.push({ spec: m[1] + '.node', kind: 'ffi' })
  return out
}

function extractPyFfi(content) {
  const out = []
  // ctypes:  ctypes.CDLL('./libfoo.so') / CDLL('foo.dylib')
  const dllRe = /(?:ctypes\.)?CDLL\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = dllRe.exec(content))) out.push({ spec: m[1], kind: 'ffi' })
  // cffi:    ffi.dlopen('foo.so')
  const cffiRe = /\.dlopen\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = cffiRe.exec(content))) out.push({ spec: m[1], kind: 'ffi' })
  // CPython convention: `import _foo` / `from _foo import ...`
  // (single leading underscore => compiled extension)
  const extRe = /^(?:from\s+_(\w+)\s+import|import\s+_(\w+))/gm
  while ((m = extRe.exec(content))) {
    const mod = m[1] || m[2]
    if (mod) out.push({ spec: '_' + mod, kind: 'ffi' })
  }
  return out
}

// Java JNI:  System.loadLibrary("foo") → foo.so / foo.dll target
function extractJavaFfi(content) {
  const out = []
  const re = /System\.loadLibrary\s*\(\s*"([^"]+)"\s*\)/g
  let m
  while ((m = re.exec(content))) out.push({ spec: m[1], kind: 'ffi' })
  return out
}

// Rust:  extern "C" { fn foo(...); } blocks signal FFI boundary.
// We just count the block existence as a coarse marker.
function extractRustFfi(content) {
  const out = []
  const re = /extern\s+"C"\s*\{/g
  let count = 0
  while (re.exec(content)) count++
  if (count > 0) out.push({ spec: 'extern-c', kind: 'ffi-marker', count })
  return out
}

function extractMongooseModels(content) {
  if (!/\bmongoose\b/.test(content)) return []
  const models = []
  // `const User = mongoose.model('User', userSchema)`
  //  or `mongoose.model('User', new Schema({...}))`
  const re = /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?mongoose\.model\s*\(\s*['"`](\w+)['"`]/g
  let m
  while ((m = re.exec(content))) {
    models.push({ kind: 'mongoose', name: m[2], varName: m[1] || m[2], fields: [] })
  }
  return models
}

// TypeORM `@Entity()` + `class Foo { @Column() bar: string }` — best-effort
function extractTypeOrmEntities(content) {
  if (!/@Entity\s*\(/.test(content)) return []
  const out = []
  const re = /@Entity\s*\(\s*(?:['"`](\w+)['"`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g
  let m
  while ((m = re.exec(content))) {
    out.push({ kind: 'typeorm', name: m[2], tableName: m[1] || null, fields: [] })
  }
  return out
}

function extractDbModels(content, ext) {
  if (!content) return []
  if (ext === 'prisma') return parsePrismaSchema(content)
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return [
      ...extractDrizzleTables(content),
      ...extractMongooseModels(content),
      ...extractTypeOrmEntities(content),
    ]
  }
  if (ext === 'py' || ext === 'pyw') return extractSQLAlchemyModels(content)
  return []
}

// Extract environment-variable references — `process.env.X`,
// `os.environ['X']`, `os.Getenv("X")`, shell `${X}`, etc. We require
// the name to start with an uppercase letter and contain only
// uppercase/digit/underscore to keep false positives low (no random
// `process.env.foo` from minified output, etc).
function extractEnvUsage(content, ext) {
  if (!content) return []
  const found = new Set()
  const patterns = [
    // JS / TS / Node / Vite / Next
    /process\.env\.([A-Z][A-Z0-9_]+)\b/g,
    /process\.env\[['"`]([A-Z][A-Z0-9_]+)['"`]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]+)\b/g,
    // Python
    /os\.environ\[['"`]([A-Z][A-Z0-9_]+)['"`]\]/g,
    /os\.environ\.get\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
    /os\.getenv\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
    // Go / Java / Rust / Ruby / C
    /os\.Getenv\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
    /System\.getenv\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
    /env::var\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
    /ENV\[['"`]([A-Z][A-Z0-9_]+)['"`]\]/g,
    /\bgetenv\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g,
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content))) found.add(m[1])
  }
  // Shell-style ${VAR} — only on shell-like files to avoid false hits
  // from JS template literals.
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' || ext === 'psm1') {
    const sh = /\$\{?([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}?/g
    let m
    while ((m = sh.exec(content))) found.add(m[1])
  }
  return [...found]
}

function extractExternalUrls(content) {
  const seen = new Map()  // url -> count
  let m
  EXT_URL_RE.lastIndex = 0
  while ((m = EXT_URL_RE.exec(content))) {
    let url = m[0]
    // Strip trailing punctuation that the greedy regex captures from
    // surrounding prose: "see https://x.com." → "https://x.com"
    url = url.replace(URL_TRIM_RE, '')
    if (url.length < 12) continue   // arbitrary minimum to drop "http://x"
    seen.set(url, (seen.get(url) || 0) + 1)
  }
  return [...seen.entries()].map(([url, count]) => ({ url, count }))
}

function extractJSApiCalls(content) {
  const calls = []
  // fetch('/api/users', { method: 'POST' })  or  fetch(`/api/${x}`)
  const fetchRe = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{([^}]*)\})?/g
  let m
  while ((m = fetchRe.exec(content))) {
    const url = m[1]
    if (!looksLikeUrl(url)) continue
    let method = 'GET'
    if (m[2]) {
      const mm = m[2].match(/method\s*:\s*['"`](\w+)['"`]/)
      if (mm) method = mm[1].toUpperCase()
    }
    calls.push({ method, url })
  }
  // axios.get('/api/users'), axios.post(...), got.get(...), etc.
  const axiosRe = new RegExp(
    `\\b(?:axios|got|ky|request|http|api|client)\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )
  while ((m = axiosRe.exec(content))) {
    const url = m[2]
    if (!looksLikeUrl(url)) continue
    calls.push({ method: m[1].toUpperCase(), url })
  }
  // axios({ url: '/api/x', method: 'POST' })  /  axios.request({ url, method })
  const axiosObjRe = /\b(?:axios|got|ky|request|http|api|client)(?:\.request)?\s*\(\s*\{([^}]*)\}/g
  while ((m = axiosObjRe.exec(content))) {
    const body = m[1]
    const um = body.match(/url\s*:\s*['"`]([^'"`]+)['"`]/)
    if (!um) continue
    const url = um[1]
    if (!looksLikeUrl(url)) continue
    let method = 'GET'
    const mm = body.match(/method\s*:\s*['"`](\w+)['"`]/)
    if (mm) method = mm[1].toUpperCase()
    calls.push({ method, url })
  }
  // SWR / React Query convenience: useFetch('/api/x'), useSWR('/api/x')
  const hookRe = /\buse(?:Fetch|SWR|Query|Data|AsyncData)\s*\(\s*['"`]([^'"`]+)['"`]/g
  while ((m = hookRe.exec(content))) {
    const url = m[1]
    if (!looksLikeUrl(url)) continue
    calls.push({ method: 'GET', url })
  }
  // Nuxt 3 / Nitro: $fetch('/api/x'), ofetch('/api/x')
  const nitroRe = /(?:\$fetch|\bofetch)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{([^}]*)\})?/g
  while ((m = nitroRe.exec(content))) {
    const url = m[1]
    if (!looksLikeUrl(url)) continue
    let method = 'GET'
    if (m[2]) {
      const mm = m[2].match(/method\s*:\s*['"`](\w+)['"`]/)
      if (mm) method = mm[1].toUpperCase()
    }
    calls.push({ method, url })
  }
  // Template literal with leading static prefix:
  //   fetch(`/api/users/${id}`)  → emit '/api/users/'
  // Route matching downstream treats it as a prefix that the route
  // regex must consume. Limited to fetch/$fetch + identifier.method to
  // bound false positives.
  const templateRe = /\b(?:fetch|\$fetch|ofetch|axios|got|ky|api|client|http|request)(?:\.\w+)?\s*\(\s*`(\/[\w/-]+\/)\$\{/g
  while ((m = templateRe.exec(content))) {
    const url = m[1]   // e.g. '/api/users/'
    if (!looksLikeUrl(url) || url.length < 5) continue
    calls.push({ method: 'ANY', url, partial: true })
  }
  // ── SDK instance tracking (P2·4) ──────────────────────────
  // axios.create() / got.extend() / ky.create() / ofetch.create():
  //   const myClient = axios.create({ baseURL: 'https://x' })
  //   myClient.get('/users')   ← treat the same as axios.get('/users')
  // We collect all such variable names first, then run a second method-
  // match pass using just those names. baseURL is intentionally ignored
  // (mixing http://prefix and /path is fuzzy; downstream route↔fetch
  // matcher only needs the relative path).
  const sdkInstanceRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:axios|got|ky|ofetch)\.(?:create|extend)\s*\(/g
  const sdkInstances = new Set()
  while ((m = sdkInstanceRe.exec(content))) sdkInstances.add(m[1])
  // Also: const api = useApi() / createApi() patterns common in Vue/React
  // (these resolve to axios-shaped instances)
  const factoryRe = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:useApi|createApi|createClient|useFetch)\s*\(/g
  while ((m = factoryRe.exec(content))) sdkInstances.add(m[1])
  for (const name of sdkInstances) {
    const reLiteral = new RegExp(`\\b${name}\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
    let mm
    while ((mm = reLiteral.exec(content))) {
      const url = mm[2]
      if (!looksLikeUrl(url)) continue
      calls.push({ method: mm[1].toUpperCase(), url, via: 'sdk-instance' })
    }
    // Template-literal prefix for the same instance
    const reTpl = new RegExp(`\\b${name}\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*\`(\\/[\\w/-]+\\/)\\$\\{`, 'g')
    while ((mm = reTpl.exec(content))) {
      calls.push({ method: mm[1].toUpperCase(), url: mm[2], via: 'sdk-instance', partial: true })
    }
  }
  // ── tRPC procedure calls (P2·4 — informational, no URL match) ──
  // trpc.users.list.useQuery() / trpc.posts.create.mutate(...)
  // We can't match these against server routes (URLs are implicit),
  // but record them for visibility under apiCalls with method='RPC'.
  const trpcRe = /\btrpc(?:\.[A-Za-z_][\w]*)+\.(?:useQuery|useMutation|query|mutate)\s*\(/g
  while ((m = trpcRe.exec(content))) {
    // extract "trpc.<a>.<b>....method" — keep the procedure path
    const segs = m[0].replace(/\s*\($/, '').split('.')
    // ['trpc', 'users', 'list', 'useQuery']
    const proc = segs.slice(1, -1).join('.')   // 'users.list'
    if (proc) calls.push({ method: 'RPC', url: 'trpc:' + proc, via: 'trpc' })
  }
  // Dedup. Same (method, url) → keep the most informative entry:
  // an entry with `via: 'sdk-instance'` wins over the generic axiosRe
  // match (because sdk-instance correctly attributed it to the actual
  // SDK variable, not the bare keyword).
  const byKey = new Map()
  for (const c of calls) {
    const k = c.method + '|' + c.url
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, c); continue }
    // Prefer entries with via (sdk-instance > unmarked)
    if (!prev.via && c.via) byKey.set(k, c)
  }
  return [...byKey.values()]
}

function extractPyRoutes(content) {
  const routes = []
  // Flask:
  //   @app.route('/users', methods=['GET','POST'])
  //   @app.get('/users')
  //   @bp.route('/x')
  // FastAPI:
  //   @app.get('/users')
  //   @router.post('/users/{id}')
  const decRe = new RegExp(
    `@\\s*(?:[\\w]+)\\.(${HTTP_METHODS.join('|')}|route)\\s*\\(\\s*['"]([^'"]+)['"]([^)]*)\\)`,
    'g'
  )
  let m
  while ((m = decRe.exec(content))) {
    const verb = m[1].toLowerCase()
    const path = m[2]
    if (verb === 'route') {
      // Flask: @app.route('/x', methods=['POST','GET'])
      const mm = m[3].match(/methods\s*=\s*\[([^\]]+)\]/i)
      if (mm) {
        const methods = [...mm[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase())
        for (const method of methods) routes.push({ method, path })
      } else {
        routes.push({ method: 'GET', path })   // Flask default
      }
    } else {
      routes.push({ method: verb.toUpperCase(), path })
    }
  }
  return routes
}

// File-system server-route extractors for popular meta-frameworks.
// Each helper looks at the path id to decide if a file is a route,
// then peeks at the content for method-specific exports.

const HTTP_VERBS_FS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function methodsExportedFromContent(content) {
  const found = []
  for (const verb of HTTP_VERBS_FS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${verb}\\b|const\\s+${verb}\\s*=)`)
    if (re.test(content)) found.push(verb)
  }
  return found
}
function normalizeFsDynamic(p) {
  return p.replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1')
}

// Next.js: src/app/api/<seg>/route.<ext>  or  src/pages/api/<seg>.<ext>
export function extractNextApiRoutes(id, content) {
  if (!id || !content) return []
  let m, basePath
  if ((m = id.match(/^(?:src\/)?app\/(api\/.+)\/route\.(?:tsx|jsx|ts|js)$/))) {
    basePath = '/' + m[1]
  } else if ((m = id.match(/^(?:src\/)?pages\/(api\/.+)\.(?:tsx|jsx|ts|js)$/))) {
    basePath = '/' + m[1].replace(/\/index$/, '')
  }
  if (!basePath) return []
  basePath = normalizeFsDynamic(basePath)
  const methods = methodsExportedFromContent(content)
  if (methods.length > 0) return methods.map((method) => ({ method, path: basePath }))
  if (/export\s+default\s+(?:async\s+)?function/.test(content)) {
    return [{ method: 'ANY', path: basePath }]
  }
  return []
}

// Nuxt 3 / Nitro: server/api/<seg>.<ext>  or  server/routes/<seg>.<ext>
// Filename suffix can carry method: `foo.post.ts` → POST /api/foo
// Otherwise body: `defineEventHandler({ method: 'X' })` or default ANY.
export function extractNuxtServerRoutes(id, content) {
  if (!id || !content) return []
  const m = id.match(/^server\/(api|routes)\/(.+)\.(?:ts|js|mts|cts)$/)
  if (!m) return []
  let basePath = '/' + m[1] + '/' + m[2].replace(/\/index$/, '')
  // Method suffix in filename
  const suffixMatch = basePath.match(/^(.*)\.(get|post|put|patch|delete|head|options)$/)
  let methodFromName = null
  if (suffixMatch) { basePath = suffixMatch[1]; methodFromName = suffixMatch[2].toUpperCase() }
  basePath = normalizeFsDynamic(basePath)
  if (methodFromName) return [{ method: methodFromName, path: basePath }]
  // defineEventHandler({ method: 'POST', ... })
  const verbs = []
  const objRe = /defineEventHandler\s*\(\s*\{[^}]*?method\s*:\s*['"`](\w+)['"`]/g
  let mm
  while ((mm = objRe.exec(content))) verbs.push(mm[1].toUpperCase())
  if (verbs.length > 0) return verbs.map((method) => ({ method, path: basePath }))
  if (/(?:export\s+default\s+)?defineEventHandler/.test(content)) {
    return [{ method: 'ANY', path: basePath }]
  }
  return []
}

// SvelteKit: src/routes/<seg>/+server.<ext>  or  src/routes/+server.<ext>
export function extractSvelteKitServerRoutes(id, content) {
  if (!id || !content) return []
  let m, basePath
  if ((m = id.match(/^(?:src\/)?routes\/(.+)\/\+server\.(?:ts|js)$/))) {
    basePath = '/' + m[1]
  } else if (/^(?:src\/)?routes\/\+server\.(?:ts|js)$/.test(id)) {
    basePath = '/'
  }
  if (!basePath) return []
  basePath = normalizeFsDynamic(basePath)
  const methods = methodsExportedFromContent(content)
  if (methods.length === 0) return []
  return methods.map((method) => ({ method, path: basePath }))
}

function extractPyApiCalls(content) {
  const calls = []
  // requests.get('http://...'), httpx.post('/x'), urllib...
  const re = new RegExp(
    `\\b(?:requests|httpx|aiohttp|urllib|httplib2|session)\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"]([^'"]+)['"]`,
    'g'
  )
  let m
  while ((m = re.exec(content))) {
    const url = m[2]
    if (!looksLikeUrl(url)) continue
    calls.push({ method: m[1].toUpperCase(), url })
  }
  // session.request('POST', '/x', ...) / client.request(method='POST', url='/x')
  const reqRe = /\b(?:requests|httpx|aiohttp|session|client)\.request\s*\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]+)['"]/g
  while ((m = reqRe.exec(content))) {
    const url = m[2]
    if (!looksLikeUrl(url)) continue
    calls.push({ method: m[1].toUpperCase(), url })
  }
  return calls
}

// Conservative URL filter: keep things that look like an HTTP path or
// an absolute http(s) URL. Reject bare specifiers, file paths, anchors.
function looksLikeUrl(s) {
  if (!s) return false
  if (s.startsWith('/') && !s.startsWith('//')) return true
  if (/^https?:\/\//i.test(s)) return true
  return false
}

// Normalize an API call URL or route path into a comparable form:
// strips origin, query, hash, trailing slash; lowercases method.
// Returns the path string starting with "/".
export function normalizeUrlPath(u) {
  if (!u) return ''
  let s = u.split('?')[0].split('#')[0].trim()
  // Strip protocol+host
  s = s.replace(/^https?:\/\/[^/]+/i, '')
  // Trim multiple slashes
  s = s.replace(/\/+/g, '/')
  // Ensure leading /
  if (!s.startsWith('/')) s = '/' + s
  // Trim trailing slash (except root)
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Build a regex from a route path with dynamic segments.
// Supports: :id, {id}, <id>, <int:id>, *  → matches one path segment.
export function routePathToRegex(p) {
  const norm = normalizeUrlPath(p)
  // Two-pass: replace dynamic placeholders with sentinels BEFORE we
  // escape regex metas, then re-substitute the sentinels with the
  // actual regex patterns. Avoids order-of-escaping headaches.
  const PARAM = ''
  const WILD  = ''
  let s = norm
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PARAM)
    .replace(/\{[^}]+\}/g, PARAM)
    .replace(/<[^>]+>/g, PARAM)
    .replace(/\*/g, WILD)
  s = s.replace(/[.+?^$()|[\]\\{}]/g, '\\$&')
  s = s.replace(new RegExp(PARAM, 'g'), '[^/]+')
  s = s.replace(new RegExp(WILD, 'g'), '.*')
  return new RegExp('^' + s + '$')
}

// ─── Path resolution ──────────────────────────────────────────
const RESOLVE_EXTS = [
  '', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.css', '.scss', '.sass', '.less',
  '.html', '.vue', '.svelte', '.astro',
  '.json', '.md', '.mdx', '.rst', '.svg',
  '.rs', '.go', '.java', '.kt', '.rb', '.php',
  '.cs', '.swift', '.dart',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.lsp', '.dcl', '.clj', '.scm',
  '.sh', '.bash', '.ps1', '.psm1',
]

const INDEX_FILES = [
  'index.js', 'index.jsx', 'index.ts', 'index.tsx',
  'index.mjs', 'index.cjs', 'index.html',
  '__init__.py', 'mod.rs', 'main.go',
]

export function resolveImport(fromAbsPath, spec, rootAbs, validIds, fromExt) {
  if (!spec || typeof spec !== 'string') return null

  // Strip query / hash
  spec = spec.split('?')[0].split('#')[0].trim()
  if (!spec) return null

  // URL or data URI → skip
  if (/^(?:[a-z]+:)?\/\//i.test(spec) || spec.startsWith('data:')) return null

  // CSS leading ~ (webpack alias) → strip
  if (spec.startsWith('~')) spec = spec.slice(1)

  // Python relative dots (`.`, `..`, `.foo`)
  // .ipynb notebooks contain Python imports, treat them the same.
  if (/^(?:py|pyw|ipynb)$/.test(fromExt) && spec.startsWith('.')) {
    return resolvePythonRelative(fromAbsPath, spec, rootAbs, validIds)
  }

  // Python dotted module (a.b.c) → search from root
  if ((fromExt === 'py' || fromExt === 'ipynb') && !spec.startsWith('.') && !spec.startsWith('/')) {
    const subPath = spec.replace(/\./g, '/')
    for (const ext of ['.py', '/__init__.py']) {
      const cand = path.join(rootAbs, subPath + ext)
      const relId = idOf(rootAbs, cand)
      if (validIds.has(relId)) return relId
    }
    return null
  }

  // C# dotted namespace (System.Collections.Generic) → search.
  // Standard convention: namespace path matches directory path. We
  // try the full path first, then progressively shorter prefixes
  // (handles `using A.B.C` where the file is `A/B/C.cs` OR `A/B.cs`).
  if (fromExt === 'cs' && /^[A-Za-z]/.test(spec)) {
    const parts = spec.split('.')
    for (let i = parts.length; i >= 1; i--) {
      const sub = parts.slice(0, i).join('/')
      const cand = path.join(rootAbs, sub + '.cs')
      const id = idOf(rootAbs, cand)
      if (validIds.has(id)) return id
    }
    // Also try as a folder containing the namespace's .cs files
    for (let i = parts.length; i >= 1; i--) {
      const sub = parts.slice(0, i).join('/')
      const dir = path.join(rootAbs, sub)
      // Just check for *any* .cs file inside (return the first match)
      for (const id of validIds) {
        if (id.startsWith(sub + '/') && id.endsWith('.cs')) return id
      }
    }
    return null
  }

  // Dart — `dart:`/`package:` are external (SDK / pub.dev), skip them.
  // Everything else is a path string relative to the importing file's
  // directory: `import 'services/x.dart'` from `lib/main.dart` resolves
  // to `lib/services/x.dart`. Also handles `export` / `part` / `part of`.
  if (fromExt === 'dart') {
    if (spec.startsWith('dart:')) return null
    if (spec.startsWith('package:')) return null
    const fromDir = path.dirname(fromAbsPath)
    const cand = path.resolve(fromDir, spec)
    const id = idOf(rootAbs, cand)
    if (validIds.has(id)) return id
    return null
  }

  // Swift `import ModuleName` → look for a top-level folder of that
  // name (Sources/ModuleName/ or just ModuleName/) and return one of
  // its .swift files. SwiftPM convention.
  if (fromExt === 'swift' && /^[A-Za-z]/.test(spec)) {
    const moduleName = spec.split('.')[0]   // ignore .Submodule for now
    const patterns = [
      `Sources/${moduleName}/`,
      `${moduleName}/Sources/`,
      `${moduleName}/`,
    ]
    for (const pat of patterns) {
      for (const id of validIds) {
        if (id.includes(pat) && id.endsWith('.swift')) return id
      }
    }
    return null
  }

  // Go — `import "github.com/owner/repo/sub/pkg"`.
  //
  // Internal vs external is determined by reading the repo's go.mod once
  // and caching the module declaration; anything prefixed with that path
  // is internal and the suffix maps to a directory of .go files.
  if (fromExt === 'go' && /^[A-Za-z0-9_]/.test(spec)) {
    const modPrefix = getGoModulePrefix(rootAbs)
    let internalPath = null
    if (modPrefix && spec === modPrefix) internalPath = ''
    else if (modPrefix && spec.startsWith(modPrefix + '/')) {
      internalPath = spec.slice(modPrefix.length + 1)
    }
    if (internalPath != null) {
      // Return any .go file inside that subdir (graph-level — we just
      // need *some* node in the target package).
      const prefix = internalPath ? internalPath + '/' : ''
      for (const id of validIds) {
        if (id.startsWith(prefix) && id.endsWith('.go')
            && !id.slice(prefix.length).includes('/')) return id
      }
      // Fallback: any .go anywhere under the dir
      for (const id of validIds) {
        if (id.startsWith(prefix) && id.endsWith('.go')) return id
      }
    }
    return null
  }

  // Rust — `use crate::a::b::c`, `use self::x`, `use super::x`, `mod x;`.
  //
  // Maps the module path to `src/a/b/c.rs`, `src/a/b/c/mod.rs`, or for
  // `mod x;` resolved relative to the importing file's directory.
  if (fromExt === 'rs' && /^[A-Za-z_]/.test(spec)) {
    return resolveRustModule(fromAbsPath, spec, rootAbs, validIds)
  }

  // Java / Kotlin — `import com.foo.bar.Baz` → look for any file ending
  // in `com/foo/bar/Baz.{java,kt}`. Source roots vary (`src/main/java/`,
  // `src/`, etc.), so we suffix-match instead of trying to enumerate
  // them. We also try shortening the FQN (Spring/Guava `import a.b.*`
  // wildcards end up as just `a.b` — match it as a directory).
  if ((fromExt === 'java' || fromExt === 'kt') && /^[A-Za-z_]/.test(spec)) {
    const cleaned = spec.replace(/\.\*$/, '')   // strip wildcard
    const parts = cleaned.split('.')
    if (parts.length < 2) return null
    // Try Foo.java / Foo.kt (innermost segment as the class name)
    const exts = fromExt === 'kt' ? ['.kt', '.java'] : ['.java', '.kt']
    for (let i = parts.length; i >= 2; i--) {
      const tail = parts.slice(0, i).join('/')
      for (const ext of exts) {
        const suffix = '/' + tail + ext
        for (const id of validIds) {
          if (id.endsWith(suffix)) return id
        }
      }
    }
    return null
  }

  // PowerShell `Import-Module Name` → look for Name.psm1 / Name/Name.psm1
  if (fromExt === 'ps1' && /^[A-Za-z]/.test(spec) && !spec.includes('/')) {
    const candidates = [`${spec}.psm1`, `${spec}/${spec}.psm1`, `${spec}.ps1`]
    for (const cand of candidates) {
      const id = idOf(rootAbs, path.join(rootAbs, cand))
      if (validIds.has(id)) return id
    }
    return null
  }

  // Clojure / Scheme dotted/dashed namespace → file path
  // Convention: `my.cool.ns` → `my/cool/ns.clj` (also `_` for `-`)
  if ((fromExt === 'clj' || fromExt === 'scm') && /^[a-z]/.test(spec)) {
    const subPath = spec.replace(/\./g, '/').replace(/-/g, '_')
    for (const ext of [`.${fromExt}`, '.cljc']) {
      const cand = path.join(rootAbs, subPath + ext)
      const id = idOf(rootAbs, cand)
      if (validIds.has(id)) return id
    }
    return null
  }

  // Relative path
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const fromDir = path.dirname(fromAbsPath)
    const base = spec.startsWith('/')
      ? path.join(rootAbs, spec)
      : path.resolve(fromDir, spec)
    return tryResolve(base, rootAbs, validIds)
  }

  // HTML / CSS / Markdown / SCSS-style refs commonly omit the `./` prefix.
  // Treat path-like specifiers (containing `/` or having an extension) as
  // relative from the source file when the source is one of those formats.
  const PATH_LIKE_SOURCES = new Set([
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'md', 'mdx', 'svelte', 'vue',
  ])
  if (PATH_LIKE_SOURCES.has(fromExt) && (spec.includes('/') || spec.includes('.'))) {
    const fromDir = path.dirname(fromAbsPath)
    const relTry = tryResolve(path.resolve(fromDir, spec), rootAbs, validIds)
    if (relTry) return relTry
    // Also try as if it were rooted (e.g. /assets/x.png in HTML)
    return tryResolve(path.join(rootAbs, spec), rootAbs, validIds)
  }

  // Before giving up on a bare specifier, try TypeScript path mapping
  // (`@excalidraw/common` → `./packages/common/src/index.ts`) for any
  // ext that uses tsconfig — JS/TS, plus jsconfig for plain JS.
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(fromExt)) {
    const r = resolveTsconfigPath(spec, rootAbs, validIds)
    if (r) return r
  }

  // Bare specifier → either an external package or an unresolvable alias.
  return null
}

function tryResolve(basePath, rootAbs, validIds) {
  // If basePath itself is an indexed file (e.g. `foo.wasm` / `foo.node`),
  // match directly. Without this, FFI imports like `require('./addon.node')`
  // would never resolve because tryResolve only appends extensions.
  const directId = idOf(rootAbs, basePath)
  if (validIds.has(directId)) return directId
  // Direct + extensions
  for (const ext of RESOLVE_EXTS) {
    const cand = basePath + ext
    const id = idOf(rootAbs, cand)
    if (validIds.has(id)) return id
  }
  // Directory + index files
  for (const idx of INDEX_FILES) {
    const cand = path.join(basePath, idx)
    const id = idOf(rootAbs, cand)
    if (validIds.has(id)) return id
  }
  return null
}

function resolvePythonRelative(fromAbsPath, spec, rootAbs, validIds) {
  // spec like ".module", "..pkg.sub", "."
  const dots = spec.match(/^\.+/)[0].length
  const rest = spec.slice(dots).replace(/\./g, '/')
  let base = path.dirname(fromAbsPath)
  for (let i = 1; i < dots; i++) base = path.dirname(base)
  const candPath = rest ? path.join(base, rest) : base
  for (const ext of ['.py', '/__init__.py']) {
    const cand = candPath + ext
    const id = idOf(rootAbs, cand)
    if (validIds.has(id)) return id
  }
  return null
}

function idOf(rootAbs, absPath) {
  return path.relative(rootAbs, absPath).split(path.sep).join('/')
}

// ─── tsconfig.json paths cache ──────────────────────────────────
// Reads `compilerOptions.paths` (and `baseUrl`) from the project's
// root tsconfig.json once per rootAbs. Lets us resolve TypeScript
// path mapping like `@excalidraw/common` → `./packages/common/src/index.ts`.
//
// JSON-with-comments tolerant: strips // line comments and /* block */
// comments before JSON.parse so real-world tsconfig files don't fail.
const _tsconfigCache = new Map()  // rootAbs → { baseUrl, paths: [{ pattern, targets }] }
function loadTsconfigPaths(rootAbs) {
  if (_tsconfigCache.has(rootAbs)) return _tsconfigCache.get(rootAbs)
  let cfg = { baseUrl: '.', paths: [] }
  try {
    // Read root tsconfig.json first; fall back to jsconfig.json.
    const candidates = [path.join(rootAbs, 'tsconfig.json'), path.join(rootAbs, 'jsconfig.json')]
    let raw = null
    for (const c of candidates) {
      if (fs.existsSync(c)) { raw = fs.readFileSync(c, 'utf8'); break }
    }
    if (raw) {
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .replace(/,(\s*[}\]])/g, '$1')      // trailing commas
      const parsed = JSON.parse(stripped)
      const co = parsed?.compilerOptions || {}
      cfg.baseUrl = co.baseUrl || '.'
      if (co.paths) {
        for (const [pattern, targets] of Object.entries(co.paths)) {
          cfg.paths.push({ pattern, targets: Array.isArray(targets) ? targets : [targets] })
        }
      }
    }
  } catch {}
  _tsconfigCache.set(rootAbs, cfg)
  return cfg
}

// Resolve an import spec via tsconfig path mapping. Returns the
// matched file id, or null if no path mapping applies / no file
// matches the resolved target.
function resolveTsconfigPath(spec, rootAbs, validIds) {
  const cfg = loadTsconfigPaths(rootAbs)
  if (!cfg.paths.length) return null
  const baseDir = path.resolve(rootAbs, cfg.baseUrl)
  for (const { pattern, targets } of cfg.paths) {
    // Patterns may end with `/*` for prefix mapping; otherwise exact match.
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2)   // '@excalidraw/common'
      if (spec === prefix || spec.startsWith(prefix + '/')) {
        const rest = spec === prefix ? '' : spec.slice(prefix.length + 1)
        for (const tgt of targets) {
          const tgtRel = tgt.endsWith('/*') ? tgt.slice(0, -2) : tgt
          const cand = rest
            ? path.join(baseDir, tgtRel, rest)
            : path.join(baseDir, tgtRel)
          const r = tryResolve(cand, rootAbs, validIds)
          if (r) return r
        }
      }
    } else if (spec === pattern) {
      for (const tgt of targets) {
        const cand = path.join(baseDir, tgt)
        const r = tryResolve(cand, rootAbs, validIds)
        if (r) return r
        // Some targets are direct file paths without extension fallback
        const direct = idOf(rootAbs, cand)
        if (validIds.has(direct)) return direct
      }
    }
  }
  return null
}

// ─── Go module prefix cache ─────────────────────────────────────
// Reads `module github.com/owner/repo` from the repo's go.mod once per
// rootAbs. Used to decide which imports point inside the repo vs
// external packages.
const _goModCache = new Map()
function getGoModulePrefix(rootAbs) {
  if (_goModCache.has(rootAbs)) return _goModCache.get(rootAbs)
  let prefix = null
  try {
    const p = path.join(rootAbs, 'go.mod')
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8')
      const m = txt.match(/^\s*module\s+(\S+)/m)
      if (m) prefix = m[1]
    }
  } catch {}
  _goModCache.set(rootAbs, prefix)
  return prefix
}

// ─── Rust module resolution ─────────────────────────────────────
// Maps `use crate::a::b`, `use self::x`, `use super::x`, `mod x;` into
// a file path inside the repo. Best-effort: we look at `src/` first
// (cargo convention) and also resolve relative to the importing file
// for `self::` / `super::` / bare `mod x;`.
function resolveRustModule(fromAbsPath, spec, rootAbs, validIds) {
  // Strip any item suffix — `use crate::a::Foo` → module is `crate::a`.
  // The item itself (Foo) is just a symbol export, not a file. We try
  // both the full path and the parent.
  const candidates = []
  const segments = spec.split('::')
  function addModuleCandidates(relSegs) {
    if (!relSegs.length) return
    const sub = relSegs.join('/')
    candidates.push(sub + '.rs')
    candidates.push(sub + '/mod.rs')
  }
  if (segments[0] === 'crate') {
    addModuleCandidates(segments.slice(1))
    addModuleCandidates(segments.slice(1, -1))   // strip item
  } else if (segments[0] === 'self' || segments[0] === 'super') {
    let base = path.dirname(fromAbsPath)
    let i = 0
    while (i < segments.length && segments[i] === 'super') {
      base = path.dirname(base); i++
    }
    if (segments[i] === 'self') i++
    const rest = segments.slice(i)
    if (rest.length) {
      const cand1 = path.join(base, ...rest) + '.rs'
      const cand2 = path.join(base, ...rest, 'mod.rs')
      candidates.push(idOf(rootAbs, cand1))
      candidates.push(idOf(rootAbs, cand2))
      // Also strip item
      if (rest.length > 1) {
        candidates.push(idOf(rootAbs, path.join(base, ...rest.slice(0, -1)) + '.rs'))
      }
    }
  } else {
    // Bare `mod foo;` — resolve relative to the importing file's dir.
    const base = path.dirname(fromAbsPath)
    candidates.push(idOf(rootAbs, path.join(base, ...segments) + '.rs'))
    candidates.push(idOf(rootAbs, path.join(base, ...segments, 'mod.rs')))
    // Also try src/ as a fallback root
    addModuleCandidates(segments)
  }
  // Search src/ as a default crate root too
  if (segments[0] === 'crate' || !['self','super'].includes(segments[0])) {
    const segs = segments[0] === 'crate' ? segments.slice(1) : segments
    const inSrc = ['src', ...segs].join('/')
    candidates.push(inSrc + '.rs')
    candidates.push(inSrc + '/mod.rs')
    if (segs.length > 1) {
      candidates.push(['src', ...segs.slice(0, -1)].join('/') + '.rs')
    }
  }
  for (const c of candidates) {
    if (validIds.has(c)) return c
  }
  return null
}
