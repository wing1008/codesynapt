import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

// ── Real-repo regression bar ──
// Fixtures prove patterns; THIS test freezes the invariants of the production
// build path over the repo's own source (the only real codebase that is always
// present on CI). Thresholds are FLOORS measured 2026-06-11 (symbols 1198,
// edges 1898, genuine-gap 1, dynamicSites 273) with headroom — they catch
// silent mass-loss/phantom-flood regressions, not exact counts.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '../..')
const parsers = require(path.join(ROOT, 'packages/core/lib/symbol-parsers.cjs'))
const sg = require(path.join(ROOT, 'packages/core/lib/symbol-graph.cjs'))

function collectEntries() {
  const EXTS = new Set(['js', 'cjs', 'mjs'])
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(ROOT, rel))) {
      const r = rel + '/' + name
      const st = fs.statSync(path.join(ROOT, r))
      if (st.isDirectory()) { if (!/node_modules|vendor/.test(name)) walk(r); continue }
      const ext = name.split('.').pop()
      if (EXTS.has(ext) && !name.includes('.test.')) out.push({ id: r, ext, absPath: path.join(ROOT, r) })
    }
  }
  for (const d of ['packages/core', 'public', 'electron']) walk(d)
  return out
}

async function buildOnce() {
  parsers.registerAll()
  const g = new sg.SymbolGraph()
  const stats = await g.build(collectEntries())
  return { g, stats }
}

describe('real-repo regression bar (production build path on own source)', () => {
  it('holds all floor/exactness invariants', async () => {
    const { g, stats } = await buildOnce()
    // Exactness: a thrown parser is NEVER acceptable.
    expect(stats.parseFailures).toBe(0)
    // Floors — silent mass-loss guards.
    expect(stats.symbolCount).toBeGreaterThanOrEqual(1000)
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1600)
    expect(stats.byEdgeKind.call).toBeGreaterThanOrEqual(1100)
    expect(stats.byEdgeKind['call-candidate']).toBeGreaterThanOrEqual(200)
    expect(stats.byEdgeKind.ref).toBeGreaterThanOrEqual(180)
    // Precision discipline: genuine (non-stdlib) unresolved stays tiny.
    const dr = stats.declineReasons
    const stdlib = (dr['builtin-method'] || 0) + (dr['builtin-fallback'] || 0)
    expect(stats.unresolvedAmbiguous - stdlib).toBeLessThanOrEqual(10)
    // Zero-silence ledger active on real code (273 measured; floor 200).
    expect(stats.dynamicSiteCount).toBeGreaterThanOrEqual(200)
    // Accounting completeness on real code.
    const acc = g.accounting()
    expect(acc.unexplained).toBe(0)
  }, 120000)

  it('is deterministic: two builds produce the identical graph shape', async () => {
    const a = await buildOnce()
    const b = await buildOnce()
    expect(a.stats.symbolCount).toBe(b.stats.symbolCount)
    expect(a.stats.edgeCount).toBe(b.stats.edgeCount)
    expect(a.stats.byEdgeKind).toEqual(b.stats.byEdgeKind)
    expect(a.stats.dynamicSiteCount).toBe(b.stats.dynamicSiteCount)
  }, 240000)
})
