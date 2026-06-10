# Changelog

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
