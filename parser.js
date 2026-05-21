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
    return r
  } catch {
    const g = parseGeneric(content)
    g.externalUrls = extractExternalUrls(content)
    g.dynamicPatterns = detectDynamicPatterns(content, ext)
    return g
  }
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
        // require('...')
        if (c.type === 'Identifier' && c.name === 'require'
            && args[0]?.type === 'StringLiteral') {
          imports.push({ spec: args[0].value, kind: 'import' })
        }
        // import('...')
        if (c.type === 'Import' && args[0]?.type === 'StringLiteral') {
          imports.push({ spec: args[0].value, kind: 'dynamic' })
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
  // Express / Hono / Koa-router / Fastify shorthand:
  //   app.get('/users', ...)
  //   router.post('/users/:id', ...)
  //   fastify.delete('/users/:id', ...)
  const methodRe = new RegExp(
    `\\b(?:app|router|api|server|fastify|hono|express|route)\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  )
  let m
  while ((m = methodRe.exec(content))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] })
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
  const hookRe = /\buse(?:Fetch|SWR|Query|Data)\s*\(\s*['"`]([^'"`]+)['"`]/g
  while ((m = hookRe.exec(content))) {
    const url = m[1]
    if (!looksLikeUrl(url)) continue
    calls.push({ method: 'GET', url })
  }
  return calls
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

  // Bare specifier → either an external package or an unresolvable alias.
  return null
}

function tryResolve(basePath, rootAbs, validIds) {
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
