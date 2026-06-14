# Changelog

## 0.0.5 — beta (unreleased)

> Beta / pre-release — APIs and formats may still change.

### Added
- **`/codesynapt` + `/codesynapt-auto` install automatically on `npm install`** —
  the Claude Code slash commands now ship in the package and a postinstall step
  copies them into `~/.claude/commands`. Skips silently when Claude Code isn't
  set up, in CI, or with `CS_NO_CLAUDE_COMMANDS=1`; backs up an existing copy to
  `.bak`; never fails the install. (Previously required manual file copying.)
- **Reproducible measurement corpus** — `scripts/corpus-manifest.json` (12 OSS
  repos pinned by URL + SHA) + `scripts/fetch-corpus.mjs`, so the Layer-2
  call-graph precision numbers reproduce from a clean checkout.

### Fixed / hardened
- **Multi-session daemons no longer leak** — the registry's stale-entry sweep now
  also covers `daemon` entries (was session/viewer only), with a self-exclude
  guard so a live daemon never reaps its own entry.
- **MCP HTTP transport (`--http`) is now concurrency-safe** — replaced a global
  `process.stdout` monkeypatch with a per-request `AsyncLocalStorage` sink, so
  concurrent requests no longer return empty or cross-contaminated responses.
- **Symbol-graph in-flight rebuild race** — a file change landing mid-build no
  longer marks a pre-change graph as fresh; an epoch guard keeps it stale and
  rebuilds once so the next reader gets current data.
- MCP `serverInfo.version` (and the HTTP self-describe) now read `package.json`
  instead of a hard-coded string; removed an advertised SSE endpoint that 404'd.

### Changed
- Headline / package description repositioned around **blast radius, offline, and
  measured precision** (reproducible wrong-edge rate); the 3D view is framed as
  optional.
- Benchmarks now report **% fewer tokens + tool-calls (1 vs N)** and re-measured
  zod / vue; call-graph accuracy cites a reproducible position oracle (0–1.3%
  wrong-edge) instead of a non-reproducible import-resolution number.

## 0.0.4 — beta (2026-06-12)

> Beta / pre-release — APIs and formats may still change.

### Added — Python runtime tracing
- **`cs trace run -- python app.py`** now records real Python call edges
  through the same observe/merge pipeline as the Node tracer: a
  `sys.setprofile` bootstrap captures in-repo caller→callee pairs, filters
  site-packages, survives a crashing script, and the witnessed edges merge
  into the live graph (amber in 3D) — including dynamic calls
  (`globals()[name]()`) static analysis cannot see.

### Added — the expression layer (file → function → **expression**)
- **`cs symbol flow <name|id>`** — per-function dataflow facts, computed
  lazily for one function (never project-wide): which parameter / local /
  call-result / literal flows into each call argument, plus return
  provenance. CERTAIN flows only (direct identifiers + simple binding
  chains); object/closure/mutation flows are counted in `unresolvedFlows`,
  never guessed. Covers the reference four: **JS/TS, Python, Java, C#**.
- **`cs symbol flow <name|id> <param>`** — argument-level blast: "if I
  change THIS parameter, which downstream call sites receive the value?"
  Walks confident call edges only; ambiguous targets stop the walk and are
  counted (JS family in this release).
- **Signature-change alerts**: editing a function's parameter list raises an
  immediate desktop toast + a trace-timeline `issue` entry with the caller
  count, pointing at `cs symbol flow` for the argument impact. Line-shift
  proof keys; colliding same-named object methods are excluded rather than
  false-flagged.

### Fixed / hardened
- Desktop `/health` gains `epoch` / `graphVersion` / `traceVersion`
  (pure-client re-bootstrap against a desktop backend was disabled).
- Lua bare calls were all misclassified as member calls — the zero-silence
  ledger was mute for Lua and plain user calls hit the builtin guard.
- **Duplicate-desktop warning**: a second desktop opening the same project
  now warns loudly (it silently fought the first over discovery — clients
  could flip-flop onto a stale instance).
- newly-unreachable alerts suppress mass flips (>30 — an enrichment-timing
  baseline artifact, not real orphans).
