# Design — Symbol-Level Completeness (locked plan, 2026-06-11)

> Goal: the function/symbol call graph reaches a **bounded, reproducible**
> "complete" bar for the frequently-used languages, anchored by COMMITTED tests
> so the claim survives session resets — no more verification that depends on the
> assistant's word. (This session produced false "static 99% done" claims that a
> multi-project check overturned; the fix is a harness, not a promise.)

## Locked order
1. **Verification harness + bounded bar** (language-common). Per-language
   known-answer fixtures committed as tests — "100% passed" becomes `npm test`,
   not an assertion in chat.
2. **The 4 symbol-level languages together to the bar**: JS/TS, Python, Java, C#.
   (The engine supports ~11–12 languages at FILE level; symbol/function level was
   deliberately narrowed to these 4. Completing all 4 to the bar gives the
   reference template for the remaining languages.)
3. **observed-edge merge + 3D visualization + Leg B-2 (desktop uncertainty
   markers)**; **Leg A (static disambiguation)** in parallel.
4. **Real-time neuron map** (continuous live tracing + live graph). **Expression
   layer** — separate epic, after the function-level loop; pulled partly forward
   only if step-3/coverage work proves a genuine miss traces to expression-level
   attribution.
5. **Remaining languages** (~7–8) using the 4 as the proven template.

Why this order: complete one trustworthy multi-language FUNCTION-level base first
(steps 1–2), then build the feature loop (merge → visualize → real-time) on top,
then widen language breadth. Breadth on an unverified base just multiplies
unverified surface.

## The bar — per language, as committed known-answer tests
A hand-authored fixture per language whose call graph is KNOWN, with each call
site labelled by category. The test asserts the built graph matches exactly:

- **Static recall** — 100% of the *statically-determinable* edges in the fixture
  are present. (The fixture is designed so the determinable set is explicit.)
- **Static precision** — zero WRONG edges (no phantom/mis-resolved call).
- **Dynamic honesty** — every dynamic call site (computed `obj[x]()`, reflection,
  DI, local callback) is EITHER caught by runtime tracing OR explicitly marked a
  blind spot. Never silently dropped.
- **Decline honesty** — the decline breakdown contains only stdlib/builtin-correct
  declines; no genuine user call is misclassified as stdlib.

Bounded by construction (a fixed fixture has a finite known answer), so it cannot
become the "measure forever" trap. The multi-project decline-breakdown stays as a
secondary REGRESSION signal, not a pass/fail.

## DONE — the user's bar, verbatim-derived (locked 2026-06-11)
The 4 symbol languages (JS/TS, Python, Java, C#) are "complete" ONLY when ALL of
the following hold SIMULTANEOUSLY (one suite, all green at once):
1. **Static 100%** — every statically-determinable call edge present
   ("정적인 이상 못 이을 리가 없잖아"). Proven by per-language known-answer
   fixtures + multi-project regression.
2. **Zero wrong edges** — "잘못된 연결은 있으면 안 된다". Phantom-edge asserts.
3. **Dynamic = maximal candidates + zero silence** — "동적도 확실한 연결이
   없을뿐 어느 것들이 오는지는 알 수 있고". EVERY dynamic call site (incl. the
   currently-invisible computed `obj[k]()` / local-callback sites) is detected
   and marked; named-ambiguous sites carry their full candidate set. Nothing is
   silently dropped — the fixture asserts the site is accounted for.
4. **Accounting completeness** — every symbol is entry-reachable OR
   dynamic-marked OR flagged dead; zero unexplained. (Certificate is per
   file/site, not a project-level binary — dynamic localizes, it does not
   poison.)
5. **User-usable** — shipped through CLI + MCP + desktop for all 4 languages
   with the honesty surfaces (static-floor footer, markers), not test-only.

Out of scope for this milestone (explicitly, so "done" is not oversold):
expression layer, real-time live map, Python/Java/C# runtime tracers (runtime
tracing stays JS-first as the dynamic filler). Known depth limit: Java/C#
resolution is common-pattern level, not a full compiler type solver — unresolved
patterns are DOCUMENTED, never silently dropped; any bar change is a user
decision, never an assistant shortcut.

## Anti-false-verification contract
- A language is "done" ONLY when its committed fixture test is green. The
  assistant may not claim completion from a single ad-hoc measurement again.
- Cross-language measurement uses the subshell-cd harness (a prior session bug:
  `cs serve` ignores CS_ROOT and scans cwd — measure via real cwd per project).
- Fixtures live in `tests/lang-completeness/<lang>.*`.
