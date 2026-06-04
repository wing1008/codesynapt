# Symbol Mode (Layer-2) — Design & Plan

Function/symbol-level dependency graph that lives alongside the file-level
(layer-1) graph. This document is the single source of truth for the data
model, the call-resolution policy, and the phased build plan with the
measurement gates each phase must pass.

> Status: **design locked, Phase B in progress.** Grounded in a Phase-0
> measurement spike (see "Phase 0 findings"), not assumptions.

---

## 1. Why layer-2

Layer-1 maps file→file import coupling. It catches cross-file blast radius
(`_json_store.py`: 5 direct / 60 transitive importers → real, high-value
warning) but is **blind to within-file complexity**: `main_window.py` has
only 3 importers, so layer-1 calls it "low risk" — yet it is a 5000-line hub
whose internal functions are called from everywhere. An AI editing it on
layer-1's word gets false confidence.

Layer-2 nodes are **functions / methods / classes**; edges are **calls /
extends / implements / refs**. A function-level blast radius answers "what
actually calls *this function*" instead of "what imports the file it lives
in".

---

## 2. Current state (honest, post-Phase-0)

The components were drafted in earlier work but were **never wired or run**:

- `lib/symbol-graph.cjs` — `SymbolGraph` model, `resolveCall`, reachability,
  embeddings. Solid.
- `lib/symbol-parser-{js,py,treesitter,tsc}.cjs` — per-language
  `extractSymbols` / `extractReferences`. Real, but never exercised.
- `registerParser()` is **defined but called nowhere** → `PARSERS` registry
  is always empty → `SymbolGraph.build()` would extract nothing.
- No `/symbol/*` HTTP endpoint; the desktop UI cell (`public/app.js`
  `buildSymbolGraph`) fetches `/symbol/summary` which **does not exist**.
- `SymbolGraph.build()` is invoked from no production path.

So "60–70% complete" (an earlier estimate of *code presence*) was misleading.
Honest state: **symbol extraction is solid; integration is 0%; call
precision needs a policy fix; recall is unmeasured.**

---

## 3. Phase 0 findings (measured, read-only spike on real code)

Corpora: `packages/core` (JS/TS self-host, 18 files) + DocsPro (Python, 100
files, read-only).

1. **Parsers extract well.** Python kind split (class 112 / method 965 /
   func 336 / const 184) matches a real PyQt app. Symbols are trustworthy.
2. **Layer-1 import resolution is fine** — not a bug. In `packages/core`
   only 9/78 import specs resolved to in-set files because the rest are Node
   builtins / npm / ffi; every relative import (`./parser.js`,
   `../lib/control-server.cjs`) resolved correctly.
3. **Single precision hole = the `allowAny` bare-name fallback**
   (`symbol-parser-js.cjs:449`, `symbol-parser-py.cjs:176` call
   `resolveCall(..., {allowAny:true})`). When a call's receiver type is
   unknown, the bare name is matched against **any** same-named symbol —
   linking `walk()`'s `.add()` to an unrelated `add` in another file,
   `drawControl` to `FavoritesStore.save`, etc. Worst for builtins /
   inherited / common method names (`add get resolve close save log data`).
4. **Fix measured** (tightened policy = builtin filter + unique-production-
   candidate only):

   | corpus | cross-file edges | suspect-cross |
   |---|---|---|
   | JS original | 80 | 43 |
   | JS tightened | 39 | **8** (−81%) |
   | Python original | 893 | 334 |
   | Python tightened | 676 | **155** (−54%) |

   Removed edges are overwhelmingly false (builtin guesses). The few
   non-false removals are **genuinely ambiguous** (e.g. `build →
   extractSymbols` when 4 files export `extractSymbols`) — exactly the cases
   that should be marked unresolved, not guessed. Real loss is <1% and
   recoverable via the imported-path + type inference.
   Caveat: this measures **precision only**; recall needs an independent
   ground-truth sample (Phase B-2). The suspect metric also *undercounts*
   false positives (`data`/`_alog`/`flush` slipped through), so true
   precision gain is larger and the builtin list needs tuning.

