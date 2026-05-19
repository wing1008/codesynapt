# Changelog

All notable changes to filegraph3d.

## Unreleased — 2026-05-18 session

### Added — AI agent integration

- **HTTP control API** on `127.0.0.1:7707` (env override `FG3D_PORT`).
  17 endpoints: `/health`, `/summary`, `/graph` (paginated + sortable),
  `/node/:id`, `/file/:id`, `/deps/:id`, `/users/:id`, `/find?q=`,
  `/external`, `/blast/:id`, `/timeline`, `/tour`, `/history/:id`,
  `/changes`, `POST /focus/:id`, `POST /open/:id`, `POST /restore/:id`,
  `POST /refresh/:id`. Local-only, no auth (loopback trusted).
- **CLI** at `bin/fg3d.cjs` — 19 commands, thin wrapper around the
  HTTP API. `npm link` registers `fg3d`, `fg3d-mcp`, `filegraph3d-server`
  globally.
- **MCP server** at `bin/fg3d-mcp.cjs` — hand-rolled stdio JSON-RPC
  2.0, zero dependencies (~150 lines). 19 tools exposed to Claude Code
  / Cursor / Continue / Cline. Register once with
  `claude mcp add filegraph3d node /abs/path/bin/fg3d-mcp.cjs`. See
  [docs/mcp-setup.md](./docs/mcp-setup.md).

### Added — graph features

- **Live AI agent visualization** — every MCP/CLI call pulses the
  touched node in 3D with a ripple + color tint per tool type (cyan
  read, yellow focus, red write, etc). A cyan→magenta navigation
  trail line connects the last ~32 touched nodes so you can see the
  agent's path through the codebase. AI trace overlay panel
  (bottom-right) logs each operation live.
- **Blast radius predictor** — `fg3d blast <id>` / `fg3d_blast_radius`
  returns BFS impact (totalFiles, totalLoc, tokenEstimate, categories
  split into tests/source/config/docs/other, byDepth). Highlights
  affected nodes in magenta when called.
- **Time-lapse mode** — ⏱ button in topbar. Reads `git log
  --diff-filter=A` to build a per-file birth timeline; slider hides
  nodes that didn't exist yet at the chosen commit; Play button
  animates 25 s start→end.
- **Guided tour** — 🧭 button. Heuristic-selected stops (entry points
  matching `^(?:src/)?(?:index|main|app|server|cli|bin)\.`, top hubs
  by incoming-import count, top external-API integration files).
  Camera flies to each stop with a short rationale.
- **Project summary** (`fg3d_summary`, ~300 tokens) — Layer-1
  overview: fileCount/edgeCount, top 5 folders, top 10 hubs, ext mix,
  orphan count, dynamic-pattern file count, external domains.
  Version-counter cache; invalidates on snapshot.
- **External URL inventory** — `fg3d external` lists every external
  host the project calls (http/https/ws/wss), grouped by domain.
  Combines structured `apiCalls` detection (fetch/axios/got/ky/SWR/
  React Query/requests/httpx/aiohttp) + a generic URL grep over all
  source files so URLs in `.env.example`, comments, hardcoded
  constants are captured.
- **Dynamic pattern detection** — parser flags files using
  `require(expr)`, `import(expr)`, template-literal imports, `eval`,
  `new Function`, `Reflect`, `importlib`, `__import__`, `exec`,
  `getattr`. Surfaced as `hasDynamicResolution: true` +
  `dynamicPatterns: [...]` on each node so AI doesn't treat them as
  reliably orphan.
- **Session changes panel** (📝) — every file modified this session
  (any source: AI, you, external editor). Click a row to focus the
  node; click `+` to expand a line-by-line LCS diff from first-seen
  to current content.
- **Auto file history** (opt-in via Settings) — per-file timestamped
  snapshots in `.filegraph3d/history/`, capped at 3 per file. Same
  dedup logic for chokidar re-fires. Inspector shows view/restore
  buttons; `fg3d_restore` MCP tool can roll back.
- **Inspector overhaul** — connection badge
  (🟢 connected / 🟡 no incoming / 🟠 orphan) based on actual import
  graph. Full-file textarea editor with 500 ms debounced auto-save
  via new `write-file` IPC. History panel + content panel.
