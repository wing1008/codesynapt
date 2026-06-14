---
description: CodeSynapt AUTO mode — auto-launch desktop + load cwd, then call cs_* only for non-trivial work
---

**Step 1 (do this immediately, via Bash):**

```
cs ensure
```

This makes sure the CodeSynapt desktop app is running with the current working directory loaded. No-op if already loaded; otherwise auto-launches or swaps. Wait for the `✅` line (up to 60s).

**Step 2:** From this point on in the session, the CodeSynapt MCP server is available. **Do not call cs_* tools for trivial work** — but DO call them automatically when the work is non-trivial (per the table below). When in doubt, lean toward NOT calling.

**Skip cs_* entirely for:**
- Typos, comment-only changes, formatting, single literal swaps
- README / docs / CHANGELOG edits
- Single-line bug fixes in a leaf file
- General conversation / Q&A / "explain X" questions
- Brand-new files the user just created this session

**Call cs_* automatically when:**

| Situation | Tool to call |
|---|---|
| First message about an unfamiliar project | `cs_summary({action:'project'})` once (~300 tokens) |
| **Impact / removal / refactor questions** ("X 비활성화하면?", "X 제거해도 돼?", "리팩토링 영향", "what breaks if I remove X", "is it safe to delete X") | **MUST `cs_blast({action:'safety', id: X})` FIRST**. This is the #1 use case for cs_*. Read+Grep for impact is wrong tool. |
| Refactor / rename / signature change / removed export / multi-file edit | `cs_blast({action:'safety', id})` first |
| Safety 🟡 or 🔴 | `cs_blast({action:'bundle', id, budget:8000})` |
| 🔴 RISKY verdict | STOP, surface to user, ask for confirmation |
| "Find the X feature / Y screen / where is the X page" | `cs_intent({action:'feature'|'url'|'schema'})` (NOT grep) |
| "Who uses X?" / "X 쓰는 곳" / "Is X used anywhere?" | `cs_query({action:'users', id})` (NOT grep) |
| Editing a file ≥ 100 LOC or known hub | prefer `cs_change({action:'edit', id, find, replace})` |
| Before suggesting a significant commit/deploy | `cs_health({action:'preflight'})` |
| User asks "what next?" / 뭐 할까 / open-ended | `cs_health({action:'suggest', top:5})` |
| Korean user | add `locale: 'ko'` to safety/preflight/suggest |

If the user later types `/clear` or starts a new session, this mode resets. To re-enter, call `/codesynapt-auto` again. For stricter mode (cs_* preferred for everything), call `/codesynapt` instead.
