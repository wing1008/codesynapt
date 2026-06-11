# Design — Remaining-Language Expansion (Phase 5 epic, proposal)

> Status: **design-first, not started** (2026-06-11). The 4 reference languages
> (JS/TS, Python, Java, C#) passed the completeness bar SIMULTANEOUSLY — they
> are the template. This phase widens to the other supported grammars.

## Candidates (already parse at symbol level via tree-sitter)
go, rust, kotlin (+kts), swift, php, cpp/c, scala, lua, bash — per LANG_CONFIG.
File-level (Layer-1) already covers more; this is about the FUNCTION bar.

## Per-language checklist (copy of the proven template)
For each language, in one PR:
1. Known-answer bar fixture (`tests/lang-completeness/<lang>.test.js`):
   - STATIC RECALL: direct calls, method calls, typed member calls
   - PRECISION: ambiguous dispatch declines (no arbitrary impl), decoy file
   - DYNAMIC: candidates for named-ambiguous; zero-silence for unnameable
   - Language-specific super/parent idiom (super./base./embedding) precise
     or honestly declined — NEVER sprayed
2. Run the bar → fix what it catches in the tree-sitter extractor
   (inheritance node types in extractInheritance, receiver typing in
   RECV_OF/BIND_OF, keyword sets).
3. Multi-repo decline-breakdown spot check on a real repo of that language
   (subshell-cd harness; genuine gap and candidate ratio recorded in the PR).
4. Gate: the WHOLE suite green — all previously-passing languages must stay
   green in the same run.

## Order proposal (by user value × parser maturity)
go → rust → kotlin → swift → php → cpp → scala → lua/bash.
(go/rust have receiver typing already: goReceiverType, RECV_OF.rust.)

## Known engine-level gaps to expect
- extractInheritance: go interface embedding handled; rust trait impls map via
  impl blocks (no extends edge — dispatch candidates need impl→trait links).
- Runtime tracing stays JS/Node-only; other languages get static+marking until
  per-language tracers (py sys.monitoring, JVM agent) are scheduled separately.