- **i18n (Korean / English)** — top-bar `EN` / `한` toggle. Strings
  via `data-i18n` attributes + `t(key)` helper, persisted to
  `localStorage`. Covers settings panel, hints bar, AI panels,
  inspector badges, status bar, dialog, drop overlay, welcome.
- **File tree root display** — folder name + full path now show at
  the top of the file tree panel so users know which root is loaded
  without checking the topbar.

### Added — response meta + freshness control

- **Standardized `meta` envelope** on every API response:
  `{ scannedAt, serverTime, tokenEstimate, totalAvailable?, returned?,
  offset?, limit?, sort?, truncated? }`. Lets the AI budget tokens
  and self-check freshness.
- **Pagination + sort** on `/graph`: `?limit=N&offset=N&ext=ts&minMass=3&sort=mass:desc`.
  Default sort is `mass:desc` so even a bare `limit=10` returns the
  10 most-imported files (instead of garbage insertion-order). Other
  sorts: `size:desc`, `loc:desc`, `id:asc`, `insertion` (opt-out).
- **`fg3d_refresh(id)`** — force re-scan of one file in ms.
  Recommended call before high-stakes mutations to defeat staleness.

### Added — camera / scene polish

- **Cursor-anchored zoom-in** (dolly toward cursor) +
  **center-drift zoom-out** (like Obsidian) for a more intuitive
  graph navigation pattern.
- **Unlocked vertical camera tilt** (`phi` clamp removed) — pole pass
  works smoothly via dynamic `camera.up` recomputation.
- **Spherical force-directed layout** — removed disk-flattening force
  + spherical node seeding. Cluster reaches a clean sphere instead
  of a flattened pancake.
- **Idle auto-rotate** — after 4 s of no user input, the camera
  rotates slowly around the focus target. Instantly stops on any
  interaction.
- **Scene-wide heartbeat** — subtle sine modulation on node size /
  emit so the graph feels alive at rest.
- **AI trace pulse + ripple + trail** — recently-touched nodes pulse
  in their tool-color tint with a 700 ms ripple burst on each call;
  a cyan→magenta line traces the agent's navigation path through the
  graph (additive blending, fades over 8 s).

### Changed

- **Default label budget** reduced from 60 → 10 simultaneous labels.
  Top 10 by mass (or focused node + closest neighbors when a node is
  selected).
- **`read-file` IPC** size cap raised 500 KB → 2 MB; content slicing
  removed so the inspector textarea shows the entire file.
- **Scanner ignores `.filegraph3d/`** so the auto-history folder
  doesn't appear in the graph.

### Fixed

- **`pathLabel` was getting overwritten by the translation system**
  after a folder was loaded — removed its `data-i18n` attribute and
  switched to manual translated init only when no folder is loaded.
- **`status.files` JS overwrote translated label** by setting the
  cell's `innerHTML` — refactored to use `t('status.files')` inside
  the template literal so it survives lang toggle + per-tick
  re-renders.

## Unreleased — 2026-05-15 session

### Fixed
- **CSP blocked `<script type="importmap">`** — `public/index.html`
  meta CSP did not permit the inline import map, which made the bare
  specifier `import * as THREE from 'three'` fail to resolve. App.js
  never executed, so every UI button was inert. Added the SHA-256 hash
  for the importmap inline (`'sha256-NfHJr+xcDJiAGqHYgFEaR5vX+0YDa2Tbke39iP8L6uY='`)
  to `script-src`.
- **Three.js r160 `BufferAttribute.updateRange` is getter-only** —
  the previous setter-style writes (`attr.updateRange = { offset, count }`)
  threw `TypeError` every frame, so nodes / edges never rendered.
  Replaced all six call sites in `public/app.js` with
  `attr.clearUpdateRanges(); attr.addUpdateRange(start, count)` (the
  r159+ API). No deprecation warnings.
- **Left panels overlapped and intercepted clicks** on the 3D nodes.
  Replaced floating `position: fixed` panels with a proper 3-column
  CSS Grid layout (body grid: rows `topbar / main / statusbar`;
  columns `leftRail / canvas / rightRail`). Overlays (welcome,
  dialogs, toasts, settings, inspector, searchbar, hints) remain
  `position: fixed`.
