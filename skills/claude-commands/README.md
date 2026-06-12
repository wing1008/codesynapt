# Claude Code slash commands (optional)

These add `/codesynapt` and `/codesynapt-auto` to Claude Code — a convenience
wrapper that auto-runs `cs ensure` and tells Claude to prefer the `cs_*` tools.
They are OPTIONAL: the MCP tools work without them.

## Install
Copy both files into your Claude Code commands dir:

```bash
# macOS / Linux
cp codesynapt.md codesynapt-auto.md ~/.claude/commands/

# Windows (PowerShell)
Copy-Item codesynapt.md, codesynapt-auto.md $env:USERPROFILE\.claude\commands\
```

Then in a Claude Code session: `/codesynapt` (force) or `/codesynapt-auto`.

Prerequisite: the MCP server is connected — `claude mcp add -s user codesynapt -- cs mcp`.
