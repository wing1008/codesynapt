# Expression Mode (Layer-3) — Design & Plan

Intra-procedural **expression / variable dataflow** that lives alongside
the file-level (layer-1) import graph and the function-level (layer-2)
call graph. This document is the single source of truth for the L3 data
model, the flow-resolution policy, and the phased build plan with the
measurement gate each phase must pass.

> Status: **draft / design-of-record (準備).** Nothing is built. This
> mirrors the conventions of `docs/SYMBOL-MODE-PLAN.md` (the L2 record)
> and reuses its infrastructure wherever possible. It is written to be
> implemented against, not as a wish-list.

---

## 1. Why layer-3

The product vision is a neuron-map of code at three depths:

| Layer | Node | Edge | Question it answers | State |
|---|---|---|---|---|
| L1 (file) | file | import | "what imports `auth.ts`?" | built |
| L2 (symbol) | function / method / class | call / extends / ref | "what calls `User.save`?" | built + oracle-verified |
| **L3 (expression)** | **variable / param / expression** | **flows-to / reads / writes / binds** | **"what feeds this call argument? where does `token` reach?"** | **NOT built** |

L2 tells the AI *that* `handleRequest` calls `db.query`. It is blind to
**what flows through the call**: which variable became the SQL string,
where that variable was last written, whether the untrusted `req.body`
reached it. An agent refactoring a function still has to read the whole
body to answer "if I rename this parameter, which expressions break?" or
"what is the source of the value passed to `query()`?". L3 makes that a
graph query instead of a re-read.

L3 is the layer where **dataflow** lives: def-use chains, variable →
call-argument → parameter → field/return propagation, *inside one
function body*. It is the most ambitious layer and the one most prone to
combinatorial blowup and to a measurement trap — both are addressed
explicitly in §8–§9.

### L3 vs L2 — the sharp distinction

- L2 edge: `foo → bar` means "the body of `foo` contains a call that
  statically resolves to symbol `bar`." Granularity = **symbol**.
- L3 edge: `x@12 → arg0(query@27)` means "the value bound to variable
  `x` at line 12 flows, with no redefinition, into the first argument of
  the call at line 27." Granularity = **expression / SSA-ish binding**.

L3 nodes are *sub-symbol*: they live **inside** an L2 symbol's
`[startLine, endLine]` span and are keyed to it. L3 never invents a new
call edge; it explains the *data* moving along (or into) the calls L2
already found.

---

## 2. Current state (honest)

