import { describe, it, expect } from 'vitest'
import { buildGraph, hasCallTo } from './_build.js'

// ── Cross-file resolution bar ──
// The single-file fixtures cannot catch the most damaging real-world failure:
// a call resolving to a SAME-NAMED symbol in the WRONG file. Each language gets
// a "decoy" file declaring the same name; the edge must land in the right file.

describe('cross-file bar — JavaScript (import disambiguation)', () => {
  const A = `export function helper() { return 1 }`
  const DECOY = `export function helper() { return 999 }`   // same name, NOT imported
  const B = `import { helper } from './a.js'
export function caller() { return helper() }`

  it('resolves to the IMPORTED file, never the same-named decoy', async () => {
    const g = await buildGraph(
      [
        { id: 'a.js', ext: 'js', content: A },
        { id: 'decoy.js', ext: 'js', content: DECOY },
        { id: 'b.js', ext: 'js', content: B },
      ],
      { 'b.js': ['a.js'] },
    )
    expect(hasCallTo(g, 'caller', 'helper', 'a.js')).toBe(true)
    expect(hasCallTo(g, 'caller', 'helper', 'decoy.js')).toBe(false)
  })

  it('with NO import info and 2 same-named files: declines rather than guesses', async () => {
    const g = await buildGraph([
      { id: 'a.js', ext: 'js', content: A },
      { id: 'decoy.js', ext: 'js', content: DECOY },
      { id: 'b.js', ext: 'js', content: B.replace("import { helper } from './a.js'\n", '') },
    ])
    // Ambiguous (2 production candidates) — a confident edge to EITHER is a guess.
    expect(hasCallTo(g, 'caller', 'helper', 'a.js')).toBe(false)
    expect(hasCallTo(g, 'caller', 'helper', 'decoy.js')).toBe(false)
  })
})

describe('cross-file bar — Python (import disambiguation)', () => {
  const A = `def helper():\n    return 1\n`
  const DECOY = `def helper():\n    return 999\n`
  const B = `from a import helper\n\ndef caller():\n    return helper()\n`

  it('resolves to the IMPORTED file, never the same-named decoy', async () => {
    const g = await buildGraph(
      [
        { id: 'a.py', ext: 'py', content: A },
        { id: 'decoy.py', ext: 'py', content: DECOY },
        { id: 'b.py', ext: 'py', content: B },
      ],
      { 'b.py': ['a.py'] },
    )
    expect(hasCallTo(g, 'caller', 'helper', 'a.py')).toBe(true)
    expect(hasCallTo(g, 'caller', 'helper', 'decoy.py')).toBe(false)
  })
})

describe('cross-file bar — Java (typed cross-file resolution)', () => {
  const SERVICE = `public class Service {\n  int run() { return 1; }\n}\n`
  const OTHER = `public class Other {\n  int run() { return 999; }\n}\n`   // same method name
  const USER = `public class App {\n  int use(Service s) { return s.run(); }\n}\n`

  it('typed call lands on the right class across files, not the same-named decoy', async () => {
    const g = await buildGraph([
      { id: 'Service.java', ext: 'java', content: SERVICE },
      { id: 'Other.java', ext: 'java', content: OTHER },
      { id: 'App.java', ext: 'java', content: USER },
    ])
    expect(hasCallTo(g, 'use', 'Service.run', 'Service.java')).toBe(true)
    expect(hasCallTo(g, 'use', 'Other.run', 'Other.java')).toBe(false)
  })
})

describe('cross-file bar — C# (typed cross-file resolution)', () => {
  const SERVICE = `class Service {\n  public int Run() { return 1; }\n}\n`
  const OTHER = `class Other {\n  public int Run() { return 999; }\n}\n`
  const USER = `class App {\n  int Use(Service s) { return s.Run(); }\n}\n`

  it('typed call lands on the right class across files, not the same-named decoy', async () => {
    const g = await buildGraph([
      { id: 'Service.cs', ext: 'cs', content: SERVICE },
      { id: 'Other.cs', ext: 'cs', content: OTHER },
      { id: 'App.cs', ext: 'cs', content: USER },
    ])
    expect(hasCallTo(g, 'Use', 'Service.Run', 'Service.cs')).toBe(true)
    expect(hasCallTo(g, 'Use', 'Other.Run', 'Other.cs')).toBe(false)
  })
})
