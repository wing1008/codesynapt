import { describe, it, expect } from 'vitest'
import { parseFile, resolveImport, resolveImportAll, extractNextApiRoutes,
         extractNuxtServerRoutes, extractSvelteKitServerRoutes } from '../packages/core/parser.js'

describe('parseFile — JS/TS imports', () => {
  it('extracts ES module imports', () => {
    const r = parseFile('x.ts', `import foo from './foo'\nimport { bar } from './bar'`, 'ts')
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['./bar', './foo'])
  })

  it('extracts CommonJS requires', () => {
    const r = parseFile('x.js', `const foo = require('./foo')`, 'js')
    expect(r.imports.some((i) => i.spec === './foo')).toBe(true)
  })

  it('extracts dynamic imports', () => {
    const r = parseFile('x.ts', `const m = await import('./lazy')`, 'ts')
    expect(r.imports.some((i) => i.spec === './lazy')).toBe(true)
  })
})

describe('parseFile — Python', () => {
  it('extracts from X import Y', () => {
    const r = parseFile('x.py', `from utils import helper\nfrom data.loader import load_csv`, 'py')
    // Emit both the package and `package.name` so submodule imports resolve
    // (e.g. `from django.conf import global_settings` → conf/global_settings.py).
    expect(r.imports.map((i) => i.spec).sort()).toEqual(
      ['data.loader', 'data.loader.load_csv', 'utils', 'utils.helper'])
  })

  it('extracts plain import X', () => {
    const r = parseFile('x.py', `import os\nimport requests`, 'py')
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['os', 'requests'])
  })

  it('joins parenthesized multi-line imports and emits submodule specs (2026-06-02)', () => {
    const r = parseFile('x.py', `from django.db import (\n    transaction,\n    connection,\n)`, 'py')
    const specs = r.imports.map((i) => i.spec).sort()
    expect(specs).toContain('django.db.transaction')   // submodule file
    expect(specs).toContain('django.db.connection')
    expect(specs).toContain('django.db')               // package __init__
  })
})

describe('parseFile — .ipynb', () => {
  it('extracts imports from code cells, ignores markdown + magics', () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# header'] },
        { cell_type: 'code', source: ['%matplotlib inline\n', 'import numpy as np\n', 'from utils import x\n'] },
      ],
      metadata: { kernelspec: { language: 'python' } },
    })
    const r = parseFile('x.ipynb', nb, 'ipynb')
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['numpy', 'utils', 'utils.x'])
    expect(r.envUsage).toBeDefined()
  })
})

describe('parseFile — Dart', () => {
  it('extracts package + relative imports', () => {
    const r = parseFile('main.dart', `
import 'package:flutter/material.dart';
import 'services/auth.dart';
export 'utils.dart';
part 'gen.g.dart';
`, 'dart')
    expect(r.imports.length).toBe(4)
    expect(r.imports.some((i) => i.spec === 'package:flutter/material.dart')).toBe(true)
    expect(r.imports.some((i) => i.spec === 'services/auth.dart' && i.kind === 'import')).toBe(true)
    expect(r.imports.some((i) => i.kind === 'export')).toBe(true)
  })
})

describe('parseFile — C#', () => {
  it('extracts using directives', () => {
    const r = parseFile('x.cs', `
using System;
using System.Collections.Generic;
using static System.Math;
namespace Foo {}
`, 'cs')
    expect(r.imports.some((i) => i.spec === 'System')).toBe(true)
    expect(r.imports.some((i) => i.spec === 'System.Collections.Generic')).toBe(true)
  })
})

describe('parseFile — env usage extraction', () => {
  it('detects process.env.X in JS', () => {
    const r = parseFile('x.js', `const k = process.env.STRIPE_KEY`, 'js')
    expect(r.envUsage).toContain('STRIPE_KEY')
  })

  it('detects os.environ in Python', () => {
    const r = parseFile('x.py', `import os\nkey = os.environ.get('API_KEY')`, 'py')
    expect(r.envUsage).toContain('API_KEY')
  })

  it('detects import.meta.env (Vite)', () => {
    const r = parseFile('x.ts', `const url = import.meta.env.VITE_API_URL`, 'ts')
    expect(r.envUsage).toContain('VITE_API_URL')
  })
})

