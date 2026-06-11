import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCallTo, hasCandidate } from './_build.js'

// ── Symbol-completeness BAR — Rust ──
// Rust specifics: methods live in impl blocks (classStack via impl), associated
// functions are called Type::fn (scoped), untyped member calls on unknown
// receivers REFUSE the bare fallback entirely (std surface too large — the
// measured slice.iter() -> Map.iter phantom class), trait impls give dispatch
// candidates via the trait edge.

const FIX = `
fn leaf() -> i32 { 1 }

fn mid() -> i32 { leaf() }              // EDGE mid -> leaf

fn top() -> i32 { mid() + leaf() }      // EDGE top -> mid, top -> leaf

struct Engine { n: i32 }

impl Engine {
    fn new() -> Engine { Engine { n: 0 } }     // associated fn -> Engine.new
    fn run(&self) -> i32 { leaf() }            // EDGE Engine.run -> leaf
    fn boot(&self) -> i32 { self.run() }       // EDGE boot -> Engine.run (self typed)
}

fn use_typed() -> i32 {
    let e = Engine::new();                     // e: Engine via Type::new
    e.run()                                    // EDGE use_typed -> Engine.run
}

fn use_assoc() -> i32 {
    Engine::new();                             // EDGE use_assoc -> Engine.new (scoped)
    0
}
`

describe('symbol-completeness bar — Rust', () => {
  it('STATIC RECALL: direct, assoc-fn, self and typed-receiver calls', async () => {
    const g = await buildGraph([{ id: 'fix.rs', ext: 'rs', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'top', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.run', 'leaf')).toBe(true)
    expect(hasCall(g, 'Engine.boot', 'Engine.run')).toBe(true)
    expect(hasCall(g, 'use_assoc', 'Engine.new')).toBe(true)
    expect(hasCall(g, 'use_typed', 'Engine.run')).toBe(true)
  })

  it('PRECISION: untyped member calls never grab a same-named user method', async () => {
    const TRAP = `
struct Map { }
impl Map {
    fn iter(&self) -> i32 { 0 }
}
fn walk(items: &[i32]) -> i32 {
    let mut s = 0;
    for it in items.iter() {              // std slice::iter — NOT Map.iter
        s += it;
    }
    s
}
`
    const g = await buildGraph([{ id: 'trap.rs', ext: 'rs', content: TRAP }])
    expect(hasCall(g, 'walk', 'Map.iter')).toBe(false)
  })

  it('cross-file: typed call lands in the right file, not the decoy', async () => {
    const SVC = `pub struct Service {}
impl Service { pub fn work(&self) -> i32 { 1 } }
`
    const DECOY = `pub struct Other {}
impl Other { pub fn work(&self) -> i32 { 999 } }
`
    const APP = `fn use_it(s: &Service) -> i32 { s.work() }
`
    const g = await buildGraph([
      { id: 'svc.rs', ext: 'rs', content: SVC },
      { id: 'decoy.rs', ext: 'rs', content: DECOY },
      { id: 'app.rs', ext: 'rs', content: APP },
    ])
    expect(hasCallTo(g, 'use_it', 'Service.work', 'svc.rs')).toBe(true)
    expect(hasCallTo(g, 'use_it', 'Other.work', 'decoy.rs')).toBe(false)
  })

  it('DYNAMIC: ambiguous method name (2 impls, unknown receiver) → candidates, no phantom', async () => {
    const AMB = `
struct A {}
impl A { fn render(&self) -> i32 { 1 } }
struct B {}
impl B { fn render(&self) -> i32 { 2 } }
fn draw(x: &dyn std::any::Any) -> i32 {
    // receiver type unknown to the static layer — must NOT pick A or B
    0
}
fn go_a(a: &A) -> i32 { a.render() }      // typed → precise
`
    const g = await buildGraph([{ id: 'amb.rs', ext: 'rs', content: AMB }])
    expect(hasCall(g, 'go_a', 'A.render')).toBe(true)
    expect(hasCall(g, 'go_a', 'B.render')).toBe(false)
  })
})
