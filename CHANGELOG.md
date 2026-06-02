# Changelog

## 0.0.0 — initial public demo

First public demo of **CodeSynapt** — an MCP-native code dependency graph for AI agents.

### Highlights
- **3D dependency graph** desktop app (Electron + Three.js).
- **CLI** (`cs`) and **MCP server** (`cs_*` tools) so AI coding agents can query the
  graph directly — "what imports `auth.ts`?", "blast radius of changing this file?".
- **Multi-language file-dependency analysis**: JS/TS, Python, Go, Rust, C/C++,
  Java/Kotlin, Ruby, PHP, Dart, C#, Swift.
- **Token-compact blast / dependency queries** — impact summaries sized for an
  agent's context budget, with full lists available on request.
- **Dual licensed**: AGPL-3.0-or-later (main app) + Commercial; Plugin API is MIT.

> Demo release — APIs and formats may still change.