- **File tree toggle disappeared with the panel.** Added a topbar
  toggle button (🗂) so the tree can be reopened regardless of its
  state; `T` shortcut and in-panel `−` button still work.
- **Disconnected nodes drifted off into the distance.** Tightened the
  soft world cap (linear+quadratic growth) and added a hard clamp at
  `R_SOFT × 1.85` that teleports outliers back onto the shell. A
  cold-state check enforces the clamp even when the simulation has
  settled.

### Added
- **Refresh button** in the topbar (↻, `F5`) — rescans the currently
  loaded folder via existing `loadFolder` IPC. Disabled when no folder
  is open, animates a rotation while a rescan is in flight.
- **Layout sliders** in Settings (persisted to localStorage):
  - **node distance** (0.3×–3×) — scales repulsion and spring rest
    length, expanding/compacting the layout. Triggers a soft reheat.
  - **node size** (0.3×–3×) — multiplies the rendered point size.
    Default was rebased: today's `1.0×` matches what `0.3×` produced
    before. (Old `node_size` localStorage entry is auto-cleared.)
  - **max world size** (60–300) — radius of the world soft cap.
    Smaller values produce tighter, more compact graphs; larger
    values allow more spread.
  - **reset to defaults** button — restores all three sliders.
- **Full-stack edges** (`kind: 'api'`) — connect client API call sites
  to server route handlers. `parser.js` now extracts:
  - JS/TS/JSX/TSX/Vue/Svelte/Astro routes (Express, Fastify, Koa,
    Hono, Express-router) and API calls (`fetch`, `axios`, `got`,
    `ky`, `request`, SWR / React Query hooks).
  - Python routes (Flask `@app.route` + `methods=`, FastAPI
    `@app.get/post/...`, `@router.X`) and API calls
    (`requests`/`httpx`/`aiohttp`/`session`).
  `scanner.js` builds a route index across all files, then matches
  each `apiCall` URL (after `normalizeUrlPath`) against route regexes
  (`:id`, `{id}`, `<int:id>`, `*` supported). Method-aware: a
  `GET` call matches `GET` and `ALL` routes only. Duplicates and
  self-calls are dropped. Visually identical to import edges; the
  `k: 'api'` field is recorded in the data.

### Changed
- **Drag direction (horizontal)** — flipped sign of `cam.theta` delta
  in the pointermove handler. Left/right drag now feels natural for
  the user's preferred orbit direction. Vertical (`cam.phi`) unchanged.
- **Node glow disabled** — `nodeMat` blending changed from
  `AdditiveBlending` to `NormalBlending`, and `glowTexture` reshaped
  to a sharper-edged disk (no halo). Background nebula sprites and
  starfield are unchanged.
- **Resize uses canvas, not window** — `resize()` now reads
  `canvas.clientWidth/Height`, and a `ResizeObserver` on the canvas
  triggers it whenever a rail toggles. Labels and `pickAtNDC` also
  use canvas coordinates so picking works correctly in the new
  middle-column layout.

### Notes / known limits
- Full-stack matching does NOT understand Express router mount
  prefixes (`app.use('/api', router)`). Template-literal URLs are not
  interpolated; only bare-string URLs match.
- File-based routing (Next.js `app/api/...`, Nuxt server routes) is
  not inferred from filenames.

## v0.11.1 — Infrastructure & automation

### Added
- **Issue templates** for bug reports, feature requests, and plugin
  API issues. Each pre-fills labels and routes to the right docs.
- **Pull request template** with a checklist covering testing,
  documentation, and CLA agreement.
- **Issue chooser config** (`.github/ISSUE_TEMPLATE/config.yml`) that
  routes questions to Discussions, security to private channel, and
  commercial inquiries to LICENSES.md. Blank issues disabled.
- **Dependabot configuration** with weekly checks, grouped patch/minor
  updates, separate tracking for plugin-api dependencies, and major
  Electron/three.js bumps held back for manual review.
