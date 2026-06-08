import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Smoke test: prove the per-language type-checker sub-engines are reachable via
// scanner.enrichSymbolGraph() and that the TS block adds an edge the fast,
// name-based AST engine misses.
//
// NOTE on location: the project's vitest config only discovers tests under the
// repo-root `tests/**` glob, so this lives here (not packages/core/tests/) to
// actually run. It still exercises packages/core/lib/subengine-ts.cjs via the
// public Scanner API.

const require = createRequire(import.meta.url)
let hasTypescript = false
try { require.resolve('typescript'); hasTypescript = true } catch { hasTypescript = false }

let tmpRoot

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-subengine-'))
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })

  // Two classes, each with a `handle()` method. Because >=2 production classes
  // define a method of that name, the AST engine's ambiguous-method guard
  // (symbol-graph.cjs resolveCall) REFUSES a bare-name member call to `handle`.
  fs.writeFileSync(path.join(tmpRoot, 'src/a.ts'), [
    'export class A {',
    '  handle(): number { return 1 }',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(tmpRoot, 'src/b.ts'), [
    'export class B {',
    '  handle(): number { return 2 }',
    '}',
    '',
  ].join('\n'))

  // Generic identity: the receiver type flows through `wrap<T>(x: T): T`, so the
  // AST parser can't pin the concrete type of `x` locally.
  fs.writeFileSync(path.join(tmpRoot, 'src/util.ts'), [
    'export function wrap<T>(x: T): T { return x }',
    '',
  ].join('\n'))

  // driver(): `wrap(new A()).handle()`. The receiver of `.handle()` is only
  // knowable via generic type resolution, and `handle` is ambiguous by name —
  // so the AST engine misses this call entirely. The TS type checker resolves
  // it to A.handle. This is exactly the ~20% slice the sub-engine recovers.
  fs.writeFileSync(path.join(tmpRoot, 'src/main.ts'), [
    "import { A } from './a'",
    "import { B } from './b'",
    "import { wrap } from './util'",
    '',
    'export function driver(): number {',
    '  const x = wrap(new A())',
    '  return x.handle()',
    '}',
    '',
  ].join('\n'))
})

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

async function buildGraph(root) {
  const s = new Scanner(root)
  await new Promise((resolve) => { s.once('snapshot', resolve); s.start() })
  try { s.stop() } catch {}
  await s.buildSymbolGraph()
  return s
}

describe('sub-engine enrichment — reachability', () => {
  it('ts block adds a type-checker-only edge via enrichSymbolGraph()', async () => {
    if (!hasTypescript) {
      // The TS block needs the `typescript` npm dep. If it's not resolvable in
      // this env, the block is unavailable and the test cannot trigger an edge.
      console.warn('[skip] `typescript` not resolvable — TS sub-engine unavailable')
      expect(hasTypescript).toBe(false)
      return
    }

    // Build with the kill switch ON so the graph is the PURE AST graph (no
    // auto-enrichment), giving us a clean before/after for the manual call.
    const prevOff = process.env.CS_SUBENGINE_OFF
    process.env.CS_SUBENGINE_OFF = '1'
    let scanner
    try {
      scanner = await buildGraph(tmpRoot)
    } finally {
      if (prevOff === undefined) delete process.env.CS_SUBENGINE_OFF; else process.env.CS_SUBENGINE_OFF = prevOff
    }
    expect(scanner.symbolGraph).toBeTruthy()

    const beforeViaTs = scanner.symbolGraph.edges.filter((e) => e.via === 'ts').length
    expect(beforeViaTs).toBe(0) // AST build does not stamp via:'ts'

    const stats = scanner.enrichSymbolGraph()
    expect(stats).toBeTruthy()
    expect(stats.ts).toBeTruthy()
    expect(stats.ts.added).toBeGreaterThanOrEqual(1)

    const viaTs = scanner.symbolGraph.edges.filter((e) => e.via === 'ts')
    expect(viaTs.length).toBeGreaterThanOrEqual(1)
  })

  // The TS block is the DEFAULT-ON tier: a plain buildSymbolGraph() with NO env
  // flags set must auto-add the via:'ts' edge (no manual enrichSymbolGraph()).
  it('buildSymbolGraph() auto-runs the TS block by default (no env flags)', async () => {
    if (!hasTypescript) {
      console.warn('[skip] `typescript` not resolvable — TS sub-engine unavailable')
      expect(hasTypescript).toBe(false)
      return
    }
    const prevOn = process.env.CS_SUBENGINE
    const prevHeavy = process.env.CS_SUBENGINE_HEAVY
    const prevOff = process.env.CS_SUBENGINE_OFF
    delete process.env.CS_SUBENGINE
    delete process.env.CS_SUBENGINE_HEAVY
    delete process.env.CS_SUBENGINE_OFF
    try {
      const scanner = await buildGraph(tmpRoot)
      const viaTs = scanner.symbolGraph.edges.filter((e) => e.via === 'ts')
      expect(viaTs.length).toBeGreaterThanOrEqual(1) // auto-enriched, no manual call
    } finally {
      if (prevOn === undefined) delete process.env.CS_SUBENGINE; else process.env.CS_SUBENGINE = prevOn
      if (prevHeavy === undefined) delete process.env.CS_SUBENGINE_HEAVY; else process.env.CS_SUBENGINE_HEAVY = prevHeavy
      if (prevOff === undefined) delete process.env.CS_SUBENGINE_OFF; else process.env.CS_SUBENGINE_OFF = prevOff
    }
  })

  // Kill switch: CS_SUBENGINE_OFF=1 disables ALL enrichment, so no via:'ts' edge.
  it('CS_SUBENGINE_OFF=1 disables enrichment (no via:ts edge)', async () => {
    const prevOff = process.env.CS_SUBENGINE_OFF
    process.env.CS_SUBENGINE_OFF = '1'
    try {
      const scanner = await buildGraph(tmpRoot)
      const viaTs = scanner.symbolGraph.edges.filter((e) => e.via === 'ts')
      expect(viaTs.length).toBe(0)
    } finally {
      if (prevOff === undefined) delete process.env.CS_SUBENGINE_OFF; else process.env.CS_SUBENGINE_OFF = prevOff
    }
  })
})
