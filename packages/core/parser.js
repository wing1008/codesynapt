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
      // JS/TS web frameworks: Express-style + NestJS-style decorators
      r.routes   = [...extractJSRoutes(content), ...extractAnnotationRoutes(content)]
      r.apiCalls = extractJSApiCalls(content)
    } else if (ext === 'py' || ext === 'pyw') {
      r.routes   = extractPyRoutes(content)
      r.apiCalls = extractPyApiCalls(content)
    } else if (ext === 'go') {
      r.routes   = extractGoRoutes(content)
    } else if (ext === 'java' || ext === 'kt') {
      r.routes   = extractAnnotationRoutes(content)
    } else if (ext === 'vue' || ext === 'svelte' || ext === 'astro') {
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
  // Split on \r?\n so CRLF files don't leave a trailing \r — JS regex `.`
  // doesn't match \r and `$` won't anchor before it, which would break the
  // `from . import sub` end-anchored capture below.
  const rawLines = content.split(/\r?\n/)
  let inTriple = false
  for (let li = 0; li < rawLines.length; li++) {
    let line = rawLines[li]
    // Skip triple-quoted docstrings / string literals: they frequently
    // contain `from x import y` code examples that are NOT real imports
    // (false-positive edges). Toggle on odd counts of `"""` or `'''`.
    const triples = (line.match(/"""|'''/g) || []).length
    if (inTriple) {
      if (triples % 2 === 1) inTriple = false
      continue
    }
    if (triples % 2 === 1) inTriple = true
    if (line.trim().startsWith('#')) continue
    // Join parenthesized multi-line imports — `from x import (\n a,\n b,\n)`
    // is extremely common in formatted code (black/isort). Accumulate the
    // following lines (import names, not docstrings) until the `)` closes.
    if (/^\s*from\s+[.\w]+\s+import\s*\(/.test(line) && !line.includes(')')) {
      while (li + 1 < rawLines.length && !line.includes(')')) {
        line += ' ' + rawLines[++li].replace(/#.*$/, '').trim()
      }
      line = line.replace(/[()]/g, ' ')
    }
    let m
    // from X import Y   (X can include leading dots for relative)
    if ((m = line.match(/^\s*from\s+(\.+|[.\w]+)\s+import\s+(.+)$/))) {
      const from = m[1]
      // `from . import sub` / `from .. import sub`: the imported names are
      // usually SUBMODULES of the relative package, not attributes of its
      // __init__. Emit `.sub` so resolution finds the submodule file; also
      // keep the bare package as a fallback (names defined in __init__).
      if (/^\.+$/.test(from)) {
        for (let n of m[2].replace(/#.*$/, '').split(',')) {
          n = n.trim().replace(/[()]/g, '').split(/\s+as\s+/)[0].trim()
          if (n && n !== '*') imports.push({ spec: from + n, kind: 'import' })
        }
        imports.push({ spec: from, kind: 'import' })
      } else {
        // `from pkg import sub`: the imported names may be SUBMODULES (files)
        // of pkg, not just attributes of its __init__. Emit `pkg.name` so
        // submodule files resolve; non-module names (classes/funcs) simply
        // resolve to nothing. Keep the bare package too (it is also executed,
        // and names may be defined in its __init__).
        for (let n of m[2].replace(/#.*$/, '').split(',')) {
          n = n.trim().replace(/[()]/g, '').split(/\s+as\s+/)[0].trim()
          if (n && n !== '*') imports.push({ spec: from + '.' + n, kind: 'import' })
        }
        imports.push({ spec: from, kind: 'import' })
      }
    }
    else if ((m = line.match(/^\s*from\s+(\.+|[.\w]+)\s+import/))) {
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
  // File modules: `mod X;` / `pub mod X;` / `pub(crate) mod X;` (the `;`
  //   matters — inline `mod X { ... }` has no backing file, so we skip it).
  // Imports: `use ...;` / `pub use ...;`, including grouped/nested forms
  //   `use a::b::{c, d::e, self};` and renames `use a::b as c;`. Each group
  //   member is expanded into its own spec so it resolves to its own file.
  const imports = []
  const VIS = '(?:pub\\s*(?:\\([^)]*\\)\\s*)?)?'
  const modRe = new RegExp('^\\s*' + VIS + 'mod\\s+(\\w+)\\s*;', 'gm')
  let m
  while ((m = modRe.exec(content))) imports.push({ spec: m[1], kind: 'import' })
  // `use` statements can span multiple lines up to the terminating `;`.
  const useRe = new RegExp('^\\s*' + VIS + 'use\\s+([^;]+);', 'gm')
  while ((m = useRe.exec(content))) {
    for (const spec of expandRustUse(m[1])) imports.push({ spec, kind: 'import' })
  }
  return { imports }
}

// Expand a Rust `use` tree (without the leading `use`/trailing `;`) into a
// flat list of module-path specifiers. Handles nested `{}` groups, `self`
// (refers to the group prefix), `as` renames, and `*` globs.
function expandRustUse(body) {
  const s = body.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '')
  const out = []
  const matchBrace = (str, open) => {
    let depth = 0
    for (let i = open; i < str.length; i++) {
      if (str[i] === '{') depth++
      else if (str[i] === '}') { depth--; if (depth === 0) return i }
    }
    return str.length
  }
  const splitTop = (str) => {
    const parts = []
    let depth = 0, start = 0
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '{') depth++
      else if (str[i] === '}') depth--
      else if (str[i] === ',' && depth === 0) { parts.push(str.slice(start, i)); start = i + 1 }
    }
    parts.push(str.slice(start))
    return parts
  }
  const walk = (seg, prefix) => {
    const brace = seg.indexOf('{')
    if (brace === -1) {
      let leaf = seg.replace(/::\*$/, '').replace(/^\*$/, '')
      if (leaf === 'self' || leaf === '') { if (prefix) out.push(prefix); return }
      out.push(prefix ? prefix + '::' + leaf : leaf)
      return
    }
    const head = seg.slice(0, brace).replace(/::$/, '')
    const newPrefix = head ? (prefix ? prefix + '::' + head : head) : prefix
    const inner = seg.slice(brace + 1, matchBrace(seg, brace))
    for (const part of splitTop(inner)) walk(part, newPrefix)
  }
  walk(s, '')
  return out.filter(Boolean)
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
  // require/include (optionally _once), allowing `__DIR__ . ` concatenation
  // before the string literal (the dominant real-world form).
  const reqRe = /\b(?:require|include)(?:_once)?\b[^;'"]*['"]([^'"]+)['"]/g
  let m
  while ((m = reqRe.exec(content))) imports.push({ spec: m[1], kind: 'require' })
  // `use` namespace imports (PSR-4). Forms handled:
  //   use A\B\C;  use A\B\C as D;  use function A\b;  use const A\B;
  //   use A\B\{C, D as E, function f};   (PHP 7+ group use)
  // The negative-shape first char (`[A-Za-z_\\]`) skips closure `use ($x)`.
  const useRe = /^\s*use\s+(?:function\s+|const\s+)?([A-Za-z_\\][^;]*);/gm
  while ((m = useRe.exec(content))) {
    for (const spec of expandPhpUse(m[1])) imports.push({ spec, kind: 'use' })
  }
  return { imports }
}

// Expand a PHP `use` body into fully-qualified class names. Handles group
// use `Prefix\{A, B as C}`, `as` aliases, and `function`/`const` members.
function expandPhpUse(body) {
  const out = []
  const brace = body.indexOf('{')
  if (brace === -1) {
    const fqcn = body.split(/\s+as\s+/i)[0].trim()
    if (fqcn) out.push(fqcn)
    return out
  }
  const prefix = body.slice(0, brace).replace(/\\\s*$/, '').trim()
  const inner = body.slice(brace + 1, body.lastIndexOf('}'))
  for (let part of inner.split(',')) {
    part = part.replace(/\b(?:function|const)\s+/i, '').split(/\s+as\s+/i)[0].trim()
    if (part) out.push(prefix + '\\' + part.replace(/^\\/, ''))
  }
  return out
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
    // Look one line below the decorator for `def handler_name(...)`
    // so the file-graph builder can link the route to its handler.
    const after = content.slice(m.index + m[0].length)
    const hm = after.match(/^[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/)
    const handler = hm ? hm[1] : null
    if (verb === 'route') {
      const mm = m[3].match(/methods\s*=\s*\[([^\]]+)\]/i)
      if (mm) {
        const methods = [...mm[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase())
        for (const method of methods) routes.push({ method, path, handler })
      } else {
        routes.push({ method: 'GET', path, handler })   // Flask default
      }
    } else {
      routes.push({ method: verb.toUpperCase(), path, handler })
    }
  }
  return routes
}

// Go / Gin / Echo / Chi router calls
//   r.GET("/users", getUsers)
//   router.POST("/u/:id", h.UpdateUser)
//   e.Any("/x", handler)
function extractGoRoutes(content) {
  const routes = []
  const re = new RegExp(
    `\\b(?:r|router|engine|app|e|mux|api|grp|group)\\.(${HTTP_METHODS.join('|')}|Any|Handle|HandleFunc)\\s*\\(\\s*"([^"]+)"\\s*,([^)]*)\\)`,
    'gi'
  )
  let m
  while ((m = re.exec(content))) {
    const method = m[1].toUpperCase() === 'ANY' || m[1].toUpperCase() === 'HANDLE' || m[1].toUpperCase() === 'HANDLEFUNC' ? 'ANY' : m[1].toUpperCase()
    const path = m[2]
    const handlerStr = (m[3] || '').trim()
    const hm = handlerStr.match(/([A-Za-z_][\w.]*)\s*$/)
    let handler = null
    if (hm && !/(func\b|\{)/.test(handlerStr)) {
      // For receiver.Method form, take the rightmost segment
      handler = hm[1].split('.').pop()
    }
    routes.push({ method, path, handler })
  }
  return routes
}

// Spring (Java) / NestJS (TS) / Quarkus (Java) annotation routes
//   @GetMapping("/users")              public List<User> getUsers()
//   @RequestMapping(value="/u", method=RequestMethod.GET)
//   @Get('/users')                     getUsers(): User[]
//   @Post('/u')                        @Body() body
function extractAnnotationRoutes(content) {
  const routes = []
  // Spring single-method mappings
  const springRe = /@(Get|Post|Put|Delete|Patch|Options|Head)Mapping\s*\(\s*(?:value\s*=\s*)?(?:"|')([^"']+)(?:"|')(?:[^)]*)\)\s*[\s\S]{0,200}?(?:public|private|protected)?\s*[\w<>\[\],?\s.]*\s+(\w+)\s*\(/g
  let m
  while ((m = springRe.exec(content))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], handler: m[3] })
  }
  // @RequestMapping(value="/x", method=RequestMethod.GET)
  const rmRe = /@RequestMapping\s*\([^)]*?value\s*=\s*"([^"]+)"[^)]*?method\s*=\s*RequestMethod\.(\w+)[^)]*\)\s*[\s\S]{0,200}?(?:public|private|protected)?\s*[\w<>\[\],?\s.]*\s+(\w+)\s*\(/g
  while ((m = rmRe.exec(content))) {
    routes.push({ method: m[2].toUpperCase(), path: m[1], handler: m[3] })
  }
  // NestJS-style decorators (TypeScript)
  //   @Get('/users')  getUsers() { ... }
  const nestRe = /@(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*(?:@\w+\s*\([^)]*\)\s*)*\s*(?:public|private|protected|async)?\s*(\w+)\s*\(/g
  while ((m = nestRe.exec(content))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], handler: m[3] })
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

  // Python dotted module (a.b.c) → search from the import root. Try flat
  // layout (package at repo root) AND src-layout (`src/<pkg>/`), which is the
  // modern standard and would otherwise be missed. (Only these two known
  // layouts — a broad suffix match would create false edges for stdlib/3rd-
  // party imports that happen to share an internal filename.)
  if ((fromExt === 'py' || fromExt === 'ipynb') && !spec.startsWith('.') && !spec.startsWith('/')) {
    const subPath = spec.replace(/\./g, '/')
    for (const pfx of ['', 'src/']) {
      for (const tail of [subPath + '.py', subPath + '/__init__.py']) {
        if (validIds.has(pfx + tail)) return pfx + tail
      }
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
      // Just check for *any* .cs file inside (return the first match)
      for (const id of validIds) {
        if (id.startsWith(sub + '/') && id.endsWith('.cs')) return id
      }
    }
    // Fully-qualified `using Root.Sub` where the root namespace maps to the
    // scan root (not a directory) — drop leading segments and match the
    // suffix: `FluentValidation.Internal` → `Internal/…`.
    for (let start = 1; start < parts.length; start++) {
      const sub = parts.slice(start).join('/')
      const cand = idOf(rootAbs, path.join(rootAbs, sub + '.cs'))
      if (validIds.has(cand)) return cand
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
    if (spec.startsWith('package:')) {
      // `package:<self>/x.dart` → lib/x.dart; other packages are external.
      const body = spec.slice('package:'.length)
      const slash = body.indexOf('/')
      const pkg = slash < 0 ? body : body.slice(0, slash)
      const sub = slash < 0 ? '' : body.slice(slash + 1)
      const self = loadPubspecName(rootAbs)
      if (self && pkg === self && sub && validIds.has('lib/' + sub)) return 'lib/' + sub
      return null
    }
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
  if (fromExt === 'rs' && /^(?:::)?[A-Za-z_]/.test(spec)) {   // allow leading `::` (absolute path)
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
          // endsWith('/'+...) misses files at the source root (id has no
          // leading segment, e.g. ROOT=src/main/java → id 'com/foo/Bar.java').
          if (id.endsWith(suffix) || id === tail + ext) return id
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

  // PHP — `use Vendor\Pkg\Class;` (PSR-4) resolves like a Java FQN: turn the
  // namespace separators into slashes and suffix-match a `.php` file. The
  // leading `\`, `as` aliases and group braces were handled in parsePHP.
  // require/include string paths (no backslash) fall through to relative.
  if (fromExt === 'php' && spec.includes('\\')) {
    const fqcn = spec.replace(/^\\+/, '')
    // Authoritative composer PSR-4 map first.
    for (const { prefix, dir } of loadComposerPsr4(rootAbs)) {
      if (fqcn === prefix || fqcn.startsWith(prefix + '\\')) {
        const rest = fqcn.slice(prefix.length).replace(/^\\+/, '').replace(/\\/g, '/')
        const cand = (rest ? (dir ? dir + '/' + rest : rest) : dir) + '.php'
        if (validIds.has(cand)) return cand
      }
    }
    // Fallback: suffix match (no composer.json, or unmapped namespace).
    const rel = fqcn.replace(/\\/g, '/') + '.php'
    if (validIds.has(rel)) return rel
    for (const id of validIds) {
      if (id.endsWith('/' + rel)) return id
    }
    return null
  }

  // Ruby — `require_relative "x"` is relative to the requiring file; `require
  // "gem/x"` is resolved against the load path (conventionally lib/). Try
  // both, then a `/x.rb` suffix match. Stdlib/gems (`require "json"`) match
  // nothing → null.
  if (fromExt === 'rb') {
    const relTry = tryResolve(path.resolve(path.dirname(fromAbsPath), spec), rootAbs, validIds)
    if (relTry) return relTry
    const want = spec.replace(/\.rb$/, '') + '.rb'
    if (validIds.has(want)) return want
    if (validIds.has('lib/' + want)) return 'lib/' + want
    for (const id of validIds) {
      if (id.endsWith('/' + want)) return id
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
    // C/C++: `#include "x.h"` omits the ./ and is relative to the file's dir
    // (or found via an -I dir — handled by the basename fallback below).
    'c', 'cc', 'cpp', 'h', 'hpp',
  ])
  if (PATH_LIKE_SOURCES.has(fromExt) && (spec.includes('/') || spec.includes('.'))) {
    const fromDir = path.dirname(fromAbsPath)
    const relTry = tryResolve(path.resolve(fromDir, spec), rootAbs, validIds)
    if (relTry) return relTry
    // Also try as if it were rooted (e.g. /assets/x.png in HTML)
    const rootTry = tryResolve(path.join(rootAbs, spec), rootAbs, validIds)
    if (rootTry) return rootTry
    // C/C++ headers are frequently resolved through -I include dirs; fall back
    // to a unique basename match anywhere in the tree.
    if (fromExt === 'c' || fromExt === 'cc' || fromExt === 'cpp' || fromExt === 'h' || fromExt === 'hpp') {
      const base = spec.split('/').pop()
      for (const id of validIds) {
        if (id === base || id.endsWith('/' + base)) return id
      }
    }
    return null
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

// Like resolveImport, but for languages where ONE import pulls in an entire
// module/namespace, returns EVERY file in that unit instead of a single
// representative — so blast/deps are file-complete. All other languages (and
// file-precise imports) return the single resolveImport result as a 1-array,
// so the scanner's behaviour is unchanged for them.
export function resolveImportAll(fromAbsPath, spec, rootAbs, validIds, fromExt) {
  spec = (spec || '').split('?')[0].split('#')[0].trim()
  if (!spec) return []

  // Swift: `import Module` → every .swift under that module's source dir
  // (a module spans all files in Sources/<Module>/, recursively).
  if (fromExt === 'swift' && /^[A-Za-z_]/.test(spec)) {
    const m = spec.split('.')[0]
    for (const pat of [`Sources/${m}/`, `${m}/Sources/`, `${m}/`]) {
      const hits = [...validIds].filter((id) => id.includes(pat) && id.endsWith('.swift'))
      if (hits.length) return hits
    }
    return []
  }

  // C#: `using A.B` → every .cs file that DECLARES namespace A.B. Resolved via
  // the namespace index (declarations), with C#'s relative lookup through the
  // importing file's enclosing namespaces. Falls back to a folder match if the
  // project has no parseable namespace declarations.
  if (fromExt === 'cs' && /^[A-Za-z]/.test(spec)) {
    const { nsToFiles, fileToNs } = loadCsNamespaceIndex(rootAbs, validIds)
    if (nsToFiles.size) {
      const fromId = idOf(rootAbs, fromAbsPath)
      const base = (fileToNs.get(fromId) || '').split('.').filter(Boolean)
      const want = spec.split('.')
      for (let i = base.length; i >= 0; i--) {       // innermost enclosing first
        const cand = base.slice(0, i).concat(want).join('.')
        if (nsToFiles.has(cand)) return [...nsToFiles.get(cand)].filter((id) => id !== fromId)
      }
      return []
    }
    // Fallback: mirrored folder, immediate children only.
    const parts = spec.split('.')
    const folders = []
    for (let i = parts.length; i >= 1; i--) folders.push(parts.slice(0, i).join('/'))
    for (let s = 1; s < parts.length; s++) folders.push(parts.slice(s).join('/'))
    for (const sub of folders) {
      const hits = [...validIds].filter((id) =>
        id.endsWith('.cs') && id.startsWith(sub + '/') && !id.slice(sub.length + 1).includes('/'))
      if (hits.length) return hits
    }
    return []
  }

  // Go: `import "mod/sub/pkg"` → every .go file in that package directory
  // (a Go package is the whole directory; importing it pulls in all its files).
  if (fromExt === 'go' && /^[A-Za-z0-9_]/.test(spec)) {
    const modPrefix = getGoModulePrefix(rootAbs)
    let internalPath = null
    if (modPrefix && spec === modPrefix) internalPath = ''
    else if (modPrefix && spec.startsWith(modPrefix + '/')) internalPath = spec.slice(modPrefix.length + 1)
    if (internalPath == null) return []
    const prefix = internalPath ? internalPath + '/' : ''
    return [...validIds].filter((id) =>
      id.startsWith(prefix) && id.endsWith('.go') && !id.slice(prefix.length).includes('/'))
  }

  const one = resolveImport(fromAbsPath, spec, rootAbs, validIds, fromExt)
  return one ? [one] : []
}

function tryResolve(basePath, rootAbs, validIds) {
  // If basePath itself is an indexed file (e.g. `foo.wasm` / `foo.node`),
  // match directly. Without this, FFI imports like `require('./addon.node')`
  // would never resolve because tryResolve only appends extensions.
  const directId = idOf(rootAbs, basePath)
  if (validIds.has(directId)) return directId
  // TypeScript NodeNext: an import written as './x.js' (or .jsx/.mjs/.cjs)
  // commonly resolves to the sibling TS source './x.ts'. TS-style ESM
  // *requires* the .js extension in the specifier even though the file on
  // disk is .ts — so try the TS twin before the generic extension sweep.
  const tsTwin = basePath.match(/^(.*)\.(jsx|mjs|cjs|js)$/)
  if (tsTwin) {
    const twinExts = tsTwin[2] === 'jsx' ? ['.tsx']
                   : tsTwin[2] === 'mjs' ? ['.mts']
                   : tsTwin[2] === 'cjs' ? ['.cts']
                   : ['.ts', '.tsx']   // .js → .ts then .tsx
    for (const ext of twinExts) {
      const id = idOf(rootAbs, tsTwin[1] + ext)
      if (validIds.has(id)) return id
    }
  }
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

// Composer PSR-4 autoload map (`composer.json`) — the authoritative way a
// PHP `use Vendor\Pkg\Class;` maps to a file. A prefix may strip namespace
// segments that aren't mirrored in the path (e.g. `GuzzleHttp\Psr7\` → `src/`),
// which a plain suffix match cannot recover. Read once per root (cf. go.mod).
// C# namespace index — C# namespaces are declared explicitly and are NOT
// bound to file paths (a folder `Resources/Languages/` may declare namespace
// `Foo.Resources`). To fan a `using A.B` out to the right files we must read
// the `namespace` declarations rather than guess from the folder. Built once
// per root (cf. composer / go.mod caches).
const _csNsCache = new Map()  // rootAbs → { nsToFiles: Map<ns,Set<id>>, fileToNs: Map<id,ns> }
function loadCsNamespaceIndex(rootAbs, validIds) {
  if (_csNsCache.has(rootAbs)) return _csNsCache.get(rootAbs)
  const nsToFiles = new Map(), fileToNs = new Map()
  const NS = /^\s*namespace\s+([A-Za-z_][\w.]*)/gm
  for (const id of validIds) {
    if (!id.endsWith('.cs')) continue
    let txt
    try { txt = fs.readFileSync(path.join(rootAbs, id.split('/').join(path.sep)), 'utf8') } catch { continue }
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1)   // strip BOM
    let m, first = null
    NS.lastIndex = 0
    while ((m = NS.exec(txt))) {
      const ns = m[1]
      if (!first) first = ns
      if (!nsToFiles.has(ns)) nsToFiles.set(ns, new Set())
      nsToFiles.get(ns).add(id)
    }
    if (first) fileToNs.set(id, first)
  }
  const idx = { nsToFiles, fileToNs }
  _csNsCache.set(rootAbs, idx)
  return idx
}

const _composerCache = new Map()  // rootAbs → [{ prefix, dir }] longest-first
function loadComposerPsr4(rootAbs) {
  if (_composerCache.has(rootAbs)) return _composerCache.get(rootAbs)
  let maps = []
  try {
    const c = path.join(rootAbs, 'composer.json')
    if (fs.existsSync(c)) {
      const parsed = JSON.parse(fs.readFileSync(c, 'utf8'))
      const sources = [parsed?.autoload?.['psr-4'], parsed?.['autoload-dev']?.['psr-4']]
      for (const m of sources) {
        if (!m) continue
        for (const [prefix, dir] of Object.entries(m)) {
          for (const one of (Array.isArray(dir) ? dir : [dir])) {
            maps.push({
              prefix: prefix.replace(/\\+$/, ''),
              dir: String(one).replace(/^\.\//, '').replace(/\/+$/, ''),
            })
          }
        }
      }
      maps.sort((a, b) => b.prefix.length - a.prefix.length)  // longest prefix wins
    }
  } catch {}
  _composerCache.set(rootAbs, maps)
  return maps
}

// Dart package name (`pubspec.yaml`) — a Dart file can import its OWN package
// via `package:<self>/x.dart`, which resolves to `lib/x.dart`. We need the
// package name to tell self-imports from external pub.dev packages. Cached.
const _pubspecCache = new Map()  // rootAbs → package name | null
function loadPubspecName(rootAbs) {
  if (_pubspecCache.has(rootAbs)) return _pubspecCache.get(rootAbs)
  let name = null
  try {
    const c = path.join(rootAbs, 'pubspec.yaml')
    if (fs.existsSync(c)) {
      const m = fs.readFileSync(c, 'utf8').match(/^name:\s*(\S+)/m)
      if (m) name = m[1]
    }
  } catch {}
  _pubspecCache.set(rootAbs, name)
  return name
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

// Cargo workspace index — real Rust projects are almost always multi-crate
// (a `crates/*/` workspace, or a Tauri `src-tauri/`), so the crate root is NOT
// `<scanRoot>/src`. Read every Cargo.toml to learn each crate's name and src
// dir, so `crate::`/`self::` resolve within the FILE's crate and cross-crate
// `use other_crate::…` resolves into that crate. Cached per root.
const _cargoCache = new Map()  // rootAbs → { crateSrcs: [srcRootId...], nameToSrc: Map<name_,srcRoot> }
function loadCargoWorkspace(rootAbs, validIds) {
  if (_cargoCache.has(rootAbs)) return _cargoCache.get(rootAbs)
  const crateSrcs = [], nameToSrc = new Map()
  for (const id of validIds) {
    if (!id.endsWith('Cargo.toml') || id.includes('/target/')) continue
    const dir = id.slice(0, id.length - 'Cargo.toml'.length).replace(/\/$/, '')
    const srcRoot = dir ? dir + '/src' : 'src'
    let txt
    try { txt = fs.readFileSync(path.join(rootAbs, id.split('/').join(path.sep)), 'utf8') } catch { continue }
    // Only [package] crates have a name + src/; pure [workspace] roots don't.
    const pkg = txt.match(/\[package\]([\s\S]*?)(?=\n\s*\[|$)/)
    if (!pkg) continue
    const nm = pkg[1].match(/\bname\s*=\s*["']([^"']+)["']/)
    if (!nm) continue
    nameToSrc.set(nm[1].replace(/-/g, '_'), srcRoot)
    crateSrcs.push(srcRoot)
  }
  crateSrcs.sort((a, b) => b.length - a.length)   // longest (most specific) first
  const idx = { crateSrcs, nameToSrc }
  _cargoCache.set(rootAbs, idx)
  return idx
}

// Invalidate the per-root resolution caches. The long-running scanner / desktop
// app must call this when the underlying inputs change (a .cs file's namespace,
// tsconfig paths, composer PSR-4, pubspec name, go.mod module) — otherwise the
// dependency graph silently goes stale after edits, and every project ever
// opened leaks its cache entry. Pass a root to clear just that project, or
// nothing to clear everything.
export function clearParserCaches(rootAbs) {
  const caches = [_tsconfigCache, _csNsCache, _composerCache, _pubspecCache, _goModCache, _cargoCache]
  if (rootAbs == null) { for (const c of caches) c.clear(); return }
  for (const c of caches) c.delete(rootAbs)
}

// ─── Rust module resolution ─────────────────────────────────────
// Maps `use crate::a::b`, `use self::x`, `use super::x`, `mod x;` into
// a file path inside the repo. Best-effort: we look at `src/` first
// (cargo convention) and also resolve relative to the importing file
// for `self::` / `super::` / bare `mod x;`.
function resolveRustModule(fromAbsPath, spec, rootAbs, validIds) {
  // Resolve a Rust module path to a file using the real 2018 module tree, and
  // — crucially for real projects — the Cargo WORKSPACE: a file's crate may
  // live at `crates/<name>/src/` or `app/src-tauri/src/`, not `<root>/src/`,
  // and `use other_crate::…` crosses into a sibling crate.
  const relId = idOf(rootAbs, fromAbsPath)
  const ws = loadCargoWorkspace(rootAbs, validIds)

  // This file's crate src root (longest matching). Fall back to scan-root
  // `src/` for a single-crate-at-root layout or synthetic/unit inputs.
  let crateSrc = null
  for (const s of ws.crateSrcs) { if (relId === s || relId.startsWith(s + '/')) { crateSrc = s; break } }
  const srcPrefix = crateSrc ? crateSrc + '/' : (relId.startsWith('src/') ? 'src/' : '')

  // The importing file's module path, relative to its crate src root.
  let p = relId.startsWith(srcPrefix) ? relId.slice(srcPrefix.length) : relId
  p = p.replace(/\.rs$/, '')
  let myMod = p.split('/').filter(Boolean)
  if (myMod[myMod.length - 1] === 'mod') myMod.pop()
  else if (myMod.length === 1 && (myMod[0] === 'lib' || myMod[0] === 'main')) myMod = []

  const raw = spec.split('::').filter((s) => s && s !== '*')
  if (!raw.length) return null

  // `lib.rs`/`main.rs` are reserved crate-root filenames — only the empty path
  // (the crate root itself) may map to them, never a named submodule.
  const fileForIn = (pfx, segs) => segs.length
    ? [pfx + segs.join('/') + '.rs', pfx + segs.join('/') + '/mod.rs']
        .filter((c) => c !== pfx + 'lib.rs' && c !== pfx + 'main.rs')
    : [pfx + 'lib.rs', pfx + 'main.rs']
  // Walk prefixes longest→shortest: the deepest segment that maps to a real
  // file is the target (segments below it are inline submodules/items in that
  // file). `rooted` paths may collapse to the crate root; bare paths may not.
  const walk = (pfx, segs, rooted) => {
    const minN = rooted ? 0 : segs.length
    for (let n = segs.length; n >= minN; n--) {
      for (const cand of fileForIn(pfx, segs.slice(0, n))) if (validIds.has(cand)) return cand
    }
    return null
  }

  if (raw[0] === 'crate') return walk(srcPrefix, raw.slice(1), true)
  if (raw[0] === 'self' || raw[0] === 'super') {
    const base = myMod.slice()
    let i = 0
    while (i < raw.length && raw[i] === 'super') { if (base.length) base.pop(); i++ }
    if (raw[i] === 'self') i++
    return walk(srcPrefix, base.concat(raw.slice(i)), true)
  }
  // Bare head: cross-crate `use other_crate::a::b` if it names a workspace
  // crate (Cargo uses hyphens, code uses underscores — normalize).
  const head = raw[0].replace(/-/g, '_')
  if (ws.nameToSrc.has(head)) return walk(ws.nameToSrc.get(head) + '/', raw.slice(1), true)
  // Otherwise `mod foo;` (a child of the current module) or an external crate
  // (no repo file → null). Full path only — don't collapse onto self/root.
  return walk(srcPrefix, myMod.concat(raw), false)
}
