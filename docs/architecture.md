# Architecture

How codesynapt works under the hood. Aimed at contributors and the
curious; not required reading for users.

- [High-level pipeline](#high-level-pipeline)
- [Process model](#process-model)
- [Project structure](#project-structure)
- [The parser](#the-parser)
- [The scanner](#the-scanner)
- [Layer-2: the symbol (function-call) graph](#layer-2-the-symbol-function-call-graph)
- [Layout simulation](#layout-simulation)
- [Rendering](#rendering)
- [Event bus](#event-bus)
- [State management](#state-management)
- [Design decisions](#design-decisions)

## High-level pipeline

```
   user opens folder
          │
          ▼
   ┌──────────────┐
   │  Scanner     │  chokidar watches folder; emits change events
   │  (main)      │  ignores node_modules, .git, etc. via gitignore
   └──────┬───────┘
          │ file paths + contents
          ▼
   ┌──────────────┐
   │  Parser      │  @babel/parser for JS/TS, regex for Python/Rust/etc.
   │  (main)      │  produces {nodes: [...], edges: [...]} snapshot
   └──────┬───────┘
          │ IPC: snapshot
          ▼
   ┌──────────────┐
   │  Renderer    │  receives snapshot, builds graph state
   │  (window)    │  runs force-directed layout
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │  Three.js    │  WebGL instanced rendering
   │  scene       │  pre-allocated buffers for 300k nodes
   └──────────────┘
```

## Process model

Standard Electron split:

- **Main process** (`electron/main.cjs`) — Node.js. Owns the BrowserWindow,
  filesystem, child processes, IPC. Runs the scanner and parser.
- **Preload** (`electron/preload.cjs`) — bridges main and renderer via
  `contextBridge`. Exposes only the explicit `window.codesynapt.*` API
  (`window.fg3d` is a legacy alias pointing at the same object).
- **Renderer** (`public/`) — Chromium. Renders the graph, handles
  user input. Cannot reach Node APIs except via the preload bridge.

**Security**: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: false` (preload uses `require`). External URLs are
intercepted and opened in the user's OS browser instead of the app.

## Multi-session (experimental)

*Off by default. Enabled with `CS_REGISTRY=1`.* Full contract and rationale:
[design-multi-session.md](./design-multi-session.md).

The default model is one desktop, one loaded project. The experimental
multi-session model lets several Claude Code sessions share a per-project
backend and lets the desktop view any of them as a **pure client**:

- **Detached daemon** — each project root is served by a singleton detached
  `cs serve` daemon instead of an in-process backend. MCP sessions and the
  viewer are pure clients; the daemon outlives any one of them.
- **Registry** (`~/.codesynapt/`) — three lease dirs: `sessions/`, `daemons/`,
  `viewers/`. Each participant rewrites its own file's `lastSeen` every few
  seconds; liveness is file-based (no shared counter). A daemon self-exits once
  no live session or viewer references it.
- **Cursor delta** — clients bootstrap the full graph once, then poll
  `/delta?sinceGraph=&sinceTrace=` for `(epoch, seq)` deltas. Trace is filtered
  per session; the graph is shared. An `epoch` change (daemon restart) triggers
  a re-bootstrap.
- **Viewer** — the desktop reads the `sessions/` registry, lets you pick one
  from a left-rail tab, attaches to that session's daemon, and re-emits its
  graph + trace through the same renderer channels the local scanner uses.

The legacy single-port path (`~/.codesynapt/port`) stays in place; the registry
path is layered behind the flag for incremental rollout.

## Project structure

```
codesynapt/
├── electron/
│   ├── main.cjs              Electron main process entry
│   ├── preload.cjs           IPC bridge
│   └── plugin-loader.cjs     Plugin discovery + manifest validation
│
├── public/                   Renderer (HTML/CSS/JS)
│   ├── index.html
│   ├── style.css             7 themes (~4.4k lines)
│   ├── app.js                the main renderer (~7.3k lines)
│   ├── backend.js            CPU/GPU dispatcher for layout
│   ├── plugin-host.js        Plugin lifecycle + sandbox
│   └── vendor/               Three.js (regenerated via postinstall)
│
├── packages/core/            Engine — no Electron deps (shared by CLI + MCP)
│   ├── parser.js             Pure-JS file parser
│   ├── scanner.js            Chokidar-based file watcher
│   ├── bin/                  cs CLI + codesynapt-mcp entrypoints
│   └── lib/                  control-server, symbol-graph, registry, viewer-client, …
│
├── server.js                 Browser dev mode (HTTP + WebSocket)
├── plugin-api/               Plugin API package (MIT)
├── scripts/                  Build scripts (vendor copy, license check)
├── build/                    Build resources (mac entitlements)
├── .github/workflows/        CI/CD (multi-OS builds on tag push)
└── tests/                    Vitest suite (parser, scanner, control-server, …)
```

## The parser

Located at `packages/core/parser.js`. **No Electron dependency** so it can be reused
in CLI tools or workers.

### Languages

| Language | Strategy | Notes |
|---|---|---|
| JavaScript / TypeScript / JSX / TSX | `@babel/parser` AST walk | Most accurate; handles ES modules, dynamic imports, JSX |
| Python | Regex | `import x`, `from x import y`, `__init__.py` aware |
| Rust | Regex (via plugin) | See [rust-parser example](../plugin-api/examples/rust-parser/) |
| Go, Ruby, PHP, Swift, Kotlin, etc. | Regex | Less precise; misses edge cases |
| CSS | Regex | `@import` only; `url(...)` not followed |
| HTML | Regex | `<script src>`, `<link href>` |
| JSON, YAML, MD, etc. | Skipped | Not import-bearing |

For new languages, write a [parser plugin](../plugin-api/docs/types/exporter.md).

### Path resolution

After extracting raw import strings, we resolve them to file IDs:

1. Relative paths → resolve against the importing file's directory, trying
   common extensions (`.js`, `.ts`, `.jsx`, `.tsx`, …) and `<path>/index.<ext>`
2. Bare specifiers → resolve through **tsconfig `paths` / `baseUrl`** (and
   `jsconfig.json`), then monorepo **workspace package names** (`@scope/pkg`),
   honoring the package's `package.json` **`exports`** map for both the main
   entry and subpaths (`@scope/pkg/helper`)
3. Language-native rules for non-JS specifiers (Python dotted modules, Go
   packages, C# namespaces, PHP PSR-4 via `composer.json`, Dart `package:`, …)
4. If nothing resolves → kept as an "external" reference (visible in the
   inspector, no graph edge)

What it intentionally does **not** read: `webpack.config.js` / Vite aliases that
aren't mirrored in tsconfig, and package `imports` (`#`-specifiers). Resolution
is precision-first: an ambiguous candidate is declined, not guessed.

## The scanner

Located at `packages/core/scanner.js`. Uses [chokidar v3](https://github.com/paulmillr/chokidar)
to watch the filesystem.

- Reads `.gitignore` and applies it to file enumeration
- Built-in ignore list: `node_modules`, `.git`, `dist`, `build`,
  `target`, etc.
- Debounces file changes via `awaitWriteFinish: { stabilityThreshold: 500ms }`
- Emits `scan-progress` events during initial scan (for the loading UI)
- Re-parses only changed files; full snapshot rebuild only on folder
  open

## Layer-2: the symbol (function-call) graph

The file/import graph above is **Layer-1**: nodes are files, edges are
imports. **Layer-2** is a second, finer graph whose nodes are individual
**symbols** (functions, classes, methods, structs…) and whose edges are
the **`call`** relationships between them. It is built lazily — only when a
symbol-level query arrives — by `Scanner.buildSymbolGraph()` in `scanner.js`,
which drives `SymbolGraph` in `packages/core/lib/symbol-graph.cjs`.

### How it's built

Per-language AST parsers, registered in
`packages/core/lib/symbol-parsers.cjs`:

- **JS/TS family** (`js jsx ts tsx mjs cjs`) → the babel-based parser
  (`symbol-parser-js.cjs`), with type-aware receiver inference.
- **Python** (`py pyw pyi`) → a tree-sitter parser.
- **Other tree-sitter–validated languages** — `go rs java kt swift cs php
  c cc cpp h hpp sh bash scala lua` — via `symbol-parser-treesitter.cjs`.
  Only grammars that passed independent ground-truth validation are
  registered; languages with known web-tree-sitter ABI / parsing problems
  (e.g. Ruby, Dart) stay Layer-1 only rather than emit a wrong graph.

Each parser yields the file's symbols (with line ranges) and the raw call
sites inside them. `SymbolGraph.build()` then resolves each call site to a
target symbol, also using Layer-1's import data (`fileImports`) so a call
can prefer a symbol in a file the caller actually imports.

### resolveCall — precision-first

`SymbolGraph.resolveCall()` is deliberately **precision-first**: when a
call name is ambiguous it declines to guess rather than inventing a
plausible-but-wrong edge. Concretely:

- Untyped member calls on builtin/common method names (`map`, `filter`,
  `parse`-like names that collide with user helpers, …) are not resolved.
- When ≥2 imported files (or ≥2 production symbols) declare the same name,
  it records every candidate but resolves the edge **only when exactly one**
  unambiguous target exists; ≥2 ⇒ decline. Auxiliary paths
  (`scripts/`, `test/`, `build/`…) are deprioritised as call targets so
  production wins.

Declined calls are counted (surfaced in `stats()`) instead of being
silently dropped — "unresolved" is reported as data.

### The call-candidate (dynamic-dispatch) leg

Calls that can't be confidently resolved to a single target — dynamic
dispatch, multiple trait/interface implementations of the same method name
— are recorded as a separate **`call-candidate`** edge kind. These live in
their own adjacency (`candOut` / `candIn`), kept SEPARATE from the
confident `call` graph so that callers/callees/blast stay precise. The
"could be one of these" set is queried on demand rather than mixed into the
confident answer.

### Optional sub-engine enrichment (type-checkers)

After the fast AST engine builds the graph, an **optional** post-pass
(`packages/core/lib/subengines.cjs`, `enrich()`) runs registered
per-language type-checker **sub-engines** and unions in only the edges the
AST engine missed (it never rewrites existing edges; duplicates are
no-ops). Each added edge is tagged with its provenance
`via: engine.name` (e.g. `'ts'`), and a matching `call-candidate` can be
promoted to a confident `call`.

The pass is **tiered by cost**, wired up in `buildSymbolGraph()`:

- **TS sub-engine — default-on.** In-process (the bundled `typescript`
  package), so it always runs for JS/TS users.
- **`CS_SUBENGINE=1`** — also runs the external Java / C# sub-engines
  (they spawn an external toolchain, off by default).
- **`CS_SUBENGINE_HEAVY=1`** — also runs the slow Python (jedi)
  sub-engine. (Python is both heavy and external, so in practice this is
  set alongside `CS_SUBENGINE=1`.)
- **`CS_SUBENGINE_OFF=1`** — disables ALL enrichment (escape hatch if the
  TS post-pass ever misbehaves).

Layer-2 is surfaced to AI agents through the `cs_symbol_*` MCP tools and
the function-level `cs_blast({action:'function'})`; see
[docs/mcp-setup.md](./mcp-setup.md).

## Layout simulation

3D force-directed layout. Three forces:

- **Repulsion** between every pair of nodes (Barnes-Hut approximation
  via spatial octree for O(n log n))
- **Spring** along each edge (Hooke's law, configurable stiffness)
- **Centering** weak pull toward origin to keep things on screen

Implemented in `public/app.js`'s `simulate()` function. Runs every
animation frame while `state.sim.alpha > alphaMin`; reheats on graph
changes.

### Backend dispatcher

`backend.js` switches between CPU (default) and GPU (WebGPU, planned)
implementations. Currently GPU step is `null` — auto-falls back to
CPU. Users can force CPU in settings if their GPU is busy with
another app.

CPU implementation handles 300k nodes at ~7 fps simulating, 100 fps
settled.

## Rendering

Three.js with **instanced rendering** for everything:

- One `InstancedMesh` for all nodes (one geometry, position/color/scale
  per instance)
- One `InstancedMesh` for all edges (line segments)
- Halos use a separate instanced shader for the glow effect

Buffer sizes are **pre-allocated** for 300k nodes / 1M edges. This
means no per-frame allocation pressure and no GC pauses during
animation. Nodes added beyond the cap are silently ignored.

### Picking

Pointer picking uses GPU readback into a 1×1 framebuffer — sample the
pixel under the cursor, decode its color to a node ID. Avoids the
CPU cost of ray-vs-mesh intersection tests.

## Event bus

A simple pub/sub in `app.js`:

```js
bus.on('selection:changed', (id) => { ... })
bus.emit('selection:changed', nodeId)
```

Used to decouple panels from each other. The inspector, context panel,
filter badges, status bar, and file tree all subscribe — they don't
know about each other, just about events.

Events:

- `snapshot:applied` — new data loaded (`{ root }`)
- `selection:changed` — `nodeId | null`
- `filter:changed` — (no payload)
- `focus:changed` — `nodeId | null`
- `graph:cleared` — folder closed
- `activeset:changed` — star or pipeline updated

`bus.on()` returns an unsubscribe function. Plugins receive the same
API surface.

## State management

A single `state` object in `app.js`. Plain JS, no framework.

- `state.nodes: Map<id, node>` — for O(1) lookup
- `state.byIdx: node[]` — for ordered iteration (rendering)
- `state.edges: edge[]` — flat array
- `state.selectedId`, `state.focusedId`, `state.filterText`, etc.

Plugins access a subset of state via `ctx.graph` (read-only).

### Why no framework?

Adding React or Vue would buy us:

- Component reuse (we have ~5 panels)
- Reactive updates (we already use the event bus)
- Better dev tools

And cost us:

- ~150KB more bundle size (React) or ~80KB (Vue)
- Mental model overhead for contributors who don't know it
- Render scheduling that fights with our 60fps animation loop

The current "plain JS + event bus" approach is intentional. If you
contribute, please don't introduce a framework dependency unless
there's a strong case.

## Design decisions

### Why 3D, not 2D?

Dependency graphs in 2D get tangled fast. Past ~200 nodes you spend
more time disentangling crossings than reading structure. 3D gives
enough extra dimension that clusters separate naturally, and the
orbit camera lets you look at things from multiple angles to verify
what you're seeing.

### Why force-directed, not hierarchical?

Hierarchical layouts (like `dot` from GraphViz) work well for trees
but assume a clear root. Real codebases are graphs, not trees — they
have cycles, multiple entry points, shared utilities. Force-directed
handles these gracefully and adapts as you star different files as
"active."

### Why active sets instead of automatic dead-code detection?

AI-assisted coding workflows produce files where:
- `.old.` files are often the real production code
- New files are experiments that don't actually work yet
- README and docs don't match the code

Any automatic heuristic gets these wrong. Letting the user mark "this
is what's really live right now" is more honest. See
[features.md](./features.md#active-sets-and-pipelines).

### Why AGPL, not MIT?

The author wants to be able to monetize the app commercially later
without losing the contribution model. AGPL lets the code stay public
and inspectable while preserving commercial rights, and auto-converts
to Apache 2.0 after 4 years — so it's an OSI-compatible long-term
plan, just with a delay. The plugin API stays MIT so the ecosystem
remains fully open.

### Why Electron?

Browser-native graphics (WebGL/WebGPU) + the file system access
needed for code scanning. Tauri would give a smaller binary but
worse plugin sandboxing story (no JS realm to isolate plugins from
the host). The size penalty (~150 MB installed) is acceptable for a
desktop developer tool.

## Reading the code

Start at:

1. `electron/main.cjs` → see how the app starts up
2. `scanner.js` → how files are discovered
3. `parser.js` → how imports are extracted
4. `public/app.js` (the largest file) → renderer, layout, UI

If something seems wrong or surprising, [open an issue](https://github.com/YOUR_USER/codesynapt/issues)
or a PR.
