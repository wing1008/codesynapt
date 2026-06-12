---
description: CodeSynapt FORCE mode — auto-launch desktop, load cwd, prefer cs_* MCP tools for every non-trivial query/edit
---

**Step 1 (do this immediately, via Bash):**

```
cs ensure
```

This makes sure the CodeSynapt desktop app is running with the current working directory loaded. It is a no-op if the desktop is already loaded with the same folder; otherwise it auto-launches or swaps. Wait for it to print `✅` (up to 60s on first launch).

**Step 2:** From this point on in the session, treat CodeSynapt as the primary code-intelligence backend. Before edits, queries, or "what does this code do" style questions, prefer the cs_* MCP tools over reading raw files or running shell commands.

**Step 3:** call `cs_summary({action:'project'})` once now to load the project shape (~300 tokens).

**For the rest of the session, follow these rules:**

| When | Tool |
|---|---|
| **Impact analysis** — user says "비활성화", "제거", "지워", "리팩토링", "안전", "영향", "범위", "깨지나", "쓰는 곳", "disable", "remove", "delete", "refactor", "safe to", "impact", "affected", "blast" | **MUST `cs_blast({action:'safety', id})` FIRST** — do NOT answer impact questions via grep/read alone. cs_blast is exactly for this. |
| About to edit a file ≥ 100 LOC, hub file, or refactor | `cs_blast({action:'safety', id})` first |
| Safety 🟡 or 🔴 | `cs_blast({action:'bundle', id, budget:8000})` to pack context |
| 🔴 RISKY verdict | STOP, surface to user, ask for confirmation |
| "Find the X feature / Y screen / where is the X page" | `cs_intent({action:'feature'|'url'|'schema'})` (NOT grep) |
| Dependency questions ("who uses X?", "X 쓰는 곳", "X 참조하는") | `cs_query({action:'users'|'deps', id})` (NOT grep) |
| Editing non-trivial files | prefer `cs_change({action:'edit', id, find, replace})` over your own Edit tool (auto-snapshots + 3D pulse) |
| Before suggesting a significant commit/deploy | `cs_health({action:'preflight'})` |
| User asks "what next?" / 뭐 할까 | `cs_health({action:'suggest', top:5})` |
| Korean user | add `locale: 'ko'` to safety/preflight/suggest |

**Hard rule for impact questions**: if the user asks "if I remove/disable/refactor X, what breaks?" — the answer comes from `cs_blast({action:'safety', id: X})`. Read+Grep is the fallback, NOT the first move. Doing impact analysis without cs_blast in FORCE mode is a bug.

**Skip cs_* for trivial work**: typos, comment-only changes, formatting, single-literal swaps, README/docs edits, brand-new files in this session, general conversation, or "explain X" questions.

If the user later types `/clear` or starts a new session, this mode resets. To re-enter, call `/codesynapt` again.
