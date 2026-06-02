# Architecture

How codesynapt works under the hood. Aimed at contributors and the
curious; not required reading for users.

- [High-level pipeline](#high-level-pipeline)
- [Process model](#process-model)
- [Project structure](#project-structure)
- [The parser](#the-parser)
- [The scanner](#the-scanner)
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
  `contextBridge`. Exposes only the explicit `window.cs.*` API.
- **Renderer** (`public/`) — Chromium. Renders the graph, handles
  user input. Cannot reach Node APIs except via the preload bridge.

**Security**: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: false` (preload uses `require`). External URLs are
intercepted and opened in the user's OS browser instead of the app.

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
│   ├── style.css             ~2,200 lines, 7 themes
│   ├── app.js                ~3,500 lines, the main renderer
│   ├── backend.js            CPU/GPU dispatcher for layout
│   ├── plugin-host.js        Plugin lifecycle + sandbox
│   └── vendor/               Three.js (regenerated via postinstall)
│
├── parser.js                 Pure-JS file parser (no Electron deps)
├── scanner.js                Chokidar-based file watcher
├── server.js                 Browser dev mode (HTTP + WebSocket)
│
├── plugin-api/               Plugin API package (MIT)
├── scripts/                  Build scripts (vendor copy, license check)
├── build/                    Build resources (mac entitlements)
├── .github/workflows/        CI/CD (multi-OS builds on tag push)
│
├── test.js                   Parser smoke test
└── perf-test.js              Layout benchmark
```

## The parser

Located at `parser.js`. **No Electron dependency** so it can be reused
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

1. Strip extension from raw path
2. Try matching against known file IDs
3. Try common extensions (`.js`, `.ts`, `.jsx`, `.tsx`, etc.)
4. Try `<path>/index.<ext>`
5. If no match → keep as "external" reference (visible in inspector,
   doesn't create a graph edge)

This is intentionally simpler than a full module resolver — we don't
read `tsconfig.json`, `webpack.config.js`, or `package.json`'s exports
field. Plugins can override this if you need precision.

## The scanner

Located at `scanner.js`. Uses [chokidar v3](https://github.com/paulmillr/chokidar)
to watch the filesystem.

- Reads `.gitignore` and applies it to file enumeration
- Built-in ignore list: `node_modules`, `.git`, `dist`, `build`,
  `target`, etc.
- Debounces file changes via `awaitWriteFinish: { stabilityThreshold: 500ms }`
- Emits `scan-progress` events during initial scan (for the loading UI)
- Re-parses only changed files; full snapshot rebuild only on folder
  open

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
