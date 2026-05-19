# MCP setup — using filegraph3d from AI coding agents

filegraph3d ships a Model Context Protocol (MCP) server at
`bin/fg3d-mcp.cjs`. Once registered with an MCP-capable client (Claude
Code, Cursor, Continue, Cline, custom clients), the client gets 19
tools that read and control the running filegraph3d app.

## Prerequisites

1. **filegraph3d desktop app must be running.** The MCP server is a thin
   bridge to the Electron app's localhost:7707 control API. If the app
   isn't open, every tool call returns `ECONNREFUSED`.
2. **A folder loaded in the app.** Open a folder via the welcome screen
   or `File → Open Folder…` before asking the agent to query it.

## Tools exposed

### Project shape (call first, cheap)

| Tool | What it does |
|---|---|
| `fg3d_health` | Current root folder, file/edge counts, history toggle state |
| `fg3d_summary` | **Layer-1 overview (~300 tokens)** — file/edge counts, top folders, top hubs, ext mix, orphan count, dynamic-pattern files, external services. Call before any narrow query. |

### Node queries (cheap, per file)

| Tool | What it does |
|---|---|
| `fg3d_get_node` | Detail for one file: ext, LOC, size, imports, importedBy, `hasDynamicResolution`, `dynamicPatterns` |
| `fg3d_get_deps` | What this file imports |
| `fg3d_get_users` | What imports this file (direct dependents) |
| `fg3d_read_file` | Read file content (up to 2 MB) |
| `fg3d_find` | Substring search over file ids |

### Reasoning helpers

| Tool | What it does |
|---|---|
| `fg3d_blast_radius` | BFS impact of editing a file: `{ totalFiles, totalLoc, tokenEstimate, categories, byDepth }`. Pass `direction: 'users'` for dependents (default) or `'deps'` for closure. |
| `fg3d_external_urls` | Every external API / website / WebSocket host the project calls, grouped by domain |
| `fg3d_session_changes` | Files modified this session (any source: AI, you, external editor) |
| `fg3d_session_diff` | First-seen vs current line-by-line diff for one file |
| `fg3d_tour` | Suggested entry-points + hubs + API integration stops for onboarding |
| `fg3d_timeline` | Git history — when each file first appeared |

### UI control (desktop app reacts visually)

| Tool | What it does |
|---|---|
| `fg3d_focus` | Move the desktop camera to a node (node pulses) |
| `fg3d_open` | Open the inspector for a file (content + history + diff visible) |

### History / mutations

| Tool | What it does |
|---|---|
| `fg3d_history` | List auto-history snapshots (max 3 per file, opt-in) |
| `fg3d_restore` | Roll a file back to a snapshot |

### Staleness control

| Tool | What it does |
|---|---|
| `fg3d_refresh` | Force re-scan one file (use before high-stakes decisions; ms-fast). All responses also carry `meta.scannedAt` so the agent can self-check freshness. |

### Bulk query (use with care)

| Tool | What it does |
|---|---|
| `fg3d_list_nodes` | Full graph (or filtered + paginated). Pass `limit`/`offset`/`ext`/`minMass`/`sort`. **Default sort is `mass:desc`** so even `limit: 10` returns the 10 most-imported files. |

## Claude Code

One-time registration:

```sh
claude mcp add filegraph3d node /absolute/path/to/filegraph3d/bin/fg3d-mcp.cjs
```

Then in any session, just ask the agent questions that involve
project-wide structure:

> "이 프로젝트가 호출하는 외부 API 다 알려줘"
> "`src/auth/session.ts` 수정하면 어떤 파일들이 영향받아?"
> "import 안 되는 잔재 파일 찾아서 목록 줘"
> "`src/api/payment.ts` 한 시간 전 버전으로 되돌려"

Claude Code picks the right tool automatically. The desktop window (if
visible) reacts — camera moves to focused nodes, inspector opens for
file inspections — so you can watch the agent navigate.

To verify it's wired up:

```sh
claude mcp list
# you should see "filegraph3d" in the list
```

## Cursor

