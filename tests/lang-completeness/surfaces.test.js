import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { buildGraph } from './_build.js'

// ── Bar #5 (user-usable): the honesty data must reach the SHARED view layer
// both servers (desktop + headless) serve from — not live only inside the graph.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sv = require(path.resolve(__dirname, '../../packages/core/lib/symbol-views.cjs'))

const FIX = `
export function main() { used(); maybe[k]() }
function used() { return 1 }
function lonely() { return 2 }
const maybe = {}, k = 'x'
`

async function graph() {
  return buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
}

describe('user surfaces — shared symbol views', () => {
  it('/symbol/accounting: partition + caveats are served', async () => {
    const g = await graph()
    const r = sv.handleSymbolView(g, 'accounting', {}, { files: new Map(), supportedExts: new Set(['js']) })
    expect(r.status).toBe(200)
    expect(r.body.unexplained).toBe(0)
    expect(r.body.total).toBe(r.body.entries + r.body.reachable + r.body.possible + r.body.dead)
    expect(r.body.labels.dead).toMatch(/floor/)
    expect(r.body).toHaveProperty('dynamicSiteCount')
    expect(r.body.deadSymbols.map((d) => d.name)).toContain('lonely')
  })

  it('symbolNodeView: per-symbol dynamicSites count is exposed', async () => {
    const g = await graph()
    const main = [...g.nodes.values()].find((n) => n.name === 'main')
    const view = sv.symbolNodeView(g, main)
    expect(view.dynamicSites).toBeGreaterThanOrEqual(1)   // maybe[k]() recorded
  })

  it('blast: dynamicSitesInImpact + floor caveat ride along', async () => {
    const g = await graph()
    const used = [...g.nodes.values()].find((n) => n.name === 'used')
    const r = sv.handleSymbolView(g, 'blast', { id: used.id, depth: 3 }, {})
    expect(r.status).toBe(200)
    expect(r.body.caveat).toMatch(/floor/)
    // main (caller of used) contains the computed call site → counted in impact.
    expect(r.body.dynamicSitesInImpact).toBeGreaterThanOrEqual(1)
  })

  it('summary: dynamicSiteCount flows through stats to both servers', async () => {
    const g = await graph()
    const r = sv.handleSymbolView(g, 'summary', {}, { files: new Map(), supportedExts: new Set(['js']) })
    expect(r.body.dynamicSiteCount).toBeGreaterThanOrEqual(1)
  })
})
