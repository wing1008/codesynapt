import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo } from './_build.js'

// ── Symbol-completeness BAR — PHP ──

const FIX = `<?php
function leaf() { return 1; }

function mid() { return leaf(); }            // EDGE mid -> leaf

function top() { return mid() + leaf(); }    // EDGE top -> mid, top -> leaf

class Engine {
    public function run() { return leaf(); }     // EDGE Engine.run -> leaf
    public function boot() { return $this->run(); }  // EDGE boot -> Engine.run ($this)
}

function useTyped(Engine $e) {
    return $e->run();                        // EDGE useTyped -> Engine.run (param typed)
}
`

describe('symbol-completeness bar — PHP', () => {
  it('STATIC RECALL: direct, $this and typed-param calls', async () => {
    const g = await buildGraph([{ id: 'fix.php', ext: 'php', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.boot', 'Engine.run')).toBe(true)
    expect(hasCall(g, 'useTyped', 'Engine.run')).toBe(true)
  })

  it('cross-file decoy: typed call lands in the right file', async () => {
    const SVC = `<?php class Service { public function work() { return 1; } }\n`
    const DECOY = `<?php class Other { public function work() { return 999; } }\n`
    const APP = `<?php function useIt(Service $s) { return $s->work(); }\n`
    const g = await buildGraph([
      { id: 'svc.php', ext: 'php', content: SVC },
      { id: 'decoy.php', ext: 'php', content: DECOY },
      { id: 'app.php', ext: 'php', content: APP },
    ])
    expect(hasCallTo(g, 'useIt', 'Service.work', 'svc.php')).toBe(true)
    expect(hasCallTo(g, 'useIt', 'Other.work', 'decoy.php')).toBe(false)
  })
})
