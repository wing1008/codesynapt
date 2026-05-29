# CLAUDE.md

Project-level context for Claude Code (and other AI coding agents)
working on CodeSynapt itself.

## TL;DR

CodeSynapt is a desktop app (Electron + Three.js) + CLI + MCP server
that visualizes code dependency graphs in 3D. The killer angle is
that it exposes the graph to AI coding agents via the MCP protocol —
so an agent can ask "what files import auth.ts?" and get a precise
answer (and the desktop window pulses the touched node so the user
can watch).

## Before editing — read this

1. **[AGENTS.md](./AGENTS.md)** — hard rules, conventions, common
   mistakes, patterns the existing code follows. **Read this first.**
2. **[docs/architecture.md](./docs/architecture.md)** — how the
   internals fit together.
3. **[docs/mcp-setup.md](./docs/mcp-setup.md)** — MCP tool catalog. Note:
   the 19-tool table in that doc is the pre-0.14 layout; current is **8
   `cs_*` tools** dispatched via `{action: '...'}`. README and the slash
   command bodies (`~/.claude/commands/codesynapt.md`) have the live
   contract until that doc is rewritten.

## When you're working IN this project, you can use codesynapt ON itself

```sh
npm install
npm start             # launches the app, scans the cwd by default
```

Then from another terminal (or via the MCP integration if registered):

```sh
cs summary          # Layer-1 project overview
cs users src/app.js # who imports app.js — useful before refactoring
cs blast public/app.js 3 users   # 3-hop impact of changing app.js
```

Yes, this is a self-hosting moment. The tool helps maintain itself.

## Hard rules — must not violate

These are non-negotiable. Full rationale in `AGENTS.md`.

- 🚫 **No runtime framework** (React, Vue, Svelte…) — plain JS + event bus
- 🚫 **No network calls** in the app itself (offline by design — telemetry,
  CDN, error reporting all forbidden). The MCP server runs locally only.
- 🚫 **No localStorage without try/catch** (throws in private mode, quota)
- 🚫 **No reaching into globals from plugins** — use `ctx.*` APIs only
- 🚫 **No license boundary violations** — `plugin-api/` is MIT,
  everything else is AGPL-3.0. Don't copy MIT-licensed code into AGPL.

## When you add a new feature

Follow the checklist in `AGENTS.md` — but the most common gotchas:

- **New HTTP endpoint?** Add to `packages/core/bin/codesynapt.cjs` (CLI command) AND
  `packages/core/bin/codesynapt-mcp.cjs` (MCP tool). Wrap response with `withMeta()` so
  AI can budget tokens.
- **New UI string?** Use `data-i18n="key"` (HTML) or `t('key')` (JS),
  add the key to both `T.ko` and `T.en` in `public/app.js`.
- **New IPC channel?** Add to `electron/main.cjs` AND `electron/preload.cjs`.
- **New CSS variable?** Define in all 7 themes in `style.css`.

## License

Dual-licensed. Main app = AGPL-3.0, `plugin-api/` = MIT. See `LICENSES.md`.