describe('parseFile — Express router prefix (P1·1)', () => {
  it('combines app.use(prefix, router) with router.method', () => {
    const r = parseFile('routes.js', `
const usersRouter = express.Router()
usersRouter.get('/list', (req, res) => {})
usersRouter.post('/:id', (req, res) => {})
app.use('/api/users', usersRouter)
app.get('/health', (req, res) => {})
`, 'js')
    const paths = r.routes.map((rt) => rt.path).sort()
    expect(paths).toEqual(['/api/users/:id', '/api/users/list', '/health'])
  })

  it('rejects random variables (not routers)', () => {
    const r = parseFile('x.js', `randomVar.get('/should-not-match')`, 'js')
    expect(r.routes.length).toBe(0)
  })
})

describe('extractNextApiRoutes — Next.js file-system API routes', () => {
  // extractNextApiRoutes is invoked by scanner.parseOne (not parseFile);
  // we test the helper directly.
  it('extracts from src/app/api/<seg>/route.ts', () => {
    const r = extractNextApiRoutes('src/app/api/users/route.ts', `
export async function GET(req) { return Response.json({}) }
export async function POST(req) { return Response.json({}) }
`)
    expect(r.some((rt) => rt.method === 'GET' && rt.path === '/api/users')).toBe(true)
    expect(r.some((rt) => rt.method === 'POST' && rt.path === '/api/users')).toBe(true)
  })

  it('handles dynamic segments [id]', () => {
    const r = extractNextApiRoutes('src/app/api/users/[id]/route.ts', `export async function GET(req) {}`)
    expect(r.some((rt) => rt.path === '/api/users/:id')).toBe(true)
  })

  it('ignores non-api files', () => {
    const r = extractNextApiRoutes('src/app/users/page.tsx', `export default function Page() {}`)
    expect(r.length).toBe(0)
  })
})

describe('extractNuxtServerRoutes — Nuxt 3 / Nitro', () => {
  it('server/api/<seg>.ts with defineEventHandler default', () => {
    const r = extractNuxtServerRoutes('server/api/users.ts', `export default defineEventHandler(async (event) => ({}))`)
    expect(r).toEqual([{ method: 'ANY', path: '/api/users' }])
  })

  it('method suffix in filename: foo.post.ts → POST /api/foo', () => {
    const r = extractNuxtServerRoutes('server/api/foo.post.ts', `export default defineEventHandler(() => {})`)
    expect(r).toEqual([{ method: 'POST', path: '/api/foo' }])
  })

  it('defineEventHandler({ method: "PUT" }) object form', () => {
    const r = extractNuxtServerRoutes('server/api/users/[id].ts',
      `export default defineEventHandler({ method: 'PUT', handler() {} })`)
    expect(r[0].method).toBe('PUT')
    expect(r[0].path).toBe('/api/users/:id')
  })

  it('ignores non-server/ files', () => {
    const r = extractNuxtServerRoutes('pages/index.vue', `<script>export default {}</script>`)
    expect(r.length).toBe(0)
  })
})

describe('Astro server endpoints (covered by Next.js pages pattern)', () => {
  // Astro `src/pages/api/*.ts` with `export const GET/POST` matches the
  // same regex as Next.js pages router → extractNextApiRoutes handles it.
  it('Astro src/pages/api/users.ts with method exports', () => {
    const r = extractNextApiRoutes('src/pages/api/users.ts', `
export const GET = async ({ request }) => new Response('ok')
export const POST = async ({ request }) => new Response('ok')
`)
    expect(r.some((rt) => rt.method === 'GET' && rt.path === '/api/users')).toBe(true)
    expect(r.some((rt) => rt.method === 'POST' && rt.path === '/api/users')).toBe(true)
  })
})

