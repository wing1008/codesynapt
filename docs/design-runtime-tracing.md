# Design — Runtime Call Tracing (Leg C)

> Status: **proposal** (2026-06-10). Fills the dynamic blind spot that static
> analysis provably cannot: `obj[x]()`, DI-injected calls, local callbacks —
> these produce **no static edge and are not even counted** (proven empirically
> with a fixture: `fn()` and `w[method]()` yielded `no-match: 0`, zero samples).

## Why
Static resolution is a **floor**, and how high that floor sits varies wildly by
codebase (measured 2026-06-10):

| project | precise `call` | `call-candidate` | genuine gap |
|---|---|---|---|
| filegraph3d | 1481 | 486 | 14 |
| Hmapp | 468 | **3965** | **893** |

Static alone can never reach "no missing info" — dynamic dispatch is undecidable
from source (Rice's theorem). The only way to observe a dynamic edge is to **run
the code and watch**. Runtime tracing is therefore not optional polish; it is the
half of the graph static cannot produce.

## Honest model — three edge tiers
- `call` — static, precise (one target, confident).
- `call-candidate` — static, ambiguous (real target is among N candidates).
- `observed` — **runtime**: actually happened during a traced run. Can (a) confirm
  one `call-candidate` → promote it, or (b) be a wholly static-invisible dynamic
  edge → add it, marked `observed`.

Result: *no wrong info* (precise-static + literally-observed) + *no silent
missing* (candidates marked, dynamic filled by observation, unexercised paths
flagged as such). Neither layer is complete alone; together they approach the
real graph.

## Feasibility (confirmed)
- Symbols already store `startLine`+`endLine` → a runtime frame `(file, line)`
  maps to the symbol whose `[startLine, endLine]` contains the line.
- Trace storage already exists (`.codesynapt/traces/*.jsonl`, `cs trace`,
  `/trace` endpoints). We add a runtime-call recorder beside the AI-activity log.

## Mechanism — three options weighed
1. **CPU sampling profiler** (`node --cpu-prof` / inspector `Profiler` domain).
   The `.cpuprofile` is a call tree (caller→callee) with `file:line`. **Low
   overhead, does NOT alter behavior, zero source changes.** Lossy: sampling
   misses short/rare calls. → great first pass on tested/hot paths.
2. **Source instrumentation** (babel-wrap every function to log entry+caller).
   Complete (every call) but heavy, needs a require-hook/build step, and can
   perturb timing/behavior.
3. **require-hook export wrapping** (wrap module exports, read stack on call).
   Captures the cross-module edges we care about, medium overhead.

**Recommendation: stage it.** Phase 1 = option 1 (profiler) — cheapest, safest,
immediately useful. Phase 2 = option 3 for precision on hot modules if needed.

### Phase-1 mechanism — EMPIRICALLY VALIDATED (2026-06-10)
Ran `node --cpu-prof` on a fixture with a static-direct call, a callback
(`fn()`), and a computed call (`w[method]()`):
- `realTarget` (static) hits=930, **`fn` (callback) captured as a node** (hits=0
  but present), **`render` (computed target) captured** (hits=1).
- **Edges come from the call-tree `parent→child` structure, NOT hitCount** — so a
  hits=0 pass-through node still yields its edge (`loop→fn→realTarget`).
- Confirmed limits: `render` barely sampled (hits=1, called 1/1024 iters) ⇒
  **rare/one-shot dynamic calls can be missed**; trivial bodies get JIT-inlined
  and vanish ⇒ inlining is a real second blind spot. Hot paths: reliable. Rare
  paths: probabilistic. Surface this as observed-coverage, never completeness.

Implementation note: extract edges by walking `profile.nodes[*].children`
(map node id → callFrame), emit `(parentFrame → childFrame)`, then map each frame
`(url,lineNumber)` to the symbol whose `[startLine,endLine]` contains it.

## Trigger UX
`cs trace run -- <command>` — wraps any command with the profiler, e.g.:
```
cs trace run -- npm test
cs trace run -- node scripts/smoke.js
```
Post-run: parse the profile → map frames to symbols → emit `observed` edges →
merge into the graph (desktop pulses the newly-observed edges) → persist to
`.codesynapt/traces/runtime-<ts>.json`.

## Honest caveat (must surface)
Runtime tracing only sees **exercised** paths — it is coverage-limited. An
untested dynamic call stays invisible. So the UI/CLI must label observed-edge
coverage ("traced run touched N/M symbols") and never imply completeness. This is
the same honesty discipline as the static footer.

## Scope
JS/Node first (we are Node; test suites are JS). Python (`sys.settrace`) and
JVM (agent) are separate, later tracers behind the same `observed` model.

## Open decisions (need sign-off before building)
1. **Mechanism for Phase 1**: CPU sampling profiler (recommended) vs jump
   straight to precise instrumentation?
2. **Trigger**: `cs trace run -- <cmd>` wrapping — acceptable UX?
3. **Scope**: JS/Node only for v1?