- Trace "no frames" messages hint at scan-ignore rules (underscore-prefixed
  files traced to silence).

### Fixed — pre-release inspection sweep (insp-004)
A multi-agent + manual adversarial inspection before release surfaced and fixed
release-blocking and accuracy bugs, each anchored by a known-answer test:
- **Installed-package Layer-2 restored.** The grammar wasm was resolved by a
  hard-coded `../../../node_modules` path that only exists in the dev repo, so a
  hoisted `npm install` silently disabled Layer-2 for **every** tree-sitter
  language (Python/Java/C#/…) while coverage still reported 100%. Now resolved
  via `require.resolve`; a CI job proves Layer-2 parses from a real install.
- **Honest coverage.** A language whose parser fails to load this session is no
  longer counted as covered — it's reported as degraded with a warning.
- **Python tracer** flushes observed edges on `sys.exit()` (the common
  `sys.exit(main())` path discarded them), puts the script dir on `sys.path`
  (sibling imports work under tracing), and supports `-m module`.
- **Expression flow no longer makes wrong claims**: reassigned / `+=` /
  self-referential / branch-assigned / default / parameter-property bindings
  resolve to `unknown` (counted), never a stale value; interpolated strings are
  not "literal"; TS default & constructor-property params keep their names.
- **Signature alerts** only fire on real parameter changes — body-only,
  whitespace-only and comment-only edits no longer raise a false alert, and
  destructured params are tracked.
- **No false call edges**: an untyped member call `x.foo()` no longer resolves
  to an unrelated free function `foo`; a `new C()`-constructed class keeps its
  constructor (and `super()` chain) out of the dead set; CJS
  `const {f} = require()` call sites now show their callers.
- CLI: `cs --version`, `cs blast` shows the dynamic-incompleteness caveat, the
  scanner ignores its own `.codesynapt/` data dir, a directly-launched
  `cs serve` stays up until Ctrl-C.

## 0.0.3 — beta (2026-06-11)

> Beta / pre-release — APIs and formats may still change.

### Added — runtime tracing (the dynamic half of the graph)
- **`cs trace run [--no-merge] -- <command>`** runs any command under the V8
  CPU profiler, maps the sampled call tree to symbols, and classifies each
  observed edge against the static graph: confirms a static call, resolves an
  ambiguous candidate, or surfaces a **NEW dynamic edge static analysis cannot
  see**. Merged edges persist (mtime-guarded: observations on edited files
  expire rather than re-attaching to the wrong symbol) and survive rebuilds.
- **`cs trace watch [--interval <sec>] -- <command>`** attaches to a
  long-running process (dev server, worker) and profiles in cycles — each
  cycle's observations merge into the live graph immediately.
- **Live 3D updates**: runtime-witnessed edges render **amber** in the symbol
  layer and appear the moment a trace merges (no restart); symbols containing
  dynamic call sites get a warm uncertainty tint. Each merge also leaves a
  trace-timeline entry ("runtime: N edges observed …").

### Added — honesty surfaces (the graph now states its own limits)
- **Zero-silence dynamic-site ledger**: call sites whose callee cannot even be
  named statically (`obj[k]()`, `getattr(o,n)()`, local callbacks) are recorded
  per symbol instead of silently dropped, and counted in summaries.
- **`cs symbol accounting`** (+ `GET /symbol/accounting`, MCP
  `cs_symbol_summary {accounting:true}`): every symbol labelled
  entry / reachable / possible / dead with `unexplained: 0` by construction —
  dead is always presented as a static floor with its caveats, never proof.
- `cs symbol summary` ends with a **static-floor resolution footer** (precise
  vs candidate counts, stdlib-vs-genuine declines, dynamic-site count);
  symbol blast reports **`dynamicSitesInImpact`**; node views carry per-symbol
  `dynamicSites`.
- **Polymorphic dispatch candidates**: a typed call resolving to an interface/
  base method declaration now also surfaces every subtype override as
  `call-candidate` edges — blast on an implementation no longer misses callers
  of its interface.

### Fixed — graph accuracy
- **C# emitted no inheritance edges at all** (`class A : IGreeter` was
  invisible — base_list unhandled).
