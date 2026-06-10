# codesynapt plugin development

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Plugin API: v0.1](https://img.shields.io/badge/Plugin%20API-v0.1.0-orange.svg)](./package.json)
[![Plugin types: 6](https://img.shields.io/badge/plugin%20types-6-blueviolet)](#six-plugin-types)
[![Examples: 4](https://img.shields.io/badge/examples-4-success)](./examples/)

> Build themes, exporters, parsers, layouts, panels, and context-menu
> actions for [codesynapt](https://github.com/wing1008/codesynapt).

This package contains the public API surface for codesynapt plugins.
It is **MIT-licensed** — you can build and distribute plugins under any
license you choose, including commercially. The main codesynapt app
itself is AGPL-licensed; see the top-level `LICENSE` for details.

---

## Where to start

| If you want to… | Read this |
|---|---|
| Build your first plugin in 5 minutes | [Getting started](./docs/01-getting-started.md) |
| Understand how plugins work | [Concepts](./docs/02-concepts.md) |
| Add a new color theme | [Theme guide](./docs/types/theme.md) |
| Add an export format | [Exporter guide](./docs/types/exporter.md) |
| Look up an API method | [API reference](./docs/api-reference.md) |
| Fix something that's not working | [Troubleshooting](./docs/troubleshooting.md) |
| Copy a working example | [examples/](./examples/) |

---

## Six plugin types

| Type | What it does | Difficulty | Example |
|---|---|---|---|
| `theme` | A new color palette and look | ★☆☆ | [sunset-theme](./examples/sunset-theme/) |
| `exporter` | A new export format (Mermaid, GraphViz, etc.) | ★☆☆ | [mermaid-exporter](./examples/mermaid-exporter/) |
| `action` | A right-click item on graph nodes | ★☆☆ | [hello-world-plugin](./examples/hello-world-plugin/) |
| `parser` | Support for a new language | ★★☆ | [rust-parser](./examples/rust-parser/) |
| `panel` | A side panel in the app UI | ★★☆ | (in progress) |
| `layout` | A new graph layout algorithm | ★★★ | (in progress) |

A plugin has exactly one type — pick the smallest one that fits. You
can ship multiple plugins for different concerns.

---

## Anatomy of a plugin

Every plugin is a folder containing **at least two files**:

```
my-plugin/
├── manifest.json      ← metadata (id, name, type, permissions)
└── main.js            ← entry point (theme.css for theme plugins)
```

That's it. No build step required (you can use plain JS), no `npm install`
needed (the API surface is just a type definition for IDE support).

---

## Where plugins live

codesynapt looks for plugins in a per-user directory:

| OS | Path |
|---|---|
| **macOS** | `~/Library/Application Support/codesynapt/plugins/` |
| **Windows** | `%APPDATA%\codesynapt\plugins\` |
| **Linux** | `~/.config/codesynapt/plugins/` |

You can open this folder from the app via **Settings → Appearance →
Open plugin folder…**.

Each plugin is its own subfolder. Restart codesynapt after installing
a plugin to pick it up.

---

## TypeScript support (optional)

If you're using TypeScript, the types in `types.d.ts` give you full
IntelliSense and compile-time checks:

```sh
npm install --save-dev @codesynapt/plugin-api
```

```ts
import type { Plugin } from '@codesynapt/plugin-api'

const plugin: Plugin = {
  activate(ctx) {
    ctx.log('hello from typescript')
  }
}
export default plugin
```

You can also use plain JavaScript — the API works identically.

---

## License

This API package: **MIT** — see [LICENSE](./LICENSE).

You can publish your plugins under any license you like (MIT,
Apache-2.0, proprietary, etc).

The codesynapt app itself: **AGPL-3.0** — see [`../LICENSE`](../LICENSE).
Personal and internal use is free; commercial redistribution requires
a license.