describe('extractSvelteKitServerRoutes — SvelteKit', () => {
  it('src/routes/<seg>/+server.ts with GET/POST exports', () => {
    const r = extractSvelteKitServerRoutes('src/routes/api/users/+server.ts', `
export async function GET({ url }) {}
export async function POST({ request }) {}
`)
    const paths = r.map((rt) => `${rt.method} ${rt.path}`).sort()
    expect(paths).toEqual(['GET /api/users', 'POST /api/users'])
  })

  it('handles dynamic [id] segments', () => {
    const r = extractSvelteKitServerRoutes('src/routes/api/users/[id]/+server.ts', `export const GET = () => {}`)
    expect(r[0].path).toBe('/api/users/:id')
  })

  it('ignores non +server files', () => {
    const r = extractSvelteKitServerRoutes('src/routes/api/users/+page.svelte', `<script>`)
    expect(r.length).toBe(0)
  })
})

describe('parseFile — apiCalls', () => {
  it('detects fetch with method', () => {
    const r = parseFile('x.ts', `fetch('/api/users', { method: 'POST' })`, 'ts')
    expect(r.apiCalls.some((c) => c.method === 'POST' && c.url === '/api/users')).toBe(true)
  })

  it('detects $fetch / ofetch (Nuxt)', () => {
    const r = parseFile('x.ts', `await $fetch('/api/users')\nawait ofetch('/api/items')`, 'ts')
    const urls = r.apiCalls.map((c) => c.url).sort()
    expect(urls).toContain('/api/users')
    expect(urls).toContain('/api/items')
  })

  it('dedupes when both fetchRe and nitroRe match $fetch', () => {
    const r = parseFile('x.ts', `await $fetch('/api/x')`, 'ts')
    const calls = r.apiCalls.filter((c) => c.url === '/api/x')
    expect(calls.length).toBe(1)
  })
})

describe('parseFile — SDK instance + TRPC (P2·4)', () => {
  it('axios.create instance variable', () => {
    const r = parseFile('x.ts', `
const myApi = axios.create({ baseURL: 'https://api.example.com' })
myApi.get('/users')
myApi.post('/users', { name: 'a' })
`, 'ts')
    const calls = r.apiCalls.filter((c) => c.via === 'sdk-instance')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.some((c) => c.method === 'GET' && c.url === '/users')).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url === '/users')).toBe(true)
  })

  it('got.extend instance variable', () => {
    const r = parseFile('x.ts', `
const client = got.extend({ prefixUrl: 'https://x' })
client.delete('/items/42')
`, 'ts')
    expect(r.apiCalls.some((c) => c.method === 'DELETE' && c.url === '/items/42' && c.via === 'sdk-instance')).toBe(true)
  })

  it('factory-style createApi() variable', () => {
    const r = parseFile('x.ts', `
const svc = createApi()
svc.get('/health')
`, 'ts')
    expect(r.apiCalls.some((c) => c.url === '/health' && c.via === 'sdk-instance')).toBe(true)
  })

  it('TRPC useQuery / useMutation recorded as RPC', () => {
    const r = parseFile('x.tsx', `
const { data } = trpc.users.list.useQuery()
trpc.posts.create.mutate({ title: 'a' })
`, 'tsx')
    const rpc = r.apiCalls.filter((c) => c.method === 'RPC')
    expect(rpc.length).toBe(2)
    expect(rpc.some((c) => c.url === 'trpc:users.list')).toBe(true)
    expect(rpc.some((c) => c.url === 'trpc:posts.create')).toBe(true)
  })

  it('ignores non-SDK variables', () => {
    const r = parseFile('x.ts', `
const random = somethingElse()
random.get('/should-not-match')
`, 'ts')
    expect(r.apiCalls.some((c) => c.via === 'sdk-instance')).toBe(false)
  })
})

