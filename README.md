# filegraph3d

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](./LICENSE)
[![Plugin API: MIT](https://img.shields.io/badge/Plugin%20API-MIT-green.svg)](./plugin-api/LICENSE)
[![Version](https://img.shields.io/github/package-json/v/YOUR_USER/filegraph3d?label=version&color=informational)](./CHANGELOG.md)
[![Node ≥20](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](./docs/installation.md)

> **The dependency graph your AI coding agent should be reading.**
> A 3D code-graph visualizer + CLI + MCP server, in one package.
> Same scanner, three surfaces: a desktop window for humans, a CLI for
> terminals, and an MCP server so Claude Code / Cursor / any MCP client
> can query the graph (and watch the result) as a first-class tool.

## Why this exists

Coding agents (Claude Code, Cursor, Aider…) read files one at a time.
They have no project-wide map: which files matter, what imports what,
which routes match which fetch calls, what external services the code
talks to, which "v2" file is the real one vs. abandoned drafts.

`filegraph3d` builds that map and exposes it three ways:

| Surface | For | Example |
|---|---|---|
| **MCP server** | AI coding agents | "Which files import `auth.js`?" → agent calls `fg3d_get_users` |
| **CLI** (`fg3d`) | terminal users, scripts, CI | `fg3d external` — list every API/website your code talks to |
| **Desktop app** | visual exploration | drop folder → 3D graph with live updates; watch the AI navigate live |

All three share the same scanner: imports across JS/TS/Vue/Svelte/Python/Go/Rust/Ruby/PHP/C/C++, plus route↔fetch matching for full-stack monorepos, plus external URL inventory, plus dynamic-pattern detection.

## What it does well

- **AI-aware tool design** — every response includes `meta: { scannedAt, tokenEstimate, totalAvailable, truncated }`. The agent can decide if data is fresh enough and budget tokens before drilling deeper.
- **Layer-1 summary** (`fg3d_summary`, ~300 tokens) — agents call this first to get project shape (file count, top hubs, orphans, external services, dynamic-pattern count) before any narrow query.
- **Connection-aware orphan detection** — files with no incoming imports are flagged so AI doesn't edit abandoned versions.
- **Blast radius prediction** — `fg3d_blast_radius` returns BFS impact + token-cost estimate so the agent can scope a refactor before starting.
- **Live agent visualization** — when the desktop window is open, every MCP call pulses the touched node in 3D + draws a trail through visited files. You can literally see the AI navigate the codebase.
- **Auto-history per file** (opt-in) — every save snapshots the previous content (cap 3). Roll back from the inspector or via `fg3d_restore`.
- **External URL inventory** — `fg3d external` lists every API host the project calls (Stripe, OpenAI, your own backend…), grouped by domain.
- **Time-lapse + onboarding tour** — replay project's git history at the timeline slider; auto-generated guided tour of entry points and hubs.
- **i18n** — toggle Korean ↔ English with one button (`EN` / `한`); persists across sessions.

## Quick start

```sh
git clone https://github.com/YOUR_USER/filegraph3d.git
cd filegraph3d && npm install
npm start          # desktop app + HTTP control API on :7707
```

In another terminal:

```sh
# CLI — 19 commands. Most useful first:
node bin/fg3d.cjs health                        # is the app running? which folder?
node bin/fg3d.cjs summary                       # cheap project overview (Layer 1)
node bin/fg3d.cjs ls --limit 10                 # top 10 most-imported files
node bin/fg3d.cjs deps src/x.ts                 # what does x.ts import?
node bin/fg3d.cjs users src/x.ts                # who imports x.ts? (blast radius)
node bin/fg3d.cjs blast src/x.ts 3              # 3-hop dependents + token estimate
node bin/fg3d.cjs external                      # external APIs/websites by domain
node bin/fg3d.cjs find auth                     # substring search
node bin/fg3d.cjs focus src/x.ts                # move desktop camera to node
node bin/fg3d.cjs open  src/x.ts                # open inspector with file content
node bin/fg3d.cjs changes                       # files modified this session
node bin/fg3d.cjs diff src/x.ts                 # first-seen → now line diff
node bin/fg3d.cjs tour                          # suggested guided tour
node bin/fg3d.cjs timeline                      # git history (file birth times)
node bin/fg3d.cjs history src/x.ts              # auto-history snapshots
node bin/fg3d.cjs restore src/x.ts <ts>         # restore from snapshot
node bin/fg3d.cjs refresh src/x.ts              # force re-scan one file
node bin/fg3d.cjs show src/x.ts                 # node detail + meta
node bin/fg3d.cjs read src/x.ts                 # file content
```

Make `fg3d` globally available:

```sh
npm link        # adds fg3d / fg3d-mcp / filegraph3d-server to PATH
```

## Hook up your AI agent

### Claude Code (one-time)

```sh
claude mcp add filegraph3d node /absolute/path/to/filegraph3d/bin/fg3d-mcp.cjs
```

That registers 19 MCP tools (all `fg3d_*`). In any session, just ask
project-shape questions and Claude picks the right tool automatically:

> *"이 프로젝트가 호출하는 외부 API 다 알려줘"*
> → `fg3d_external_urls` → returns domains grouped by file caller

> *"`src/auth/session.ts` 수정하면 어떤 파일들이 영향받아?"*
> → `fg3d_blast_radius` → 23 files, est. 9.5k tokens to read all

> *"import 안 되는 잔재 파일 찾아줘"*
> → `fg3d_summary` (sees `orphanCount: 12`) → `fg3d_list_nodes` filtered by `minMass=0`

> *"src/api/payment.ts 한 시간 전 버전으로 되돌려"*
> → `fg3d_history` → `fg3d_restore` with the matching timestamp

If the desktop app is open you'll **see** every tool call pulse the
relevant node in 3D — a live X-ray of what the agent is doing.

### Cursor / Continue / Cline / others

Same MCP server. Standard config — see [**docs/mcp-setup.md**](./docs/mcp-setup.md) for examples.

## Use cases

**1. AI-assisted refactoring without breakage.** Before changing
`src/lib/payment.ts`, ask Claude "blast radius". Agent runs
`fg3d_blast_radius` → tells you "23 files affected, ~9.5k tokens, 12
are tests". You decide scope before any code changes.

**2. External API audit.** `fg3d external` lists every external host
the project calls. Useful for security review, migration planning
(e.g. "swap Stripe → Toss"), or estimating monthly API spend.

**3. Cleaning up "v2" files.** Open the desktop app. Files in the
inspector get a 🟠 `orphan` / 🟡 `no incoming` / 🟢 `connected` badge
based on actual import graph — so you know which version is the real
one before you delete.

**4. Full-stack route tracing.** filegraph3d matches `fetch('/api/x')`
client calls to `app.get('/api/x', …)` server routes across JS/TS and
Python (Express, Fastify, Koa, Hono, Flask, FastAPI). The graph shows
client→server lines so the AI can answer "which UI calls this
endpoint?"

**5. Watching the AI think.** Open the desktop app, start a Claude
Code session in your terminal, ask the agent to do something
non-trivial. The graph pulses every file the agent inspects + draws
a trail through its navigation path. The AI trace panel logs each
tool call live.

**6. Onboarding a new project.** Open it in filegraph3d, hit the 🧭
**Tour** button. The camera flies through entry points, top hubs, and
external API integration spots. Or ask Claude: "give me the guided
tour" → calls `fg3d_tour`.

**7. Watching project evolution.** Hit the ⏱ **Time-lapse** button.
The slider scrubs through git history — files appear at their first
commit. Press play to watch the project grow over 25 seconds. Pairs
well with screen recordings for `r/dataisbeautiful`.

**8. Recovering AI-edited files.** Turn on **Auto history** in
Settings. Every save (yours or the AI's) snapshots the previous
version. Roll back from the inspector if Claude edits the wrong
thing.

## Desktop app — visual surface

![screenshot placeholder — add screenshot.png here]

Built on Electron + Three.js. Scales to 100k+ files. Features:

- **Real-time** — drop a folder, watch the graph form in seconds; live updates as you edit
- **Scales** — 300k node smoke test runs at 50fps active / 100fps idle
- **Spherical force-directed layout** with cursor-anchored zoom (zoom-in tracks cursor; zoom-out drifts toward center like Obsidian)
- **Live AI agent visualization** — pulse + ripple + cyan-to-magenta navigation trail when MCP calls hit the graph
- **Idle auto-rotate camera** + scene heartbeat for the "alive" feel; instantly stops on user input
- **Inspector** with full-file editor + auto-save + connection badge + history panel + diff view
- **Auto file history** — opt-in, max 3 versions per file under `.filegraph3d/history/`
- **Changes panel** (📝) — every file the session has modified, with one-click line-diff
- **Onboarding tour** (🧭) — auto-generated walkthrough of entry points + hubs + API integration
- **Time-lapse** (⏱) — slider replays git history; files appear at their first commit
- **i18n** — Korean ↔ English toggle, persisted
- **7 themes** — Observatory, Minimal, Terminal, Maximal, Carbon (CRT), Mono (Tokyo Night), Daylight
- **Extensible** — plugin API for themes, exporters, parsers, layouts, panels, and context actions
- **Cross-platform** — macOS (Intel + Apple Silicon), Windows, Linux
- **Private by design** — local-only HTTP control API on 127.0.0.1, no telemetry, code never leaves your machine

For OS-specific installation notes, see **[docs/installation.md](./docs/installation.md)**.

## Documentation

| Looking for… | Read |
|---|---|
| **MCP setup for Claude Code / Cursor / Continue** | [**docs/mcp-setup.md**](./docs/mcp-setup.md) |
| How to install on your OS | [docs/installation.md](./docs/installation.md) |
| Features and what it does | [docs/features.md](./docs/features.md) |
| Keyboard / mouse controls | [docs/controls.md](./docs/controls.md) |
| How the internals work | [docs/architecture.md](./docs/architecture.md) |
| Building a plugin or theme | [plugin-api/README.md](./plugin-api/README.md) |
| What changed in each release | [CHANGELOG.md](./CHANGELOG.md) |
| Reporting a security issue | [SECURITY.md](./SECURITY.md) |
| Getting help or asking questions | [.github/SUPPORT.md](./.github/SUPPORT.md) |
| Contributing code | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Community guidelines | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |
| AI coding agent guide (working ON filegraph3d) | [AGENTS.md](./AGENTS.md) |

## License

filegraph3d uses **dual licensing**:

- **Main app** ([LICENSE](./LICENSE)): [Business Source License 1.1](https://mariadb.com/bsl-faq-adopting/)
  - ✅ Free for personal, internal, academic, and research use
  - ✅ Free to inspect, modify, and build plugins
  - ⛔ Commercial redistribution requires a license
  - 📅 Auto-converts to Apache 2.0 on **2030-05-14**
- **Plugin API** ([plugin-api/LICENSE](./plugin-api/LICENSE)): **MIT**
  - Build and distribute plugins under any license you choose

For commercial licensing or other arrangements, contact `[YOUR_EMAIL]`.

For a plain-language explanation of the licensing model, see
**[LICENSES.md](./LICENSES.md)**.
