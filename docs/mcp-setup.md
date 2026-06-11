# MCP setup — using CodeSynapt from AI coding agents

CodeSynapt ships a Model Context Protocol (MCP) server at
`packages/core/bin/codesynapt-mcp.cjs`. Once registered with an MCP-capable
client (Claude Code, Cursor, Continue, Cline, custom clients), the client
gets **11 `cs_*` tools** (8 file-level + 3 symbol-level). Most take an
`action` field that dispatches to a sub-operation — so the surface stays
small while behavior stays rich.

## Prerequisites

1. **Nothing to pre-start — the MCP server auto-starts its own backend.** On the
   first tool call it either attaches to a CodeSynapt daemon/desktop already
   running for this project, or spawns a headless backend itself (scanning
   `CS_ROOT` or the cwd) — so `cs_*` tools work out of the box with no daemon and
   no desktop. The **desktop app is optional** and only adds the live 3D view.
   (`cs ensure` can pre-warm a shared daemon; `CS_PORT` pins a specific one.)
2. **A folder loaded.** Open via the welcome screen / `File → Open Folder…`,
   pass `--root` to `cs serve`, or set `CS_INITIAL_ROOT` before launching
   the desktop. `/codesynapt` runs `cs ensure` which auto-loads the cwd.
3. **Recommended UX**: register the MCP server once with `claude mcp add …`,
   then enter one of the two opt-in modes (`/codesynapt` for FORCE or
   `/codesynapt-auto` for AUTO) per session. **Default behavior is OFF** —
   `cs_*` tools are not called until you enter a mode.

## The tools

