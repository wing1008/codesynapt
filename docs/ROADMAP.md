# Roadmap — winning a niche next to codegraph

Internal planning doc. Not user-facing. Lays out the 8-week path to
shipping CodeSynapt as a real competitor to `@colbymchenry/codegraph`
in the AI-coding-agent space.

## Honest competitive picture (2026-05-31)

Where we win today:

- **Indexing speed**: 3–79× faster on the six-repo bench. In-memory,
  no SQLite write.
- **Query latency**: 0–4 ms vs codegraph's ~300 ms.
- **Live 3D visualization + AI trace pulses**: codegraph has no UI.
- **Blast-radius file graph**: codegraph's `impact` is symbol-only;
  we already paint the file-level blast radius in 3D.

Where they win today:

- **Symbol parsing accuracy**: 30–94 % of codegraph's symbol count
  on the bench (Kotlin/Swift call edges are the weakest). They've
  spent a year fine-tuning tree-sitter queries.
- **Expression-level granularity**: every identifier is a node in
  codegraph; we only emit declarations.
- **Agent benchmark numbers**: their "25 % cheaper / 62 % fewer
  tool calls" headline is a published, reproducible figure. We
  haven't measured agent end-to-end yet.
- **Auto-install across agents**: `codegraph install` registers the
  MCP server in Claude Code / Cursor / Codex / opencode / Kiro /
  Hermes / Gemini / Antigravity in one command. Ours is manual.

Direct accuracy-on-symbol-questions parity is not a fight we win
short-term. Winning means **defending the speed/visual moat** while
**closing the accuracy gap enough that we don't lose on either
axis**, then **finally measuring agent end-to-end** to back the
positioning with real numbers.

## Phases

### Phase 1 — sharpen what we already win (Week 1)

| Task | Outcome |
|------|---------|
| README/landing demo GIF: 3D graph forming live | Visual moat made visible to first-time readers |
| Live-trace screencast: AI agent edits a file, node pulses | The "wow" demo nobody else can ship |
| Interactive blast-radius GIF on click | Differentiator against `codegraph impact` text dump |
| `/symbol/explore` Hybrid response (top 3 body, rest signatures) | First-call response ≤ codegraph's ≈ 1.5 k tokens |
| `codesynapt serve` headless mode (no electron required) | Enter the CI / agent-only market |

### Phase 2 — close the parsing gap (Weeks 3–4, **start now**)

| Task | Target |
|------|--------|
| Kotlin / Swift `call_expression` query tuning (more wrapper node types) | Edge coverage 50 % → 80 % vs codegraph |
| Cross-file resolver: feed file-mode imports into symbol resolver | Same-name collisions resolve correctly across files |
| Reference scoring: de-dup + prefer same-class / same-module callees | Fewer noise edges, better explore ranking |
| Optional: expression-level node extraction | Symbol count parity (5+ days of work — likely defer) |

### Phase 3 — agent benchmark with real numbers (Week 2)

Needs `ANTHROPIC_API_KEY`. Re-run the codegraph methodology:

```
claude -p "<question>" --strict-mcp-config --mcp-config <cfg>
```

- 6 repos × 2 arms (WITH/WITHOUT) × 4 runs, median reported.
- Cost (`total_cost_usd`), tokens, time, tool calls, file reads, grep.
- Estimated ≈ $33, 1.5 h wall-clock.

Result paths:

| Outcome | Marketing line |
|---------|----------------|
| CodeSynapt cheaper | "Faster, cheaper, visual" — clean win |
| Roughly equal | "Equal accuracy + 10× faster indexing + 3D" |
| codegraph cheaper | Loop back into Phase 2 with the failing question categories |

### Phase 4 — distribution (Week 5)

| Task | Outcome |
|------|---------|
| `codesynapt install` — auto-register MCP into supported agents | Onboarding parity with codegraph |
| Split npm package: `codesynapt` (CLI + headless server) vs `codesynapt-desktop` (electron) | Headless users don't drag the electron download |
| Product Hunt + Hacker News launch posts | Distribution |
| GitHub Sponsors / Buy Me a Coffee already on README — add usage telemetry opt-in for funnel data | Funding |

### Weeks 6–8 — feedback loop

Real user data. Iterate on the gaps Phase 3 surfaces. Ship dot
releases.

## Today's working order

1. **Phase 2 first** (user's call, 2026-05-31) — close the parsing gap
   before any benchmark or marketing pass so we're not measuring a
   weaker version.
   - 2-A: Kotlin / Swift call wrapper nodes (a few hours).
   - 2-B: Cross-file resolver via file-mode imports (half a day).
   - 2-C: Reference scoring tweaks (an hour).
   - Re-run `symbol-bench.mjs`; commit; push.
2. Then Phase 1 visual / demo work.
3. Then Phase 3 once a key is available.

## What we are not doing

- We are **not** rewriting Symbol mode to use the codegraph node
  model. Different node granularity is a design choice, not a bug.
- We are **not** persisting symbols to SQLite. The in-memory speed
  is the moat — losing it loses the fight.
- We are **not** chasing every language codegraph supports. The
  current 7 (JS / TS / Python / Go / Rust / Java / Kotlin / Swift)
  cover the bench plus most of what users actually load.

## Open questions to revisit

- Is "agent token cost" or "agent first-token latency" the more
  marketable metric? Decide after Phase 3.
- Should the desktop app ever be hidden when running headlessly via
  `codesynapt serve`, or remain optional viewer? Currently both.
- How aggressively should we deprecate file-mode tools as agents
  shift to symbol mode? Keep both indefinitely until usage data says
  otherwise.
