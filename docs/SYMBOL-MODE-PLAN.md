# Symbol-mode plan

A second indexing/query mode that runs alongside today's file-graph
mode. File mode stays unchanged — it's CodeSynapt's strength (fast,
in-memory, drives the 3D visualisation). Symbol mode adds the
function/class/struct granularity needed to compete with codegraph
on agent queries.

## Why a second mode (not a replacement)

| | File mode (today) | Symbol mode (new) |
|---|---|---|
| Node | a file | a symbol (function/class/struct/interface) |
| Edge | file → file (import / require) | symbol → symbol (call / extends / implements) |
| Indexing speed | 0.3–3.7 s / repo (6-repo bench) | expected 5–50 s (10× cost — same as codegraph) |
| Storage | 0 (in-memory) | in-memory (we deliberately don't replicate codegraph's SQLite — relies on cs scan speed) |
| Drives 3D view | yes | no (text/MCP only) |
| Best for | live editing, blast radius, hub overview, visual exploration | callers/callees, "who calls Foo.bar", agent context |

Treating them as separate modes (not a rewrite of file mode) means:
- File mode keeps its speed/visual edge for the things it's already
  good at.
- Symbol mode gets to grow at its own pace (per-language) without
  destabilising the file graph.
- Both can be queried in one MCP session — an agent can ask
  `cs_summary` (file overview) and `cs_symbol_explore` (symbol drill-in)
  in sequence.

## Endpoint layout

File-mode endpoints (unchanged):
```
GET  /health   /summary   /find?q=   /deps/:id   /users/:id   /blast/:id
POST /load
```

New symbol-mode endpoints (`/symbol/*` prefix):
```
GET  /symbol/summary              project-wide symbol counts + kind mix
GET  /symbol/find?q=name          search by symbol name
GET  /symbol/callers/:id          symbols that call this one
GET  /symbol/callees/:id          symbols this one calls
GET  /symbol/node/:id             one symbol's source + signature + doc
GET  /symbol/explore?q=<text>     one-shot answer — relevant symbols + code
POST /symbol/scan                 force a (re)scan in symbol mode
```

Symbol indexing is **lazy by default** — `POST /load` only does the
file scan. The first `/symbol/*` call (or `POST /symbol/scan`) builds
the symbol graph on top. Agents that don't ask symbol questions pay
no extra cost.

## Data model

```js
SymbolNode {
  id:        string,    // `<file>#<name>@<line>`  (stable across renames? No — see notes)
  name:      string,    // 'handleRequest'
  qualifiedName: string,// 'RouterGroup.handleRequest'
  kind:      'function' | 'method' | 'class' | 'struct' | 'interface'
           | 'enum' | 'const' | 'type',
  file:      string,    // file-mode id (links symbol-mode → file-mode)
  startLine: number,
  endLine:   number,
  signature: string,    // 'func (g *RouterGroup) handle(httpMethod string) IRoutes'
  doc:       string,    // leading comment / docstring, if any
  exported:  boolean,
}

