# Exporter plugin

An exporter plugin adds a new entry to codesynapt's export menu. Your
plugin receives the current graph and returns a string; the app handles
file downloads, MIME types, and the user-facing UI.

- [Minimal example](#minimal-example)
- [What `generate` receives](#what-generate-receives)
- [Example: Mermaid](#example-mermaid)
- [Example: GraphViz DOT](#example-graphviz-dot)
- [Example: Custom JSON](#example-custom-json)
- [Tips & patterns](#tips--patterns)
- [Common mistakes](#common-mistakes)

## Minimal example

```
plugins/my-exporter/
├── manifest.json
└── main.js
```

**`manifest.json`:**

```json
{
  "id": "my-exporter",
  "name": "My Exporter",
  "version": "1.0.0",
  "type": "exporter",
  "main": "main.js",
  "minAppVersion": "0.10.0",
  "license": "MIT",
  "permissions": ["export"]
}
```

**`main.js`:**

```js
export default {
  activate(ctx) {
    ctx.exporters.register({
      name: 'My Format',
      extension: 'txt',
      mimeType: 'text/plain',
      generate(graph) {
        return `Exported ${graph.nodes.length} files`
      }
    })
  }
}
```

That's it. The user will see "My Format" in the export dropdown.
Clicking it generates a `.txt` file with one line of text.

## What `generate` receives

The `generate` function gets a [`GraphAPI`](../api-reference.md#graphapi)
object — read-only access to the current graph:

```ts
generate(graph: GraphAPI): string | Promise<string>
```

You can use:

| Property/method | What it gives you |
|---|---|
| `graph.root` | Absolute path of the opened folder |
| `graph.nodes` | Array of all nodes (each has `id`, `ext`, `size`, `loc`, `hex`) |
| `graph.edges` | Array of all edges (each has `s`, `t`, `k`) |
| `graph.selectedId` | Currently selected node id (or `null`) |
| `graph.activeSet` | Currently active file set (or `null` if disabled) |
| `graph.getNode(id)` | Lookup a single node |
| `graph.outgoing(id)` / `graph.incoming(id)` | Get edges from/to a node |
| `graph.readFile(id)` | Read file contents (requires `read-files` permission) |

`generate` can be `async` if you need to do anything that takes time —
for example reading file contents. The app shows a "Generating…"
state while it's running.

## Example: Mermaid

[Mermaid](https://mermaid.js.org/) diagrams render inside GitHub
Markdown, Notion, Obsidian, and many other tools.

```js
export default {
  activate(ctx) {
    ctx.exporters.register({
      name: 'Mermaid Diagram',
      extension: 'mmd',
      mimeType: 'text/plain',
      generate(graph) {
        const lines = ['graph LR']

        // Mermaid node ids must be alphanumeric, so we map every
        // file path to a safe alias.
        const aliases = new Map()
        const taken = new Set()
        for (const node of graph.nodes) {
          const base = (node.id.split('/').pop() || node.id)
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .replace(/^(\d)/, '_$1')
          let alias = base
          let n = 2
          while (taken.has(alias)) alias = `${base}${n++}`
          aliases.set(node.id, alias)
          taken.add(alias)
        }

        // Declare each node with its file name as the visible label
        for (const node of graph.nodes) {
          const alias = aliases.get(node.id)
          const label = (node.id.split('/').pop() || node.id)
            .replace(/"/g, '\\"')
          lines.push(`  ${alias}["${label}"]`)
        }

        // Then edges
        for (const e of graph.edges) {
          const s = aliases.get(e.s)
          const t = aliases.get(e.t)
          if (s && t) lines.push(`  ${s} --> ${t}`)
        }

        return lines.join('\n')
      }
    })
  }
}
```

For graphs over a few hundred nodes, Mermaid can get slow — consider
filtering to just the active set:

```js
generate(graph) {
  const active = graph.activeSet
  const nodes = active
    ? graph.nodes.filter((n) => active.has(n.id))
    : graph.nodes
  // ...rest as above, using `nodes` instead of `graph.nodes`
}
```

## Example: GraphViz DOT

[GraphViz](https://graphviz.org/) DOT is the lingua franca of dependency
graphs. Render with `dot -Tsvg graph.dot -o graph.svg`.

```js
export default {
  activate(ctx) {
    ctx.exporters.register({
      name: 'GraphViz DOT',
      extension: 'dot',
      mimeType: 'text/vnd.graphviz',
      generate(graph) {
        const lines = ['digraph G {']
        lines.push('  rankdir=LR;')
        lines.push('  node [shape=box, fontname="JetBrains Mono", fontsize=10];')

        // Nodes — use file ids as both the dot identifier (quoted) and label.
        for (const node of graph.nodes) {
          const id = JSON.stringify(node.id)
          const ext = node.ext
          // Color nodes by extension
          const color = colorForExt(ext)
          lines.push(`  ${id} [label=${JSON.stringify(basename(node.id))}, color="${color}"];`)
        }

        // Edges
        for (const e of graph.edges) {
          lines.push(`  ${JSON.stringify(e.s)} -> ${JSON.stringify(e.t)};`)
        }

        lines.push('}')
        return lines.join('\n')
      }
    })
  }
}

function basename(p) {
  return p.split('/').pop() || p
}

function colorForExt(ext) {
  const map = { js: '#F7DF1E', ts: '#3178C6', jsx: '#61DAFB',
                tsx: '#3178C6', py: '#3776AB', css: '#264DE4' }
  return map[ext] || '#999999'
}
```

DOT handles thousands of nodes gracefully — it's designed for this.

## Example: Custom JSON

If you want to feed the graph into your own tooling, a structured JSON
export is often the right choice. Make sure your shape is documented
or you'll forget what it means in six months.

```js
export default {
  activate(ctx) {
    ctx.exporters.register({
      name: 'JSON (analysis)',
      extension: 'json',
      mimeType: 'application/json',
      generate(graph) {
        const data = {
          // Versioning your export format pays off the first time you
          // change it.
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          root: graph.root,
          stats: {
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
          },
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            ext: n.ext,
            size: n.size,
            loc: n.loc,
          })),
          edges: graph.edges.map((e) => ({
            from: e.s,
            to: e.t,
            kind: e.k,
          })),
        }
        return JSON.stringify(data, null, 2)
      }
    })
  }
}
```

## Tips & patterns

### Respect the active set when present

If the user has curated an active set, they're telling you "the rest
isn't really part of my project right now." Most exports should filter
to it:

```js
const active = graph.activeSet  // null if disabled
const nodes = active ? graph.nodes.filter((n) => active.has(n.id))
                     : graph.nodes
const edges = active
  ? graph.edges.filter((e) => active.has(e.s) && active.has(e.t))
  : graph.edges
```

### Truncate huge exports

If your format struggles past 5k nodes (Mermaid does), warn the user
or truncate:

```js
if (graph.nodes.length > 5000) {
  ctx.toast(`Graph has ${graph.nodes.length} nodes — Mermaid may struggle. Consider using an active set.`)
}
```

Toast access requires the plugin context, so capture it from
`activate`:

```js
export default {
  activate(ctx) {
    this._ctx = ctx
    ctx.exporters.register({
      // ...
      generate: (graph) => this.doExport(ctx, graph)
    })
  },
  doExport(ctx, graph) {
    if (graph.nodes.length > 5000) {
      ctx.toast('Large graph — this may take a moment')
    }
    // ...
  }
}
```

### Make output reproducible

Sort nodes/edges in a stable order. Otherwise diffing two exports of
the same graph produces noise:

```js
const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))
```

### Don't read files unless you have to

Reading file contents costs IO. If your format only needs the
dependency structure, work from `graph.nodes` and `graph.edges` alone.

If you do need contents:

```js
{
  // ...
  permissions: ['export', 'read-files']
}
```

```js
generate: async (graph) => {
  const lines = []
  for (const node of graph.nodes) {
    const content = await graph.readFile(node.id)
    // ... do something
  }
  return lines.join('\n')
}
```

## Common mistakes

### "My exporter doesn't appear in the export menu"

- Did you declare `"permissions": ["export"]` in the manifest? Without
  it, `ctx.exporters.register(...)` throws.
- Did you quit and restart the app? Plugins load at startup.

### "Generate runs but no file downloads"

Make sure you `return` (not `console.log`) the generated string. Async
generators must `return` a string (or `Promise<string>`).

```js
// ❌ no return — empty file
generate(graph) {
  console.log('done!')
}

// ✅ returns the string
generate(graph) {
  return 'hello'
}
```

### "Output file has wrong extension"

`extension` in your registration is the bare suffix without a dot:

```js
extension: 'mmd'  // ✅
extension: '.mmd' // ❌ produces "file..mmd"
```

### "Unicode characters appear as ???"

Make sure your `mimeType` indicates the encoding:

```js
mimeType: 'text/plain; charset=utf-8'
```

Or use a more specific type that implies UTF-8 (e.g.
`application/json`).

## Next steps

- Try the [mermaid-exporter example](../../examples/mermaid-exporter/)
  — a complete working version of the Mermaid exporter.
- Look at the [API reference](../api-reference.md) for everything
  available on `graph`.
- Check [troubleshooting](../troubleshooting.md) when stuck.
