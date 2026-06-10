# Installation

codesynapt ships as a desktop app (Electron). Pre-built binaries are
available for macOS, Windows, and Linux, or you can build from source.

- [Pre-built binaries](#pre-built-binaries)
- [Building from source](#building-from-source)
- [Permissions](#permissions)
- [Verifying the build](#verifying-the-build)
- [Troubleshooting](#troubleshooting)

## Pre-built binaries

Download the latest release from
[Releases](https://github.com/wing1008/codesynapt/releases).

| OS | Recommended | Notes |
|---|---|---|
| **macOS 12+** (Intel / Apple Silicon) | `.dmg` | Unsigned — first launch: right-click → Open → Open Anyway. Or System Settings → Privacy & Security → Open Anyway. |
| **Windows 10/11** | `.exe` installer (NSIS) or portable `.exe` | Unsigned — SmartScreen warns on first run: click "More info" → "Run anyway". |
| **Linux (Debian/Ubuntu)** | `.deb` | Install with `sudo dpkg -i codesynapt_*.deb` |
| **Linux (other)** | `.AppImage` or `.tar.gz` | AppImage needs `libfuse2`: `sudo apt install libfuse2`. The `.tar.gz` has no dependencies — extract and run. |

### Why are the builds unsigned?

Apple developer certificates cost $99/year and Windows EV certificates
cost $300-500/year. Until codesynapt has commercial revenue to cover
these, you'll see a "publisher unverified" warning on first launch.
Click through it — the source is open and the build is reproducible
(see [Verifying the build](#verifying-the-build)).

## Building from source

```sh
git clone https://github.com/wing1008/codesynapt.git
cd codesynapt
npm install
npm start
```

### Requirements

- **Node.js 20+** (LTS or current)
- **macOS 12+**, **Windows 10+**, or a recent Linux distribution
- ~250 MB free disk space for build artifacts

### Common scripts

| Command | What it does |
|---|---|
| `npm start` | Launch the Electron app (production-like) |
| `npm run server -- /path/to/some/project` | Start dev server with hot reload; open `http://localhost:7777` |
| `npm test` | Run the parser smoke test + integration tests |
| `npm run license-check` | Verify all dependencies use permissive licenses |
| `npm run dist` | Build distributable binaries for current OS |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Cross-build for specific OS |

For full release/distribution flow, see [docs/maintainer/publishing.md](./maintainer/publishing.md).

## Permissions

codesynapt needs **only one thing**:

- **File system read access** to the folder you open — granted
  automatically when you pick or drop a folder.

It does **not** need:

- Network access (the app makes zero outbound connections)
- Camera, microphone, or location
- System privileges
- Any kind of account or login

### macOS specifics

On macOS 13+, the first time you open a folder under `Documents`,
`Desktop`, or `Downloads`, macOS may show a permission prompt. Click
"Allow".

codesynapt is built with [hardened runtime](https://developer.apple.com/documentation/security/hardened-runtime)
enabled. The required entitlements (JIT for V8, user-selected
read-only file access) are declared in `build/entitlements.mac.plist`.

## Verifying the build

If you want to verify a downloaded binary matches the published
source, the build is **reproducible** when run in the same Node
version:

```sh
git clone https://github.com/wing1008/codesynapt.git
cd codesynapt
git checkout v0.0.0
npm ci                    # exact dependency versions from package-lock.json
npm run dist              # build for your OS

# Compare the SHA-256 hashes of dist/ against the release page
shasum -a 256 dist/*.dmg  # or *.exe, *.AppImage, *.deb, *.tar.gz
```

Hash values for each release are listed in the release notes on
GitHub.

### Dependency license verification

To check no dependency has slipped in a non-permissive license:

```sh
npm run license-check
```

This walks `node_modules` and fails the script if any package uses
something outside MIT, BSD, Apache-2.0, ISC, or similar permissive
licenses.

## Troubleshooting

### macOS: "App is damaged and can't be opened"

This is Gatekeeper's response to an unsigned app. Fix:

```sh
xattr -cr "/Applications/CodeSynapt.app"
```

Or right-click the app → Open → Open Anyway.

### Windows: "Windows protected your PC"

This is SmartScreen reacting to the unsigned binary. Click
"More info" → "Run anyway".

### Linux AppImage: "FUSE: command not found"

The AppImage runtime needs `libfuse2`:

```sh
sudo apt install libfuse2
```

Or use the `.tar.gz` build instead — it has no FUSE dependency.

### "Permission denied" when opening a folder

On macOS, verify the folder isn't restricted by System Settings →
Privacy & Security → Files & Folders. On Linux, check `ls -ld
/path/to/folder` — you need read+execute on the directory.

### App opens but graph is empty

Check the bottom-right status bar. If it says `0 files scanned`, the
folder doesn't contain any parseable files. codesynapt parses
`.js .jsx .ts .tsx .mjs .cjs .py .rs .go .css` and a few more by
default. For other languages, see the
[parser plugin guide](../plugin-api/docs/types/exporter.md).