describe('parseFile — confidence (P2·3)', () => {
  it('pure static imports → high', () => {
    const r = parseFile('x.ts', `import foo from './foo'\nconst a = 1`, 'ts')
    expect(r.confidence).toBe('high')
  })

  it('dynamic require/import → medium', () => {
    const r = parseFile('x.ts', `const m = require(name)\nimport(path)`, 'ts')
    expect(r.confidence).toBe('medium')
  })

  it('eval / new Function → low', () => {
    const r = parseFile('x.js', `eval('alert(1)')`, 'js')
    expect(r.confidence).toBe('low')
  })

  it('Reflect.* → low', () => {
    const r = parseFile('x.ts', `Reflect.apply(fn, null, [])`, 'ts')
    expect(r.confidence).toBe('low')
  })

  it('NestJS @Injectable decorator → low', () => {
    const r = parseFile('x.ts', `@Injectable() export class Foo { constructor(private bar: Bar) {} }`, 'ts')
    expect(r.confidence).toBe('low')
  })

  it('tsyringe container.resolve → low', () => {
    const r = parseFile('x.ts', `const svc = container.resolve(MyService)`, 'ts')
    expect(r.confidence).toBe('low')
  })

  it('Python exec/eval → low', () => {
    const r = parseFile('x.py', `exec('print(1)')`, 'py')
    expect(r.confidence).toBe('low')
  })
})

describe('resolveImport', () => {
  it('resolves Python dotted module to file', () => {
    const ids = new Set(['utils.py', 'data/loader.py'])
    expect(resolveImport('/x/main.py', 'utils', '/x', ids, 'py')).toBe('utils.py')
    expect(resolveImport('/x/main.py', 'data.loader', '/x', ids, 'py')).toBe('data/loader.py')
  })

  it('resolves Python absolute import in a src/ layout (2026-06-02)', () => {
    // `from attr.converters import x` where the package lives at src/attr/ —
    // flat resolution would miss it.
    const ids = new Set(['src/attr/converters.py', 'src/attr/__init__.py'])
    expect(resolveImport('/x/src/attr/_make.py', 'attr.converters', '/x', ids, 'py')).toBe('src/attr/converters.py')
    expect(resolveImport('/x/src/attr/_make.py', 'attr', '/x', ids, 'py')).toBe('src/attr/__init__.py')
  })

  it('skips dart: and package: for Dart', () => {
    const ids = new Set(['lib/foo.dart'])
    expect(resolveImport('/x/lib/main.dart', 'dart:async', '/x', ids, 'dart')).toBeNull()
    expect(resolveImport('/x/lib/main.dart', 'package:flutter/material.dart', '/x', ids, 'dart')).toBeNull()
  })
})

// Regression — graph-accuracy bugs found by measurement on 2026-06-01.
// Each guards one fix; don't let a future parser change silently revert these.
describe('parseFile — Python from-dot-import / CRLF / docstring (2026-06-01 regression)', () => {
  it('resolves `from . import sub` to submodule specs (not just the package)', () => {
    const specs = parseFile('pkg/a.py', 'from . import cli\nfrom . import typing as ft', 'py')
      .imports.map((i) => i.spec)
    expect(specs).toContain('.cli')
    expect(specs).toContain('.typing')
  })

  it('handles CRLF line endings in from-dot-import', () => {
    const specs = parseFile('pkg/a.py', 'from . import cli\r\nfrom .mod import x\r\n', 'py')
      .imports.map((i) => i.spec)
    expect(specs).toContain('.cli')
    expect(specs).toContain('.mod')
  })

  it('ignores imports inside triple-quoted docstrings (code examples)', () => {
    const src = 'from .real import a\ndef f():\n    """\n    from flask import fake\n    """\n    pass\n'
    const specs = parseFile('pkg/a.py', src, 'py').imports.map((i) => i.spec)
    expect(specs).toContain('.real')
    expect(specs).not.toContain('flask')
  })
})

