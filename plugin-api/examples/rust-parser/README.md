# rust-parser

A codesynapt plugin that adds support for **Rust** (`.rs`) files.

## What it does

Without this plugin, codesynapt ignores `.rs` files — they appear as
isolated nodes with no edges, because the app doesn't know how to
read Rust's import syntax.

With this plugin installed, codesynapt parses:

- `use path::to::thing;` — including `pub use`
- `mod foo;` — local module declarations
- `extern crate foo;` — legacy crate imports

Comments are stripped first so commented-out imports don't produce
false edges.

## Install

```sh
# Copy this folder into your codesynapt plugins directory:
# macOS:   ~/Library/Application Support/codesynapt/plugins/
# Windows: %APPDATA%\codesynapt\plugins\
# Linux:   ~/.config/codesynapt/plugins/

cp -r rust-parser ~/Library/Application\ Support/codesynapt/plugins/
```

Then quit and reopen codesynapt.

Open a Rust project (or any folder containing `.rs` files). You'll
see them connected by import edges in the graph.

## Limitations

This is a regex-based parser. It handles 95% of real-world Rust code
but has known blind spots:

| Case | Handling |
|---|---|
| `use foo::bar;` | ✅ Captures `foo` (the leading path segment) |
| `use foo::{bar, baz};` | ✅ Captures `foo` once |
| `use foo as f;` | ✅ Captures `foo` |
| `use foo::*;` | ✅ Captures `foo` |
| `pub use foo::bar;` | ✅ Captures `foo` |
| Macro-generated `use` | ❌ Not seen (macros not expanded) |
| `use` inside `mod { ... }` blocks | ⚠️ Captured but path may be wrong |
| `#[cfg(...)] use foo;` | ✅ Captures (cfg-gated imports counted) |

If you need precise Rust parsing (workspace resolution, real path
resolution, cfg evaluation), this isn't the right tool — use
[cargo-modules](https://github.com/regexident/cargo-modules) and
export its graph.

## How resolution works

The parser returns import paths like `"std::collections"`. codesynapt
then tries to match these against actual files in your project. The
matching is path-prefix based, so:

- `use crate::foo::bar` → matches `src/foo/bar.rs` or `src/foo/bar/mod.rs`
- `use std::collections` → no match (external crate, no source in your project)

External crates appear as imports with no resolved target — they're
visible in the inspector but don't create edges.

## License

MIT. Copy, modify, redistribute freely.