SymbolEdge {
  source: SymbolNode.id,
  target: SymbolNode.id,
  kind:   'call' | 'extends' | 'implements' | 'returns' | 'param-type',
  line:   number,        // where the reference is in source.file
}
```

Notes:
- IDs include line numbers — they shift when code above changes, but
  for an in-memory rebuild that's fine (we don't persist IDs).
- `qualifiedName` lets us resolve `User.save()` against `User.update()`
  in the same class without ambiguity.
- Edges always source from "where the reference appears in code".
  `kind: 'call'` includes both function calls and method calls.

## Per-language parser plan

Stage 1 (JS/TS) and Stage 2 (others) are wired through the same
interface: each parser exports `extractSymbols(content, fileId)` and
`extractReferences(content, fileId, symbolIndex)`.

| Stage | Language | Parser | Notes |
|-------|----------|--------|-------|
| 1 | JavaScript / TypeScript | `@babel/parser` (already a dep) | full AST. Method calls resolved via simple type inference (class instance → class methods). Imports give us cross-file symbol resolution for free. |
| 2 | Python | Built-in regex over `def `, `class `, `async def`. Calls resolved by name matching within the same module + tracked imports. Stretch: `python3 -c "import ast …"` shellout for accuracy. | works on `.py` and `.ipynb` (extract from cells). |
| 2 | Go | Regex over `func ([…]Receiver) Name(`, `type X struct/interface`. Calls resolved within package + via import paths (re-uses go.mod logic from file mode). | |
| 2 | Rust | Regex over `fn `, `impl X`, `struct/enum/trait X`. Generic params stripped. Calls resolved via `use` chains (re-uses Rust resolver from file mode). | |
| 2 | Java / Kotlin | Regex over `public/private/static T name(`. Inner classes handled by tracking brace depth. | accuracy 70% on heavy generics — see Stage 3. |
| 2 | Swift | Regex over `func `, `class `, `struct `, `enum `, `protocol `. | similar caveat. |
| 3 | All | tree-sitter (`web-tree-sitter@0.20.8` + `tree-sitter-wasms`) | exact AST, no regex. ✅ **shipped** — toggle with `CS_SYMBOL_PARSER=regex` to fall back. Kotlin & Swift `call_expression` queries still need fine-tuning (low edge counts on okhttp/alamofire). |

## Reference (call-graph) resolution

For Stage 1 (JS/TS) we lean on Babel's `traverse` to track scope:

```js
traverse(ast, {
  CallExpression(path) {
    const callee = resolveCallee(path)
    if (callee) edges.push({ source: enclosingFn(path), target: callee.id, kind: 'call', line: path.node.loc.start.line })
  },
  ClassDeclaration(path) {
    if (path.node.superClass) edges.push({...})
  },
})
```

For Stage 2 regex-based parsers we do best-effort name resolution:
1. Build a global index `{ name → [SymbolNode] }` after symbol extraction.
2. For each line in each file, regex `\b<name>\s*\(` to find calls.
3. Disambiguate by file-mode imports + same-class scope.

False positives are tolerable — codegraph also misses some. We measure
and document accuracy on the bench repos.

## `/symbol/explore` — the headline endpoint

Mirrors codegraph's `context` shape:

```json
GET /symbol/explore?q=How%20does%20gin%20route%20requests%20through%20its%20middleware%20chain%3F
{
  "query": "How does gin route requests through its middleware chain?",
  "entryPoints": [
    { "id": "routergroup.go#RouterGroup@55", "name": "RouterGroup", "kind": "struct", "file": "routergroup.go", "line": 55 }
  ],
  "relatedSymbols": [...],          // by name match + neighbourhood (1–2 hop)
  "snippets": [
    { "id": "...", "source": "type RouterGroup struct { …", "line": 55 }
  ],
  "meta": { "tokenEstimate": 620, "totalSymbols": 12 }
}
```

Selection logic:
1. Tokenise query → keywords (drop stopwords).
2. Score each symbol on (name match + qualifiedName match + doc match).
3. Pick top-N (default N=8, budget-aware).
4. Pull source between `startLine`–`endLine` for each chosen symbol
   (clamped to ~40 lines/symbol so big files don't blow the budget).
5. Optionally include 1-hop neighbours (callers + callees) of top
   entry points.

## Mode interaction with file mode

- File mode tracks `scanner.files`. Each `SymbolNode.file` references
  a file-mode `id`, so `/symbol/find` can pivot back to file-mode's
  `/users/:id` etc. by reading `node.file`.
- `POST /load` always runs the file scan first. Symbol scan is on-demand.
- Cache invalidation on project swap also resets symbol indexes —
  add `_symbolCache = { version: -1, data: null }` to the list
  cleared in `startScanner()`.

## MCP tool surface

Add three new tools (small surface, matches codegraph's most-used three):

```
cs_symbol_search({ action: 'find' | 'callers' | 'callees' | 'node', q?, id? })
cs_symbol_explore({ q, budget?: 8000 })
cs_symbol_summary({})
```

Existing `cs_*` tools (cs_summary, cs_query, cs_blast) keep working
unchanged. Agents can use either mode or both.

## Acceptance criteria

For Stage 1 (JS/TS):
- [ ] `POST /load` on Excalidraw (TS) takes < 5 s for file scan
      (unchanged from today).
- [ ] `POST /symbol/scan` on Excalidraw completes in < 15 s.
- [ ] `/symbol/explore?q=...render...` returns ≤ 2,500 tokens with
      both the entry points and at least 3 surrounding snippets.
- [ ] File-mode benchmarks (`SELF-BENCH.md`) regress < 5 %.

For Stage 2 (other languages):
- [ ] Same `/symbol/scan` runs on Django, Gin, Tokio, OkHttp,
      Alamofire and reports `≥ 50 %` of codegraph's `Nodes` count
      on each.

For Stage 3 (measurement):
- [ ] `COMPARISON.md` gets a third section ("CodeSynapt symbol mode
      vs codegraph") with per-repo index time + explore token counts.

## Out of scope (deliberately)

- Cross-language symbol resolution (e.g. Python calling C extension).
  codegraph also doesn't do this.
- Persistent on-disk symbol DB. We rely on the speed of rebuilding;
  if rebuild is too slow on huge repos that's the signal to add
  caching, not before.
- 3D symbol visualisation. The file graph is the visual; symbol mode
  is text/MCP only. Adding a symbol-level 3D view later is its own
  story.

## Risks

- **Memory.** Excalidraw at 10k symbols, Django at 60k — these are
  fine in-memory. A 500k-symbol monorepo could blow it; we'd add a
  sharded structure or fall back to disk. **Mitigate by checking
  memory on the bench repos before announcing the feature.**
- **Accuracy on regex languages.** Acceptable for v1 (codegraph's
  early versions also missed cases) but we document the caveat and
  treat Stage 3 (tree-sitter) as the path to parity.
- **Mode confusion for users.** Default is file mode (unchanged
  behaviour). Symbol mode is opt-in via the new endpoints / MCP
  tools — no automatic switch.