- **`super()` / `super.` / `base.` candidate spray**: these calls resolved
  against every same-named method in the project (measured: 69% of one repo's
  candidate edges, with the real target often NOT among them). They now resolve
  statically to the declared parent — precise edge for an in-repo parent,
  counted `super-external` decline (no spray) for an external one.
  Candidates on a real ML repo dropped 4377 → 1222.
- **JS computed-call phantom**: `o[k]()` treated the subscript variable `k` as
  the callee name and could phantom-match a user symbol named `k`.
- Async POST replies were silently dropped by the request-lifecycle guard
  (`close` fires on normal body completion) — affected every body-carrying
  endpoint served asynchronously.

### Fixed — daemon reliability
- **Zombie daemon accumulation**: on Windows, lease-file renames collide with
  concurrent readers (EPERM) — updates were silently lost and a chronic touch
  failure starved the idle-reap check, accumulating daemons until the port
  range was exhausted (desktop "control API disabled"). Lease writes now retry
  and fall back to a plain overwrite; the reap check can no longer be starved;
  orphaned `.tmp` lease files are swept.
- The daemon no longer self-exits while still serving a request (a large
  repo's first symbol build outlives the idle grace window).
- `cs trace run`/`watch` hold a session lease for their whole duration.

### Added — all 13 symbol languages reach the completeness bar
- Go, Rust, Kotlin, Swift, PHP, C++, Scala, Lua and Bash join JS/TS, Python,
  Java and C# — every symbol-level language now has a committed known-answer
  bar, gated green simultaneously. The new bars caught and fixed real gaps:
  Rust `&T` params were never type-harvested, Kotlin had **no inheritance
  edges at all** (and untyped params), C/C++ parameters were never harvested
  (nested `function_declarator`), PHP typed params dead (`named_type`
  unwrap), and Go's fully-silent bare-unknown call class is now ledgered
  (with an import filter so external calls don't flood it).

### Added — the live map (always-on) + auto-discovery + issue alerts
- **Always-on live symbol map**: editing a source file now silently refreshes
  the 3D symbol layer (the map no longer shows pre-edit reality until toggled).
- **Recall-miss auto-discovery**: runtime-observed edges that look statically
  resolvable but have no static edge are flagged as suspects into a quiet
  review queue (`.codesynapt/recall-suspects.jsonl`) — suspicion never
  verdict, no auto-fix, no interruption.
- **Realtime potential-issue alerts**: when an edit leaves symbols statically
  unreachable, the desktop toasts immediately and a trace-timeline `issue`
  entry is recorded — honestly labelled a static floor.

### Fixed — pre-release inspection (two adversarial rounds)
- A multi-agent inspection + direct re-verification before publishing caught
  and fixed: observed-edge persistence dropping valid re-observations after
  an edit; Python dotted external bases (`nn.Module`) phantom-linking to
  same-named user classes (super(), extends AND typed-member-miss paths);
  tracing silently broken on paths with spaces; unbounded observed-edge file
  growth (now compacts); self-loop dispatch candidates; false issue-alert
  floods on project switch; runtime-only edges miscounted as static; stdlib
  call floods in the five new bar languages; an actively-used daemon reaping
  mid-use; and dogfooding artifacts that had been shipping inside the npm
  tarball since 0.0.1 (now excluded).

### Verification
- **13-language completeness bar** committed as known-answer fixtures:
  static recall, precision (no phantom edges, wrong-file decoys), dynamic
  honesty (max candidates + zero silence), accounting, and a real-repo
  regression bar with build-determinism checks — all languages gated green
  simultaneously (253 tests). A cross-grammar wasm corruption
  (web-tree-sitter 0.20.x, scala→lua) is documented with an expected-fail
  regression rather than hidden.

## 0.0.2 — beta (2026-06-10)

> Beta / pre-release — APIs and formats may still change.

### Added
- **Desktop UI overhaul.** The left toolbar is now a vertical icon
  activity-bar (collapsible, state persisted); settings moved into a left-rail
  accordion; panels were flattened and the file panel is a collapsible
  accordion. Adds a folder-region opacity slider, larger dependency arrows, and
  a proper "ungroup folders" toggle.
- **Legacy desktop registers in the per-project daemon registry**, so the CLI
  and MCP discover the desktop's backend the same way they discover `cs serve`
  — one provider per project, no port guessing.

### Fixed
- **`cs scan` no longer hangs for ~60 s on exit** — a stray safety timer kept
  the event loop alive after the snapshot was emitted (60 s → ~0.9 s).
- **More edges resolved.** `require()` / `import()` specifiers built from
  `path.resolve` / `path.join(__dirname, …)` literals are now extracted.
- **Symbol `callers` surfaces value references.** A function passed as a
  callback (referenced, not called) is shown as used — not reported as dead.
- `cs symbol` accepts a symbol id directly (ids round-trip through resolve).
- Top-hub lists no longer include Markdown / doc files.
- `cs init` backs up an existing `CLAUDE.md` before writing.

### Docs
- MCP setup no longer claims the desktop app must be running first — the MCP
  server auto-starts its own backend; the desktop app is optional.

## 0.0.1 — beta (2026-06-09)

> Beta / pre-release — APIs and formats may still change.

### Added
- **Multi-session (experimental, off by default — set `CS_REGISTRY=1`).** The
  desktop can attach to another Claude Code session's per-project daemon and
  watch *its* dependency graph + live trace from a left-rail session picker,
  acting as a pure client (no second scan). Detach hands the view back to the
  local project.

### Changed
- **MCP setup is now one step.** `codesynapt-mcp` auto-starts its own backend
  in-process (scanning `CS_ROOT` or the working directory) when no desktop
  app / `cs serve` is running — so `claude mcp add codesynapt -- codesynapt-mcp`
  is all that's needed, with nothing else to keep running. If a backend is
  already up (desktop or `cs serve`), the MCP attaches to it as before.
  The auto-scan resolves the real **project root** by walking up from the
  working directory to the nearest marker (`.git` / `package.json` / `go.mod`
  / `Cargo.toml` / `pyproject.toml` / …), so the agent scans the project even
  when launched from a subdirectory. If no project is found (e.g. home or a
  drive root), it returns an actionable error instead of walking the whole disk.

### Fixed
- **Initial scan no longer freezes the backend.** Files are now parsed in
  cooperative batches that yield the event loop, so the control-server stays
  responsive while a large project scans (a 5k-file scan went from ~4.5 s of
  unresponsiveness to a ~19 ms median). Edge resolution at the end of the scan
  is still a single pass.
- Desktop renderer was loaded over `file://`, where `<script type="module">` +
  importmap are blocked by CORS, so the graph never rendered in the packaged
  app. Now served over a custom `app://` standard scheme.
- A `symbolModeState` temporal-dead-zone `ReferenceError` aborted renderer
  init (declaration moved to module top).
- Startup white flash removed (window shown on `ready-to-show`).
- **Graph accuracy — monorepo `exports` subpaths.** Workspace imports that go
  through a package's `exports` subpath map (e.g. `@scope/lib/helper` →
  `./internal/helper.ts`, including `*` wildcards) now resolve instead of being
  dropped as missing edges / false orphans.
- **Symbol graph — callbacks are no longer false dead code.** A function used
  only as a callback (passed as a value, e.g. `arr.map(fn)`) is surfaced under
  `referencedBy` in `cs_symbol` callers, so it isn't misread as unused when it
  has zero direct callers. The confident call graph (callers/blast) is unchanged.

## 0.0.0 — initial public demo

First public demo of **CodeSynapt** — an MCP-native code dependency graph for AI agents.

### Highlights
- **3D dependency graph** desktop app (Electron + Three.js).
- **CLI** (`cs`) and **MCP server** (`cs_*` tools) so AI coding agents can query the
  graph directly — "what imports `auth.ts`?", "blast radius of changing this file?".
- **Multi-language file-dependency analysis**: JS/TS, Python, Go, Rust, C/C++,
  Java/Kotlin, Ruby, PHP, Dart, C#, Swift.
- **Token-compact blast / dependency queries** — impact summaries sized for an
  agent's context budget, with full lists available on request.
- **Dual licensed**: AGPL-3.0-or-later (main app) + Commercial; Plugin API is MIT.

> Demo release — APIs and formats may still change.