- **CI workflow** (`.github/workflows/ci.yml`) running on every push
  and PR: syntax checks on all `.js`/`.cjs` files, license compliance,
  parser smoke test on three OSes, markdown link validation.
- **SHA-256 checksum generation** for release artifacts. Per-OS
  `SHA256SUMS-<os>.txt` files attached to each release for build
  verification (as promised in `docs/installation.md`).
- **Status badges** on README and plugin-api/README — license, version,
  CI, build, platform support.
- **`AGENTS.md`** — guide for AI coding agents (Claude Code, Cursor,
  Codex, Aider) describing project conventions, hard rules, common
  pitfalls, and the maintainer's expectations.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1, adapted for a
  one-maintainer project with realistic enforcement expectations.
- **`.github/SUPPORT.md`** — routing doc for help requests. GitHub
  auto-links this from the "Help" panel on Issues.
- **`.github/FUNDING.yml`** — placeholder for the Sponsor button.
  Includes commented-out templates for GitHub Sponsors, Buy Me a
  Coffee, Ko-fi, Patreon, Open Collective, Liberapay, Tidelift, and
  Polar. Maintainer enables whichever they actually set up.
- **release-drafter** automation: rolling draft of next release notes
  is maintained as PRs merge. 10 release-note categories (Breaking,
  Features, Bug fixes, Plugin system, UI/themes, Performance, Security,
  Documentation, Maintenance, Dependencies). Auto-determines major /
  minor / patch version bump from PR labels.
- **Auto-labeler** (`actions/labeler@v5`) that applies labels to PRs
  based on changed files — `*.md` → `documentation`, `plugin-api/**`
  → `plugin-api`, `.github/workflows/**` → `ci`, etc. Saves manual
  labeling effort and improves release-drafter accuracy.
- **`.github/LABELS.md`** — full label conventions reference with
  one-line descriptions, colors, and `gh label create` commands for
  first-time setup.
- **Maintainer publishing guide** rewritten with the new release-drafter
  flow: review draft, polish, bump version files, tag, push, CI builds
  and attaches binaries automatically.

### Changed
- Build workflow now generates `generate_release_notes: true` for
  automated release page content.
- `CONTRIBUTING.md` Submitting section expanded with template guidance
  and explicit accept/reject criteria.

## v0.11.0 — Plugin system + dual licensing

### Added
- **Plugin API** (`plugin-api/`) — MIT-licensed package for building
  themes, exporters, parsers, layouts, panels, and context-menu
  actions. Full TypeScript types, documentation, and four working
  examples.
- **Plugin loader** in main process: discovers plugins in the user's
  data directory, validates manifests (id pattern, type, permissions),
  prevents path traversal, and gracefully reports invalid plugins.
- **Plugin host** in renderer: isolates plugins in their own Function
  scope, mediates all app access through a curated `ctx` object,
  enforces permissions, and manages lifecycle/disposables.
- Plugin themes appear automatically in Settings → Appearance.
- "Open plugin folder…" button in Settings.
- `docs/` directory structure: installation, features, controls,
  architecture, maintainer guides.

### Changed
- **License: MIT → BSL 1.1** for the main app. Plugin API stays MIT.
  Auto-converts to Apache 2.0 on 2030-05-14.
- README rewritten as a concise landing page; detailed docs moved to
  `docs/`.
- `bus.on()` now returns an unsubscribe function (plugin requirement).
- `bus.off()` method added for symmetric API.

## v0.10.1 — OS/license/compatibility audit

### Changed
- Electron upgraded v28 → v41 (v28 is EOL).
- electron-builder upgraded v24 → v25.
- Node.js minimum bumped 18 → 20.
- macOS: hardened runtime enabled with `build/entitlements.mac.plist`.
- Linux: added `.tar.gz` target as fuse2-free alternative to AppImage.
- CSP strengthened: `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`.

### Added
- `scripts/license-check.js` — fails the build if any dependency uses
  a non-permissive license.
- `SECURITY.md` documenting data handling, supported versions, and
  vulnerability reporting.
- README permissions section explaining file access requirements.

## v0.10.0 — Active set curation

### Added
- **Active sets and pipelines** — user-curated "what's really live"
  markings. Star individual files or group them into named pipelines.
  Non-active files dim or hide depending on mode.
