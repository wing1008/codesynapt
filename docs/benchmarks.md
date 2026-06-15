# Benchmarks — speed & tokens

Every number below is **produced by running the real scanner / control-server**
on real codebases — nothing here is hand-written. Reproduce it yourself:

```sh
node scripts/benchmark.mjs <path-to-any-repo> --runs=5
node scripts/benchmark.mjs <path-to-any-repo> --json   # machine-readable
```

Measured on the author's Windows 11 dev machine; **your numbers will differ**
with CPU / disk / repo. The point is the *shape* (scan is ~linear, queries are
sub-100 ms, answers are 1–2 orders of magnitude smaller than reading files),
not the exact milliseconds.

## Codebases

| Repo | Files | Edges | What |
|---|---|---|---|
| `packages/core` | 36 | 35 | CodeSynapt's own engine source (JS/CJS) |
| [`colinhacks/zod`](https://github.com/colinhacks/zod) | 492 | 724 | popular TS validation library |
| [`vuejs/core`](https://github.com/vuejs/core) | 637 | 1,819 | Vue 3 monorepo (TS) |

## Speed

| Repo | Cold scan (median) | Incremental — save | Incremental — delete | Endpoint p50 / p95 |
|---|---|---|---|---|
| `packages/core` (33) | **275 ms** | 351 ms | 169 ms | 0–1 ms / 0–1 ms |
| zod (491) | **1.06 s** | 384 ms | 215 ms | 0–2 ms / 0–6 ms |
| vue/core (637) | **1.73 s** | 460 ms | 290 ms | 0–5 ms / 0–31 ms |

- **Cold scan** = `Scanner` start → first complete snapshot (median of N runs).
- **Incremental** = file saved → next snapshot, the real watcher path (chokidar
  `awaitWriteFinish` + snapshot debounce). A *save* lands a fresh graph in
  **~0.35–0.46 s**; a *delete* in ~0.17–0.29 s. No re-index step, no manual
  refresh.
- **Endpoints** (`/summary`, `/graph`, `/blast`, …) answer in **single-digit
  milliseconds** once scanned — they read the in-memory graph, not the disk.

## Tokens

The value proposition: an agent gets a precise, token-budgeted answer instead
of reading files. Token estimate = `text length / 4` — the **same** estimator
`cs` reports in `meta.tokenEstimate`, applied to both sides so the ratio is
apples-to-apples. (Exact counts vary by model tokenizer; this is a consistent
estimate, not a per-model number.)

### Project map — `cs_summary` vs reading the whole project

| Repo | `cs_summary` | Read all sources | Ratio | % fewer tokens | Tool calls |
|---|---|---|---|---|---|
| `packages/core` | 231 tok | 224,160 tok | **970×** | **99.90%** | 1 MCP call vs 36 reads |
| zod | 324 tok | 921,226 tok | **2,843×** | **99.96%** | 1 vs 492 reads |
| vue/core | 328 tok | 1,380,420 tok | **4,209×** | **99.98%** | 1 vs 637 reads |

*("Read all sources" is the upper bound — what it would cost to read every file
to map the project. The summary gives the structure + top hubs in a few hundred
tokens.)*

### Impact analysis — "what breaks if I change X?"

`cs_blast` returns the dependents + a 🟢/🟡/🔴 verdict in one small payload.
The honest baseline is reading the **whole transitive blast radius** (reverse
dependents, 3 hops) — what an agent does to judge full impact. Hub = the
most-imported internal file.

| Repo | Hub | Direct importers | Blast radius (3-hop) | `cs_blast` | Read blast radius | Ratio | % fewer |
|---|---|---|---|---|---|---|---|
| `packages/core` | `lib/registry.cjs` | 4 | 4 files | 254 tok | 55,104 tok | **217×** | **99.54%** |
| zod | `packages/zod/src/v4/index.ts` | 90 | 90 files | 3,369 tok | 166,829 tok | **49.5×** | **97.98%** |
| vue/core | `packages/shared/src/index.ts` | 163 | 440 files | 10,706 tok | 1,056,078 tok | **98.6×** | **98.99%** |

Changing a central file in vue/core touches **440 files**; `cs_blast` summarizes
that impact in ~10.7k tokens vs ~1.05M tokens to read it all — ~98× less.

**In tool-call terms:** `cs_blast` answers in **1 MCP call** where reading the
full blast radius is N file reads (4 / 90 / 440 above); the token cut is
**~98–99.9% fewer** across summary/blast. **Caveat (read this):** our baseline is
the *naive* "read every file in the set", an **upper bound**; a careful agent
reads fewer, so treat these as the *shape* of the gap, not a guaranteed per-task
multiple.

## Accuracy (call-graph precision)

The Layer-2 function-call graph is checked against an **independent position
oracle** — it resolves each ambiguous-name call by source position, not by the
scanner's own logic, so it cannot rubber-stamp the scanner. Reproduce:

```sh
node scripts/_precision_pos.mjs
```

- **Wrong-edge rate 0.0%** on the in-repo corpus (1,751 same-file edges with an
  ambiguous name — the case most likely to mis-resolve — 0 wrong).
- **0–1.3%** across a 13-language external corpus (full method + per-language
  tables in [`docs/measurements/2026-06-14-layer-measurement.md`](./measurements/2026-06-14-layer-measurement.md)).

> **What this number is — and isn't.** The 0–1.3% is the **position oracle on
> same-file ambiguous-name calls** (the case most likely to mis-resolve). A
> *separate, known* limitation — **nested-scope #M1** (a same-named function
> shadowed inside another function's body) — shows a higher **name-based upper
> bound** in the linked doc (JS ~51%, C# ~50%). That figure counts *coincidental
> same-names*, so the real rate is lower — it's an honest upper bound, not the
> oracle precision, and it's tracked for the #M1 fix / 0.0.9. We publish both
> rather than hide the harder case: if you follow the link and see "51%", that's
> the name-based ceiling, not the 0–1.3% oracle result.

The graph is *precision-first*: an ambiguous edge is declined and surfaced as a
*candidate* rather than guessed, so wrong edges stay near zero (recall trades off
against that). Re-run the oracle on your own repo before relying on it.

## Honest caveats

- These are **import-graph (Layer-1)** numbers plus token estimates; they do not
  claim semantic precision. The graph follows static imports (see the accuracy /
  limitations notes in the README).
- "Read files" baselines are the *naive* alternative; a careful agent reads
  fewer files than the full blast radius — so treat the token ratios as an
  upper-bound illustration of the gap, not a guarantee of N× on every task.
- Single machine, few repos. Re-run `scripts/benchmark.mjs` on your own repos
  for numbers that mean something for you.
