# CodeSynapt

[![CI](https://img.shields.io/github/actions/workflow/status/wing1008/codesynapt/ci.yml?branch=main&label=ci)](https://github.com/wing1008/codesynapt/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](./LICENSE)
[![Commercial license available](https://img.shields.io/badge/Commercial-Available-orange.svg)](./LICENSES.md)
[![Plugin API: MIT](https://img.shields.io/badge/Plugin%20API-MIT-green.svg)](./plugin-api/LICENSE)
[![Version](https://img.shields.io/github/package-json/v/wing1008/codesynapt?label=version&color=informational)](./CHANGELOG.md)
[![Node 20|22](https://img.shields.io/badge/Node-20%20%7C%2022-339933?logo=node.js&logoColor=white)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](./docs/installation.md)
[![Tests](https://img.shields.io/badge/tests-302%20passing-brightgreen)](./tests/)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/wing1008?label=Sponsor&logo=GitHub&style=social)](https://github.com/sponsors/wing1008)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/wing1008)

> **The MCP dependency map that shows AI agents what breaks before they edit —
> no wrong edges, and unseen code flagged as candidates.**
> One call surfaces just what's affected — *without* reading the whole project
> into context — so the AI is less likely to break code it wasn't looking at,
> using far fewer tokens. Fully offline — no cloud, no re-indexing, live-updating
> (~0.4 s after a save). Ships first as an MCP server (11 `cs_*` tools: 8
> file-level + 3 symbol-level) + CLI (`cs`); an optional 3D desktop window pulses
> every node the AI touches.

## Why this exists

Coding agents (Claude Code, Cursor, Aider…) read files one at a time.
They have no project-wide map: which files matter, what imports what,
which routes match which fetch calls, what external services the code
talks to, which "v2" file is the real one vs. abandoned drafts.

`codesynapt` builds that map and exposes it three ways:

| Surface | For | Example |
|---|---|---|
| **MCP server** | AI coding agents | "Which files import `auth.js`?" → agent calls `cs_query({action:'users', id:'auth.js'})` |
| **CLI** (`cs`) | terminal users, scripts, CI | `cs external` — list every API/website your code talks to; `cs ci-diff main..HEAD` — PR blast radius as Markdown |
| **Desktop app** | visual exploration | drop folder → 3D graph with live updates; watch the AI navigate live |

All three share the same scanner: imports across JS/TS, Python, Go, Rust, Java/Kotlin, C/C++, C#, Swift, Dart, Ruby, PHP (plus Vue/Svelte components), route↔fetch matching for full-stack monorepos, external URL inventory, and dynamic-pattern detection.

## What it does well

- **No false completeness** — dynamic / DI / reflection calls are surfaced as `candidate*` + floor caveats, and blast verdicts drop to `confidence:'limited'` when the static graph can't see everything. The agent never edits on a false sense of completeness.
- **Measured, not asserted** — Layer-2 call edges: **0% wrong-edge** on an independent position oracle in-repo, **0–1.3%** across a 13-language corpus (reproduce: `node scripts/_precision_pos.mjs`; [details](./docs/measurements/2026-06-14-layer-measurement.md)). Token cost vs reading files: **~98–99.9% fewer**, 1 MCP call instead of N file reads ([benchmarks](./docs/benchmarks.md)). The blast radius you act on is measured.
- **11 `cs_*` MCP tools** (not 37 narrow ones) — 8 file-level: `cs_summary`, `cs_query`, `cs_blast`, `cs_intent`, `cs_health`, `cs_change`, `cs_trace`, `cs_ui` (each takes an `action` enum); plus 3 symbol-level: `cs_symbol_summary`, `cs_symbol_search`, `cs_symbol_explore` for the Layer-2 function-call graph. Designed so the agent picks the right one with a glance, not by scanning a wall of tool names.
- **AI-aware response envelope** — every response includes `meta: { scannedAt, tokenEstimate, totalAvailable, truncated }`. The agent budgets tokens before drilling deeper.
- **Blast radius before edit** — `cs_blast({action:'safety', id})` returns 🟢/🟡/🔴 verdict + reasons in one call; `action:'bundle'` packs the closest neighbours into a token budget so the agent reads the right context first.
- **Precision-first dependency graph** — import resolution favors precision over recall: an ambiguous edge is declined and surfaced as a *candidate* rather than guessed. JS/TS resolve via the Babel AST (with optional TypeScript-Compiler checks); Python, Ruby, PHP, Swift, Kotlin, Go, Rust, C#, C/C++ via language-native rules. For Go, C# and Swift the *import* edge is module/namespace-level (one import links the importing file to the imported unit). The function-level call graph (Layer 2) covers 13 languages — JS/TS, Python, Java, C#, Go, Rust, Kotlin, Swift, PHP, C/C++, Scala, Lua, Bash — **each gated by a committed known-answer completeness bar** (static recall, no-phantom precision, dynamic honesty), all green simultaneously in CI. Honest limit: it follows *static imports*, so autoload / DI / reflection-implicit dependencies (Rails/Zeitwerk, Spring) carry no import statement to resolve — those are surfaced as `caveat` markers, not silently dropped. **Blast counts are a floor, not a ceiling.**
- **Live updates (~0.4 s after a save)** — chokidar file-watcher + snapshot debounce; a fresh graph lands in ~0.35–0.46 s on real repos ([measured](./docs/benchmarks.md)). No re-indexing, no manual refresh, no cloud round-trip.
- **Live agent visualization** — when the desktop window is open, every MCP call pulses the touched node in 3D. You see the AI navigate.
- **Full-stack route↔fetch matching** — JS/TS, Python, Next.js file-system API routes auto-detected. Frontend `fetch('/api/billing')` linked to `app/api/billing/route.ts` automatically.
- **Headless + CI** — `cs scan`, `cs serve`, `cs ci-diff main..HEAD`, `cs ci-gate --max-blast 50`. No Electron required for CI / SSH / Docker.
- **Auto-history per file** (opt-in) — every save snapshots previous content (cap 3). Roll back via `cs_change({action:'restore'})`.
- **External URL inventory** — `cs_intent({action:'external'})` lists every API host the project calls (Stripe, OpenAI, your own backend…), grouped by domain.
- **Env / secret leak detection** — `cs_health({action:'secrets'})` flags server-only env vars accidentally used in client bundles.
- **Offline by design** — no network calls, no telemetry, no cloud sync. The whole graph lives in memory + your local `.codesynapt/` directory.
- **i18n** — Korean ↔ English toggle, persists.

## Quick start

Three install paths, pick the one that matches you.

### Path 1 — Windows `.exe` (easiest, no Node required up-front)

Download `CodeSynapt-Setup-<version>.exe` from the [Releases](https://github.com/wing1008/codesynapt/releases) page. Run the installer:

- **Auto-detects** existing Node.js. If found, uses your system Node (saves 76 MB). If not, ships Node 22 LTS bundled.
- Adds `cs` / `codesynapt` / `codesynapt-mcp` to your user `PATH` automatically (toggle "Add cs command to PATH" — checked by default).
- Installs to `%LOCALAPPDATA%\Programs\CodeSynapt\`. **Updates are clean**: installing a newer `.exe` auto-removes the old one and preserves your data under `%APPDATA%\codesynapt\`.

After install, open **a new** PowerShell:

```sh
cs --help
```

If `cs` shows usage, you're done. (Unsigned installer — Windows SmartScreen will warn "unverified publisher"; click "More info → Run anyway".)

### Path 2 — Developer / source (any OS)

```sh
git clone https://github.com/wing1008/codesynapt.git
cd codesynapt
npm install                      # full install — desktop + CLI + MCP (~700 MB w/ Electron)
npm link                         # adds cs / codesynapt / codesynapt-mcp to your PATH
npm start                        # desktop app + HTTP control API on :7707
```

### Path 3 — CLI / MCP only (no desktop, no 3D — for CI / SSH / Docker, ~30 MB)

```sh
git clone https://github.com/wing1008/codesynapt.git
cd codesynapt
npm install --omit=optional --omit=dev
npm link
cs scan .                        # one-shot
cs serve .                       # long-running HTTP daemon (no Electron)
```

`three` (3D renderer) and `ws` are `optionalDependencies`; `electron` is a devDependency. CI runners can skip the 700 MB Electron download entirely.

### CLI — `cs` command

After `.exe` install (Path 1) or `npm link` (Paths 2/3), the `cs` command is on your PATH. The Node `codesynapt` and `codesynapt-mcp` aliases also work.

#### Headless — no desktop window needed (CI / SSH / Docker)

```sh
cs scan [path] --summary               # one-shot project overview
cs scan [path] --json                  # full graph as JSON
cs serve [path] --port 7707            # long-running HTTP API daemon
cs ci-diff main..HEAD                  # PR impact report (Markdown by default)
cs ci-gate main..HEAD --max-blast 50   # CI gate, exits 1 on breach
```

#### Connected — talks to a running desktop or `cs serve` daemon at :7707

```sh
# Setup
cs ensure                              # ensure desktop is running with cwd loaded
                                       # (auto-launches if dead, swaps folder if needed, no-op otherwise)
cs init                                # one-time setup: CLAUDE.md + /codesynapt slash + mcp add hint

# Most useful first:
cs summary                             # cheap project overview (Layer 1)
cs safety src/x.ts                     # 🟢/🟡/🔴 + one-line advice
cs bundle src/x.ts --budget 8000       # pack neighbours into token budget
cs blast  src/x.ts 3                   # transitive dependents + token estimate
cs suggest                             # "what to ask the AI next" recommendations
cs preflight                           # deploy-readiness check
cs env [VAR]                           # .env declared vs used
cs secrets                             # server-only env leaked to client?
cs feature payment                     # keyword → FE/BE/shared cluster
cs url /billing                        # URL → file (Next.js/Astro/SvelteKit)
cs schema [Model]                      # DB models (Prisma/Drizzle/SQLAlchemy)
cs external                            # external APIs/websites by domain
cs deps  src/x.ts                      # what does x.ts import?
cs users src/x.ts                      # who imports x.ts?
cs find  auth                          # substring search across **file ids only** (path match)
cs search "RUNPOD_API_KEY"             # full-text **content** search (mtime LRU cache, sub-50ms when warm) — best-effort
cs ls    --limit 10                    # top 10 most-imported files
cs focus src/x.ts                      # move desktop camera (desktop only)
```

> **`cs search` caveat**: full-text search is *best-effort*. If invoked while the initial scan is still running, the endpoint returns `503 scan in progress` — retry after a couple of seconds. Under heavy event-loop pressure (large repo + fresh scan), a single search can occasionally hang; this is a known limitation tracked for future `worker_threads` refactor. `cs_query({action:'search'})` MCP returns the same payload; AI agents automatically fall back to Read+Grep on failure.

The desktop app exposes ~30 endpoints. Run `cs --help` for the full
list including history, restore, refresh, tour, timeline, trace.

> Used `git clone` (Paths 2/3) and the `cs` command isn't found? Run `npm link` inside the cloned repo — it registers `cs` / `codesynapt` / `codesynapt-mcp` / `codesynapt-server` globally.

## Hook up your AI agent

### Claude Code — recommended setup (2 commands)

```sh
cd <your-project>
cs serve .                           # start the backend FIRST (cs init snapshots it)
cs init                              # generates CLAUDE.md + installs /codesynapt slash commands
claude mcp add codesynapt codesynapt-mcp   # registers 11 cs_* tools (one-time, per OS user)
```

> `cs init` snapshots the running project into `CLAUDE.md`, so a backend
> (`cs serve .` or the desktop `npm start`) must be up first — otherwise it
> stops with a "server not reachable" hint. To install **only** the
> `/codesynapt` slash commands without a server, run `cs init --slash-only`.

That's it. Inside any Claude Code session in that project:

```
/codesynapt        ← FORCE mode: cs_* preferred for every non-trivial query/edit
/codesynapt-auto   ← AUTO mode:  cs_* only for non-trivial work (skips typos/docs)
```

**Default is OFF** — `cs_*` tools are not called until you enter a mode. `/clear` or new session resets to OFF.

The slash command's first step is `cs ensure` — it guarantees the desktop is running and the **current working directory is loaded**. Auto-launches the desktop if dead, swaps folder if a different one was loaded, no-op otherwise. One command, zero clicks.

### Manual MCP registration (any client)

If you skipped `cs init` or use Cursor/Continue/Cline:

```sh
claude mcp add codesynapt node /absolute/path/to/codesynapt/packages/core/bin/codesynapt-mcp.cjs
```

That registers 11 MCP tools (all `cs_*`): 8 intent-shaped file-level
tools plus 3 symbol-level tools (`cs_symbol_summary` / `cs_symbol_search`
/ `cs_symbol_explore`) for the Layer-2 function-call graph. In any
session, just ask project-shape questions and Claude picks the right
action automatically:

> *"이 프로젝트가 호출하는 외부 API 다 알려줘"*
> → `cs_intent({action:'external'})` → domains grouped by file caller

> *"`src/auth/session.ts` 수정하면 어떤 파일들이 영향받아?"*
> → `cs_blast({action:'safety', id:'src/auth/session.ts'})` → 🟡 CAUTION, 23 dependents, advice

> *"수정 전에 같이 봐야 할 파일 묶음 만들어줘"*
> → `cs_blast({action:'bundle', id, budget:8000})` → packed files within token budget

> *"import 안 되는 잔재 파일 찾아줘"*
> → `cs_health({action:'legacy'})` → orphan/path/filename/duplicate candidates with confidence

> *"`/billing` 화면이 어느 파일이야?"*
> → `cs_intent({action:'url', path:'/billing'})` → matched file (Next.js / Astro / SvelteKit aware)

> *"src/api/payment.ts 한 시간 전 버전으로 되돌려"*
> → `cs_change({action:'history', id})` → `cs_change({action:'restore', id, ts})`

> *"배포해도 안전한가?"*
> → `cs_health({action:'preflight'})` → undeclared env / http URLs / hub tests / leaks — overall ok|warn|fail

If the desktop app is open you'll **see** every tool call pulse the
relevant node in 3D — a live X-ray of what the agent is doing.

### Cursor / Continue / Cline / others

Same MCP server. Standard config — see [**docs/mcp-setup.md**](./docs/mcp-setup.md) for examples.

## Use cases

**1. AI-assisted refactoring without breakage.** Before changing
`src/lib/payment.ts`, ask Claude "is it safe to refactor?". Agent runs
`cs_blast({action:'safety'})` → 🟢/🟡/🔴 with reasons in one call.
Follow up with `action:'bundle'` to get the closest neighbours packed
into a token budget — the right context for the edit.

**2. CI gate for impact-risky PRs.** Add one line to your CI:
`cs ci-gate main..HEAD --max-blast 50` fails the build if a single
file changes touches >50 dependents. Or `cs ci-diff main..HEAD
--format=github-comment` to post a Markdown impact report on the PR.

**3. External API + secret audit.** `cs_intent({action:'external'})`
lists every external host (Stripe, OpenAI…), grouped by caller — for
security review, migration planning, API spend estimation.
`cs_health({action:'secrets'})` catches server-only env vars
accidentally used in client bundles.

**4. Cleaning up "v2" / dead files.**
`cs_health({action:'legacy'})` returns confidence-scored cleanup
candidates across 4 categories (orphan / path / filename / duplicate),
so you know which version is the real one before deleting.

**5. Full-stack route tracing.** codesynapt matches `fetch('/api/x')`
client calls to `app.get('/api/x', …)` server routes across JS/TS and
Python (Express, Fastify, Koa, Hono, Flask, FastAPI) — plus Next.js
file-system API routes (`app/api/*/route.ts`, `pages/api/*`)
auto-detected. The graph shows client→server lines so the AI can
answer "which UI calls this endpoint?"

**6. Watching the AI think.** Open the desktop app, start a Claude
Code session in your terminal, ask the agent to do something
non-trivial. The graph pulses every file the agent inspects + draws
a trail through its navigation path. The AI trace panel logs each
tool call live.

**7. URL → file in one query.** Designer says "the /billing screen
looks broken". `cs_intent({action:'url', path:'/billing'})` →
`src/app/(dashboard)/billing/page.tsx` (Next.js route groups + dynamic
segments handled).

**8. Onboarding a new project.** Open it in codesynapt, hit the 🧭
**Tour** button. The camera flies through entry points, top hubs, and
external API integration spots. Or ask Claude: "give me the guided
tour" → `cs_trace({action:'tour'})`.

**9. Watching project evolution.** Hit the ⏱ **Time-lapse** button.
The slider scrubs through git history — files appear at their first
commit. Press play to watch the project grow.

**10. Recovering AI-edited files.** Turn on **Auto history** in
Settings. Every save (yours or the AI's) snapshots the previous
version. Roll back from the inspector if Claude edits the wrong
thing.

## Desktop app — visual surface

Built on Electron + Three.js. Features:

- **Real-time** — drop a folder, watch the graph form in seconds; live updates as you edit
- **Scales** — 300k node smoke test runs at 50fps active / 100fps idle
- **Spherical force-directed layout** with cursor-anchored zoom (zoom-in tracks cursor; zoom-out drifts toward center like Obsidian)
- **Live AI agent visualization** — pulse + ripple + cyan-to-magenta navigation trail when MCP calls hit the graph
- **Idle auto-rotate camera** + scene heartbeat for the "alive" feel; instantly stops on user input
- **Inspector** with full-file editor + auto-save + connection badge + history panel + diff view
- **Auto file history** — opt-in, max 3 versions per file under `.codesynapt/history/`
- **Changes panel** (📝) — every file the session has modified, with one-click line-diff
- **Onboarding tour** (🧭) — auto-generated walkthrough of entry points + hubs + API integration
- **Time-lapse** (⏱) — slider replays git history; files appear at their first commit
- **i18n** — Korean ↔ English toggle, persisted
- **7 themes** — Observatory, Minimal, Terminal, Maximal, Carbon (CRT), Mono (Tokyo Night), Daylight
- **Extensible** — plugin API for themes, exporters, parsers, layouts, panels, and context actions
- **Cross-platform** — macOS (Intel + Apple Silicon), Windows, Linux
- **Private by design** — local-only HTTP control API on 127.0.0.1, no telemetry, code never leaves your machine
- **Multi-session** — attach the desktop to another Claude Code session's per-project daemon and watch *its* graph + live trace, from a left-rail session picker. The per-project daemon registry is on by default (`CS_REGISTRY=0` opts out).
- **Runtime tracing** — `cs trace run -- npm test` profiles any Node command and merges the *witnessed* call edges into the live graph (amber links in 3D); `cs trace watch -- npm run dev` does it continuously for a long-running process. Observations persist across rebuilds and expire when their files change — runtime fills exactly the dynamic half static analysis cannot see.
- **Honest accounting** — `cs symbol accounting` labels every symbol entry / reachable / possible / dead (`unexplained: 0` by construction); a dead verdict is always presented as a static floor with its caveats, never proof.

For OS-specific installation notes, see **[docs/installation.md](./docs/installation.md)**.

## Documentation

| Looking for… | Read |
|---|---|
| **MCP setup for Claude Code / Cursor / Continue** | [**docs/mcp-setup.md**](./docs/mcp-setup.md) |
| How to install on your OS | [docs/installation.md](./docs/installation.md) |
| Features and what it does | [docs/features.md](./docs/features.md) |
| Keyboard / mouse controls | [docs/controls.md](./docs/controls.md) |
| How the internals work | [docs/architecture.md](./docs/architecture.md) |
| Speed & token benchmarks (reproducible) | [docs/benchmarks.md](./docs/benchmarks.md) |
| Building a plugin or theme | [plugin-api/README.md](./plugin-api/README.md) |
| What changed in each release | [CHANGELOG.md](./CHANGELOG.md) |
| Reporting a security issue | [SECURITY.md](./SECURITY.md) |
| Getting help or asking questions | [.github/SUPPORT.md](./.github/SUPPORT.md) |
| Contributing code | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Community guidelines | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |
| AI coding agent guide (working ON codesynapt) | [AGENTS.md](./AGENTS.md) |

## License

CodeSynapt uses **dual licensing**:

- **Main app** ([LICENSE](./LICENSE)): **[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html)**
  - ✅ Free for personal, internal company, academic, and research use
  - ✅ Free to inspect, modify, and build plugins
  - ⚠️ If you modify CodeSynapt and offer it to others as a network service, your modifications must also be open-sourced under AGPL
  - 💼 **Commercial license available** for organizations that can't accept AGPL — see [LICENSES.md](./LICENSES.md)
- **Plugin API** ([plugin-api/LICENSE](./plugin-api/LICENSE)): **MIT**
  - Build and distribute plugins under any license you choose

For commercial licensing inquiries, open a [GitHub Discussion](https://github.com/wing1008/codesynapt/discussions) or DM `@wing1008`.

For a plain-language explanation of the licensing model, see **[LICENSES.md](./LICENSES.md)**.

## Support the project

CodeSynapt is built by one person ([@wing1008](https://github.com/wing1008)) in their spare time. If it saves you time, consider:

- ⭐ **Star the repo** — costs nothing, helps a lot
- 💚 **[GitHub Sponsors](https://github.com/sponsors/wing1008)** — recurring or one-time
- ☕ **[Buy me a coffee](https://buymeacoffee.com/wing1008)** — one-time tip
- 🏢 **[Commercial license](./LICENSES.md)** — if your company needs to ship CodeSynapt without AGPL obligations

Contributions in the form of bug reports, PRs, and docs improvements are also very welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.
