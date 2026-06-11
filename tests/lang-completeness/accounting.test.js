import { describe, it, expect } from 'vitest'
import { buildGraph } from './_build.js'

// ── Accounting completeness bar (user bar #4) ──
// EVERY symbol must carry exactly one label: entry / reachable / possible /
// dead — unexplained MUST be 0. A dead verdict is a documented static floor
// (dynamicSiteCount + entryDetection caveats are returned, never hidden).

function idsByName(g, ...names) {
  const out = []
  for (const n of g.nodes.values()) if (names.includes(n.name)) out.push(n.id)
  return out
}
function deadNames(g, acc) {
  return acc.dead.map((id) => g.nodes.get(id)?.name)
}

describe('accounting bar — JavaScript', () => {
  const FIX = `
function main() { used(); [1].map(cbRef); maybe() }
function used() { return chained() }
function chained() { return 1 }
function cbRef() { return 2 }                 // alive only as a VALUE (ref)
function maybe() { return 3 }
function trulyDead() { return deadChained() } // nobody calls main-ward
function deadChained() { return 4 }
`
  it('partitions every symbol with unexplained === 0', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    const acc = g.accounting(idsByName(g, 'main'))
    expect(acc.unexplained).toBe(0)
    expect(acc.total).toBe(acc.entryCount + acc.reachableCount + acc.possibleCount + acc.deadCount)
  })

  it('labels match the fixture: dead is exactly the unreached chain', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    const acc = g.accounting(idsByName(g, 'main'))
    const dead = deadNames(g, acc)
    expect(dead).toContain('trulyDead')
    expect(dead).toContain('deadChained')   // dead transitively — its only caller is dead
    expect(dead).not.toContain('used')
    expect(dead).not.toContain('chained')
    expect(dead).not.toContain('cbRef')     // value-referenced → possible, NOT dead
    expect(dead).not.toContain('maybe')
  })

  it('returns the honesty caveats (dead = floor, not proof)', async () => {
    const g = await buildGraph([{ id: 'fix.js', ext: 'js', content: FIX }])
    const acc = g.accounting(idsByName(g, 'main'))
    expect(acc).toHaveProperty('dynamicSiteCount')
    expect(acc).toHaveProperty('entryDetection')
  })
})

describe('accounting bar — Java (treesitter path)', () => {
  const FIX = `
public class App {
  int main() { return new Service().run(); }
}
class Service {
  int run() { return helper(); }
  int helper() { return 1; }
  int unused() { return 99; }
}
`
  it('partitions with unexplained === 0 and finds the dead method', async () => {
    const g = await buildGraph([{ id: 'App.java', ext: 'java', content: FIX }])
    const acc = g.accounting(idsByName(g, 'main'))
    expect(acc.unexplained).toBe(0)
    const dead = deadNames(g, acc)
    expect(dead).toContain('unused')
    expect(dead).not.toContain('run')
    expect(dead).not.toContain('helper')
  })
})
