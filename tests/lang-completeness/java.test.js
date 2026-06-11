import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCandidate } from './_build.js'
import { parseFile } from '../../packages/core/parser.js'

// ── Symbol-completeness BAR — Java ──
// Common-pattern fixture (NOT a full type solver — see design doc depth limit).

const FIX = `
import java.lang.reflect.Method;

public class Fix {
  static int leaf() { return 1; }
  static int mid() { return leaf(); }              // EDGE mid -> leaf
  static int top() { return mid() + leaf(); }      // EDGE top -> mid, top -> leaf

  int run() { return helper(); }                    // EDGE run -> helper (same class)
  int helper() { return leaf(); }                   // EDGE helper -> leaf

  void reflect() throws Exception {
    Method m = Fix.class.getMethod("run");
    m.invoke(this);                                 // DYNAMIC: reflection
  }
}

interface Greeter { String greet(); }
class Alpha implements Greeter { public String greet() { return "a"; } }
class Beta  implements Greeter { public String greet() { return "b"; } }
class UseG {
  String go(Greeter g) { return g.greet(); }        // AMBIGUOUS: 2 impls -> candidates
}
`

describe('symbol-completeness bar — Java', () => {
  it('STATIC RECALL: every statically-determinable call edge is present', async () => {
    const g = await buildGraph([{ id: 'Fix.java', ext: 'java', content: FIX }])
    expect(hasCall(g, 'mid', 'leaf')).toBe(true)
    expect(hasCall(g, 'top', 'mid')).toBe(true)
    expect(hasCall(g, 'top', 'leaf')).toBe(true)
    expect(hasCall(g, 'run', 'helper')).toBe(true)
    expect(hasCall(g, 'helper', 'leaf')).toBe(true)
  })

  it('PRECISION: typed interface call resolves to the DECLARATION, never one arbitrary impl', async () => {
    const g = await buildGraph([{ id: 'Fix.java', ext: 'java', content: FIX }])
    // Correct typed resolution: g is Greeter → confident edge to the interface decl.
    expect(hasCall(g, 'go', 'Greeter.greet')).toBe(true)
    // A confident edge to a SINGLE impl would be a phantom (arbitrary-impl bug).
    expect(hasCall(g, 'go', 'Alpha.greet')).toBe(false)
    expect(hasCall(g, 'go', 'Beta.greet')).toBe(false)
  })

  it('DYNAMIC = max candidates: BOTH impls surface as dispatch candidates', async () => {
    const g = await buildGraph([{ id: 'Fix.java', ext: 'java', content: FIX }])
    expect(hasCandidate(g, 'go', 'Alpha.greet')).toBe(true)
    expect(hasCandidate(g, 'go', 'Beta.greet')).toBe(true)
  })

  it('ZERO SILENCE: reflection is flagged at the file level (Layer-1 marker)', () => {
    const r = parseFile('Fix.java', FIX, 'java')
    expect(r.dynamicPatterns).toContain('reflection')
  })
})
