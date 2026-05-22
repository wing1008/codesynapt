import { describe, it, expect } from 'vitest'
import { parseFile, resolveImport, extractNextApiRoutes } from '../parser.js'

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
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['data.loader', 'utils'])
  })

  it('extracts plain import X', () => {
    const r = parseFile('x.py', `import os\nimport requests`, 'py')
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['os', 'requests'])
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
    expect(r.imports.map((i) => i.spec).sort()).toEqual(['numpy', 'utils'])
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

describe('resolveImport', () => {
  it('resolves Python dotted module to file', () => {
    const ids = new Set(['utils.py', 'data/loader.py'])
    expect(resolveImport('/x/main.py', 'utils', '/x', ids, 'py')).toBe('utils.py')
    expect(resolveImport('/x/main.py', 'data.loader', '/x', ids, 'py')).toBe('data/loader.py')
  })

  it('skips dart: and package: for Dart', () => {
    const ids = new Set(['lib/foo.dart'])
    expect(resolveImport('/x/lib/main.dart', 'dart:async', '/x', ids, 'dart')).toBeNull()
    expect(resolveImport('/x/lib/main.dart', 'package:flutter/material.dart', '/x', ids, 'dart')).toBeNull()
  })
})
