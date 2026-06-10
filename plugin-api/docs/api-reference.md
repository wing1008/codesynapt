# API reference

Every method available to plugins, with signatures, parameters, return
values, and a small example.

For the raw TypeScript types, see [`../types.d.ts`](../types.d.ts) —
that file is the single source of truth. This page is the human-readable
companion.

## Quick index

| Namespace | Purpose |
|---|---|
| [`ctx`](#the-context-object) | The root object passed to `activate(ctx)` |
| [`ctx.graph`](#graph-api) | Read graph state |
| [`ctx.ui`](#ui-api) | Register panels, menu items, commands |
| [`ctx.exporters`](#exporter-registry) | Register export formats |
| [`ctx.parsers`](#parser-registry) | Register language parsers |
| [`ctx.layouts`](#layout-registry) | Register layout algorithms |
| [`ctx.events`](#event-bus) | Subscribe to app events |
| [`ctx.storage`](#plugin-storage) | Persistent per-plugin storage |
| [`ctx.toast`](#cxtoastmsg) | Show a toast notification |
| [`ctx.log`](#cxlog-args) | Log to the plugin console |

---

## The context object

```ts
ctx.manifest: PluginManifest    // your plugin's own manifest
ctx.appVersion: string          // host codesynapt version (e.g. "0.11.0")
ctx.graph: GraphAPI             // read graph state
ctx.ui: UIAPI                   // register UI items
ctx.exporters: ExporterRegistry
ctx.parsers: ParserRegistry
ctx.layouts: LayoutRegistry
ctx.events: EventBus            // subscribe to events
ctx.storage: PluginStorage      // persistent key-value store
ctx.toast(msg: string): void    // show a toast
ctx.log(...args: unknown[]): void  // log to console (prefixed)
```

---

## Graph API

Read-only access to the current graph. All properties update live as
the graph changes — read them when you need them, don't cache.

### `graph.root: string`

The absolute path of the currently-opened folder.

```js
ctx.log('User opened:', ctx.graph.root)
// → /Users/you/projects/codesynapt
```

### `graph.nodes: ReadonlyArray<GraphNode>`

Every file in the graph. Each node has:

```ts
interface GraphNode {
  id: string       // file path relative to root, e.g. "src/index.js"
  ext: string      // extension without dot, e.g. "js"
  size: number     // bytes
  loc: number      // lines of code
  hex: string      // display color, e.g. "#F7DF1E"
}
```

```js
const jsFiles = ctx.graph.nodes.filter((n) => n.ext === 'js')
ctx.log(`${jsFiles.length} JS files`)
```

### `graph.edges: ReadonlyArray<GraphEdge>`

Every import edge. Each edge:

```ts
interface GraphEdge {
  s: string   // source node id (the file doing the importing)
  t: string   // target node id (the file being imported)
  k: string   // edge kind: 'import' | 'require' | 'dynamic' | 'css' | 'other'
}
```

### `graph.selectedId: string | null`

The currently-selected node id, or `null` if none.

### `graph.activeSet: ReadonlySet<string> | null`

The currently-active file set (the user's curated "what's really in
use" list). `null` if the active set feature is turned off.

```js
const active = ctx.graph.activeSet
if (active) {
  ctx.log(`${active.size} active files`)
} else {
  ctx.log('Active set is off')
}
```

### `graph.getNode(id: string): GraphNode | null`

Look up a single node by id. Returns `null` if not found.

```js
const node = ctx.graph.getNode('src/index.js')
if (node) ctx.log(`${node.loc} lines`)
```

### `graph.outgoing(id: string): GraphEdge[]`

Every edge starting from this node (i.e., files this file imports).

```js
const deps = ctx.graph.outgoing('src/index.js')
ctx.log(`Imports ${deps.length} files`)
```

### `graph.incoming(id: string): GraphEdge[]`

Every edge ending at this node (i.e., files that import this file).

```js
const usages = ctx.graph.incoming('src/utils.js')
ctx.log(`Used by ${usages.length} files`)
```

### `graph.readFile(id: string): Promise<string>`

Read the contents of a file. **Requires `read-files` permission.**

```js
// In manifest.json:
//   "permissions": ["read-files"]

const content = await ctx.graph.readFile('src/index.js')
const lineCount = content.split('\n').length
```

Reading files is async because codesynapt may need to load from disk
or wait for an in-flight read. Performance: ~5ms per file on average.

---

## UI API

### `ui.registerPanel(opts: PanelOptions): PanelHandle`

Add a side panel to the right rail. **Requires `ui-panel` permission.**

```ts
interface PanelOptions {
  id: string                              // unique within your plugin
  title: string                           // shown in the panel header
  position?: 'right' | 'left' | 'bottom'  // default: 'right'
  render: (container: HTMLElement) => void
  defaultVisible?: boolean                // default: true
}

interface PanelHandle {
  refresh(): void   // force re-render
  show(): void      // make visible
  hide(): void      // hide without removing
  dispose(): void   // remove entirely
}
```

```js
const panel = ctx.ui.registerPanel({
  id: 'stats',
  title: 'My Stats',
  render(container) {
    const node = ctx.graph.getNode(ctx.graph.selectedId)
    container.innerHTML = node
      ? `<p>Selected: ${node.id}</p>`
      : `<p>No selection</p>`
  }
})

// Re-render when selection changes
ctx.events.on('selection:changed', () => panel.refresh())
```

### `ui.registerContextMenuItem(opts): MenuItemHandle`

Add a right-click item to graph nodes. **Requires `context-menu` permission.**

```ts
interface ContextMenuOptions {
  label: string                                  // display text
  icon?: string                                   // single character/emoji
  enabled?: (nodeId: string) => boolean           // dynamic enable/disable
  action: (nodeId: string) => void | Promise<void>
}
```

```js
ctx.ui.registerContextMenuItem({
  label: 'Open in browser',
  icon: '🌐',
  enabled: (nodeId) => nodeId.endsWith('.html'),
  action: (nodeId) => {
    ctx.toast(`Would open ${nodeId}`)
  }
})
```

### `ui.registerCommand(opts): CommandHandle`

Register a named command. Reserved for future command-palette support.

```js
ctx.ui.registerCommand({
  id: 'my-plugin.do-thing',
  name: 'Do The Thing',
  shortcut: 'Cmd+Shift+T',  // suggestion only — not bound yet
  action: () => ctx.toast('Did the thing!')
})
```

---

## Exporter registry

### `exporters.register(opts: ExporterOptions): ExporterHandle`

Add a new export format. **Requires `export` permission.**

```ts
interface ExporterOptions {
  name: string                          // "Mermaid Diagram"
  extension: string                     // "mmd" (no dot)
  mimeType: string                      // "text/plain"
  generate: (graph: GraphAPI) => string | Promise<string>
}
```

Full guide and worked examples: [exporter.md](./types/exporter.md).

---

## Parser registry

### `parsers.register(opts: ParserOptions): ParserHandle`

Add support for a new file extension. **Requires `parse` permission.**

```ts
interface ParserOptions {
  name: string                          // "Rust"
  extensions: string[]                  // ["rs"] (no dot)
  parse: (filePath: string, content: string) => ParseResult
}

interface ParseResult {
  imports: ParseImport[]
  loc?: number  // optional override; defaults to newline count
}

interface ParseImport {
  path: string                          // "./foo", "react", etc.
  kind: 'import' | 'require' | 'dynamic' | 'css' | 'asset' | 'other'
  line?: number                         // for debugging
}
```

Parsers are called synchronously per file during scan. Keep them fast —
ideally under 1ms per file. Heavy parsing should use a worker (advanced
topic, not covered here).

```js
ctx.parsers.register({
  name: 'Rust',
  extensions: ['rs'],
  parse(filePath, content) {
    const imports = []
    const useRegex = /^\s*use\s+([a-zA-Z_:][\w:]*)/gm
    let m
    while ((m = useRegex.exec(content)) !== null) {
      imports.push({ path: m[1], kind: 'import' })
    }
    return { imports }
  }
})
```

See the [rust-parser example](../examples/rust-parser/) for a fuller
implementation.

---

## Layout registry

### `layouts.register(opts: LayoutOptions): LayoutHandle`

Add a graph layout algorithm. The user picks layouts from a future
settings panel (not yet wired up — registered layouts are stored but
not user-selectable yet).

```ts
interface LayoutOptions {
  name: string                          // "Hierarchical"
  id: string                            // unique
  compute: (nodes, edges) =>
    Map<string, { x: number; y: number; z: number }> |
    Promise<Map<string, { x: number; y: number; z: number }>>
}
```

```js
ctx.layouts.register({
  name: 'Random',
  id: 'random',
  compute(nodes, edges) {
    const positions = new Map()
    for (const node of nodes) {
      positions.set(node.id, {
        x: (Math.random() - 0.5) * 100,
        y: (Math.random() - 0.5) * 100,
        z: (Math.random() - 0.5) * 100,
      })
    }
    return positions
  }
})
```

---

## Event bus

### `events.on(name: EventName, handler: (payload) => void): () => void`

Subscribe to an app event. Returns an unsubscribe function — call it
to stop receiving the event.

| Event | Fires when | Payload |
|---|---|---|
| `snapshot:applied` | New graph data loaded | `{ root: string }` |
| `selection:changed` | User selects a node | `string \| null` |
| `filter:changed` | Search filter changes | (no payload) |
| `focus:changed` | Hover focus changes | `string \| null` |
| `graph:cleared` | Folder closed | (no payload) |
| `activeset:changed` | Active set / pipelines updated | (no payload) |

```js
const off = ctx.events.on('selection:changed', (id) => {
  if (id) ctx.log('selected', id)
})

// Later:
off()  // unsubscribe
```

### `events.off(name, handler): void`

Alternative way to unsubscribe (the unsubscribe function returned by
`on` is usually cleaner).

---

## Plugin storage

Per-plugin localStorage, namespaced under your plugin id.

### `storage.set<T>(key: string, value: T): void`

Store a value. Must be JSON-serializable.

```js
ctx.storage.set('lastUsed', Date.now())
ctx.storage.set('preferences', { showHidden: true, depth: 5 })
```

### `storage.get<T>(key: string): T | null`

Retrieve a value. Returns `null` if the key doesn't exist.

```js
const prefs = ctx.storage.get('preferences')
if (prefs?.showHidden) { /* ... */ }
```

### `storage.delete(key: string): void`

Remove a single key.

### `storage.clear(): void`

Remove all keys for this plugin.

### `storage.keys(): string[]`

List all keys this plugin has stored.

---

## `ctx.toast(msg)`

Show a transient toast notification at the bottom of the screen.
Visible for a few seconds, then fades.

```js
ctx.toast('Export complete')
```

Toast text is automatically prefixed with your plugin name, so the
user knows where it came from:

```
[my-plugin] Export complete
```

## `ctx.log(...args)`

Log to the browser console. Output is prefixed with `[plugin:<id>]`
so you can filter for it.

```js
ctx.log('Loaded', ctx.graph.nodes.length, 'nodes')
```

Open DevTools (View → Toggle Developer Tools) to see the output.

---

## Types — full TypeScript surface

The complete TypeScript types are in [`../types.d.ts`](../types.d.ts).
If you're using TypeScript or VS Code, install the package:

```sh
npm install --save-dev @codesynapt/plugin-api
```

```ts
import type {
  Plugin,
  PluginContext,
  GraphAPI,
  // ... all the rest
} from '@codesynapt/plugin-api'
```

You get IntelliSense for every method, parameter, and return value.

## Stability

Current version: **0.1.0** (pre-release).

Expect breaking changes until 1.0. After 1.0:
- **Minor versions** (1.x) are additive — old plugins keep working.
- **Major versions** (2.0, 3.0) may break — old plugins are loaded
  with a deprecation warning so users can update.

Watch `CHANGELOG.md` (top-level codesynapt repo) for changes.