describe('resolveImport — TypeScript NodeNext .js→.ts twin (2026-06-01 regression)', () => {
  it('resolves ./x.js to ./x.ts when only the TS source exists', () => {
    expect(resolveImport('/x/src/a.ts', './b.js', '/x', new Set(['src/b.ts']), 'ts')).toBe('src/b.ts')
  })

  it('resolves ./x.jsx to ./x.tsx', () => {
    expect(resolveImport('/x/src/a.tsx', './c.jsx', '/x', new Set(['src/c.tsx']), 'tsx')).toBe('src/c.tsx')
  })

  it('still prefers a real .js file over the .ts twin when both exist', () => {
    expect(resolveImport('/x/src/a.ts', './b.js', '/x', new Set(['src/b.js', 'src/b.ts']), 'ts')).toBe('src/b.js')
  })
})

describe('resolveImport — C/C++ #include (2026-06-01 regression)', () => {
  it('resolves #include "x.h" relative to the including file', () => {
    expect(resolveImport('/x/src/a.c', 'b.h', '/x', new Set(['src/b.h']), 'c')).toBe('src/b.h')
  })

  it('falls back to basename match for headers in an -I dir', () => {
    expect(resolveImport('/x/src/a.c', 'inc.h', '/x', new Set(['include/inc.h']), 'c')).toBe('include/inc.h')
  })

  it('does not resolve system headers (no matching file)', () => {
    expect(resolveImport('/x/src/a.c', 'stdio.h', '/x', new Set(['src/b.h']), 'c')).toBeNull()
  })
})

describe('resolveImport — Java/Kotlin FQN at source root (2026-06-01 regression)', () => {
  it('resolves an import to a file sitting at the source root', () => {
    // ROOT=src/main/java → ids have no leading segment (com/...). Must still match.
    expect(resolveImport('/x/com/a/B.java', 'com.a.C', '/x', new Set(['com/a/C.java']), 'java')).toBe('com/a/C.java')
  })

  it('still resolves when nested under a source root', () => {
    expect(resolveImport('/x/src/com/a/B.java', 'com.a.C', '/x', new Set(['src/com/a/C.java']), 'java')).toBe('src/com/a/C.java')
  })
})

describe('parseFile — Rust (2026-06-02 regression: serde measurement)', () => {
  it('parses pub / pub(crate) mod and plain mod; excludes inline mod', () => {
    const r = parseFile('lib.rs', `
pub mod ast;
pub(crate) mod attr;
mod ctxt;
mod lib { pub use core::*; }
`, 'rs')
    const specs = r.imports.map((i) => i.spec).sort()
    expect(specs).toEqual(['ast', 'attr', 'ctxt'])   // inline `mod lib { }` excluded
  })

  it('expands grouped, nested, glob, self and renamed use imports', () => {
    const r = parseFile('x.rs', `
use crate::internals::{attr, ungroup, Ctxt};
use crate::de::{enum_::Variant, self};
use crate::lib::*;
use syn::Token as Tok;
`, 'rs')
    const specs = r.imports.map((i) => i.spec).sort()
    expect(specs).toEqual([
      'crate::de',                // `self` → group prefix
      'crate::de::enum_::Variant',
      'crate::internals::Ctxt',
      'crate::internals::attr',
      'crate::internals::ungroup',
      'crate::lib',               // `::*` glob stripped
      'syn::Token',               // `as Tok` stripped
    ])
  })
})

