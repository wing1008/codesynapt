# Design — Expression Layer (Phase 4 epic, proposal)

> Status: **design-first, not started** (2026-06-11). The third granularity of
> the vision: file → function → **expression**. Locked order: this comes after
> the function-level loop, which is now complete (4-language bar, runtime
> tracing run/watch, live 3D merge).

## What "expression layer" must mean (and not mean)
The vision quote: "함수가 가능하면 코드도 마찬가지" — code-level dataflow.
NOT every AST node as a graph node (codegraph's mistake — node explosion makes
the map unreadable and the payload unaffordable). The valuable subset:

1. **Intra-function dataflow**: which parameters/locals FLOW INTO which call
   arguments and the return value. This is what lets blast say "changing this
   parameter affects THESE downstream calls", one level deeper than "function
   touches function".
2. **Cross-function value threading**: `a = f(); g(a)` — f's RETURN feeds g's
   argument. The graph edge gains a "carries value" annotation rather than a
   new node per expression.
3. **Branch-conditional calls**: a call inside `if (flag)` is conditional —
   blast can label it "conditional path" (today every call looks equally certain).

## Honest-floor rules (same discipline as Layers 1-2)
- Expression facts are EXTRACTED per function on demand (lazy), never built
  whole-project — bounded cost, no 100k-node graph.
- Dataflow through dynamic constructs (computed member, eval) terminates in the
  existing dynamic-site ledger — no guessing.
- Precision first: an uncertain flow is omitted+counted, never asserted.

## Proposed increments (each independently shippable)
- **E1**: per-function expression facts endpoint `GET /symbol/flow?id=` —
  params → call-args → return chains, computed lazily via the existing babel/
  tree-sitter ASTs. Surfaced in `cs symbol flow <id>` + node view.
- **E2**: blast integration — "argument-level blast": given symbol+param index,
  which downstream call sites receive that value (bounded depth).
- **E3**: 3D: expression flows render ONLY for the selected function (on-demand
  overlay, never the whole project).
- Bar: known-answer flow fixtures per language (JS first), same harness shape.

## Open decisions
1. JS-first then the other 3, or JS-only until E3 proves value?
2. Does E2's argument-level blast justify a new MCP tool or extend cs_blast?
