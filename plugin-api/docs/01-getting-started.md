# Getting started

You'll build your first codesynapt plugin in five minutes. We'll walk
through two starter plugins — a **theme** (no JavaScript, just CSS)
and an **action** (a context-menu item that runs code).

## Prerequisites

- codesynapt installed and working
- A text editor of any kind
- That's it — no Node.js, no build tools, nothing to install

## 1. Open your plugin folder

In codesynapt, click **Settings → Appearance → Open plugin folder…**.

This opens (and creates if missing) the per-user plugin directory:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/codesynapt/plugins/` |
| Windows | `%APPDATA%\codesynapt\plugins\` |
| Linux | `~/.config/codesynapt/plugins/` |

## 2A. Track A — make a theme (the easiest plugin)

Inside the plugin folder, create a new subfolder called `my-theme`:

```
plugins/
└── my-theme/
    ├── manifest.json
    └── theme.css
```

**`manifest.json`:**

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "version": "1.0.0",
  "author": "you",
  "description": "My very first theme",
  "type": "theme",
  "main": "theme.css",
  "minAppVersion": "0.10.0",
  "license": "MIT"
}
```

**`theme.css`:**

```css
body[data-theme="my-theme"] {
  --bg:           #1F1B2E;
  --bg-glass:     rgba(30, 25, 50, 0.85);
  --fg:           #F0E8FF;
  --fg-dim:       #C5B8E0;
  --fg-mute:      #8B7DB0;

  --border:       rgba(180, 120, 255, 0.18);
  --border-hot:   rgba(180, 120, 255, 0.55);
  --border-edge:  rgba(180, 120, 255, 0.06);

  --accent:       #B478FF;    /* purple */
  --accent-warm:  #FFB845;    /* warm gold */
  --accent-pink:  #FF6B9F;
  --accent-cool:  #78D9FF;

  --decoration: 0;
  --grain:      0.02;
  --radius:     4px;
}
```

That's everything. Now:

1. **Quit codesynapt completely** (Cmd/Ctrl+Q, not just close window).
2. **Reopen** the app.
3. Go to **Settings → Appearance**. You'll see "My Theme" in the
   theme grid.
4. Click it.

The whole UI flips to your purple palette. You just made a theme.

→ **For the full list of CSS variables and how to tune them, read
the [theme guide](./types/theme.md).**

## 2B. Track B — make an action plugin (your first JS plugin)

Actions are the simplest code plugins. They add an item to the
right-click menu on graph nodes.

Create `plugins/my-action/`:

**`manifest.json`:**

```json
{
  "id": "my-action",
  "name": "My Action",
  "version": "1.0.0",
  "author": "you",
  "description": "Shows file info when you right-click a node",
  "type": "action",
  "main": "main.js",
  "minAppVersion": "0.10.0",
  "license": "MIT",
  "permissions": ["context-menu", "read-graph"]
}
```

**`main.js`:**

```js
export default {
  activate(ctx) {
    ctx.log('My Action plugin loaded')

    ctx.ui.registerContextMenuItem({
      label: 'Show info for this file',
      icon: 'ℹ',
      action: (nodeId) => {
        const node = ctx.graph.getNode(nodeId)
        if (!node) {
          ctx.toast('Node not found')
          return
        }
        const outs = ctx.graph.outgoing(nodeId).length
        const ins  = ctx.graph.incoming(nodeId).length
        ctx.toast(
          `${nodeId}\n` +
          `  ${node.loc} lines, ${node.size} bytes\n` +
          `  imports ${outs}, used by ${ins}`
        )
      }
    })
  }
}
```

Quit codesynapt. Reopen. Open a folder. Right-click any node in the
graph. You'll see "Show info for this file" in the menu. Click it.

A toast pops up with the file's stats. You just made a code plugin.

## What just happened

Every plugin follows the same shape:

1. **`manifest.json`** declares who the plugin is, what it does, and
   what permissions it needs.
2. **The entry file** (either `theme.css` for themes or `main.js` for
   code plugins) is the actual implementation.
3. **For code plugins**, the default export has an `activate(ctx)`
   function. `ctx` is a curated API — see the
   [API reference](./api-reference.md) for the full surface.

## Hot reload (limitations)

codesynapt doesn't yet support hot-reload for plugins. Any change to
a plugin requires **quitting and reopening the app**.

A common workflow is:

1. Edit the plugin file in your text editor.
2. **Cmd/Ctrl+Q** to quit codesynapt.
3. Reopen the app — your plugin reloads with the changes.

(Hot reload is on the roadmap; until then, the quit-restart cycle is
fast — a few seconds.)

## Next steps

Now that you have a working plugin:

- **[Concepts](./02-concepts.md)** — understand the plugin lifecycle,
  manifest, and permission system in depth.
- **[Theme guide](./types/theme.md)** — every CSS variable you can override.
- **[Exporter guide](./types/exporter.md)** — add a new export format.
- **[API reference](./api-reference.md)** — every method on `ctx`.
- **[Troubleshooting](./troubleshooting.md)** — what to do when things break.

## Got stuck?

If your plugin doesn't show up:

1. Check **Settings → Appearance → Open plugin folder…** is the actual
   path you put files in.
2. Make sure each plugin is in its own **subfolder** (not loose files).
3. Make sure `manifest.json` is **valid JSON** — paste it into
   `jsonlint.com` if unsure.
4. Open **DevTools** (View → Toggle Developer Tools) and look at the
   Console — plugin load errors are logged there.

More in [troubleshooting](./troubleshooting.md).