8 file-level tools (`cs_summary`, `cs_query`, `cs_blast`, `cs_intent`,
`cs_health`, `cs_change`, `cs_trace`, `cs_ui`) operate on the Layer-1
file/import graph. 3 symbol-level tools (`cs_symbol_summary`,
`cs_symbol_search`, `cs_symbol_explore`) operate on the Layer-2
function-call (symbol) graph — see the [Symbol-level tools](#symbol-level-tools-layer-2)
section at the end.

### `cs_summary` — project shape (cheap, call first)

| Action | What it returns |
|---|---|
| `project` | File/edge counts, top folders, top hubs, ext mix, orphan count, confidence distribution (~300 tokens, Layer 1) |
| `health` | Is the desktop alive, current root, history flag |
| `packages` | Monorepo packages: file counts + cross-package edges |
| `package_graph` | Package-to-package edge list (visual overview) |
| `package_detail` | Files + declared deps + cross-pkg edges for one package — requires `name` |

**WHEN**: once at the start of a session on an unfamiliar project.
**SKIP**: if the user is chatting or touching a single small file.

### `cs_query` — code exploration (cheap per file)

| Action | What it returns |
|---|---|
| `list` | Paginated graph. Filters: `ext`, `minMass`. Sort default `mass:desc`. Big repos: pass `limit`. |
| `node` | One file's metadata + imports + importedBy — requires `id` |
| `deps` | What this file imports — requires `id` |
| `users` | What imports this file (= blast surface) — requires `id` |
| `find` | Substring search across file ids — requires `q` |
| `read` | File content up to 2 MB — requires `id` |

**WHEN**: "who uses X?", "what does X import?", "find files with `auth`",
locate or read one file. Use this instead of grep when you need the graph.

### `cs_blast` — impact analysis (the headline tool)

| Action | What it returns |
|---|---|
| `safety` | 🟢/🟡/🔴 verdict + reasons + one-line advice. Pass `deep: true` for the full impacted list. Optional `locale: 'ko'`. |
| `bundle` | Pack closest neighbours within token `budget` (default 8000) — call this when safety is 🟡/🔴 to load the right context. |
| `radius` | Transitive BFS with token estimate. `dir: 'users'\|'deps'`, `depth: 1-10` (default 3). Deeper than safety. |

**WHEN**: before any NON-TRIVIAL edit — refactor, signature change, removed
export, multi-file work, hub file edits. Also for the user's "if I remove X,
what breaks?" / "is it safe to delete X?" questions.
**SKIP**: typos / comments / single-literal changes / docs.
**HARD RULE**: 🔴 RISKY → STOP, surface to the user, don't auto-edit. 🟡 CAUTION → call `bundle` first.

### `cs_intent` — human → file mapping

| Action | What it returns |
|---|---|
| `feature` | Keyword → frontend/backend/shared file clusters — requires `keyword` |
| `url` | URL path → file (Next.js app/pages, Astro, SvelteKit, Nuxt, SvelteKit). Without `path` returns all routes. |
| `schema` | DB models (Prisma / Drizzle / SQLAlchemy). With `model` returns definition + usage. |
| `external` | Every external URL the project calls, grouped by domain |

**WHEN**: the user describes something by *domain language* rather than a
file path. "Where's the billing feature?", "Which file handles `/api/auth`?",
"What does the `User` model touch?", "What APIs do we call?"

### `cs_health` — diagnostics + next-step recommendations

| Action | What it returns |
|---|---|
| `env` | Env vars: declared (`.env*`) vs used (cross-reference). Pass `var` to focus on one. |
| `secrets` | Server-only env leaked into frontend bundles. **RULE**: fail at preflight, surface to user. |
| `vendors` | Third-party folder auto-detect → suggests `.codesynaptignore` entries |
| `preflight` | Comprehensive deploy-readiness. **RULE**: don't suggest commit/deploy if `overall=fail`. Optional `locale: 'ko'`. |
| `suggest` | Rule-based "next thing to ask the AI to fix" (high/medium/low). Best opening when stuck. Pass `top` (default 10). |
| `legacy` | Orphan / path / filename / duplicate cleanup candidates with confidence scores. Pass `type` to filter. |

**WHEN**:
- `preflight`: before suggesting commit/deploy on a SIGNIFICANT change.
- `suggest`: user is open-ended ("what next?") or you finished a task with attention to spare.
- `env`/`secrets`/`vendors`/`legacy`: on-demand diagnosis.

### `cs_change` — write/edit with snapshot + pulse

| Action | What it does |
|---|---|
| `write` | Overwrite file entirely — `id`, `content`. For full rewrites or small files. |
| `edit` | Precise find→replace — `id`, `find`, `replace`, `replaceAll`. 404=find not found, 409=ambiguous. |
| `refresh` | Force re-parse one file — `id`. Use after external tool modified the file. |
| `history` | List auto-snapshots — `id` |
| `restore` | Roll a file back to a snapshot — `id`, `ts` |

**WHEN**: editing a file ≥ 100 LOC, or a hub file, or anything `cs_blast`
called caution/risky. Why prefer over your own Edit tool when non-trivial:
auto-snapshots + audit log + green pulse on the 3D node + AI trace overlay.
**SKIP**: typos / comments / formatting / brand-new files you just created
this session — your own Edit tool is fine there.
**PREREQ**: non-trivial → call `cs_blast({action:'safety'})` first; if 🔴 don't proceed.

### `cs_trace` — AI session traces + project history

| Action | What it returns |
|---|---|
| `log` | Current session events (tool, id, ts). Filters: `limit`, `tool`. |
| `stats` | Top files / tool breakdown / duration for current session |
| `sessions` | Past sessions on disk (`.codesynapt/traces`) |
| `session` | One past session detail — requires `sessionId` |
| `clear` | Start fresh session (previous archived) |
| `changes` | Files modified this session (current vs first-seen size/loc) |
| `diff` | First-seen → current diff for one file — requires `id` |
| `tour` | Heuristic guided tour: entry points + hubs + API hotspots |
| `timeline` | Git history — when each tracked file first appeared |

**WHEN**: reviewing what an AI did (audit), onboarding a new file, finding
recently-touched files, or replaying a past session.

### `cs_ui` — desktop reaction (visual side effect)

| Action | What it does |
|---|---|
| `focus` | Move the 3D camera to a node and highlight it — requires `id` |
| `open` | Open the inspector panel for a node — requires `id` |

**WHEN**: you want the human watching the desktop to *see* what you're
talking about. Optional but useful for demos / pairing.

## Symbol-level tools (Layer-2)

The three `cs_symbol_*` tools work on the **function-call (symbol) graph**
— individual functions, classes, methods and the `call` edges between them
— rather than the file/import graph the eight tools above use. They mirror
the most-used trio of a symbol-level code-graph tool. File-mode tools stay
available; pick whichever matches the question.

### `cs_symbol_summary` — symbol-mode overview (call first for symbol work)

No arguments for the default summary. Returns total symbol count, breakdown
by kind (function / class / struct / …) and by edge kind — including honesty
counters: `dynamicSiteCount` (call sites static analysis cannot even name),
`declineReasons` (stdlib-correct vs genuinely-unresolved declines) and
`byEdgeKind.observed` (runtime-witnessed edges merged by `cs trace run` /
`cs trace watch` — these are REAL calls a run proved, including dynamic ones
static analysis cannot see). The first call after a project is loaded
triggers the symbol scan (it is built lazily).

Pass `{ "accounting": true }` for the completeness partition instead: every
symbol labelled entry / reachable / possible / dead with `unexplained: 0` —
use it for "what code is unused?" questions, and treat `dead` as a STATIC
FLOOR (its caveats ride along), never proof.

**WHEN**: once at the start of a function-level investigation.

### `cs_symbol_search` — symbol search + graph navigation

| Action | What it returns |
|---|---|
| `find` | Symbols whose name contains `q` (case-insensitive). Optional `limit` (default 50). |
| `callers` | Symbols that call this symbol `id` |
| `callees` | Symbols that this symbol `id` calls |
| `node` | One symbol with its source body — requires `id` |

**WHEN**: after `cs_symbol_summary`, when the answer needs a specific
function/class — "who calls `handleAuth`?", "what does `parseConfig` call?".

### `cs_symbol_explore` — one-shot architecture answer

Takes a natural-language question `q` (optional `budget`, default 8000
tokens for snippet bodies). Returns symbols grouped by lifecycle:
`exact_match` (literal name match), `active` (called a lot — live
production), `entry` (exported main / handler / route / CLI bin),
`semantic` (pulled in by embedding similarity), and
`deprecated / legacy / test / aux / orphan` (usually skip). Each entry
carries `inDegree`, `outDegree`, classification, `ageDays`, and `semSim`
so you can filter without a second call.

**WHEN**: a broad architecture question where you want one call to surface
the relevant functions ranked by how live they are.

> **Coverage**: the symbol graph is built for all supported languages via
> per-language AST parsers (babel for JS/TS, tree-sitter for the validated
> languages). `cs_blast({action:'function'})` (function-level blast) is
> documented as JS/TS + Python only; the `cs_symbol_*` tools surface the
> symbol graph for whatever languages parsed. See
> [docs/architecture.md](./architecture.md) for how Layer-2 is built and
> the optional type-checker sub-engines that enrich it.

## Claude Code

One-time registration:

```sh
claude mcp add codesynapt node /absolute/path/to/codesynapt/packages/core/bin/codesynapt-mcp.cjs
```

Then enter a mode per session:

```
/codesynapt        — FORCE: prefer cs_* for every non-trivial query/edit
/codesynapt-auto   — AUTO: only on non-trivial work; skips trivial
```

Once in a mode, just chat normally. The slash command's first instruction is
`cs ensure`, which guarantees the desktop is running with the cwd loaded
(auto-launches if dead, swaps folder if loaded a different one, no-op
otherwise). After that the agent reaches for the right `cs_*` tool based on
the question shape.

To verify the MCP server is wired up:

```sh
claude mcp list
# you should see "codesynapt - ✓ Connected"
```

## Cursor

Same MCP config format. Add to `~/.cursor/mcp.json` or per-workspace
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "codesynapt": {
      "command": "node",
      "args": ["/absolute/path/to/codesynapt/packages/core/bin/codesynapt-mcp.cjs"]
    }
  }
}
```

Restart Cursor. The 11 `cs_*` tools appear under the MCP tools section.

## Continue / Cline / others

Any MCP-compliant client. Same pattern: command `node`, args pointing at
`packages/core/bin/codesynapt-mcp.cjs`. The server speaks newline-delimited
JSON-RPC 2.0 over stdio per the MCP spec.

For Streamable HTTP transport (cloud-hosted clients, Anthropic API remote
MCP), launch with `--http [--port 7708]`:

```sh
codesynapt-mcp --http --port 7708
# clients POST JSON-RPC to http://127.0.0.1:7708/mcp
```

## Custom port

If 7707 is taken, set `CS_PORT` (legacy alias `FG3D_PORT`):

```sh
CS_PORT=8088 npm start                              # in the codesynapt dir
CS_PORT=8088 node packages/core/bin/codesynapt-mcp.cjs   # if testing manually
```

Claude Code registration with env:

```sh
claude mcp add codesynapt node /abs/path/packages/core/bin/codesynapt-mcp.cjs -e CS_PORT=8088
```

## Verifying

Stdio smoke test (paste these into stdin of the server):

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cs_summary","arguments":{"action":"health"}}}
```