describe('resolveImport — Rust module tree (2026-06-02 regression)', () => {
  const ids = new Set([
    'src/lib.rs', 'src/de.rs', 'src/de/enum_.rs', 'src/internals/mod.rs',
    'src/internals/attr.rs', 'src/bound.rs',
  ])
  it('resolves `mod x;` in a non-mod.rs file to the <stem>/ subdir, not a sibling', () => {
    // `mod enum_;` declared in src/de.rs → src/de/enum_.rs (2018 rule).
    expect(resolveImport('/x/src/de.rs', 'enum_', '/x', ids, 'rs')).toBe('src/de/enum_.rs')
  })
  it('resolves crate:: paths, stripping the trailing item to the module file', () => {
    expect(resolveImport('/x/src/bound.rs', 'crate::internals::attr', '/x', ids, 'rs')).toBe('src/internals/attr.rs')
    // Ctxt is an item in internals/mod.rs → parent module file.
    expect(resolveImport('/x/src/bound.rs', 'crate::internals::Ctxt', '/x', ids, 'rs')).toBe('src/internals/mod.rs')
  })
  it('resolves a top-level crate item to the crate root file', () => {
    expect(resolveImport('/x/src/de.rs', 'crate::bound', '/x', ids, 'rs')).toBe('src/bound.rs')
  })
  it('resolves self:: and super:: relative to the file module path', () => {
    expect(resolveImport('/x/src/de/enum_.rs', 'super::enum_', '/x', ids, 'rs')).toBe('src/de/enum_.rs')
    expect(resolveImport('/x/src/internals/mod.rs', 'self::attr', '/x', ids, 'rs')).toBe('src/internals/attr.rs')
  })
  it('descends through inline submodules to the deepest real file', () => {
    // `crate::internals::attr::Foo` — attr.rs is the deepest file; segments
    // below it are inline modules/items inside attr.rs.
    expect(resolveImport('/x/src/bound.rs', 'crate::internals::attr::deep::Foo', '/x', ids, 'rs')).toBe('src/internals/attr.rs')
  })
  it('falls back to the crate root for an unmatched crate:: item (re-export)', () => {
    // `use crate::Reexport` where Reexport is a top-level item in lib.rs.
    expect(resolveImport('/x/src/de.rs', 'crate::Reexport', '/x', ids, 'rs')).toBe('src/lib.rs')
  })
  it('does not resolve external crate paths to repo files', () => {
    // Bare `use syn::Token` (external) — must not collapse onto self or root.
    expect(resolveImport('/x/src/de.rs', 'syn::Token', '/x', ids, 'rs')).toBeNull()
  })
})

describe('parseFile — Ruby / PHP (2026-06-02 regression)', () => {
  it('Ruby: extracts require, require_relative and load', () => {
    const r = parseFile('lib/x.rb', `
require 'faraday/version'
require_relative 'multipart_boundary'
load 'tasks/foo.rb'
require 'json' if cond
`, 'rb')
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['faraday/version', 'json', 'multipart_boundary', 'tasks/foo.rb'])
  })

  it('PHP: parses use, group use, aliases and require concatenation', () => {
    const r = parseFile('x.php', `<?php
use Monolog\\Handler\\StreamHandler;
use Psr\\Log\\LoggerInterface as Logger;
use Monolog\\Formatter\\{LineFormatter, JsonFormatter as JF};
use function Monolog\\Utils\\detectAndCleanUtf8;
require __DIR__ . '/helpers.php';
`, 'php')
    const specs = r.imports.map((i) => i.spec).sort()
    expect(specs).toEqual([
      '/helpers.php',
      'Monolog\\Formatter\\JsonFormatter',
      'Monolog\\Formatter\\LineFormatter',
      'Monolog\\Handler\\StreamHandler',
      'Monolog\\Utils\\detectAndCleanUtf8',
      'Psr\\Log\\LoggerInterface',
    ])
  })
})

describe('resolveImport — Ruby (2026-06-02 regression)', () => {
  const ids = new Set([
    'faraday.rb', 'faraday/version.rb', 'faraday/request/body.rb',
    'faraday/request/multipart_boundary.rb',
  ])
  it('resolves load-path require to the root (lib) tree', () => {
    expect(resolveImport('/x/faraday.rb', 'faraday/version', '/x', ids, 'rb')).toBe('faraday/version.rb')
  })
  it('resolves require_relative siblings without a leading ./', () => {
    expect(resolveImport('/x/faraday/request/body.rb', 'multipart_boundary', '/x', ids, 'rb'))
      .toBe('faraday/request/multipart_boundary.rb')
  })
  it('does not resolve stdlib requires', () => {
    expect(resolveImport('/x/faraday.rb', 'json', '/x', ids, 'rb')).toBeNull()
  })
})

