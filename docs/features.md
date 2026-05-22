# Features

A complete tour of what filegraph3d does.

- [The graph](#the-graph)
- [File tree](#file-tree)
- [Search and filter](#search-and-filter)
- [Active sets and pipelines](#active-sets-and-pipelines)
- [Minimap](#minimap)
- [Inspector](#inspector) — now with edit + auto-save + history + diff
- [AI agent integration](#ai-agent-integration) — MCP server + CLI
- [Live AI agent trace](#live-ai-agent-trace) — watch the AI navigate
- [Blast radius prediction](#blast-radius-prediction)
- [External URL inventory](#external-url-inventory)
- [Time-lapse](#time-lapse) — git history replay
- [Guided tour](#guided-tour) — onboarding
- [Auto file history](#auto-file-history) — opt-in safety net
- [Session changes](#session-changes) — what was edited this session
- [Language toggle](#language-toggle) — Korean ↔ English
- [Themes](#themes)
- [Export](#export)
- [Settings](#settings)
- [Performance](#performance)

> The features below the inspector were added in the 2026-05-18 session
> as the project repositioned around AI-coding workflows. See
> [CHANGELOG.md](../CHANGELOG.md) for the full list.

## The graph

The main canvas shows every file as a sphere, every import as an edge.

- **Color** = file extension (`.js` = yellow, `.tsx` = blue, `.py` =
  steel, etc). The palette is fixed by language and not user-themeable
  in v0.11.
- **Size** = proportional to the file's mass (lines × log(deps + 1)).
  Large hub files visibly bigger.
- **Position** = force-directed layout in 3D. Settles into clusters
  reflecting your import structure.

The simulation runs at 60 FPS while active, drops to ~2 FPS once
settled to save battery. Camera orbit / zoom / pan are mouse-driven
(see [controls.md](./controls.md)).

## File tree

The left panel shows your project as a folder tree. Click any file
to select it in the graph; click a folder to filter the graph to
that subtree.

- ★ next to a file marks it as part of your **active set** (see below)
- Folder counts (e.g., `★3`) tell you how many starred files are
  inside, even if collapsed
- `Esc` clears any active filter

## Search and filter

The search bar at the top supports three modes:

| Mode | Example | Matches |
|---|---|---|
| **Plain** (`aA`) | `parser` | Substring match in file path |
| **Glob** (`*?`) | `src/**/*.test.ts` | Standard glob patterns |
| **Regex** (`.*`) | `^src/(?:api|core)/` | Full regular expression |

Cycle modes with the button next to the search box. Search has two
behaviors:

- **Highlight** (default): non-matches dim, matches glow
- **Hide**: non-matches disappear from the graph entirely

Toggle this in Settings → Search.

Press `/` or `Ctrl+F` from anywhere to focus the search box.

## Active sets and pipelines

**The killer feature for AI-assisted workflows.** Conventional
"dead code detection" tools assume newer = real and `.old.` = dead.
AI coding inverts this — the `.old.` file is often the real production
code while the AI's "improved" version doesn't actually work.

So filegraph3d lets you **declare what's really live** instead of
guessing.

### Starring individual files

Click the ☆ next to any file in the tree, or click the **★ Mark as
active** button in the context panel. The file becomes part of your
active set. Non-active files dim in the graph (or hide entirely,
your choice).

### Pipelines

For organizing groups of related files:

1. Click the `+` button in the Pipelines panel (left bottom)
2. Name the pipeline (e.g., "Production auth flow")
3. Click ★ on any file → "Add to pipeline" → pick your pipeline
4. Toggle pipelines on/off independently

You can have multiple pipelines and switch between them — useful for
comparing "what I'm working on now" vs "the test runner setup" vs
"legacy LTX inference path", etc.

### Modes

| Mode | Effect |
|---|---|
| **off** | Active set ignored — everything shown normally |
| **dim** | Non-active files visible but at low opacity |
| **hide** | Non-active files invisible |

Cycle with the ◐ button in the Pipelines panel.

Active sets are saved per-folder in localStorage — they survive across
sessions.

## Minimap

Top-right panel showing the whole graph in 2D from above. Click
anywhere to recenter the main camera on that location. Useful for
graphs too large to comfortably navigate in 3D.

Toggle visibility with `M` or the panel's `−` button.

## Inspector

**Double-click** a node (or hit `Enter` after selecting) to open the
inspector. It fills the entire canvas area for distraction-free
inspection:

- File path, extension, size, line count, mass
- **Connection badge** — 🟢 `connected` (in:N out:M) / 🟡 `no incoming`
  (entry point or unused) / 🟠 `orphan` (no connections) — helps you
  spot abandoned versions at a glance
- Full lists of incoming and outgoing edges (click any to jump there)
- Active-set status and pipeline memberships
- Buttons to open the file in your default editor, reveal in
  Finder/Explorer
- **history** — last 3 auto-snapshots if enabled (View / Restore buttons)
- **content** — full file in an editable textarea; auto-saves to disk
  500 ms after you stop typing
- Single click on a node still just selects (no inspector). Use
  double-click or `Enter` to open.

## AI agent integration

Three surfaces share one scanner: the desktop window, a CLI (`fg3d`),
and an MCP server (`fg3d-mcp`) for Claude Code / Cursor / Continue.

See [**docs/mcp-setup.md**](./mcp-setup.md) for setup. Quick recap:

```sh
claude mcp add filegraph3d node /abs/path/bin/codesynapt-mcp.cjs
```

Then ask Claude things like "이 프로젝트가 호출하는 외부 API 다 알려줘"
or "src/auth/session.ts 수정하면 어떤 파일 영향받아?" and it picks the
right tool automatically.

19 MCP tools / 19 CLI commands cover: project summary, per-node detail,
content read, dependency closure / blast radius, external URLs, find /
focus / open, history list / restore, session changes / diff, guided
tour, timeline, force refresh.

Every response carries a `meta` envelope with `scannedAt`,
`tokenEstimate`, and pagination info so the agent budgets tokens and
detects staleness.

## Live AI agent trace

When the desktop window is open and an MCP/CLI client calls a tool
that touches a file, you see it happen:

- The targeted node pulses with a tool-color tint (cyan for read,
  yellow for focus, red for write, etc.)
- A 700 ms ripple bursts out from the node
- A cyan→magenta line traces the agent's navigation path through the
  last ~32 visited nodes
- The **AI trace overlay** panel (bottom-right) logs each operation
  with timestamp + tool type + file id

This makes "what is the AI doing?" answerable at a glance instead of
scrolling text logs.

## Blast radius prediction

`fg3d blast <id> [depth]` or the `fg3d_blast_radius` MCP tool returns:

- Total files affected (BFS through dependents)
- Total LOC + size
- Token estimate (cost to read them all)
- Category breakdown (tests / source / config / docs / other)
- Per-hop breakdown (`hop 1`, `hop 2`, …)

Use it before any non-trivial refactor — the agent (or you) can
decide scope before changing anything. When called interactively, the
affected nodes flash magenta in the graph.

## External URL inventory

`fg3d external` or `fg3d_external_urls` lists every external host the
project calls (HTTP / HTTPS / WebSocket / Secure WebSocket), grouped
by domain, with caller file paths. Useful for:

- Security review ("what services have my data?")
- Migration planning ("swap Stripe for Toss — where are the call sites?")
- Cost estimation ("which APIs am I hitting?")

Detection combines structured `apiCalls` (fetch/axios/got/ky/SWR/
React Query/requests/httpx/aiohttp) with a generic URL grep, so URLs
in `.env.example`, comments, and hardcoded constants all show up.

## Time-lapse

Hit the ⏱ button in the topbar. filegraph3d reads
`git log --diff-filter=A --name-only` to build a per-file "first
introduced at" timeline. A slider appears at the bottom of the
canvas:

- Drag the slider to scrub through history; nodes that didn't exist
  yet at the chosen commit are hidden
- Hit **Play** to watch the project grow from first commit to now
  over ~25 seconds
- **Reset** restores the full graph

Requires a git repo. First call takes a few seconds for big projects
(spawns `git log`); subsequent calls are cached.

## Guided tour

Hit the 🧭 button or run `fg3d tour`. Heuristic-selected stops:

1. **Entry points** matching `^(?:src/)?(?:index|main|app|server|cli|bin)\.`
2. **Top hubs** by incoming-import count (the most "important" files)
3. **Top external-API integration files** (where the project talks to
   the outside world)

The camera flies to each stop in sequence with a short rationale.
Prev / Next / Close buttons in the overlay.

Pair with `fg3d_tour` from an MCP client so an AI can narrate to a
new team member.

## Auto file history

Opt-in via **Settings → file history → 자동 히스토리 활성화**.
Default is OFF.

When enabled, every save (yours via the inspector, the AI's via
`fg3d_restore`, or any external editor detected by chokidar) writes
a timestamped snapshot under `.filegraph3d/history/<encoded-path>/<ts>.snap`.
Max 3 snapshots per file — oldest auto-deleted.

Two ways to roll back:
- Inspector → history section → click **Restore** next to a timestamp
- `fg3d restore <id> <ts>` from the CLI, or `fg3d_restore` from MCP

Snapshots are skipped if the new content is byte-identical to the
latest snapshot (defeats chokidar re-fires).

## Session changes

Hit the 📝 button in the topbar. Lists every file modified since the
app started, with:

- Timestamp of last change
- Change count
- LOC delta and size delta (red if shrunk)
- `+` button to expand a line-by-line LCS diff from the **first seen**
  content to the **current** content

The first-seen content is captured the first time chokidar detects a
change to that file — so if you want diffs from the original baseline,
keep auto-history enabled instead.

Auto-refreshes every 3 seconds while the panel is open.

## Language toggle

The `EN` / `한` button in the topbar switches the entire UI between
English and Korean. The choice persists across sessions
(`localStorage:filegraph3d:lang`).

If a string isn't translating, that's a bug — see AGENTS.md for the
`data-i18n` / `t('key')` conventions.

## Themes

Settings → Appearance offers seven built-in themes:

- **Observatory** — brutalist + corner brackets (default)
- **Minimal** — Obsidian-inspired, quiet and rounded
- **Terminal** — Linear/VS Code-inspired, monochrome
- **Maximal** — bold gradients and saturated accents
- **Carbon** — true black + CRT phosphor green
- **Mono** — Tokyo Night warmth
- **Daylight** — full light mode

You can also install **theme plugins** from the community — see the
[theme plugin guide](../plugin-api/docs/types/theme.md).

## Export

Settings → Export offers:

- **PNG snapshot** — current camera angle as a high-DPI image
- **JSON** — the raw graph data (nodes, edges) for use elsewhere
- **GEXF / GraphML** — for import into Gephi or other graph tools

Plugins can add custom export formats (Mermaid, GraphViz DOT, etc.).
See the [exporter plugin guide](../plugin-api/docs/types/exporter.md).

## Settings

Most settings are toggles in the right panel:

- **Backend**: Auto / GPU / CPU (force CPU if GPU is doing other work)
- **Focus depth**: how many hops the focus-ripple emphasis travels
- **Show all connected**: ignore depth limit when focusing a node
- **Cluster by folder**: weak attraction between files in the same dir
- **Search syntax / mode**: plain / glob / regex; highlight / hide
- **Theme**: 7 built-in + plugins

All settings save to localStorage and restore on next launch.

## Performance

Designed to handle large monorepos. Steady-state benchmarks:

| Nodes | Layout simulation | Settled idle |
|---|---|---|
| 1,000 | 414 fps | 9,300 fps |
| 10,000 | 52 fps | 4,200 fps |
| 30,000 | 31 fps | 422 fps |
| 100,000 | 17 fps | 299 fps |
| 300,000 | 7 fps | 103 fps |

Beyond 100k nodes, expect the initial layout to take a few seconds
before things settle. Once settled, frame rates are dominated by
camera movement, not graph size.

For graphs larger than 300k, consider using the active set to focus
on the subset you care about — the dimmed/hidden remainder doesn't
cost render time.

## What's not included

A few common requests intentionally not supported:

- **Automatic dead code detection** — replaced by active sets (see above)
- **Editing files in-app** — read-only by design; use your editor
- **Cloud sync** — nothing leaves your machine
- **Team collaboration** — local tool; export and share files manually
- **Time-travel / git history overlay** — on the roadmap, not in v0.11

For things filegraph3d doesn't do, see if a [plugin](../plugin-api/README.md)
could.
