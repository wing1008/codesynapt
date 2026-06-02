# hello-world-plugin

A minimal action plugin that demonstrates:

- Registering a context-menu item
- Subscribing to selection events
- Showing toast notifications
- Using `ctx.log` for debugging

## What it does

When installed:

1. **Right-click any node** in the graph — a "Hello from plugin" item
   appears in the menu. Click it to see a toast.

2. **Click any node** — a toast pops up with that node's basic stats
   (incoming/outgoing edge counts).

## Install

Copy this folder into your filegraph3d plugins directory:

```
macOS:   ~/Library/Application Support/FileGraph 3D/plugins/
Windows: %APPDATA%\FileGraph 3D\plugins\
Linux:   ~/.config/FileGraph 3D/plugins/
```

Quit and reopen filegraph3d. Open any folder. Click or right-click
nodes.

## Files

- **`manifest.json`** — declares the plugin as type `action` with no
  required permissions (read-graph is implicit, and the toast/log
  helpers don't need permissions).

- **`main.js`** — the entry point. Subscribes to events, registers a
  context-menu item, and stores its unsubscribe function so
  `deactivate()` can clean up.

## What to look at

- The `default export` shape — every code plugin has an object with
  at least an `activate(ctx)` function.

- `ctx.events.on(...)` returns an unsubscribe function. The plugin
  stores it as `this._unsub` and calls it from `deactivate()`.

- `ctx.ui.registerContextMenuItem(...)` doesn't return a useful handle
  for the plugin to track because the plugin host handles cleanup
  automatically when the plugin unloads.

- `ctx.toast(...)` automatically prefixes messages with `[hello-world]`
  so the user knows where they came from.

## What to try next

Modify `main.js` to:

- Show different info in the toast (e.g. file extension, size in KB)
- Filter the context menu to only appear on `.js` files (use the
  `enabled` callback)
- Subscribe to a different event (`focus:changed`, `snapshot:applied`)
- Persist a counter in `ctx.storage` ("you've clicked X files")

## License

MIT.
