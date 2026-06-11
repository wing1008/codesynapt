import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo, hasCandidate } from './_build.js'

// ── Symbol-completeness BAR — Kotlin ──

const FIX = `
fun leaf(): Int = 1

fun mid(): Int = leaf()                  // EDGE mid -> leaf

fun top(): Int = mid() + leaf()          // EDGE top -> mid, top -> leaf

class Engine {
    fun run(): Int = leaf()              // EDGE Engine.run -> leaf
    fun boot(): Int = run()              // EDGE boot -> Engine.run (implicit this)
}

fun useTyped(e: Engine): Int {
    return e.run()                       // EDGE useTyped -> Engine.run (param typed)
}

interface Greeter { fun greet(): Int }
class Alpha : Greeter { override fun greet(): Int = 1 }
class Beta  : Greeter { override fun greet(): Int = 2 }
fun go(g: Greeter): Int = g.greet()      // typed -> Greeter.greet + dispatch candidates
`

describe('symbol-completeness bar — Kotlin', () => {
  it('STATIC RECALL: direct, implicit-this, typed-param calls', async () => {
    const g = await buildGraph([{ id: 'fix.kt', ext: 'kt', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.boot', 'Engine.run')).toBe(true)
    expect(hasCall(g, 'useTyped', 'Engine.run')).toBe(true)
  })

  it('PRECISION + DYNAMIC: interface dispatch → declaration + both impl candidates', async () => {
    const g = await buildGraph([{ id: 'fix.kt', ext: 'kt', content: FIX }])
    expect(hasCall(g, 'go', 'Greeter.greet')).toBe(true)
    expect(hasCall(g, 'go', 'Alpha.greet')).toBe(false)   // never one arbitrary impl
    expect(hasCandidate(g, 'go', 'Alpha.greet')).toBe(true)
    expect(hasCandidate(g, 'go', 'Beta.greet')).toBe(true)
  })

  it('cross-file decoy: typed call lands in the right file', async () => {
    const SVC = `class Service { fun work(): Int = 1 }\n`
    const DECOY = `class Other { fun work(): Int = 999 }\n`
    const APP = `fun useIt(s: Service): Int = s.work()\n`
    const g = await buildGraph([
      { id: 'svc.kt', ext: 'kt', content: SVC },
      { id: 'decoy.kt', ext: 'kt', content: DECOY },
      { id: 'app.kt', ext: 'kt', content: APP },
    ])
    expect(hasCallTo(g, 'useIt', 'Service.work', 'svc.kt')).toBe(true)
    expect(hasCallTo(g, 'useIt', 'Other.work', 'decoy.kt')).toBe(false)
  })
})
