import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import { parseFile } from '../packages/core/parser.js'
import { auditLegacy } from '../packages/core/legacy.js'
import { SymbolGraph } from '../packages/core/lib/symbol-graph.cjs'
import fs from 'fs'
import path from 'path'
import os from 'os'

async function scanOnce(root) {
  const s = new Scanner(root)
  const snap = await new Promise((resolve) => { s.once('snapshot', resolve); s.start() })
  try { s.stop() } catch {}
  return { scanner: s, snap }
}

// ───────────────────────────────────────────────────────────────────
// FIX 1 — worker / child_process entry scripts must yield import edges
// so the spawned file is not a false orphan.
// ───────────────────────────────────────────────────────────────────
describe('parser — worker/child_process entry edges (Layer-1)', () => {
  it('captures new Worker / new SharedWorker / new Worker(new URL()) literals', () => {
    const r = parseFile('src/main.js', `
const w = new Worker('./w.js')
const sw = new SharedWorker('./shared.js')
const nodeW = new Worker(new URL('./node-worker.js', import.meta.url))
`, 'js')
    const specs = r.imports.filter((i) => i.kind === 'worker').map((i) => i.spec).sort()
    expect(specs).toEqual(['./node-worker.js', './shared.js', './w.js'])
  })

  it('captures fork() / spawn(node,[...]) / execFile(node,[...]) literal scripts', () => {
    const r = parseFile('src/main.js', `
const { fork, spawn, execFile } = require('child_process')
fork('./f.js')
spawn('node', ['./spawned.js'])
execFile('node', ['./ef.js'])
`, 'js')
    const specs = r.imports.filter((i) => i.kind === 'process').map((i) => i.spec).sort()
    expect(specs).toEqual(['./ef.js', './f.js', './spawned.js'])
  })

  it('is precision-first: ignores dynamic/non-script args (no false edges)', () => {
    const r = parseFile('src/main.js', `
const p = somePath
new Worker(p)                        // dynamic — skip
new Worker('https://cdn/x.js')       // not a relative repo path — skip
spawn('node', ['--inspect'])         // flag, not a script — skip
spawn(cmd, args)                     // fully dynamic — skip
fork('node')                         // bare binary, no ext — skip
`, 'js')
    expect(r.imports.some((i) => i.kind === 'worker' || i.kind === 'process')).toBe(false)
  })

  // FIX (2026-06-10): the real in-repo call sites use path.resolve/join(__dirname,
  // …) rather than bare string literals. Without resolving these, this repo's own
  // search-worker.cjs (Worker) and symbol-parse-worker.cjs (spawnSync) were false
  // orphans — the very cases the worker-edge handler was written to fix.
  it('captures new Worker(path.resolve/join(__dirname,…)) incl. const indirection', () => {
    const r = parseFile('src/main.js', `
const workerPath = path.resolve(__dirname, '..', 'lib', 'search-worker.cjs')
const w = new Worker(workerPath)
new Worker(path.join(__dirname, 'inline-worker.cjs'))
`, 'js')
    const specs = r.imports.filter((i) => i.kind === 'worker').map((i) => i.spec).sort()
    expect(specs).toEqual(['../lib/search-worker.cjs', './inline-worker.cjs'])
  })

  it('captures spawnSync/execFileSync(execPath, [path.join(__dirname,…)])', () => {
    const r = parseFile('src/main.js', `
const cp = require('child_process')
const worker = path.join(__dirname, 'symbol-parse-worker.cjs')
cp.spawnSync(process.execPath, [worker], { input: 'x' })
cp.execFileSync(process.execPath, [path.resolve(__dirname, 'tool.cjs')])
`, 'js')
    const specs = r.imports.filter((i) => i.kind === 'process').map((i) => i.spec).sort()
    expect(specs).toEqual(['./symbol-parse-worker.cjs', './tool.cjs'])
  })

  it('is precision-first: path.join/resolve with a computed segment yields no edge', () => {
    const r = parseFile('src/main.js', `
const name = getName()
new Worker(path.join(__dirname, name))              // computed tail segment — skip
const base = getBase()
cp.spawnSync(execPath, [path.resolve(base, 'w.cjs')]) // non-__dirname dynamic base — skip
`, 'js')
    expect(r.imports.some((i) => i.kind === 'worker' || i.kind === 'process')).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// package.json subpath `exports` — a workspace package may remap a
// subpath OFF its src/ mirror (e.g. `@acme/lib/helper` → ./internal/...).
// The src/ heuristic alone can't find it; honor the exports map so the
// import is a real edge, not a false orphan.
// ───────────────────────────────────────────────────────────────────
describe('parser — package.json subpath exports (Layer-1)', () => {
  it('resolves remapped subpaths via exports (exact + * wildcard)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-exports-'))
    const mk = (p, c) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
      fs.writeFileSync(path.join(root, p), c)
    }
    mk('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }))
    mk('packages/lib/package.json', JSON.stringify({
      name: '@acme/lib',
      exports: { '.': './src/index.ts', './helper': './internal/helper.ts', './shapes/*': './internal/shapes/*.ts' },
    }))
    mk('packages/lib/src/index.ts', 'export const idx = 1\n')
    mk('packages/lib/internal/helper.ts', 'export const help = 1\n')
    mk('packages/lib/internal/shapes/circle.ts', 'export const circle = 1\n')
    mk('packages/app/src/a.ts',
      "import { idx } from '@acme/lib'\nimport { help } from '@acme/lib/helper'\nimport { circle } from '@acme/lib/shapes/circle'\n")

    const { snap } = await scanOnce(root)
    const targets = snap.edges.filter((e) => e.s === 'packages/app/src/a.ts').map((e) => e.t).sort()
    expect(targets).toContain('packages/lib/src/index.ts')             // exports['.'] main
    expect(targets).toContain('packages/lib/internal/helper.ts')        // exact subpath export
    expect(targets).toContain('packages/lib/internal/shapes/circle.ts') // wildcard subpath export

    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // Audit regressions: nested conditions must NOT throw (it once aborted the
  // whole scan); wildcards must pick the MOST specific; array targets fall back.
  it('handles nested conditions, most-specific wildcard, and array fallbacks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-exports2-'))
    const mk = (p, c) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
      fs.writeFileSync(path.join(root, p), c)
    }
    mk('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }))
    mk('packages/lib/package.json', JSON.stringify({
      name: '@acme/lib',
      exports: {
        '.': { import: { node: './src/index.ts' } },                // NESTED main entry (crashed vue/core)
        './helper': { node: { import: './internal/helper.ts' } },   // NESTED conditions
        './arr': ['./missing.ts', './internal/arrtgt.ts'],          // ARRAY fallback (1st absent)
        './*': './internal/*.ts',                                   // less specific
        './shapes/*': './shapes-internal/*.ts',                     // more specific
      },
    }))
    mk('packages/lib/src/index.ts', 'export const idx = 1\n')
    mk('packages/lib/internal/helper.ts', 'export const help = 1\n')
    mk('packages/lib/internal/arrtgt.ts', 'export const a = 1\n')
    mk('packages/lib/internal/foo.ts', 'export const f = 1\n')
    mk('packages/lib/internal/shapes/circle.ts', 'export const c1 = 1\n')   // where './*' WOULD map
    mk('packages/lib/shapes-internal/circle.ts', 'export const c2 = 1\n')   // where './shapes/*' maps
    mk('packages/app/src/a.ts',
      "import { idx } from '@acme/lib'\nimport { help } from '@acme/lib/helper'\nimport { a } from '@acme/lib/arr'\n"
      + "import { f } from '@acme/lib/foo'\nimport { c2 } from '@acme/lib/shapes/circle'\n")

    const { snap } = await scanOnce(root)   // must not hang/throw on nested conditions
    const targets = snap.edges.filter((e) => e.s === 'packages/app/src/a.ts').map((e) => e.t)
    expect(targets).toContain('packages/lib/src/index.ts')                // nested MAIN entry
    expect(targets).toContain('packages/lib/internal/helper.ts')          // nested conditions
    expect(targets).toContain('packages/lib/internal/arrtgt.ts')          // array fallback (2nd)
    expect(targets).toContain('packages/lib/internal/foo.ts')             // './*'
    expect(targets).toContain('packages/lib/shapes-internal/circle.ts')   // most-specific './shapes/*'
    expect(targets).not.toContain('packages/lib/internal/shapes/circle.ts') // NOT the './*' mapping

    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ───────────────────────────────────────────────────────────────────
// Layer-2 — a function used ONLY as a callback (`arr.map(fn)`) has zero
// confirmed CALL edges, so callers is empty. The `ref` edge still records
// the usage; surface it as refCallersOf / referencedBy so the symbol is
// not misread as dead code. The confident call graph stays unchanged.
// ───────────────────────────────────────────────────────────────────
describe('symbol graph — callback (ref) usage is not false-dead (Layer-2)', () => {
  it('a callback-only function has 0 callers but is referencedBy its user', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cb-'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src/cb.ts'),
      'function onlyCallback(x) { return x * 2 }\n' +
      'function direct(x) { return x + 1 }\n' +
      'function user() { return [1, 2].map(onlyCallback).concat(direct(3)) }\n' +
      'export { user }\n')

    const s = new Scanner(root)
    await new Promise((resolve) => { s.once('snapshot', resolve); s.start() })
    const g = await s.getSymbolGraph()
    try { s.stop() } catch {}

    const idOf = (q) => { for (const [id, n] of g.nodes) if ((n.qualifiedName || n.name) === q) return id; return null }
    const cb = idOf('onlyCallback'); const dr = idOf('direct')
    expect(cb).toBeTruthy(); expect(dr).toBeTruthy()

    // callback-only: no confirmed callers, but referenced (used) — not dead.
    expect(g.callersOf(cb).length).toBe(0)
    expect(g.refCallersOf(cb).map((n) => n.qualifiedName || n.name)).toContain('user')
    // directly-called: confirmed caller, no spurious ref — call graph unchanged.
    expect(g.callersOf(dr).map((n) => n.qualifiedName || n.name)).toContain('user')
    expect(g.refCallersOf(dr).length).toBe(0)

    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

describe('scanner — spawned scripts are NOT orphans (end-to-end)', () => {
  let root
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-worker-'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    // Entry file spawns a worker and a child_process script by literal path.
    fs.writeFileSync(path.join(root, 'src/index.js'), `
import { fork } from 'child_process'
const w = new Worker('./w.js')
fork('./f.js')
`)
    // The two spawned scripts — nothing ELSE imports them. Before the fix they
    // were reported as high-confidence orphans (this repo's own search-worker
    // was the motivating case).
    fs.writeFileSync(path.join(root, 'src/w.js'), `export function run() { return 1 }`)
    fs.writeFileSync(path.join(root, 'src/f.js'), `process.on('message', () => {})`)
  })
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  it('creates worker + process import edges to the spawned files', async () => {
    const { snap } = await scanOnce(root)
    const wEdge = snap.edges.find((e) => e.s === 'src/index.js' && e.t === 'src/w.js')
    const fEdge = snap.edges.find((e) => e.s === 'src/index.js' && e.t === 'src/f.js')
    expect(wEdge).toBeDefined()
    expect(fEdge).toBeDefined()
  })

  it('the spawned files are no longer flagged as orphans', async () => {
    const { scanner } = await scanOnce(root)
    const audit = auditLegacy(scanner)
    const orphanIds = new Set(audit.orphans.map((o) => o.id))
    expect(orphanIds.has('src/w.js')).toBe(false)
    expect(orphanIds.has('src/f.js')).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// FIX 2 — imported-first-candidate nondeterminism in resolveCall.
// When ≥2 imported files declare the same name we must NOT pick an
// arbitrary (iteration-order-dependent) one; decline instead. A single
// imported candidate must still resolve correctly.
// ───────────────────────────────────────────────────────────────────
function fn(id, name, file) {
  return { id, name, qualifiedName: name, kind: 'function', file, startLine: 1 }
}

describe('symbol-graph resolveCall — imported-candidate determinism (Layer-2)', () => {
  it('resolves to the single imported file that declares the name', () => {
    const g = new SymbolGraph()
    // Only a.js declares foo and is imported → unambiguous.
    g.addNode(fn('a:foo', 'foo', 'src/a.js'))
    g.addNode(fn('b:bar', 'bar', 'src/b.js'))
    g.fileImports.set('src/caller.js', new Set(['src/a.js', 'src/b.js']))
    const r = g.resolveCall('src/caller.js', 'foo')
    expect(r).not.toBeNull()
    expect(r.file).toBe('src/a.js')
  })

  it('DECLINES when ≥2 imported files declare the SAME name (no arbitrary pick)', () => {
    const g = new SymbolGraph()
    // BOTH a.js and b.js export a function `foo`; caller imports both.
    g.addNode(fn('a:foo', 'foo', 'src/a.js'))
    g.addNode(fn('b:foo', 'foo', 'src/b.js'))
    g.fileImports.set('src/caller.js', new Set(['src/a.js', 'src/b.js']))
    // Must NOT confidently return either one (would be order-dependent / wrong).
    const r = g.resolveCall('src/caller.js', 'foo')
    expect(r).toBeNull()
  })

  it('decline is order-independent: same result regardless of node insert order', () => {
    const mk = (order) => {
      const g = new SymbolGraph()
      const a = () => g.addNode(fn('a:foo', 'foo', 'src/a.js'))
      const b = () => g.addNode(fn('b:foo', 'foo', 'src/b.js'))
      if (order === 'ab') { a(); b() } else { b(); a() }
      g.fileImports.set('src/caller.js', new Set(['src/a.js', 'src/b.js']))
      return g.resolveCall('src/caller.js', 'foo')
    }
    expect(mk('ab')).toBeNull()
    expect(mk('ba')).toBeNull()
  })

  it('multiple symbols in the SAME imported file collapse to one candidate (still resolves)', () => {
    const g = new SymbolGraph()
    // Two `foo` symbols but both live in a.js → one resolution target, not ambiguous.
    g.addNode(fn('a:foo1', 'foo', 'src/a.js'))
    g.addNode(fn('a:foo2', 'foo', 'src/a.js'))
    g.fileImports.set('src/caller.js', new Set(['src/a.js']))
    const r = g.resolveCall('src/caller.js', 'foo')
    expect(r).not.toBeNull()
    expect(r.file).toBe('src/a.js')
  })

  it('same-file declaration still wins over imports (no regression)', () => {
    const g = new SymbolGraph()
    g.addNode(fn('self:foo', 'foo', 'src/caller.js'))
    g.addNode(fn('a:foo', 'foo', 'src/a.js'))
    g.fileImports.set('src/caller.js', new Set(['src/a.js']))
    const r = g.resolveCall('src/caller.js', 'foo')
    expect(r.file).toBe('src/caller.js')
  })
})
