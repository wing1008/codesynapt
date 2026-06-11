import { describe, it, expect } from 'vitest'
import { buildGraph, hasCall, hasCandidate } from './_build.js'
import { parseFile } from '../../packages/core/parser.js'

// ── Symbol-completeness BAR — C# ──
// Common-pattern fixture (NOT a full type solver — see design doc depth limit).

const FIX = `
using System;
using System.Reflection;

class Fix {
  static int Leaf() { return 1; }
  static int Mid() { return Leaf(); }               // EDGE Mid -> Leaf
  static int Top() { return Mid() + Leaf(); }       // EDGE Top -> Mid, Top -> Leaf

  int Run() { return Helper(); }                     // EDGE Run -> Helper
  int Helper() { return Leaf(); }                    // EDGE Helper -> Leaf

  void Reflect() {
    var m = typeof(Fix).GetMethod("Run");
    m.Invoke(this, null);                            // DYNAMIC: reflection
  }
}

interface IGreeter { string Greet(); }
class Alpha : IGreeter { public string Greet() { return "a"; } }
class Beta  : IGreeter { public string Greet() { return "b"; } }
class UseG {
  string Go(IGreeter g) { return g.Greet(); }        // AMBIGUOUS: 2 impls -> candidates
}
`

describe('symbol-completeness bar — C#', () => {
  it('STATIC RECALL: every statically-determinable call edge is present', async () => {
    const g = await buildGraph([{ id: 'Fix.cs', ext: 'cs', content: FIX }])
    expect(hasCall(g, 'Mid', 'Leaf')).toBe(true)
    expect(hasCall(g, 'Top', 'Mid')).toBe(true)
    expect(hasCall(g, 'Top', 'Leaf')).toBe(true)
    expect(hasCall(g, 'Run', 'Helper')).toBe(true)
    expect(hasCall(g, 'Helper', 'Leaf')).toBe(true)
  })

  it('PRECISION: typed interface call resolves to the DECLARATION, never one arbitrary impl', async () => {
    const g = await buildGraph([{ id: 'Fix.cs', ext: 'cs', content: FIX }])
    expect(hasCall(g, 'Go', 'IGreeter.Greet')).toBe(true)
    expect(hasCall(g, 'Go', 'Alpha.Greet')).toBe(false)
    expect(hasCall(g, 'Go', 'Beta.Greet')).toBe(false)
  })

  it('DYNAMIC = max candidates: BOTH impls surface as dispatch candidates', async () => {
    const g = await buildGraph([{ id: 'Fix.cs', ext: 'cs', content: FIX }])
    expect(hasCandidate(g, 'Go', 'Alpha.Greet')).toBe(true)
    expect(hasCandidate(g, 'Go', 'Beta.Greet')).toBe(true)
  })

  it('ZERO SILENCE: reflection is flagged at the file level (Layer-1 marker)', () => {
    const r = parseFile('Fix.cs', FIX, 'cs')
    expect(r.dynamicPatterns).toContain('reflection')
  })
})
