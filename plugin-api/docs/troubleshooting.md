# Troubleshooting

Common problems and their fixes.

- [Plugin doesn't show up](#plugin-doesnt-show-up)
- [Plugin appears in list but doesn't work](#plugin-appears-in-list-but-doesnt-work)
- [Error: invalid manifest](#error-invalid-manifest)
- [Error: entry path escapes plugin folder](#error-entry-path-escapes-plugin-folder)
- [Error: missing or invalid permission](#error-missing-or-invalid-permission)
- [Theme loads but looks wrong](#theme-loads-but-looks-wrong)
- [Exporter generates but downloads nothing](#exporter-generates-but-downloads-nothing)
- [Context menu item doesn't appear](#context-menu-item-doesnt-appear)
- [Changes don't take effect](#changes-dont-take-effect)
- [DevTools console errors](#devtools-console-errors)
- [Still stuck](#still-stuck)

## Plugin doesn't show up

**Check the folder structure.** Your plugin must be in **its own
subfolder** inside the plugins directory:

```
plugins/
├── my-plugin/              ← ✅ this is right
│   ├── manifest.json
│   └── main.js
└── my-other-plugin/        ← ✅ second plugin, also a subfolder
    ├── manifest.json
    └── theme.css
```

Loose files at the top of `plugins/` are ignored.

**Check the plugin folder path.** codesynapt shows the path in
Settings → Appearance → Open plugin folder…. Verify your files are
**in that exact directory**.

**Check the manifest file.** Open `manifest.json` and confirm:
- The file is literally named `manifest.json` (not `Manifest.json`,
  not `manifest.JSON`).
- It's valid JSON — paste into [jsonlint.com](https://jsonlint.com/)
  if unsure.

**Did you restart the app?** codesynapt only scans for plugins at
startup. **Cmd/Ctrl+Q to fully quit**, then reopen — just closing the
window isn't enough on macOS.

## Plugin appears in list but doesn't work

The plugin was discovered but failed to validate or activate. Open
**DevTools** (View → Toggle Developer Tools) and check the Console
for messages like:

```
[plugin-loader] skipping <id>: <reason>
[plugin:<id>] activate() threw: <error>
```

The reason will tell you exactly what's wrong. Common ones below.

## Error: invalid manifest

### `missing or invalid "id"`

Every plugin needs an `id`. Make sure your manifest has one:

```json
{
  "id": "my-plugin",        ← required
  ...
}
```

### `invalid id "..." (use alphanumeric + dash/underscore)`

Plugin ids must match `[a-z0-9][a-z0-9-_]*` (lowercase alphanumeric,
dashes, underscores). Starting character must be a letter or digit.

```json
{
  "id": "My Plugin!"        ← ❌ spaces, capitals, punctuation
  "id": "1plugin"           ← ✅ ok (starts with digit)
  "id": "my-plugin"         ← ✅ standard
  "id": "my_plugin_v2"      ← ✅ ok
}
```

### `unknown type "..."`

The `type` field must be one of:
`theme`, `exporter`, `parser`, `layout`, `panel`, `action`.

Typos like `themer` or `exporters` will fail.

### `unknown permission "..."`

Permissions must come from this list:
`read-files`, `read-graph`, `modify-graph`, `ui-panel`,
`context-menu`, `export`, `parse`.

## Error: entry path escapes plugin folder

You have something like `"main": "../something"` in your manifest.
For security, plugins can only reference files inside their own folder.
Move the file into the plugin directory.

```json
{
  "main": "../../shared.js"   ← ❌ refuses to load
  "main": "main.js"           ← ✅ inside plugin folder
  "main": "src/main.js"       ← ✅ subdirectory is fine
}
```

## Error: missing or invalid permission

Trying to use an API method without declaring the matching permission:

```
Plugin "my-plugin" attempted "registerContextMenuItem" but does not declare permission "context-menu"
```

Add the permission to your manifest:

```json
{
  ...
  "permissions": ["context-menu"]
}
```

Then restart the app.

The full list:
- `read-files` → `ctx.graph.readFile(id)`
- `ui-panel` → `ctx.ui.registerPanel(...)`
- `context-menu` → `ctx.ui.registerContextMenuItem(...)`
- `export` → `ctx.exporters.register(...)`
- `parse` → `ctx.parsers.register(...)`

## Theme loads but looks wrong

### "Some panels look broken"

You probably only set a few variables. The app's UI uses ~30 CSS
variables; if you override only `--bg` and `--accent`, you'll inherit
the previous theme's other colors and they'll clash.

Set everything from this list (with sensible values):

```css
body[data-theme="my-theme"] {
  --bg:           ...
  --bg-glass:     ...
  --fg:           ...
  --fg-dim:       ...
  --fg-mute:      ...
  --fg-faint:     ...
  --border:       ...
  --border-hot:   ...
  --border-edge:  ...
  --accent:       ...
  --accent-warm:  ...
  --accent-pink:  ...
  --decoration:   0 or 1
  --radius:       ...
}
```

See [theme.md](./types/theme.md) for the full list and what each does.

### "Light mode has weird specks/grain"

The grain overlay (`body::before`) uses blend-mode that looks fine on
dark but ugly on light. Disable it:

```css
body[data-theme="my-light-theme"] {
  --grain: 0;
}
body[data-theme="my-light-theme"]::before {
  opacity: 0 !important;
}
```

### "Colors leak between themes"

You defined CSS variables at `:root` instead of inside
`body[data-theme="..."]`. The variables apply globally, polluting
other themes. Scope them properly:

```css
/* ❌ leaks */
:root {
  --accent: #FF0000;
}

/* ✅ scoped */
body[data-theme="my-theme"] {
  --accent: #FF0000;
}
```

## Exporter generates but downloads nothing

### "Empty file downloads"

Your `generate` function isn't returning the string. Check:

```js
generate(graph) {
  console.log('hello')   // ❌ logged but never returned
}
```

```js
generate(graph) {
  return 'hello'         // ✅
}
```

### "Wrong extension on the file"

`extension` should be the bare suffix, no dot:

```js
extension: 'mmd'   // ✅ → file.mmd
extension: '.mmd'  // ❌ → file..mmd
```

### "Unicode characters render as ???"

Add charset to the MIME type:

```js
mimeType: 'text/plain; charset=utf-8'
```

## Context menu item doesn't appear

- Did you declare `"permissions": ["context-menu"]` in the manifest?
- Did you fully restart the app?
- Right-click directly on a **node** (sphere) in the graph — empty
  space doesn't show node-context items.
- Open DevTools and check for plugin activation errors.

## Changes don't take effect

codesynapt **does not** hot-reload plugins right now. Any change to
a plugin file requires:

1. **Quit completely** (Cmd/Ctrl+Q, not just close window).
2. **Reopen** the app.

If you change `manifest.json`, the same applies. There's no way to
reload just one plugin without restarting.

(Hot reload is on the roadmap.)

## DevTools console errors

Open DevTools: **View → Toggle Developer Tools** (or Cmd/Ctrl+Option+I).

Switch to the **Console** tab. Errors from your plugin are prefixed
with `[plugin:<id>]`. For example:

```
[plugin:my-plugin] activate() threw: TypeError: cannot read property 'foo' of undefined
    at activate (blob:file:///...:5:23)
```

The line number points to your `main.js`. Click the link to jump to
the source.

Common errors:

### `Cannot read property '...' of undefined`

You accessed something that doesn't exist. Most often:

```js
const node = ctx.graph.getNode(id)
ctx.log(node.loc)   // ❌ if node is null, this throws
```

Add a null check:

```js
const node = ctx.graph.getNode(id)
if (node) ctx.log(node.loc)
```

### `Plugin "..." attempted "..." but does not declare permission`

Add the permission to your manifest. See
[Error: missing or invalid permission](#error-missing-or-invalid-permission).

### `Failed to fetch dynamically imported module`

Your `main.js` has a syntax error preventing it from loading. Check
it parses with `node --check main.js` if you have Node installed, or
paste it into [esprima.org/demo/validate.html](https://esprima.org/demo/validate.html).

### `await is only valid in async functions`

Mark your function as `async`:

```js
generate: async (graph) => {
  const content = await graph.readFile(...)
  return content
}
```

## Still stuck

1. **Look at a working example.** Each `examples/*` plugin has a
   README explaining how it's structured. Copy and modify.

2. **Compare with the type definitions.** Open
   [`../types.d.ts`](../types.d.ts) and check that your code matches
   the expected shape.

3. **File an issue.** [GitHub issues](https://github.com/wing1008/codesynapt/issues)
   with:
   - Your `manifest.json`
   - Your `main.js` (or `theme.css`)
   - The error from the DevTools console
   - The codesynapt version (Settings → About)

4. **Ask the community.** Plugin discussion lives at
   [GitHub Discussions](https://github.com/wing1008/codesynapt/discussions).