Expected: three JSON responses on stdout, the third containing your current
root folder and file count.

## Recommended call pattern for agents

1. **Open with `cs_summary({action:'project'})`** (~300 tokens). File count,
   top folders/hubs, orphan count, ext mix. 90% of "what is this project?"
   questions answer here without further calls.
2. **For impact questions** ("can I remove X?", "what breaks if I refactor
   X?"), call `cs_blast({action:'safety', id})` FIRST. Not grep, not read.
   If 🟡/🔴 → `cs_blast({action:'bundle', id, budget:8000})` for context.
   If 🔴 → STOP and ask the user before any edit.
3. **For "where does X live"** questions, prefer `cs_intent` over grep:
   `feature` for keywords, `url` for routes, `schema` for DB models,
   `external` for outgoing APIs.
4. **For specific file inspection**, `cs_query({action:'node'|'deps'|'users', id})`.
5. **For non-trivial edits**, prefer `cs_change({action:'edit'|'write', id, …})`
   over your own Edit tool — auto-snapshots + 3D pulse + AI trace.
6. **Before suggesting a commit/deploy on a significant change**,
   `cs_health({action:'preflight'})`. Fail-open is wrong here.
7. **For the user "what next?"**, `cs_health({action:'suggest', top:5})`.
8. **For Korean users**, pass `locale: 'ko'` on `safety` / `preflight` /
   `suggest` so messages come back in Korean.
9. **Skip cs_* for trivial work**: typos, comments, formatting, single
   literal changes, README/docs, brand-new files this session, general Q&A.
   Calling MCP for these is pure overhead.

## Response meta envelope

Every response includes a `meta` field:

```json
{
  "...": "actual payload...",
  "meta": {
    "scannedAt":     1779071827925,   // ms epoch — when the graph was last rebuilt
    "serverTime":    1779071855023,   // ms epoch — now
    "tokenEstimate": 317,             // approximate tokens for this response (chars/4)
    "totalAvailable": 585,            // list endpoints only
    "returned": 50,                   // list endpoints only
    "offset": 0, "limit": 50,
    "sort": "mass:desc",              // /graph only
    "truncated": true,                // if more results exist past limit
    "contentHash": "sha256:…"         // /file/:id and /node/:id only — verify freshness
  }
}
```

Agents should check `meta.scannedAt`: if older than expected, call
`cs_change({action:'refresh', id})` on critical files. `contentHash` lets
you compare against your own Read result to confirm freshness.

## Limitations / gotchas

- **No manual backend needed — it auto-starts.** The MCP server attaches to a
  running daemon/desktop for the project or spawns a headless one on first use;
  the desktop is optional (3D view only). `cs ensure` can pre-warm a shared
  daemon, and `CS_PORT` pins a specific backend.
- **One folder at a time.** Whatever's loaded in the desktop is what the
  agent sees. `POST /load` (via `cs ensure <path>`) swaps it atomically.
- **Auto-history is opt-in.** Toggle it in Settings → file history before
  relying on `cs_change({action:'history'|'restore'})`. Without it,
  `cs_change({action:'edit'|'write'})` still works but no snapshot is taken.
- **Renderer IPC bridge** is exposed at **`window.codesynapt`** (canonical).
  **`window.fg3d`** is a legacy alias that points to the same object — old code
  reading `window.fg3d.*` keeps working. Use `window.codesynapt.*` in new code.

## How it works (one paragraph)

The Electron app (or headless `cs serve`) runs a tiny HTTP server on
`127.0.0.1:7707` exposing read endpoints (`/summary`, `/graph`, `/node/:id`,
`/external` …) and control endpoints (`POST /focus/:id`, `POST /open/:id`,
`POST /load`, `POST /change/:id`). The CLI
(`packages/core/bin/codesynapt.cjs`) is a thin HTTP client over that API.
The MCP server (`packages/core/bin/codesynapt-mcp.cjs`) is also a thin
client, but speaks newline-delimited JSON-RPC 2.0 over stdio (or HTTP via
`--http`) per the MCP spec. ~150 lines of hand-rolled JSON-RPC, no external
dependencies.