- File tree star icons with folder badges (`★3`) showing starred
  counts under collapsed folders.
- Pipelines panel (left bottom): create, rename inline, toggle on/off,
  delete with confirmation.
- Context panel: large star toggle, pipeline membership tags,
  "Add to pipeline…" dropdown.
- Filter badge bar shows active-set mode with one-click disable.

### Changed
- Visual emphasis system: active files at full brightness with 1.15×
  size pop; non-active dim to 0.12 or hide entirely.

## v0.9.2 — Click & interaction hardening

Stability patch focused on edge cases around mouse/pointer interaction,
async race conditions, and rare input scenarios.

### Fixed
- **Canvas drag**: switched from mouse events to Pointer Events with
  `setPointerCapture`, so drags now survive the cursor leaving the
  window, going to another monitor, or the window losing focus.
  Previously a drag could "stick" if mouse-up landed outside the
  window.
- **Stale hover on fast click**: when clicking quickly after a hover,
  the throttled hover state (32 ms) could still point to the
  previously hovered node. Click now re-picks at the actual click
  position.
- **Snapshot during drag**: if a file is deleted from disk while you
  drag its node, the drag now terminates cleanly instead of
  continuing to manipulate a removed object.
- **Open-folder double-click**: re-entrancy guard prevents the user
  from spawning multiple OS folder pickers by rapid-clicking.
- **Inspector row click on deleted file**: now shows a toast "File
  not in graph" instead of failing silently.
- **Empty-graph exports**: PNG/JSON/CSV buttons now show a clear
  toast when there's nothing to export rather than producing empty
  files.
- **Large JSON export**: 100k+ node exports show a brief warning
  toast, and serialization is deferred to the next tick so the
  toast actually paints before the UI freeze.
- **Glob escaping in file tree**: clicking a folder named e.g.
  `(legacy)` or `[archived]` now filters correctly (glob meta
  characters are escaped). The glob compiler also recognizes `\X`
  as a literal-character escape.
- **IME composition in search**: filter is no longer applied to
  partial Korean/Japanese/Chinese characters mid-composition.
  Filter is also now debounced 90 ms to reduce work during fast
  typing.
- **Project dialog**: backdrop click closes the dialog (standard
  UX). Previously you had to use ✕ or Esc.
- **Drag-drop overlay**: now reliably hides on dragend / blur / drop
  even when the dragenter/leave counters fall out of sync (which
  happens when crossing nested element boundaries). Overlay also
  only appears for file drags, not text/link drags.
- **Drop of a file instead of folder**: shows a toast directing the
  user to use Open Folder, instead of silently failing.
- **Minimap interaction**: also moved to Pointer Events with
  capture. Guard added so clicking on an empty minimap (no graph
  loaded) doesn't change the camera target.

### Internal
- All async click handlers (`pickFolder`, `loadFolder` from drop)
  now have try/catch with toast on failure.
- `state.draggingNode` is cleared in `applySnapshot` if its target
  node was removed.

## v0.9.1 — Stabilization patch

Internal refactor and bug fixes; no user-facing feature changes.

### Fixed
- `applyFilter` was being reassigned via function-declaration overwrite,
  which would silently fail in some bundlers or under strict-mode
  optimizations. Filter changes now propagate via a central event bus.
- Selected and hovered node IDs are now cleared automatically when the
  referenced node is removed from a snapshot (previously stale
  references could persist, causing inspector or context-panel to
  show "ghost" data for deleted files).
- `selectNode` now defensively clears the selection if called with an
  id that doesn't exist in the current graph.
- Connected-component count in the status bar now refreshes for graphs
  of any size once the simulation has settled, instead of being
  permanently shown as `—` for 50k+ node graphs.
- Folder-grouping and pause toggles now update the active-filter badge
  bar (previously they only took effect silently).