describe('resolveImport — PHP PSR-4 suffix match (2026-06-02 regression)', () => {
  // No composer.json at /x → resolver falls back to suffix matching, which
  // covers the namespace-mirrors-path layout (e.g. Monolog\ → src/Monolog).
  const ids = new Set(['src/Monolog/Handler/StreamHandler.php', 'src/Monolog/Logger.php'])
  it('maps a FQCN onto a mirrored path', () => {
    expect(resolveImport('/x/src/Monolog/Logger.php', 'Monolog\\Handler\\StreamHandler', '/x', ids, 'php'))
      .toBe('src/Monolog/Handler/StreamHandler.php')
  })
  it('does not resolve an external vendor namespace', () => {
    expect(resolveImport('/x/src/Monolog/Logger.php', 'Psr\\Log\\LoggerInterface', '/x', ids, 'php')).toBeNull()
  })
})

describe('resolveImport — Dart / C# / Swift (2026-06-02 regression)', () => {
  it('Dart: resolves relative paths; dart:/external package are null', () => {
    const ids = new Set(['lib/http.dart', 'lib/src/client.dart'])
    expect(resolveImport('/x/lib/http.dart', 'src/client.dart', '/x', ids, 'dart')).toBe('lib/src/client.dart')
    expect(resolveImport('/x/lib/http.dart', 'dart:async', '/x', ids, 'dart')).toBeNull()
    expect(resolveImport('/x/lib/http.dart', 'package:other/x.dart', '/x', ids, 'dart')).toBeNull()
  })
  it('C#: resolves a using to a mirrored path, dropping the root namespace', () => {
    const ids = new Set(['Internal/AccessorCache.cs', 'AbstractValidator.cs'])
    // fully-qualified `using FluentValidation.Internal` → suffix `Internal/`
    expect(resolveImport('/x/AbstractValidator.cs', 'FluentValidation.Internal', '/x', ids, 'cs'))
      .toBe('Internal/AccessorCache.cs')
    expect(resolveImport('/x/AbstractValidator.cs', 'System.Linq', '/x', ids, 'cs')).toBeNull()
  })
  it('Swift: resolves import ModuleName to a file in Sources/ModuleName/', () => {
    const ids = new Set([
      'Sources/OrderedCollections/OrderedSet.swift',
      'Sources/InternalCollectionsUtilities/Debugging.swift',
    ])
    expect(resolveImport('/x/Sources/OrderedCollections/OrderedSet.swift', 'InternalCollectionsUtilities', '/x', ids, 'swift'))
      .toBe('Sources/InternalCollectionsUtilities/Debugging.swift')
    expect(resolveImport('/x/Sources/OrderedCollections/OrderedSet.swift', 'Foundation', '/x', ids, 'swift')).toBeNull()
  })
})

describe('resolveImportAll — module/namespace fanout (2026-06-02)', () => {
  it('Swift: import Module fans out to every file in the module (recursive)', () => {
    const ids = new Set(['Sources/M/A.swift', 'Sources/M/sub/B.swift', 'Sources/Other/C.swift'])
    const r = resolveImportAll('/x/Sources/Other/C.swift', 'M', '/x', ids, 'swift')
    expect(new Set(r)).toEqual(new Set(['Sources/M/A.swift', 'Sources/M/sub/B.swift']))
  })

  it('C#: using fans out to the mirrored folder, immediate children only (folder fallback)', () => {
    // /csfan has no real files on disk → namespace index empty → folder fallback.
    const ids = new Set(['Internal/A.cs', 'Internal/B.cs', 'Internal/Sub/C.cs', 'X.cs'])
    const r = resolveImportAll('/csfan/X.cs', 'Internal', '/csfan', ids, 'cs')
    expect(new Set(r)).toEqual(new Set(['Internal/A.cs', 'Internal/B.cs']))  // not Sub/C.cs
  })

  it('file-precise languages still return a single target (no regression)', () => {
    const ids = new Set(['src/b.ts'])
    expect(resolveImportAll('/x/src/a.ts', './b.js', '/x', ids, 'ts')).toEqual(['src/b.ts'])
  })
})