- **No L3 / dataflow / def-use / taint scaffolding exists.** A repo-wide
  grep for `dataflow|def-use|expression-graph|taint|flows-to|L3` returns
  only: a comment in `symbol-parser-js.cjs:793` ("member-call data-flow
  gap" — about return-type inference, not a graph), a *retired* UI mode
  string in `electron/main.cjs:2428`, and the AGPL license word "taint".
  Layer-3 is greenfield.
- **But the parsers already compute most of the raw material and throw
  it away** (see §3). This is the cheapest possible starting point: L3's
  hardest part (binding variables to types/values inside a function) is
  *already done transiently* during L2 reference extraction.

So the honest state: **the substrate exists inside the L2 parse pass;
nothing persists it as a graph; precision policy + exposure + 3D are
0%.**

---

## 3. Expression info the parsers ALREADY compute and discard

This is the load-bearing finding for cost. L2 reference extraction does a
full AST walk per file and *builds, uses, then drops* exactly the
intra-procedural bindings L3 needs. Reusing this is the difference
between "re-implement a dataflow engine" and "stop discarding what we
already have."

### Babel (JS/TS) — `symbol-parser-js.cjs`

- **Variable → type bindings**, per function scope, pushed/popped with
  the enclosing stack: `typeStack` / `topTypes()` / `lookupVarType()`
  (`:484–494`). Populated by `harvestTypesFrom` (`:524`) and
  `harvestVarDecl` (`:560`) from:
  - TS parameter annotations `function f(user: User)` (`:530–547`);
  - destructured params `function f({name}: User)` (`:538`);
  - body `const x = new X()` / `const x: T = …` / `const x = factory()`
    (`:560–582`);
  - module-level `const X: T = …` harvested into the type-stack base
    (`:591–600`).
  Today this map is consulted only to resolve the *call target type*,
  then discarded at `popTypes()`. **It is a partial def→type table — the
  spine of a def-use index.**
- **Return-type dataflow** across call chains: `callReturnType` (`:502`)
  already follows `make().parse()` / `a().b().c()` by reading the callee
  symbol's `returnType` (recursion-bounded). This is *value-origin*
  reasoning — exactly L3's "where did this value come from" — used once
  and dropped.
- **Receiver / member-access chains**: the `CallExpression|NewExpression`
  visitor (`:749`) decomposes `obj.method()`, `this.prop.method()`
  (`:781`), `make().method()` (`:790`) to find the receiver. The
  decomposed chain is computed and discarded.
- **babel scope bindings**: `path.scope.getBinding(name)` is already
  called (`:771`, `:834`) to distinguish a param/local/const from a
  module function. babel's `Binding` carries `referencePaths` and
  `constantViolations` — **a complete def-use list for that variable,
  for free**, currently used only as a boolean guard.
- **Call arguments**: `path.node.arguments` is fully present on every
  resolved call edge but never read — the call edge records only
  `source/target/line`, dropping *which expressions were the arguments*.

### Tree-sitter (Python + validated set) — `symbol-parser-treesitter.cjs`

- **Per-function var→type maps**: `varTypeStack` (`:392–399`),
  `harvestPyFuncTypes` (`:723`), `goHarvestFuncTypes` (`:918`),
  `genericHarvest`. Python harvests typed params and `x = Foo()` /
  `x: T = …` / `x = factory()` assignments by scanning the function body
  (`pyScanAssignments`, `:705`). Same story: built, used for receiver
  typing, dropped.
- **Class property types**: `harvestPyClassProps` (`:742`) records
  `self.attr` types from `__init__` — field-flow material.
- **Assignment scanning**: `pyScanAssignments` already visits every
  `assignment` node in a body without descending into nested scopes — it
  is a ready-made def-site iterator; L3 needs to also keep the *RHS
  expression* and the *line*, not just the inferred type.
- **Receiver decomposition** per language (`RECV_OF`, `:973`;
  `pyObjType`, `goObjType`) walks member-access chains identically.

**Cheapest L3 start = persist what these harvests already compute.** A
def-use index is `varTypeStack` + `typeStack` *kept* (with def line and
RHS kind) instead of popped, plus babel's already-available
`Binding.referencePaths` for the use sites. No new traversal, no new type
engine.

---

## 4. Data model

### Principle: isolated parallel index, L1/L2 untouched

L2 was added as an isolated leg (the `call-candidate` adjacency lives in
its own `candOut`/`candIn`, never polluting `callOut`/`callIn` — see
`symbol-graph.cjs:108–110, 544–551`). **L3 follows the same isolation
discipline**, one level stronger: L3 nodes are *not* added to
`SymbolGraph.nodes` (that map backs blast/reachability/embeddings and
must keep meaning "callable symbols"). Instead, L3 is a **separate
`FlowGraph`, keyed to L2 symbol ids**, built lazily and only on demand
for a single symbol (see §8 — never eagerly for the whole repo).

```
FlowGraph (per L2 symbol, built on demand)
  flowNodes: Map<flowId, FlowNode>
  flowEdges: FlowEdge[]
  bySymbol:  Map<symbolId, Set<flowId>>     // every flow node inside a symbol
  defsByName: Map<name, flowId[]>           // def-use lookup within the symbol
```

`FlowNode` id: **`{symbolId}::{kind}:{name}@{line}:{col}`** — extends the
L2 id grammar (`{file}#{qn}@{line}`) so a flow node always names its
owning symbol and never collides with an L2 node id.

```
FlowNode {
  id, symbolId,                  // owning L2 symbol (the scope)
  kind: 'param' | 'var' | 'def' | 'use' | 'expr' | 'arg' | 'return' | 'field',
  name,                          // variable / param / field name (or '' for exprs)
  line, col,
  declType?,                     // known type (reuses the harvested type map)
  argIndex?,                     // for kind 'arg': position in the call
  callEdgeRef?,                  // for kind 'arg'/'return': the L2 call edge it feeds
}

FlowEdge {
  source, target,                // flowId → flowId
  kind: 'binds'      // a def binds a name        (RHS expr  → def x)
      | 'reads'      // a use reads a def         (def x     → use x)
      | 'writes'     // an assignment writes a def (expr      → def x, reassignment)
      | 'flows-to'   // value moves with no redef  (def x     → arg0 of call)
      | 'returns',   // value reaches a return     (def x     → return)
  confidence: 'confident' | 'candidate',   // see §5
  line,
}
```

### New edge kinds — additive, isolated

`binds` / `reads` / `writes` / `flows-to` / `returns` are **L3-only edge
kinds**. They never enter `SymbolGraph.edges`, `inAdj`/`outAdj`,
`callOut`/`callIn`, `candOut`/`candIn`, or `byEdgeKind`. Consequence:
`stats()`, `symbolBlast`, `computeReachability`, embeddings, and the 3D
call layer are **provably unchanged** — L3 cannot regress L2, exactly as
the call-candidate leg could not regress the confident call graph.

### Keying to L2 (the bridge)

Each `FlowNode.symbolId` points at a real L2 node; `kind:'arg'` and
`kind:'return'` nodes carry `callEdgeRef` = the `{source,target,line}` of
the L2 `call` edge they belong to. This is the join that lets a query
walk **L3 → L2**: "this argument flows into call X, which L2 resolved to
`User.save`" — i.e. the value's destination is a known symbol. (The
reverse, callee-parameter → caller-argument *interprocedural* flow, is
explicitly v2 — §9.)