- Project info dialog is now dismissed when the user closes the folder
  (previously it could linger displaying the previous root's data).
- Path-traversal check in `read-file` IPC handler now uses
  `path.relative` instead of `startsWith`, which correctly handles
  prefix-confusable paths like `/proj` vs `/proj2`.
- `startScanner` now resets `currentRoot` and emits an error toast on
  scanner-start failure instead of leaving the previous root in place.
- The minimap was running its own `requestAnimationFrame` loop in
  parallel with the main render loop. Merged into a single RAF for
  better scheduling and slightly lower idle CPU.

### Internal
- Introduced a central event bus (`bus.on` / `bus.emit`) to replace the
  ad-hoc `window.__xxxRefresh` pattern. Five subsystems (file tree,
  recent files, context panel, project dialog bootstrap, filter
  badges) now subscribe explicitly. The bus is exposed at
  `window.__bus` for in-browser debugging.
- Three separate `window` keydown listeners (general shortcuts, T,
  1-3) merged into a single listener for predictable ordering.
- Removed dead code: `sortByMass` declaration, `shouldIgnoreDir`
  method.
- Responsive media queries added for screens narrower than 1280,
  1024, and 800 pixels (previously the right rail and inspector
  would overlap on small windows).
- All side panels (file tree, right rail, status bar, recent files,
  stats, filter badges) are now hidden in the welcome / no-folder
  state.

## v0.9.0 — Side panels

- Added file tree (left top) — hierarchical view with collapse/expand,
  folder-scoped filtering on click, file selection on click. Performant
  even at 100k+ files because only expanded branches are rendered.
- Added recent files panel (left bottom) — last 8 selected files,
  persisted per root.
- Added active-filter badge bar (topbar) — shows currently-applied
  filters with ✕ to clear individually.
- Added status bar (bottom) — file/edge/component counts, simulation
  state, last-change time, backend mode, FPS.
- Added `T` shortcut for file tree, `M` for right rail.

## v0.8.0 — Right rail

- Added 1:1 minimap (top right) — 2D top-down view of the entire graph
  with click/drag to move the main camera target.
- Added context panel (right, under minimap) — shows selected node
  details, or project info when nothing is selected.
- Added project info dialog — runs on first folder open to capture
  name, version, stack, description, notes. Persisted per root.
- Right rail toggleable via search-bar button or `M` shortcut.

## v0.7.0 — Polish

- Empty-space click clears selection.
- Full keyboard shortcuts (`Esc`, `/`, `Space`, `R`, `S`, `Ctrl+F`,
  `Ctrl+,`, `Ctrl+O`).
- Search modes: substring / glob / regex; highlight-only or
  hide-non-matching.
- Match count display.
- `.gitignore` is now honored automatically.
- Scan progress toast.
- Graph statistics panel (overview, top hubs, extensions).
- Screenshot export (PNG), data export (JSON, CSV).
- Camera presets (default / top-down / side) + custom slots 1-3.
- electron-builder configuration for Mac / Win / Linux.
- GitHub Actions workflow for automated multi-platform builds.

## v0.6.0 — Backend dispatcher

- Added physics-backend dispatcher (Auto / GPU / CPU) with WebGPU
  device initialization and contention-based auto-fallback.
- Settings panel UI for backend selection.
- Window minimize / hide events drive auto-pause; window obscuration
  no longer pauses the simulation.

## v0.5.0 — Scale optimization

- Single `THREE.Points` + custom shader for all nodes (1 draw call).
- Linked-list flat spatial grid (allocation-free).
- Round-robin repulsion + spring sampling — work per tick bounded
  independently of N.
- Inlined float math in hot loops.
- Label pool (60 reusable DIVs).
- CPU NDC projection picking, throttled.
- Coast-only fast path when simulation settles.

## v0.4.0 — Fluid interactions

- d3-force style alpha cooling with reheat on interaction.
- 3D node dragging (intersect drag plane).
- Smooth camera zoom (critically damped).
- Scale-in animation for new nodes.

## v0.3.0 — Galactic visualization

- Cosmic dark theme with starfield, nebulae, additive glow halos.
- Mass-weighted physics where hubs behave like suns.

## v0.2.0 — Electron desktop app

- Wrapped in Electron with native menu, folder picker, drag-drop,
  recent folders, window state persistence.

## v0.1.0 — Initial

- Node.js HTTP+WebSocket server + vanilla JS frontend using three.js.
- Multi-language parser (15+ languages).
