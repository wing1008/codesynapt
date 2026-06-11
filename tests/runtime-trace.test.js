import { describe, it, expect } from 'vitest'
import { SymbolGraph } from '../packages/core/lib/symbol-graph.cjs'

// Leg C — runtime tracing. symbolAtLine() maps a runtime stack frame to the
// tightest enclosing symbol; observeRuntimeEdges() classifies observed call
// edges against the static graph (confirm static / confirm candidate / NEW
// dynamic). Both are pure.

function fixtureGraph() {
  const g = new SymbolGraph()
  // a.js: foo (1-10) wraps bar (3-5, tighter). b.js: baz (1-8), qux (10-15).
  g.addNode({ id: 'a#foo@1', file: 'a.js', name: 'foo', startLine: 1, endLine: 10, kind: 'function' })
  g.addNode({ id: 'a#bar@3', file: 'a.js', name: 'bar', startLine: 3, endLine: 5, kind: 'function' })
  g.addNode({ id: 'b#baz@1', file: 'b.js', name: 'baz', startLine: 1, endLine: 8, kind: 'function' })
  g.addNode({ id: 'b#qux@10', file: 'b.js', name: 'qux', startLine: 10, endLine: 15, kind: 'function' })
  g.addEdge({ source: 'a#foo@1', target: 'b#baz@1', kind: 'call' })            // static-known
  g.addEdge({ source: 'a#foo@1', target: 'a#bar@3', kind: 'call-candidate' })  // static-ambiguous
  return g
}

describe('symbolAtLine — frame → tightest enclosing symbol', () => {
  const g = fixtureGraph()
  it('picks the TIGHTEST enclosing symbol when ranges nest', () => {
    expect(g.symbolAtLine('a.js', 4)?.id).toBe('a#bar@3') // bar(3-5) ⊂ foo(1-10)
  })
  it('falls back to the outer symbol outside the nested range', () => {
    expect(g.symbolAtLine('a.js', 8)?.id).toBe('a#foo@1')
  })
  it('maps across files', () => {
    expect(g.symbolAtLine('b.js', 12)?.id).toBe('b#qux@10')
  })
  it('returns null for an unknown file or a line in no symbol', () => {
    expect(g.symbolAtLine('nope.js', 1)).toBe(null)
    expect(g.symbolAtLine('b.js', 9)).toBe(null) // gap between baz and qux
  })
})

describe('observeRuntimeEdges — classify observed vs static', () => {
  it('confirms a static call edge', () => {
    const r = fixtureGraph().observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 5 }])
    expect(r.observedEdges).toBe(1)
    expect(r.confirmedStatic).toBe(1)
    expect(r.newDynamic).toBe(0)
  })
  it('confirms (resolves) a static call-candidate', () => {
    const r = fixtureGraph().observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'a.js', el: 4 }])
    expect(r.confirmedCandidate).toBe(1)
    expect(r.confirmedStatic).toBe(0)
  })
  it('flags a NEW dynamic edge invisible to static', () => {
    const r = fixtureGraph().observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }]) // foo→qux, no static edge
    expect(r.newDynamic).toBe(1)
    expect(r.newDynamicSamples[0]).toEqual({ from: 'a#foo@1', to: 'b#qux@10' })
  })
  it('counts unmapped frames and ignores self-edges', () => {
    const r = fixtureGraph().observeRuntimeEdges([
      { cf: 'nope.js', cl: 1, ef: 'b.js', el: 5 },   // caller unmapped
      { cf: 'a.js', cl: 8, ef: 'a.js', el: 8 },       // foo→foo self, skipped
    ])
    expect(r.observedEdges).toBe(0)
    expect(r.unmappedFrames).toBe(1)
  })
  it('dedups repeated observations into one edge + reports coverage', () => {
    const r = fixtureGraph().observeRuntimeEdges([
      { cf: 'a.js', cl: 8, ef: 'b.js', el: 5 },
      { cf: 'a.js', cl: 9, ef: 'b.js', el: 6 }, // same foo→baz, different lines
    ])
    expect(r.observedEdges).toBe(1)
    expect(r.symbolsTouched).toBe(2)
    expect(r.totalSymbols).toBe(4)
  })
})

// ── Merge: observed edges join the live graph (and persistence is honest) ──
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const traceStore = _require('../packages/core/lib/trace-store.cjs')

