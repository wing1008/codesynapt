# Publishing checklist

> **For maintainers only.** This describes the release process — how
> to cut a new version and ship binaries. Regular contributors don't
> need this.

For users who want to install: see [installation.md](../installation.md).
For contributors: see [CONTRIBUTING.md](../../CONTRIBUTING.md).

Before pushing this repository public for the first time.

## 1. Replace placeholders

Search and replace `YOUR_USER` everywhere with your actual GitHub username:

```sh
grep -rln 'YOUR_USER' . | xargs sed -i '' 's|YOUR_USER|your-actual-username|g'   # macOS
grep -rln 'YOUR_USER' . | xargs sed -i 's|YOUR_USER|your-actual-username|g'      # Linux
```

Files affected: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`package.json`.

In `package.json`, also fill in:
- `"author": "Your Name <you@example.com>"`

(Optional but recommended.)

## 2. Update LICENSE

Open `LICENSE` and replace the copyright line if needed. Current line:

```
Copyright (c) 2026 CodeSynapt contributors
```

Leave as-is for community ownership, or change to your name/handle.

## 3. Verify no personal data leaked

```sh
grep -rE "your-email|home/your-username|API_KEY|TOKEN" . \
  --include="*.js" --include="*.cjs" --include="*.json" --include="*.md" \
  | grep -v node_modules
```

Should return nothing.

## 4. Run final checks

```sh
node test.js                  # parser tests pass
node perf-test.js             # performance hasn't regressed
npm run license-check         # all deps still MIT/BSD/Apache
```

All three should pass.

## 5. Commit + tag

```sh
git init                      # if not already
git add .
git commit -m "Initial public release: v0.0.0"
git branch -M main
git remote add origin https://github.com/your-username/codesynapt.git
git push -u origin main
```

## 6. Create the release

codesynapt uses [release-drafter](https://github.com/release-drafter/release-drafter)
to maintain a running draft of the next release notes. Every PR merged
to `main` is automatically categorized into the draft based on its
labels — see [`.github/LABELS.md`](../../.github/LABELS.md).

### Release flow

1. **Review the draft**. Go to the [Releases page](https://github.com/wing1008/codesynapt/releases)
   and find the draft titled `v$NEXT_VERSION`. It's been kept in sync
   by the `release-drafter` workflow since the last release.

2. **Polish the notes** if needed:
   - Reorder items within categories
   - Add a top-level summary paragraph
   - Move misplaced items between sections
   - Add migration notes for breaking changes

3. **Confirm the version number**. release-drafter computes it from
   PR labels:
   - Any PR with `breaking-change` or `major` → major bump
   - Any PR with `feature`, `enhancement`, or `minor` → minor bump
   - Otherwise → patch bump

   Edit the version field if you disagree.

4. **Update `CHANGELOG.md`** with the same content as the release
   notes. Yes, this is duplication for now — `CHANGELOG.md` is for
   people who don't visit GitHub, the release notes are for everyone
   else. (We may automate this further later.)

5. **Bump `package.json`'s version** to match. The `public/app.js`
   `appVersion` constant must also match. Commit both:

   ```sh
   # Update package.json version field, then:
   sed -i "s/appVersion: '0.[0-9]*\.[0-9]*'/appVersion: '$NEW_VERSION'/" public/app.js
   git add package.json public/app.js CHANGELOG.md
   git commit -m "chore: bump to v$NEW_VERSION"
   ```

6. **Tag and push**:

   ```sh
   git tag v$NEW_VERSION
   git push origin main v$NEW_VERSION
   ```

7. **Publish the draft**. Click "Publish release" on GitHub.

8. **CI takes over**. The tag push triggers
   [`.github/workflows/build.yml`](../../.github/workflows/build.yml),
   which builds for all three OSes and attaches binaries +
   `SHA256SUMS-<os>.txt` files to the release automatically.

### What if release-drafter is wrong?

- **Wrong category**: re-label the PR; release-drafter will re-categorize
  the next time it runs.
- **Wrong version bump**: edit the draft's version field directly
  before publishing.
- **Missing PR**: check if the PR has `skip-changelog`, `duplicate`,
  `invalid`, `wontfix`, or `question` — these are excluded by default.
- **First release ever**: release-drafter needs a previous tag to
  diff against. For v0.0.0 → v0.1.0, create the draft manually or
  use the workflow with `workflow_dispatch`.

## 7. After publishing

- **Verify the workflow ran**: check the Actions tab on GitHub.
- **Test a binary** on a clean machine to confirm install + first-run.
- **Add a screenshot** to the README so the project page looks
  alive. Drop a PNG into `docs/screenshot.png` and update the
  README comment.
- **Optional**: submit to Awesome lists (e.g. "Awesome Electron")
  once you have stars / activity.

## Files that ship in the repo

✅ Public (included via `git add .`):
- All source: `electron/`, `public/`, `parser.js`, `scanner.js`, `server.js`
- Tests: `test.js`, `perf-test.js`
- Scripts: `scripts/copy-vendor.js`, `scripts/license-check.js`
- Build: `build/entitlements.mac.plist`, `.github/workflows/build.yml`
- Docs: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, this file
- Config: `package.json`, `package-lock.json`, `.gitignore`

🚫 Excluded by `.gitignore`:
- `node_modules/` (regenerated by `npm install`)
- `dist/` (build outputs)
- `public/vendor/` (regenerated by `postinstall`)
- Editor configs, OS junk files, logs, lock files for other package
  managers
- Anything matching `.env`, `*.key`, `*.pem` (in case you ever add
  secrets locally for testing)

## Files NEVER in the repo

These exist only on the user's machine after they run the app:

- `~/Library/Application Support/CodeSynapt/state.json` (macOS)
- `%APPDATA%\CodeSynapt\state.json` (Windows)
- `~/.config/CodeSynapt/state.json` (Linux)
- `localStorage` inside the Electron app (project info, recent
  files, active-set markings, search history)

These never leave the user's machine. The app has no network access.