---

## 5. Flow-resolution policy (precision-first)

Vision standard, verbatim: **"정적은 100%, 동적은 후보군 최대치, 틀린연결
0, 빈연결=놓침은 허용"** — static must be 100%, dynamic gives the maximal
candidate set, zero wrong edges, a missed (empty) link is acceptable.

L3 inherits L2's **mark, don't guess** rule and adds a confident-flow vs
candidate-flow split mirroring `call` vs `call-candidate`:

1. **Confident `flows-to`** — emitted only when the binding is
   statically unambiguous within the function body:
   - a single SSA-style definition reaches the use with no intervening
     write (babel `Binding` with `constant === true`, or one def
     dominating the use in straight-line / single-branch code);
   - the variable is a **local or parameter** (babel
     `path.scope.getBinding` confirms it is not a free/global name — the
     same guard L2 already uses at `symbol-parser-js.cjs:834`).
2. **Candidate `flows-to` (confidence:'candidate')** — when ≥2
   definitions could reach a use (reassignment across branches, loop
   carry, aliasing): emit the **maximal honest set** of def→use edges,
   marked candidate, never collapsed to one guess. This is the L3
   analogue of `candidatesFor` (`symbol-graph.cjs:444`).
3. **Decline** — for anything statically undecidable (see §6): no edge.
   A missing flow is a *floor*, surfaced as a count
   (`unresolvedFlows`), never a wrong edge.

Confident and candidate flows live in **separate adjacency** within
`FlowGraph`, so a consumer asking "what definitely feeds this argument"
gets only confident edges, and "what could feed it" gets the union — the
identical contract the desktop/MCP already use for callers vs
candidateCallers.

### Honest boundaries (declined by design)

Statically undecidable, marked not faked:
- Aliasing through objects/arrays (`o.x = v; use(o.x)`) beyond the
  shallow `this.field` case already harvested.
- Mutation through a passed reference / closure capture across the
  candidate boundary.
- Dynamic property names (`o[k] = v`), `eval`, reflection.
- Values entering via untracked calls (an unresolved L2 callee returns
  an unknown value — the chain stops, declared honestly).
- Anything interprocedural (caller↔callee parameter binding) — v2.

---

## 6. Per-language feasibility

Start where L2 is **oracle-validated** and the substrate richest.

| Language | Substrate already present | L3 feasibility | Phase |
|---|---|---|---|
| **JS/TS (babel)** | `typeStack`, `Binding.referencePaths`/`constantViolations` (full def-use **for free**), call `arguments`, `callReturnType` chains | **Richest. Start here.** babel's scope analysis is a near-complete intra-procedural def-use engine we currently ignore. | MVP |
| **Python (tree-sitter)** | `varTypeStack`, `pyScanAssignments` (def-site iterator), `harvestPyClassProps` | **Feasible, second.** No babel-grade scope binding; def-use must be built from `pyScanAssignments` + a simple name→last-def walk. Matches L2's validated JS+Py set. | Phase 2 |
| Go / Rust / Java / C#/ Kotlin / Swift / C/C++ | `varTypeStack` + `BIND_OF`/`RECV_OF` per-language binders | Possible but **deferred** — L2 recall on these is good but def-use needs per-grammar reassignment/branch handling. Honest "L3 not available" beats half-right flows. | v2+ |
| Ruby / Lua / Dart / Elixir / Bash | L2 itself weak/absent | **Infeasible initially.** | — |

This matches L2's discipline (`symbol-parsers.cjs:27`): only expose
coverage we've measured. L3 ships JS/TS first, Python second, the rest
stay "L3 unavailable" in the coverage note.

---

## 7. MVP — smallest genuinely-useful slice

Two candidates; **MVP-A is recommended** (highest value-per-effort,
leans hardest on already-computed babel data).

