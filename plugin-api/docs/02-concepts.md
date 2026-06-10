# Concepts

Once you've built [your first plugin](./01-getting-started.md), the
pieces below explain why the system is shaped the way it is.

- [Plugin types](#plugin-types)
- [The manifest](#the-manifest)
- [Lifecycle](#lifecycle)
- [The `ctx` object](#the-ctx-object)
- [Permissions](#permissions)
- [Disposables](#disposables)
- [Plugin storage](#plugin-storage)
- [The event bus](#the-event-bus)

## Plugin types

A plugin has exactly one `type` declared in its manifest. The type
determines what API surface the plugin gets and where its entry file
lives.

| Type | Entry file | What it adds |
|---|---|---|
| `theme` | `theme.css` | Visual theme (color variables, decorations) |
| `exporter` | `main.js` | A new "Export As…" format |
| `parser` | `main.js` | Support for a new file extension/language |
| `layout` | `main.js` | A new graph layout algorithm |
| `panel` | `main.js` | A side panel in the right rail |
| `action` | `main.js` | A right-click item on graph nodes |

Pick the smallest type that fits. If you want both a theme and a
context-menu action, ship them as **two separate plugins**.

## The manifest

`manifest.json` is the only required file besides the entry. Every
plugin must have one.

### Required fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique. Use kebab-case (`my-plugin`, not `My Plugin!`). Must match `[a-z0-9][a-z0-9-_]*`. |
| `name` | string | Display name shown to users. |
| `version` | string | Semver (`1.0.0`, `0.3.1`, etc.). |
| `type` | string | One of the six plugin types above. |
| `main` | string | Path to the entry file, relative to the plugin folder. |

### Recommended fields

| Field | Type | Notes |
|---|---|---|
| `author` | string | Your name (no email required). Defaults to `"unknown"`. |
| `description` | string | One-line summary shown in the plugin list. |
| `minAppVersion` | string | Earliest codesynapt version this plugin supports. |
| `license` | string | SPDX identifier (`MIT`, `Apache-2.0`, etc.). |

### Optional fields

| Field | Type | Notes |
|---|---|---|
| `homepage` | string | URL for the plugin's documentation or repo. |
| `permissions` | string[] | What capabilities the plugin needs — see [Permissions](#permissions). |

### Path safety

`main` must point to a file **inside** the plugin folder. Paths
containing `..` or absolute paths are rejected at load time. So
`main: "../../etc/passwd"` won't work — and that's by design.

### Example: a full manifest

```json
{
  "id": "rust-parser",
  "name": "Rust Parser",
  "version": "1.0.0",
  "author": "you",
  "description": "Parse `use` statements from .rs files",
  "type": "parser",
  "main": "main.js",
  "minAppVersion": "0.10.0",
  "license": "MIT",
  "homepage": "https://github.com/you/rust-parser",
  "permissions": ["parse"]
}
```

## Lifecycle

Code plugins have two lifecycle hooks: `activate` and `deactivate`.

```js
export default {
  activate(ctx) {
    // Called once when the plugin is loaded.
    // Register everything you need here.
  },

  deactivate() {
    // Optional. Called when the plugin is unloaded.
    // Clean up timers, intervals, custom DOM elements you created
    // directly, etc.
  }
}
```

Right now, "loaded" means **the app started and discovered this plugin
in the plugin folder**. There's no in-app enable/disable toggle yet
(planned). So in practice `activate()` runs once at startup and
`deactivate()` is mostly a forward-compatible hook.

### What `activate` should do

- Register handlers (`ctx.ui.registerContextMenuItem`, etc.)
- Subscribe to events (`ctx.events.on`)
- Set up timers if needed
- Store an unsubscribe handle so `deactivate` can clean up

### What `activate` should NOT do

- **Don't** do heavy work synchronously — it blocks app startup.
- **Don't** read large files or scan directories — defer to user
  interaction.
- **Don't** throw — the app catches it, but the plugin won't load.

### Theme plugins

Themes don't have lifecycle hooks. They're just CSS, injected once at
startup. Override the `body[data-theme="your-id"]` selector and you're
done.

## The `ctx` object

Every `activate(ctx)` call receives a context object. It's the only
way a plugin should talk to the app — don't reach into `window`
globals or DOM internals, those aren't stable across versions.

```js
ctx.manifest      // your own manifest (handy for version checks)
ctx.appVersion    // host codesynapt version

ctx.graph         // read-only access to nodes/edges/selection
ctx.ui            // register UI: panels, context-menu items, commands
ctx.exporters     // register export formats
ctx.parsers       // register language parsers
ctx.layouts       // register layout algorithms
ctx.events        // subscribe to app events (selection, snapshot, etc.)

ctx.storage       // persistent per-plugin key-value store
ctx.toast(msg)    // show user a notification
ctx.log(...args)  // log to plugin console (prefixed with plugin id)
```

For each property's full surface, see the
[API reference](./api-reference.md).

## Permissions

Plugins must declare what they need in `manifest.permissions`. Attempting
to call an API without the matching permission throws an error.

| Permission | Required for |
|---|---|
| `read-files` | `ctx.graph.readFile(id)` |
| `read-graph` | Always granted (nodes/edges access). Declaring it is good form. |
| `modify-graph` | Reserved for future use (adding nodes/edges from plugins). |
| `ui-panel` | `ctx.ui.registerPanel(...)` |
| `context-menu` | `ctx.ui.registerContextMenuItem(...)` |
| `export` | `ctx.exporters.register(...)` |
| `parse` | `ctx.parsers.register(...)` |

### Why bother?

Two reasons:

1. **Self-documentation.** Anyone reading your manifest knows what the
   plugin can do without reading the code.
2. **Future-proofing.** codesynapt may eventually show a permission
   prompt to users before enabling a plugin (Obsidian and VS Code both
   have similar mechanisms). Declaring permissions now means your
   plugin won't break when that lands.

### Example

```json
{
  "id": "my-plugin",
  ...
  "permissions": ["read-files", "context-menu"]
}
```

This plugin can read file contents and add right-click items. It
cannot register an exporter or a panel — if it tries, `ctx.exporters.
register(...)` throws.

## Disposables

Several API methods return a `{ dispose() }` handle. Calling `dispose()`
removes the registration.

```js
const panel = ctx.ui.registerPanel({
  id: 'my-panel',
  title: 'My Panel',
  render(container) { container.textContent = 'hello' }
})

// Later, if you want to remove the panel:
panel.dispose()
```

If you don't dispose explicitly, the app does it for you when the
plugin is unloaded. But if your plugin shows/hides UI based on state,
you'll want to call `dispose()` yourself.

## Plugin storage

Each plugin gets a private key-value store backed by `localStorage`:

```js
ctx.storage.set('lastSelection', { nodeId: 'src/index.js', at: Date.now() })

// Next time the plugin loads:
const last = ctx.storage.get('lastSelection')
if (last) ctx.log(`Last selection was ${last.nodeId}`)
```

Keys are namespaced per plugin id — you can't accidentally clash with
another plugin or with the app itself.

Values must be JSON-serializable. Don't put DOM nodes, functions, or
circular structures in there.

## The event bus

Plugins can subscribe to app-level events. These fire whenever the
relevant state changes.

| Event | When it fires | Payload |
|---|---|---|
| `snapshot:applied` | New graph data loaded (folder opened or rescanned) | `{ root: string }` |
| `selection:changed` | User clicked a node or selected something | `string \| null` (node id) |
| `filter:changed` | Search text or filter state changed | (no payload) |
| `focus:changed` | Hovered/focused node changed | `string \| null` |
| `graph:cleared` | Folder was closed | (no payload) |
| `activeset:changed` | User starred a file or toggled a pipeline | (no payload) |

```js
const off = ctx.events.on('selection:changed', (nodeId) => {
  if (nodeId) ctx.log('user picked', nodeId)
})

// Unsubscribe:
off()
```

`ctx.events.on()` returns an unsubscribe function. Save it and call it
from `deactivate()`, or it'll keep firing after your plugin is gone.

## What's next

You now know enough to build any plugin type. The next docs are
type-specific:

- [Theme guide](./types/theme.md)
- [Exporter guide](./types/exporter.md)
- [API reference](./api-reference.md) — the precise surface
- [Troubleshooting](./troubleshooting.md) — when things go wrong
