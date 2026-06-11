import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo } from './_build.js'

// ── Symbol-completeness BAR — Swift ──
// NB: Swift parses via the heavy-grammar WORKER in production builds; the bar
// uses the in-process path (worker is a memory workaround, same extractor).

const FIX = `
func leaf() -> Int { return 1 }

func mid() -> Int { return leaf() }          // EDGE mid -> leaf

func top() -> Int { return mid() + leaf() }  // EDGE top -> mid, top -> leaf

class Engine {
    func run() -> Int { return leaf() }      // EDGE Engine.run -> leaf
    func boot() -> Int { return run() }      // EDGE boot -> Engine.run (implicit self)
}

func useTyped(e: Engine) -> Int {
    return e.run()                           // EDGE useTyped -> Engine.run (param typed)
}
`

describe('symbol-completeness bar — Swift', () => {
  it('STATIC RECALL: direct, implicit-self, typed-param calls', async () => {
    const g = await buildGraph([{ id: 'fix.swift', ext: 'swift', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.boot', 'Engine.run')).toBe(true)
    expect(hasCall(g, 'useTyped', 'Engine.run')).toBe(true)
  })

  it('cross-file decoy: typed call lands in the right file', async () => {
    const SVC = `class Service { func work() -> Int { return 1 } }\n`
    const DECOY = `class Other { func work() -> Int { return 999 } }\n`
    const APP = `func useIt(s: Service) -> Int { return s.work() }\n`
    const g = await buildGraph([
      { id: 'svc.swift', ext: 'swift', content: SVC },
      { id: 'decoy.swift', ext: 'swift', content: DECOY },
      { id: 'app.swift', ext: 'swift', content: APP },
    ])
    expect(hasCallTo(g, 'useIt', 'Service.work', 'svc.swift')).toBe(true)
    expect(hasCallTo(g, 'useIt', 'Other.work', 'decoy.swift')).toBe(false)
  })
})
