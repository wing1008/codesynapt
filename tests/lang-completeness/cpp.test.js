import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo } from './_build.js'

// ── Symbol-completeness BAR — C++ ──

const FIX = `
int leaf() { return 1; }

int mid() { return leaf(); }              // EDGE mid -> leaf

int top() { return mid() + leaf(); }      // EDGE top -> mid, top -> leaf

class Engine {
public:
    int run() { return leaf(); }          // EDGE Engine.run -> leaf
    int boot() { return run(); }          // EDGE boot -> Engine.run (implicit this)
};

int useTyped(Engine& e) {
    return e.run();                       // EDGE useTyped -> Engine.run (param typed)
}
`

describe('symbol-completeness bar — C++', () => {
  it('STATIC RECALL: direct, implicit-this, typed-param calls', async () => {
    const g = await buildGraph([{ id: 'fix.cpp', ext: 'cpp', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.boot', 'Engine.run')).toBe(true)
    expect(hasCall(g, 'useTyped', 'Engine.run')).toBe(true)
  })

  it('cross-file decoy: typed call lands in the right file', async () => {
    const SVC = `class Service {\npublic:\n  int work() { return 1; }\n};\n`
    const DECOY = `class Other {\npublic:\n  int work() { return 999; }\n};\n`
    const APP = `int useIt(Service& s) { return s.work(); }\n`
    const g = await buildGraph([
      { id: 'svc.hpp', ext: 'hpp', content: SVC },
      { id: 'decoy.hpp', ext: 'hpp', content: DECOY },
      { id: 'app.cpp', ext: 'cpp', content: APP },
    ])
    expect(hasCallTo(g, 'useIt', 'Service.work', 'svc.hpp')).toBe(true)
    expect(hasCallTo(g, 'useIt', 'Other.work', 'decoy.hpp')).toBe(false)
  })
})
