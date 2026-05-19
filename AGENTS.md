# AGENTS.md

> Guide for AI coding agents working on filegraph3d
> (Claude Code, Cursor, Codex, Aider, etc).
> Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md) instead.

This file captures conventions, design decisions, and traps that
aren't obvious from reading the code. Read it before making changes.

## What this project is

filegraph3d is a desktop app for visualizing code dependency graphs
in 3D. The stack:

- **Electron** (desktop shell — main process is Node, renderer is Chromium)
- **Three.js** (3D rendering via WebGL)
- **Vanilla JavaScript** — no React, no Vue, no framework
- **Dual-licensed**: BSL 1.1 (main app) + MIT (`plugin-api/`)

It's a one-person project. Optimize for **the maintainer's future self
re-reading this code**, not for theoretical scalability.

## Hard rules — do not violate

These are intentional choices. Don't "improve" by violating them.

### 🚫 Never add a runtime framework dependency

React, Vue, Svelte, Solid, Preact — none of them. The current
"plain JS + event bus" architecture is the choice. See
[`docs/architecture.md`](./docs/architecture.md#why-no-framework)
for the rationale.

If you find yourself wanting one, you're probably solving the wrong
problem. State management lives in a single `state` object in
`public/app.js`. UI updates go through `bus.emit()`.

### 🚫 Never add network calls

The app is **offline by design**. No telemetry, no auto-update check,
no font CDN, no analytics, no error reporting service. This is a
core privacy promise documented in `SECURITY.md`.

If a feature seems to need the network, push back or make it
opt-in via a plugin (which the user installs explicitly).

### 🚫 Never reach into globals from plugins

Plugins must only use `ctx.*` APIs. If a plugin tries to read
`window.state` or call `bus.emit` directly, that's a bug — fix the
plugin, don't accommodate it.

If a plugin genuinely needs something not exposed, add it to the
`ctx` surface in `public/plugin-host.js` (with appropriate
permission gating).

### 🚫 Never weaken path safety in plugin loading

`electron/plugin-loader.cjs` uses `path.relative()` to reject any
plugin `main` field that escapes its own folder. Don't simplify this
check away — it's the only thing stopping a malicious plugin from
referencing `/etc/passwd` or arbitrary system files.

### 🚫 Never add `localStorage` calls without try/catch

localStorage throws in private browsing, on quota exceeded, and in
some Electron configurations. Every read/write must be wrapped:

```js
try {
  localStorage.setItem(KEY, value)
} catch { /* quota or unavailable */ }
```

Failing silently is correct here — a missing preference is fine,
a thrown exception is not.

## Project structure cheat sheet

```
electron/             Main process (Node)
  main.cjs              ← BrowserWindow + IPC + HTTP control server (:7707)
  preload.cjs           ← contextBridge — only file Renderer can see Node through
  plugin-loader.cjs     ← Plugin discovery + manifest validation

bin/                  CLI + MCP entry points (CommonJS, shebang'd)
  fg3d.cjs              ← Terminal CLI — 19 commands, talks to :7707 over HTTP
  fg3d-mcp.cjs          ← MCP server — stdio JSON-RPC 2.0, 19 tools, ZERO deps

public/               Renderer (Chromium)
  index.html            ← Single page, CSP at top, data-i18n attrs on visible text
  style.css             ← All UI styles, 7 themes via body[data-theme]
  app.js                ← THE main file — state, bus, render loop, i18n, all panels
  backend.js            ← CPU/GPU dispatcher for layout (GPU is stubbed)
  plugin-host.js        ← Plugin lifecycle, ctx object construction, permission guards

parser.js             Pure JS — extracts imports + routes + apiCalls + externalUrls + dynamicPatterns
scanner.js            chokidar wrapper — watches folders, emits snapshots (with snapshotVersion)
server.js             Browser dev mode (ws + static serve)

plugin-api/           Public plugin SDK (MIT)
  types.d.ts            ← Single source of truth for plugin API
  docs/                 ← Plugin developer guides
  examples/             ← Working starter plugins

docs/                 User-facing docs
  installation.md       Per-OS install + permissions + build verification
  features.md           Every feature
  controls.md           Keyboard/mouse reference
  architecture.md       How it works internally
  mcp-setup.md          MCP server registration for Claude Code / Cursor / Continue
  maintainer/           Maintainer-only (release process)

.github/              GitHub-specific config
  ISSUE_TEMPLATE/       Bug, feature, plugin templates
  workflows/            ci.yml (PR checks), build.yml (release builds)
  dependabot.yml        Weekly dep updates
```

## Three surfaces, one scanner

`electron/main.cjs` boots the desktop UI **and** a tiny HTTP server on
`127.0.0.1:7707` (override via `FG3D_PORT`). The CLI (`bin/fg3d.cjs`)
and MCP server (`bin/fg3d-mcp.cjs`) are both thin wrappers around
that HTTP API — they don't talk to the scanner directly. This means:

- The desktop app must be running for CLI / MCP to work
- Adding a new graph capability = add an HTTP endpoint in `main.cjs`,
  then surface it in both `bin/fg3d.cjs` (command) and
  `bin/fg3d-mcp.cjs` (tool definition)
- UI control commands (`POST /focus/:id`, `/open/:id`) relay through
  `mainWindow.webContents.send('control:focus'|'control:open'|...)`
  → renderer listens via the preload `onControl` bridge

## AI-aware tool design — patterns

These patterns are why agents work well with this tool. Don't strip them.

### `withMeta(payload, extra)` envelope

Every HTTP response is wrapped with `withMeta`:

```js
return writeJson(res, 200, withMeta(payload, { totalAvailable, ... }))
```

This adds `meta: { scannedAt, serverTime, tokenEstimate, ... }` so the
AI can budget tokens and detect stale data. New endpoints should use it.

### Layer-1 first, narrow later

`fg3d_summary` is the cheap (~300 tokens) overview the agent should
read first. New features that surface a project-wide property should
also add to summary if cheap, instead of forcing a full graph dump.

### Snapshot version counter

`scanner.snapshotVersion` increments on each snapshot. Cache anything
expensive (like `buildSummaryCached`) by storing
`{ version, data }` and recomputing only on mismatch.

### `control:trace` IPC

When an HTTP endpoint touches a specific file id, `emitTrace(tool, id)`
fires `control:trace` IPC → renderer pulses the node + adds to AI trace
panel. New endpoints that take a node id should call `traceId()` (the
inline helper) instead of `idFromRest()` to participate in the
visualization.

## i18n — adding a translatable string

Two paths:

**HTML static strings:** add `data-i18n="key.path"` attribute. Add the
key to BOTH `T.ko` and `T.en` in `public/app.js`. Call
`applyI18nToDOM()` (already runs on startup + on lang toggle).

**JS-generated strings:** use `t('key.path', { var: value })` in
template literals. Add to both `T.ko` and `T.en`. For dynamic panels,
make sure `setLang()` re-renders the panel (already calls
`refreshTracePanel`, `refreshChanges`, `renderInspector`, `renderFtRoot`).

**Anti-pattern:** setting `textContent` directly in JS without going
through `t()`. The lang toggle won't catch it.

**Tooltips:** use `data-i18n-title`. **Placeholders:** use
`data-i18n-placeholder`. Both are handled by `applyI18nToDOM`.

## Conventions

### File format

- ESM (`import`/`export`) for everything except `electron/*.cjs`
- Electron main + preload **must** be `.cjs` (Node `require` semantics)
- `package.json` at root: `"type": "module"` (omitted; `.cjs` files override)
- `plugin-api/package.json`: `"type": "module"` (explicit)

### JavaScript style

- 2-space indent
- Single quotes for strings
- Semicolons: optional, current code is mostly **without**. Match
  surrounding style in the file you're editing
- Trailing commas in multi-line arrays/objects: yes
- Comments: explain **why**, not what. Code shows what; comments
  explain the why that future-you will forget

### CSS

- Use CSS custom properties from `:root` / `body[data-theme]`
- **Every new variable** must be defined in all 7 built-in themes
  (search `body[data-theme=` in `style.css` to find them)
- Spacing: use `--space-1` through `--space-6` (4px grid)
- Avoid hex colors in component styles — use `var(--accent)` etc.

### Naming

- `state.foo` — global app state, mutable
- `STATE_FOO_KEY` — localStorage key constants
- `bus.on('domain:event', fn)` — colon-separated event namespaces
- IPC channels: kebab-case (`'list-plugins'`, `'open-plugin-dir'`)

## When you make changes — checklist

For any change, before you finish:

```
☐ Syntax check changed files
   node --check public/app.js
   node --check electron/main.cjs
   (etc, for any .js/.cjs files touched)

☐ Run parser test
   node test.js
   Expected: "12 files, 10 edges"

☐ If you touched any .md, verify links
   (CI does this automatically — see .github/workflows/ci.yml)

☐ If user-visible change, add to CHANGELOG.md
☐ If plugin API change, update plugin-api/docs/ AND types.d.ts
☐ If new CSS variable, define in all 7 themes
☐ If new IPC channel, add to BOTH electron/main.cjs AND electron/preload.cjs
☐ If new HTTP endpoint, surface in BOTH bin/fg3d.cjs AND bin/fg3d-mcp.cjs
   (otherwise CLI/AI users can't reach it). Use withMeta() in the response.
☐ If new visible UI string, add a `data-i18n` attribute (HTML) or
   `t('key')` call (JS) AND add the key to BOTH T.ko and T.en in app.js
☐ If new permission, add to BOTH plugin-loader.cjs whitelist AND plugin-host.js requirePerm()
☐ If new bus event, document in plugin-api/types.d.ts EventName union
☐ If new tool that touches a node id, call emitTrace() so the renderer
   pulses the node (live AI visualization stays consistent)
```

## Things that get newcomers (including AI) stuck

### `bus.on()` returns an unsubscribe function

```js
const off = bus.on('selection:changed', handler)
// later:
off()
```

`bus.off(event, handler)` also works. Plugins depend on this. Don't
"simplify" the return value away.

### State updates don't auto-render

There's no reactivity. After mutating `state`, you must explicitly
call the right render function (`renderContextPanel()`,
`renderFileTree()`, `requestFrame()`, etc.) OR emit a bus event that
a subscriber re-renders on.

### CSP blocks inline scripts and eval

`index.html` has a strict CSP. Don't try to inject `<script>` strings
or use `eval()`. Plugins use Blob URLs + dynamic `import()` to work
around this (see `plugin-host.js`).

### Plugin manifest `id` ≠ folder name

Plugins are matched by manifest `id`, but the folder can be named
anything. Always reference plugins by manifest id in code, not folder
name. Example: a `body[data-theme="X"]` selector uses the manifest id.

### Themes affect graph chrome only, not node colors

The 7 themes change UI panels, typography, decoration flags. They
do **not** change node colors in the graph itself — those come from
a fixed extension → color map. This is intentional. If you want
themeable node colors, that's a new feature, discuss first.

### The renderer assumes Electron OR browser dev mode

`public/backend.js` and `public/app.js` check `window.fg3d` to detect
Electron. Browser mode (via `npm run server`) shims most things but
**not all** — plugins aren't available in browser mode, for example.

When adding renderer features that touch the filesystem or plugin
system, check `window.fg3d` first and degrade gracefully.

### The 300k node ceiling is a hard cap

`public/app.js` pre-allocates Three.js InstancedMesh buffers for 300k
nodes. Adding the 300,001st silently fails. This is a deliberate
trade-off — pre-allocation avoids GC pauses during animation.

If you need to raise the cap, search for the constant near the top of
`app.js` and update the InstancedMesh constructor calls. Don't
allocate per-frame.

## Common mistakes (real ones, made before)

### Adding `bus.on(...)` without storing the unsubscribe

The listener leaks forever, multiplies on hot-reload, and corrupts state
after enough re-renders. Always store and use the returned unsubscribe.

### Adding a permission to plugin-loader but not to the renderer

The plugin loads but throws on first API call. Both files must agree
on the permission name. Same for IPC channels.

### Editing built-in theme CSS without checking the others

Adding a new CSS variable to one theme means the other six fall back
to whatever the previous theme set, producing visual glitches when
switching themes. Always update all seven.

### Reading file contents in a parser plugin

Parsers receive `(filePath, content)` directly. Don't call
`ctx.graph.readFile(filePath)` inside `parse()` — the content is
already provided, and reading again is wasted IO. The `read-files`
permission is for non-parser plugins that need to inspect contents.

### Using `setInterval` without registering it

In plugin code, intervals don't auto-cleanup when the plugin
deactivates. Store the handle and clear it in `deactivate()`:

```js
let timer
export default {
  activate(ctx) { timer = setInterval(..., 1000) },
  deactivate() { clearInterval(timer) }
}
```

## Performance notes

The animation loop runs at 60fps when the simulation is active. Things
that will tank performance:

- Allocating per-frame (use object pools)
- `console.log` inside the render loop (yes really)
- DOM reads after writes in the same frame (causes layout thrash)
- Synchronous `localStorage` access on hot paths

The current code is mostly careful about this. Don't reintroduce
allocations without measuring.

## License boundary — critical

Files inside `plugin-api/` are MIT. Files outside are BSL 1.1.

**Never copy code from outside `plugin-api/` into inside `plugin-api/`**.
If a utility is needed in both, it must originate inside `plugin-api/`
and the main app can copy from there, not vice versa.

Why: BSL → MIT directionally is fine; MIT → BSL would taint the BSL
work with conflicting attribution requirements. Authors who PR to
`plugin-api/` expect their code to remain MIT.

When in doubt about license boundary, ask before doing.

## Testing approach

There's no full test suite — just:

- `test.js` — parser smoke test on a fixture project
- `perf-test.js` — layout benchmark on synthetic graphs
- Manual testing via `npm start`

For new features, **add a fixture to `test.js`** rather than building
a heavy test infrastructure. The project values lightness over
coverage.

## When you're unsure

Default to:

1. **Read the existing code first.** This project's style is
   established; match it rather than introduce something new.
2. **Smaller diff wins.** Don't refactor surrounding code while
   adding a feature. Two PRs are better than one mixed PR.
3. **Ask in the issue.** If a design choice isn't obvious from
   reading the code, leave a comment on the issue rather than
   guessing.
4. **Preserve existing behavior** unless explicitly told to change it.
   "I improved the API" is not appreciated when an existing plugin
   breaks.

## What's NOT here

- **AI prompt templates** — those belong in your tooling config
  (`.cursorrules`, `CLAUDE.md`, etc.), not in the repo
- **Build orchestration** — see `.github/workflows/` for CI, `package.json`
  for scripts
- **Code generation** — this repo is hand-written, keep it that way

---

Last updated: 2026-05-18 — added HTTP control API, CLI, MCP server,
i18n system, AI trace visualization, summary cache, response meta
envelope. If significant patterns change, update this file too.