describe('observeRuntimeEdges merge — observed edges become real graph edges', () => {
  it('merge:true adds kind "observed" into caller/callee adjacency', () => {
    const g = fixtureGraph()
    const r = g.observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }], { merge: true }) // foo→qux: NEW dynamic
    expect(r.newDynamic).toBe(1)
    expect(r.merged).toBe(1)
    // The witnessed edge is now REAL: callers/callees/blast/reachability see it.
    expect([...(g.callOut.get('a#foo@1') || [])]).toContain('b#qux@10')
    expect(g.callersOf('b#qux@10').map((n) => n.id)).toContain('a#foo@1')
    // Provenance stays distinct in byEdgeKind.
    expect(g.stats().byEdgeKind.observed).toBe(1)
  })

  it('merge is idempotent (re-observing the same edge adds nothing)', () => {
    const g = fixtureGraph()
    g.observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }], { merge: true })
    const r2 = g.observeRuntimeEdges([{ cf: 'a.js', cl: 9, ef: 'b.js', el: 13 }], { merge: true }) // same pair, other lines
    expect(r2.merged).toBe(0)
    expect(g.stats().byEdgeKind.observed).toBe(1)
  })

  it('without merge the graph is untouched (report-only)', () => {
    const g = fixtureGraph()
    g.observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }])
    expect(g.stats().byEdgeKind.observed).toBeUndefined()
  })
})

describe('persisted observations — mtime staleness guard', () => {
  it('replays pairs while files are unchanged, EXPIRES them when a file changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-obs-'))
    fs.writeFileSync(path.join(dir, 'a.js'), 'function foo(){}\n')
    fs.writeFileSync(path.join(dir, 'b.js'), 'function baz(){}\n')
    const pairs = [{ cf: 'a.js', cl: 1, ef: 'b.js', el: 1 }]
    expect(traceStore.appendObservedBatch(dir, pairs)).toBe(1)
    // Unchanged → valid.
    let loaded = traceStore.loadValidObservedPairs(dir)
    expect(loaded.pairs.length).toBe(1)
    expect(loaded.stale).toBe(0)
    // Touch one involved file (content + mtime change) → the pair EXPIRES.
    await new Promise((r) => setTimeout(r, 20))
    fs.writeFileSync(path.join(dir, 'b.js'), 'function baz(){ return 1 }\n')
    const t = Date.now() + 2000
    fs.utimesSync(path.join(dir, 'b.js'), new Date(t), new Date(t))
    loaded = traceStore.loadValidObservedPairs(dir)
    expect(loaded.pairs.length).toBe(0)
    expect(loaded.stale).toBe(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('auto-discovery — recall-miss suspects (roadmap ②, suspicion never verdict)', () => {
  it('flags an observed same-file edge to a UNIQUE-named target with no static edge', () => {
    const g = fixtureGraph()
    // foo→qux: same file pair? foo is a.js, qux is b.js — make it import-related
    g.fileImports = new Map([['a.js', new Set(['b.js'])]])
    const r = g.observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }], { merge: true })
    expect(r.newDynamic).toBe(1)
    expect(g.recallSuspects.length).toBe(1)
    expect(g.recallSuspects[0].name).toBe('qux')
    expect(g.stats().recallSuspectCount).toBe(1)
  })

  it('does NOT flag when the target name is ambiguous or files are unrelated', () => {
    const g = fixtureGraph()
    g.addNode({ id: 'c#qux@1', file: 'c.js', name: 'qux', startLine: 1, endLine: 5, kind: 'function' }) // name now ambiguous
    g.fileImports = new Map([['a.js', new Set(['b.js'])]])
    g.observeRuntimeEdges([{ cf: 'a.js', cl: 8, ef: 'b.js', el: 12 }], { merge: true })
    expect(g.recallSuspects.length).toBe(0)   // unique-name predicate refused
  })
})

describe('persisted observations — re-observation after edit (inspection fix #1)', () => {
  it('a stale old batch must NOT shadow a valid newer re-observation of the same pair', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-obs2-'))
    fs.writeFileSync(path.join(dir, 'a.js'), 'function foo(){}\n')
    fs.writeFileSync(path.join(dir, 'b.js'), 'function baz(){}\n')
    const pairs = [{ cf: 'a.js', cl: 1, ef: 'b.js', el: 1 }]
    traceStore.appendObservedBatch(dir, pairs)          // batch 1 (will go stale)
    await new Promise((r) => setTimeout(r, 20))
    fs.writeFileSync(path.join(dir, 'b.js'), 'function baz(){ return 1 }\n')
    const t = Date.now() + 2000
    fs.utimesSync(path.join(dir, 'b.js'), new Date(t), new Date(t))
    traceStore.appendObservedBatch(dir, pairs)          // batch 2: RE-observed, valid now
    const loaded = traceStore.loadValidObservedPairs(dir)
    expect(loaded.pairs.length).toBe(1)                 // the valid re-observation survives
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