### MVP-A (recommended): "what feeds this call argument" + "where does this variable reach"

Scope: **one function body, JS/TS (babel), confident flows only.**
For a chosen L2 symbol, build:
- `param`/`var`/`def` nodes from the harvested bindings (kept, not
  popped) + babel `Binding`s;
- for each *use site* (`Binding.referencePaths`), a `reads` edge def→use;
- for each argument of a resolved L2 call inside the body, a `flows-to`
  edge from the def of the argument identifier → an `arg` node carrying
  `argIndex` + `callEdgeRef`.

Delivers two queries the AI asks constantly:
- **`feeds(callId, argIndex)`** → the def(s) and their origin chain
  ("`query`'s value came from `buildSql(req.body)` at line 14").
- **`reaches(symbolId, varName)`** → every use + every call-argument the
  variable flows into ("if I rename/retype `token`, these 6 sites and
  the `verify()` call break").

Why this slice: it is the dataflow question agents hit on *every*
refactor, it is intra-procedural (no blowup), and ~80% of its machinery
already runs in the L2 babel pass.

### MVP-B (alternative): "param → call-arguments it flows into"

Narrower: only `param → flows-to → arg` (no general var def-use). Cheaper
to measure (smaller oracle) but less useful; keep as a fallback if MVP-A
measurement reveals babel scope edge cases are too noisy.

### How to MEASURE (independent oracle — no measurement trap)

L2 was gated on an oracle independent of the parser under test (ts/AST
ground truth, `docs/SYMBOL-MODE-PLAN.md` Phase-0/B-2). L3 uses the same
discipline, and the oracle **already exists in-repo**:

- **Oracle = the real TypeScript TypeChecker** via
  `symbol-parser-tsc.cjs` (Program + `getTypeChecker`,
  `symbol-parser-tsc.cjs:37`). For a hand-picked sample of functions,
  the checker's symbol/flow resolution (`getSymbolAtLocation`,
  flow-analysis on `Binding`s) is an *independent* def-use ground truth
  the babel-based L3 can be scored against. babel produces the L3 graph;
  tsc produces the oracle; they were written by different engines, so
  agreement is meaningful (same independence property L2's tsc-vs-babel
  comparison had).
- **Sample**: 20–30 functions from `packages/core` (JS/TS self-host) +
  a Python file, **hand-labelled** for the two MVP queries (this is the
  recall gate — L2's B-2 lesson: precision is cheap to claim, recall
  must be hand-labelled).
- **Gate (mirrors L2):** ship only at **precision = 100% (zero wrong
  flow edges)** on the sample; report recall honestly as a number, do
  not chase it. A `confidence:'candidate'` edge counts as correct if the
  true def is *in* the candidate set (maximal-set contract).
- **Anti-trap rule** (per `MEMORY` 측정 trap feedback): one Phase-0
  spike + one B-2-style recall gate, then **ship**. No open-ended
  precision/recall re-measurement loop.

---

## 8. Exposure

### To the AI / MCP

L3 is **per-symbol and lazy** — never a whole-repo payload (that is the
blowup, §9). Surface it by **extending the existing `/symbol/node`**
view, not a new top-level layer:

- `GET /symbol/node?id=<symbolId>&flow=1` → the existing
  `symbolNodeView` (`symbol-views.cjs:11`) plus a `flow` block:
  `{ params:[…], defs:[…], flowsInto:[{arg, call, target}], unresolvedFlows:N }`.
  Built on demand for that one symbol only.
- `GET /symbol/flow?id=<symbolId>&var=<name>` → `reaches(symbolId, var)`
  (def-use + call-arg destinations).
- `GET /symbol/flow?call=<callRef>&arg=<i>` → `feeds(call, argIndex)`.

Add a `cs_symbol_flow` MCP action (or extend `cs_symbol_explore`) and a
`cs flow <symbol> <var>` CLI command — mirroring how L2 added
`/symbol/*` to both `codesynapt.cjs` and `codesynapt-mcp.cjs`. Wrap every
response in `withMeta()` (token budget) per `CLAUDE.md`. Keep the
`candidateNote`-style honesty string for candidate flows.

### To the 3D map (the vision: live overlay, not static browsing)