---

## 4. Data model

Reuse the existing `SymbolNode` / `SymbolEdge` (see `lib/symbol-graph.cjs`):

- `SymbolNode`: `id = "{fileId}#{name}@{startLine}"`, `name`,
  `qualifiedName` (`Class.method`), `kind` (function|class|method|
  interface|type|const), `file`, `startLine`/`endLine`, `signature`,
  `doc`, `exported`, `deprecated?`, `mtimeMs`, `_embedding?`.
- `SymbolEdge`: `source`, `target` (node ids), `kind`
  (call|extends|implements|ref), `line?`.

No model change required for Phase B.

---

## 5. Call-resolution policy (THE key decision)

Resolve a call name from `fromFileId`, in priority order:

1. **Qualified type-aware** — `Receiver.method` exact `qualifiedName` match.
   (Highest precision; the strength to lean on.)
2. **Same file** — a symbol defined in the caller's file.
3. **Imported file** — a symbol in a file the caller actually imports
   (uses `fileImports`, fed from the live layer-1 edge set).
4. **Tightened allowAny fallback** (replaces today's "any same-named
   symbol"):
   - if the bare name is a known builtin / inherited / common method name →
     **do not resolve** (return null);
   - else if there is **exactly one production-path candidate** with that
     name → resolve to it;
   - else → **unresolved**.
5. **Unresolved** calls are **counted and surfaced** (`unresolvedAmbiguous`
   in `stats()`), never silently dropped — an honest "N calls we declined
   to guess" signal, consistent with the blind-spot markers.

Principle: **mark, don't guess.** A blast-radius tool that invents edges
sends AI down false trails; conservative under-linking beats confident
wrong-linking. Real cross-file calls are recovered through the imported
path + receiver-type inference, not by reopening the bare-name guess.

---

## 6. Honest boundaries (marked unresolved, by design)

Statically undecidable — we mark, we do not pretend:

- Dynamic dispatch on an untyped receiver (`obj.method()` where `obj`'s
  type is unknown).
- Duck typing / reflection (`getattr`, `__getattribute__`, `eval`).
- Decorator-rebound and higher-order calls.
- Qt **signal/slot** connections (runtime wiring) — already flagged at
  layer-1's blind-spot markers; layer-2 inherits the caveat.
- Dependency injection / framework-resolved callbacks.

These feed the existing blast `caveat` so counts read as a **floor**.

---

## 7. Phased plan with gates

- **B-1 — resolution policy in real code** *(in progress)*: implement §5 in
  `symbol-graph.cjs`, keep tests green, re-measure precision matches the
  spike. Low risk: the symbol layer is dead code today, nothing in
  production calls it.
- **B-2 — recall gate**: hand-label a ground-truth sample of calls in
  DocsPro + a JS file; measure precision **and** recall of the real
  pipeline. Gate before exposure: don't ship a layer that misleads.
- **B-3 — build pipeline**: a registration module that calls
  `registerParser` for every language; `Scanner.buildSymbolGraph()` that
  derives `fileEntries` from `scanner.files` and `fileImports` from
  `scanner.edges`; lazy build on first request.
- **B-4 — expose**: `/symbol/summary`, `/symbol/:id` (callers/callees),
  `/symbol/find`, `/symbol/blast` (function-level impact); a `cs_*` MCP
  action; connect the dead `public/app.js` UI hook.
- **B-5 — 3D**: nested symbol nodes inside file nodes, thinner call edges,
  inspector panel. Gated on perf at 10–50× node count.
- **Per-language**: tree-sitter `extractReferences` hardened and measured
  one language at a time (Python and JS first — real corpora on hand).

## 8. Risks / non-goals

- Scale: symbol nodes are 10–50× file nodes → watch parse time, memory,
  3D render budget, and AI token cost. Existing caps (`CS_MAX_SYMBOLS`
  200k, `CS_MAX_EDGES` 1M) stay.
- Recall is the open question; precision is the one B-1 settles.
- **Non-goals (for now):** full type inference, cross-language call edges,
  runtime/dynamic tracing. Marked, deferred — not faked.
