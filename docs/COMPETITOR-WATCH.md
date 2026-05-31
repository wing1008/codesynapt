# Competitor watch — what to monitor, why, how

CodeSynapt's slowest gap to close is "1+ year of real-user
fine-tuning". codegraph, Sourcegraph, Cursor, Aider etc. publish
release notes / changelogs / issue threads; reading them weekly
lets us learn from their failure modes without waiting for our own
user base to surface the same bugs.

Run `node scripts/competitor-watch.mjs` to fetch latest releases
and issues from every repo below into one Markdown digest.

## Repos to watch

| Repo | Why | Cadence |
|------|-----|---------|
| **[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)** | Closest direct competitor. Their parser fixes, MCP-tool changes, and `codegraph_explore` ranking tweaks are directly informative. | Weekly |
| **[sourcegraph/sourcegraph](https://github.com/sourcegraph/sourcegraph)** | LSIF/SCIP indexer changes — gold standard for language coverage. Most language fixes apply to us too. | Bi-weekly |
| **[sourcegraph/scip](https://github.com/sourcegraph/scip)** | The actual symbol-index format; cross-language norms we should respect. | Monthly |
| **[continuedev/continue](https://github.com/continuedev/continue)** | Open-source AI coding agent. Their codebase-indexing module is similar in spirit. | Monthly |
| **[Aider-AI/aider](https://github.com/Aider-AI/aider)** | Repo-map (symbol summary) refinements — closest to our `cs_symbol_summary`. | Monthly |
| **[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)** | MCP spec / reference servers — convention drift here changes how we expose tools. | Monthly |
| **[anthropics/claude-code](https://github.com/anthropics/claude-code)** | The primary client — flag changes (`-p`, `--mcp-config`, `--strict-mcp-config`) directly affect our harness. | Weekly |
| **[tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter)** | Parser library + WASM ABI. Grammar updates often surface as bugs we'd otherwise blame on ourselves. | Bi-weekly |

## What to look for in each

### codegraph
- New `codegraph_*` MCP tools → consider adding `cs_symbol_*` equivalent
- Parser fixes per language → check if we have the same bug
- Benchmark methodology changes → keep our `run-bench.mjs` aligned
- `install` command additions for new agent (Codex, Kiro, etc.)

### Sourcegraph
- New language SCIP indexers → tree-sitter parity check
- Symbol kind taxonomy changes
- Search-API token-budget patterns

### Continue / Aider
- Codebase-indexing chunk size + retrieval strategy
- Embedding vs structural-index trade-off discussions

### Claude Code
- `claude -p` JSON shape changes (we parse `total_cost_usd`, `usage`, etc.)
- New flags worth using in our agent benchmark
- `--strict-mcp-config` behaviour drift

### tree-sitter
- WASM ABI bumps (we pin `web-tree-sitter@0.20.8` to match
  `tree-sitter-wasms@0.1.13`)
- New official grammars we could enroll

## When to act vs note

| Finding | Action |
|---------|--------|
| Other tool ships a feature we don't have | Add to docs/ROADMAP.md, decide on inclusion |
| Other tool fixes a bug we silently share | File our own issue with the same symptom; fix in next sprint |
| Other tool removes a feature | Note as evidence the feature didn't have demand |
| New benchmark methodology | Update our bench harness so we stay comparable |
| New AI-agent client adoption | Add to `codesynapt install` target list (when that ships) |

## Cadence

- **Weekly (Monday morning):** codegraph, claude-code
- **Bi-weekly:** Sourcegraph, tree-sitter
- **Monthly:** the rest

Each pass should take ~30 minutes; the script does the fetching.
Add findings as `## YYYY-MM-DD` entries at the top of
`docs/competitor-log.md` (created on first run).

## Privacy / etiquette

- Only public release notes, public issues, public READMEs.
- Don't open issues / PRs in their repos to ask questions our docs
  could answer.
- Cite the source commit/issue when we adopt an idea — this is the
  decent thing to do and protects us if a feature later turns out
  to be patent-pending.