Cursor uses the same MCP config format. Add to your
`~/.cursor/mcp.json` (or per-workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "filegraph3d": {
      "command": "node",
      "args": ["/absolute/path/to/filegraph3d/bin/fg3d-mcp.cjs"]
    }
  }
}
```

Restart Cursor. The tools appear under the MCP tools section in chat.

## Continue / Cline / others

Any MCP-compliant client. Same pattern: command `node`, args pointing
at `bin/fg3d-mcp.cjs`. The server speaks JSON-RPC 2.0 over stdio per
the MCP spec (no transport selection needed).

## Custom port

If port 7707 is taken, set `FG3D_PORT` for both Electron and the MCP
server:

```sh
FG3D_PORT=8088 npm start                    # in the filegraph3d dir
FG3D_PORT=8088 node bin/fg3d-mcp.cjs        # if testing manually
```

For Claude Code registration, set the env in the registration:

```sh
claude mcp add filegraph3d node /abs/path/bin/fg3d-mcp.cjs -e FG3D_PORT=8088
```

## Verifying

Quick stdio smoke test (paste these into stdin of the server):

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fg3d_health","arguments":{}}}
```

Expected: three JSON responses on stdout, the third containing your
current root folder and file count.

## Recommended call pattern for agents

The tool descriptions push agents toward this hierarchy, but worth
making it explicit:

1. **Start with `fg3d_summary`** (~300 tokens). Tells you fileCount,
   top folders/hubs, orphan count, dynamic-pattern count, external
   domains. 90% of the time this answers the question without any
   further calls.
2. **Drill via `fg3d_get_node` / `fg3d_get_deps` / `fg3d_get_users`**
   for specific files. Each is small + per-file.
3. **For "what if I change X?"** use `fg3d_blast_radius` — it returns
   the token cost of reading the entire impacted set, so the agent
   can decide before committing.
4. **Before high-stakes mutations** (delete, large refactor) call
   `fg3d_refresh(id)` to guarantee fresh data. Otherwise trust the
   `meta.scannedAt` timestamp.
5. **Use `fg3d_list_nodes` last**, with explicit `limit` + `sort`
   + filter. Bare `fg3d_list_nodes()` on a 1000-file project costs
   ~50K tokens — the agent should rarely need that.

## Response meta envelope

Every response includes a `meta` field:

```json
{
  "...": "actual payload...",
  "meta": {
    "scannedAt":   1779071827925,  // ms epoch — when the graph was last rebuilt
    "serverTime":  1779071855023,  // ms epoch — now
    "tokenEstimate": 317,          // approximate tokens for this response (chars/4)
    "totalAvailable": 585,         // list endpoints only
    "returned": 50,                // list endpoints only
    "offset": 0, "limit": 50,
    "sort": "mass:desc",           // /graph only
    "truncated": true              // if more results exist past limit
  }
}
```

Agents should check `meta.scannedAt`: if older than expected, call
`fg3d_refresh` on critical files.

## Limitations / gotchas

- **The app must be running.** This is by design — the running app is
  the source of truth for the graph (live updates as files change).
  Headless CLI/MCP mode (one-shot scan without UI) is on the roadmap.
- **One folder at a time.** The control API exposes whatever folder is
  loaded in the app. Switching folders in the UI updates what the
  agent sees.
- **No write tools yet** other than `fg3d_restore`. Agents read the
  graph and control the UI but don't mutate files. Use Claude Code's
  native `Edit`/`Write` for file changes — filegraph3d will pick up
  the changes via its file watcher and re-emit the graph.
- **Auto-history is opt-in.** Toggle it on in the app's Settings panel
  before relying on `fg3d_history` / `fg3d_restore`.

## How it works (one paragraph)

The Electron app runs a tiny HTTP server on `127.0.0.1:7707` exposing
read endpoints (`/graph`, `/node/:id`, `/external` …) and a few
control endpoints (`POST /focus/:id`, `POST /open/:id`,
`POST /restore/:id?ts=`). Control endpoints relay through `ipcMain →
webContents.send` to the renderer, where the React-less HTML/Three.js
app listens for `control:focus` / `control:open` events and reacts.
The CLI (`bin/fg3d.cjs`) is a thin wrapper around that HTTP API. The
MCP server (`bin/fg3d-mcp.cjs`) is also a thin wrapper, but speaks
newline-delimited JSON-RPC 2.0 on stdio per the MCP spec — no external
dependencies, ~150 lines of hand-rolled JSON-RPC.
