# Security Policy

## Data handling

CodeSynapt runs entirely on your local machine. Specifically:

- **No network access.** The app does not connect to any external
  server, telemetry endpoint, or update service. You can verify this
  by inspecting outgoing connections (`lsof -i`, Activity Monitor,
  Resource Monitor) while running the app.
- **No data collection.** No usage analytics, no crash reports
  uploaded, no user identifiers. What you do in the app stays on your
  machine.
- **File system access** is read-only and limited to whatever folder
  you explicitly open. The app never writes to or modifies files in
  the folders you scan.
- **Local-only persistence.** Settings, recent folders, project info,
  and active-set markings are stored in:
  - macOS: `~/Library/Application Support/CodeSynapt/`
  - Windows: `%APPDATA%\CodeSynapt\`
  - Linux: `~/.config/CodeSynapt/`
  - Plus localStorage inside the Electron renderer (per-installation)

  This data is never transmitted anywhere. Deleting these directories
  resets the app to factory defaults.

### Audit + trace logs (local-only)

- **Audit log** of every HTTP control API request lives at `~/.codesynapt/audit/YYYY-MM-DD.jsonl` (NDJSON).
- **AI session traces** of every MCP tool call live at `<project>/.codesynapt/traces/session-<ts>.jsonl`.
- Both are kept for **30 days by default** and auto-pruned on app start. Override with `CS_AUDIT_RETENTION_DAYS=N` env (0 = keep forever).
- Neither is ever transmitted. You can `rm` them at any time.

## What the app reads

When you open a folder, CodeSynapt scans it to extract dependency
relationships:

- File contents are read to extract `import`/`require`/`include`
  statements via Babel AST (for JS/TS) and regex (for other
  languages). The contents are not kept in memory longer than
  needed for that extraction.
- File preview (visible in the inspector) reads the first 100 KB
  of the file you select.
- File metadata (size, modification time, line count) is read.

`.gitignore` and a built-in ignore list (`node_modules`, `dist`,
`.git`, etc.) are respected, so files in those locations are not
scanned.

## Reporting a vulnerability

If you find a security issue:

1. **Do not** open a public GitHub issue.
2. Email the maintainer (see the contact info in `package.json` or
   the GitHub profile linked from this repository).
3. Describe the issue with reproduction steps if possible.

We aim to respond within 7 days and to release a patch within 30
days for confirmed issues.

## Supported versions

Only the latest minor version is supported with security updates. We
follow Electron's support policy for the underlying framework — if
Electron deprecates a version, our app will be updated within one
minor release.

## Code signing status

Currently the released binaries are **not code-signed**. This means
on first launch:

- **macOS** will show "CodeSynapt can't be opened because the
  developer cannot be verified." Right-click the app → Open → Open
  Anyway, or System Settings → Privacy & Security → Open Anyway.
- **Windows** will show "Windows protected your PC" via SmartScreen.
  Click "More info" → "Run anyway".

Code signing requires paid developer certificates from Apple ($99/yr)
and Microsoft EV ($300-500/yr). Until the project has funding for
these, releases will be unsigned. **You should verify the SHA-256 of
any download against the value published on the GitHub Release page**
before running.

## Reproducible builds

The CI workflow (`.github/workflows/build.yml`) builds all release
binaries from the public source code. The SHA-256 of each artifact
is in the GitHub Actions log. You can verify a downloaded binary
matches what the build produced.

To build from source yourself:

```sh
git clone https://github.com/YOUR_USER/codesynapt.git
cd codesynapt
git checkout v0.0.0   # whichever version you want to verify
npm ci                  # exact deps from package-lock.json
npm run dist:mac        # or dist:win, dist:linux
shasum -a 256 dist/*.dmg
```