Per `project_ideal_vision`: a live neuron overlay, not a browsable third
graph. When a symbol node is focused (or an AI op touches it), overlay
its intra-function flow **inside** that node's bubble: param/var nodes as
sub-neurons, `flows-to` as thin animated edges pulsing toward the call
sites already drawn at L2. Reuse the candidate-edge thin/dashed styling
for `confidence:'candidate'`. L3 is rendered **only for the focused
symbol** (1 function's worth of nodes), so the 10–50× scale fear of L2
does not compound — L3 is never all-on.

---

## 9. Risks / scope / cost (honest)

1. **Combinatorial / scale blowup — the top risk.** Expression nodes are
   another 10–100× over L2 symbols (L2 was already 10–50× over L1). A
   global L3 graph would OOM and flood AI tokens. **Mitigation is
   structural, not a knob:** L3 is *never built globally*. It is built
   **per symbol, lazily, on the request that asks for it**, cached with
   the symbol's mtime, and discarded on rebuild. The data model (§4)
   enforces this — `FlowGraph` is per-symbol, not a repo singleton.
2. **Interprocedural flow is a tar pit → explicitly v2.** Binding a
   caller's argument to a callee's parameter (and propagating return
   values across the call) is the genuinely hard, context-sensitive,
   potentially exponential part. **v1 is strictly intra-procedural.** The
   L3→L2 bridge (§4, `callEdgeRef`) records the *destination symbol* of a
   flow without crossing into it — useful (you can chain queries
   manually) and bounded. Cross-function propagation is a separate,
   later, separately-gated phase.
3. **Measurement trap.** Dataflow has infinite corner cases (aliasing,
   closures, branches); it is the easiest layer to measure forever and
   ship never. **Mitigation:** the §7 gate is binary and one-shot —
   precision=100% on a hand-labelled sample, recall reported once, then
   ship the slice. The honest boundaries (§6) are *declared*, not chased.
4. **Precision erosion risk.** A wrong flow edge is worse than a missing
   one (sends the AI down a false data trail, exactly L2's lesson). The
   confident/candidate split (§5) and the babel-`Binding`
   `constant`/`constantViolations` signal keep confident edges to
   provably-single-def cases; everything ambiguous degrades to the
   maximal candidate set or to decline.
5. **babel-`Binding` dependency.** MVP leans on babel scope analysis
   being correct for TS. It is mature, but TS-specific constructs
   (declaration merging, ambient decls) may produce surprising bindings —
   caught by the tsc oracle in §7 before exposure.

### Non-goals (v1, marked not faked)

Interprocedural propagation; taint/security analysis; alias analysis
beyond `this.field`; pointer analysis; the non-JS/Py languages; a global
expression graph; runtime/dynamic value tracing.

---

## 10. Staged roadmap (each phase independently shippable)

Mirrors L2: **measure-first, oracle-verified, precision-held, isolated.**

- **L3-0 — measurement spike (read-only).** On `packages/core` + a Python
  file, instrument the *existing* L2 parse pass to **dump** what the
  type/scope harvests already compute (don't build a graph yet). Confirm
  babel `Binding.referencePaths` + the kept type maps cover the MVP-A
  queries on a sample. Output: a feasibility number (what % of sample
  def-use the existing substrate already yields) — the honest baseline,
  no assumptions. Gate to proceed.
- **L3-1 — FlowGraph + MVP-A (JS/TS, confident only).** Add the isolated
  `FlowGraph` (§4), persist the harvested bindings + babel def-use, emit
  `binds`/`reads`/`flows-to(confident)`. **L1/L2 untouched** — verify by
  re-running the L2 test suite (109 tests, per `Layer-2 status`) green.
  Lazy, per-symbol. No exposure yet.
- **L3-2 — recall gate.** Hand-label 20–30 functions; measure precision
  (must be 100%) + recall (reported) against the tsc oracle (§7). Add the
  candidate-flow split. Gate before exposure — same as L2 B-2.
- **L3-3 — expose.** `/symbol/node?flow=1`, `/symbol/flow`,
  `cs_symbol_flow` MCP action, `cs flow` CLI. `withMeta()` + honesty
  strings.
- **L3-4 — 3D live overlay.** Per-focused-symbol intra-function flow
  inside the node bubble; thin/animated `flows-to`, dashed candidate.
  Gated on render budget (only ever one symbol's flows on screen).
- **L3-5 — Python.** Repeat L3-1..L3-4 for tree-sitter Python via
  `pyScanAssignments`-built def-use. Separate gate.
- **v2 (separately gated) — interprocedural.** Caller-arg ↔ callee-param
  binding + return propagation, bounded and context-limited. Not before
  v1 is shipped and measured.

Principle, carried from L2: **mark, don't guess; isolated leg; measure
once, then ship.** L3 is the most ambitious layer — its safety comes
entirely from being per-symbol, intra-procedural, and precision-gated,
never from being clever.
