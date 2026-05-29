# Contributing to CodeSynapt

Contributions, bug reports, and feature requests are welcome.

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) — by
participating, you agree to abide by its terms. See also
[SUPPORT.md](./.github/SUPPORT.md) for where to ask for help.

## Development setup

```sh
git clone https://github.com/YOUR_USER/codesynapt.git
cd codesynapt
npm install
npm start            # launches the Electron app
```

For browser-mode development (faster reload, easier devtools):

```sh
npm run server -- /path/to/some/project
# then open http://localhost:7777
```

## Project layout

```
electron/         Electron main process, preload, and plugin loader
public/           Renderer — HTML/CSS/JS that runs in the BrowserWindow
parser.js         Multi-language import/dependency extraction (Babel + regex)
scanner.js        chokidar-based file watcher + edge builder
server.js         Standalone Node server (for browser-mode dev)
test.js           Parser smoke test
perf-test.js      Physics benchmark
plugin-api/       Plugin API package (MIT) — types, docs, examples
docs/             User and contributor documentation
scripts/          Build scripts (vendor copy, license check)
build/            Build resources (macOS entitlements)
```

For a deep dive into the internals (parser, scanner, layout, rendering
pipeline), see [docs/architecture.md](./docs/architecture.md).

## Code style

- ESM throughout (`"type": "module"`)
- 2-space indent, no semicolons in `.js` files
- Keep hot-path JS inlined and allocation-free — see comments in
  `public/app.js` `step()`
- Prefer plain DOM over a framework in the renderer

## Adding a language parser

Open `parser.js` and add an entry to the dispatch table at the bottom.
A parser is a function `(text, absPath) => { imports: [{ spec, kind }] }`.
Path resolution lives in `resolveImport`.

Add the extension to:
- `TRACKED_EXT` in `scanner.js`
- `TYPE_COLORS` in `public/app.js` (optional — falls back to hashed color)
- `test.js` — add a fixture and expected edge

Run `node test.js` to verify.

## Performance

Before opening a PR that touches the physics or render loop, run:

```sh
node perf-test.js
```

The numbers in `README.md` should not regress. The harness benchmarks
both the simulation-active and settled-steady-state paths at 1k, 10k,
30k, 100k, and 300k nodes.

## Submitting

1. **Fork** the repo and branch off `main`
2. **Make your changes** + add tests where reasonable
3. **Verify**: `node test.js` and `node perf-test.js` must pass;
   `node --check` on any changed `.js` / `.cjs` files
4. **Open a pull request** — the PR template will guide you through
   the rest

### Issue and PR templates

When you open an issue or PR, GitHub will offer templates:

- **Bug report** — for something not working
- **Feature request** — for something you'd like added
- **Plugin API issue** — for plugin development questions
- **Pull request** — the PR template asks about testing, docs, and CLA agreement

The templates exist to make your contribution faster to review, not
to gatekeep. If a section doesn't apply, write "n/a" and move on.

### What gets accepted

A PR is more likely to merge if it:

- **Solves a specific problem** — link an issue or explain the use case
- **Is focused** — one logical change per PR, not a kitchen sink
- **Doesn't break existing behavior** — or, if it must, explains why and provides migration
- **Comes with tests** — for parser changes especially, add a fixture
- **Updates docs** — if it changes user-facing or plugin-facing behavior

A PR is more likely to be rejected (politely!) if it:

- Adds a runtime framework dependency (React, Vue, etc.) — see [architecture.md](./docs/architecture.md#why-no-framework)
- Adds network calls — the app is offline by design
- Renames public APIs without strong justification
- Reformats large swaths of code unrelated to the fix

## License and CLA

CodeSynapt uses dual licensing:

- **Main app** (everything outside `plugin-api/`) — **AGPL-3.0-or-later**. See [LICENSE](./LICENSE).
- **Plugin API** (`plugin-api/`) — **MIT**. See [plugin-api/LICENSE](./plugin-api/LICENSE).
- The project maintainer (wing1008) **also offers commercial licenses** of the main app for organizations that can't accept AGPL's copyleft. See [LICENSES.md](./LICENSES.md).

By submitting a pull request, you agree that:

1. Your contribution is your original work (or you have rights to it).
2. You license your contribution under the same terms as the
   surrounding code — **AGPL-3.0-or-later** for changes to the main app,
   **MIT** for changes inside `plugin-api/`.
3. You grant the project maintainer the right to **relicense the
   project (including your contribution) under other terms**, including
   the commercial license described in `LICENSES.md`. This is required
   for the dual-license model to work — without it, the maintainer
   could not sell commercial licenses that include any community
   contribution.

If you're contributing on behalf of a company, make sure you have
authorization. For substantial contributions we may ask for a
signed CLA.

If you don't agree with these terms, you can still:
- Open issues and bug reports
- Fork the project for personal use
- Build plugins (those are MIT and don't require CLA agreement)

## Plugins are different

If you're building a plugin, you don't need to contribute it to this
repository at all. Host it in your own repository under any license
you like. We may maintain a plugin directory at some point — get in
touch if you'd like yours listed.
