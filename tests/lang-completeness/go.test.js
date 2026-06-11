import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo, dynamicSiteForms } from './_build.js'

// ── Symbol-completeness BAR — Go ──
// Same template as js/py/java/cs. Go specifics: methods live on receivers
// (`func (e *Engine) Run()` indexes as Engine.Run), interfaces are satisfied
// IMPLICITLY (no extends edge — dispatch candidates are out of scope for the
// Go bar v1 and documented as such), function values are first-class.

const FIX = `package main

func leaf() int { return 1 }

func mid() int { return leaf() }            // EDGE mid -> leaf

func top() int { return mid() + leaf() }    // EDGE top -> mid, top -> leaf

type Engine struct{ n int }

func NewEngine() *Engine { return &Engine{} }

func (e *Engine) Run() int { return leaf() }     // EDGE Engine.Run -> leaf

func (e *Engine) Boot() int { return e.Run() }   // EDGE Boot -> Engine.Run (receiver typed)

func useTyped() int {
	s := NewEngine()                         // s: *Engine via constructor return type
	return s.Run()                           // EDGE useTyped -> Engine.Run
}

func usesCallback(cb func() int) int { return cb() }   // DYNAMIC: param call

func passesRef() int { return usesCallback(leaf) }     // leaf as a VALUE
`

describe('symbol-completeness bar — Go', () => {
  it('STATIC RECALL: direct, method and typed-receiver calls', async () => {
    const g = await buildGraph([{ id: 'fix.go', ext: 'go', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'top', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.Run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.Boot', 'Engine.Run')).toBe(true)   // e.Run() on receiver
    expect(hasCall(g, 'useTyped', 'Engine.Run')).toBe(true)      // via NewEngine() return type
  })

  it('PRECISION: no phantom from refs/param calls', async () => {
    const g = await buildGraph([{ id: 'fix.go', ext: 'go', content: FIX }])
    expect(hasCall(g, 'usesCallback', 'leaf')).toBe(false)
  })

  it('cross-file: typed call lands in the right file, not a same-named decoy', async () => {
    const SVC = `package main
type Service struct{}
func (s *Service) Work() int { return 1 }
`
    const DECOY = `package main
type Other struct{}
func (o *Other) Work() int { return 999 }
`
    const APP = `package main
func use(s *Service) int { return s.Work() }
`
    const g = await buildGraph([
      { id: 'svc.go', ext: 'go', content: SVC },
      { id: 'decoy.go', ext: 'go', content: DECOY },
      { id: 'app.go', ext: 'go', content: APP },
    ])
    expect(hasCallTo(g, 'use', 'Service.Work', 'svc.go')).toBe(true)
    expect(hasCallTo(g, 'use', 'Other.Work', 'decoy.go')).toBe(false)
  })

  it('ZERO SILENCE: unresolvable bare callee is recorded, not dropped', async () => {
    // NB: the Go grammar parses fns[k]() as a GENERIC call (callee "fns"),
    // so this lands in the bare-unknown class rather than indirect — either
    // way it must be in the ledger, never silent.
    const DYN = `package main
func runIt(fns map[string]func() int, k string) int {
	return fns[k]()                      // DYNAMIC SITE: computed callee
}
`
    const g = await buildGraph([{ id: 'dyn.go', ext: 'go', content: DYN }])
    expect(dynamicSiteForms(g, 'runIt').length).toBeGreaterThanOrEqual(1)
  })
})
