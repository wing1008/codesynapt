<!--
Thanks for your contribution! Please fill out the sections below.

Tip: small, focused PRs are easier to review and merge faster than
big ones. If you're making a large change, consider breaking it up.
-->

> **⚠ Required — apply a label.** For this PR to land in the next release's
> CHANGELOG, a maintainer must add ONE of these GitHub labels before merge:
> `breaking-change` · `feature` · `bug` · `enhancement` · `documentation` ·
> `dependencies` · `chore` · `security` · `performance` · `refactor` · `tests`.
>
> External contributors: fill in the "Type of change" checkboxes below — a
> maintainer will translate them into the matching label. (Unlabeled PRs are
> silently dropped from the changelog by release-drafter.)

## What this PR does

<!--
A short summary of the change. Be specific — "fix bug" or "improve
performance" aren't enough. Examples of good summaries:

- "Add `theme` permission to plugin manifest validator"
- "Fix selection ring rendering when zoomed in past 200%"
- "Reduce parser allocations on large JS files"
-->

## Why

<!--
The motivation. What problem does this solve? Who asked for it? Link
related issues:

  Closes #123
  Related to #456
-->

## Type of change

<!-- Check all that apply -->

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature causing existing functionality to change)
- [ ] 📚 Documentation update
- [ ] 🔌 Plugin API change
- [ ] 🎨 UI / theme change
- [ ] ⚡ Performance improvement
- [ ] 🧰 Refactor / cleanup
- [ ] 🔒 Security fix

## How I tested this

<!--
Describe how you verified your change works. Include:
- Commands you ran
- Scenarios you tested manually
- Edge cases you considered
-->

- [ ] `npm test` passes (parser smoke test)
- [ ] `node --check` passes for all changed `.js` / `.cjs` files
- [ ] Tested manually on a real folder (size: ___ files)
- [ ] Tested with the Electron app (not just browser mode)
- [ ] (If touching plugins) Tested with at least one example plugin

<!-- For UI changes, please attach a screenshot or short video. -->

## Screenshots / video

<!-- Drag images or recordings here for UI changes. -->

## Documentation

- [ ] No docs needed — internal change only
- [ ] Updated `CHANGELOG.md` (user-visible change)
- [ ] Updated `docs/` (architecture or feature change)
- [ ] Updated `plugin-api/docs/` (plugin API change)
- [ ] Updated `README.md`

## Breaking changes

<!--
If this is a breaking change, describe:
- What broke
- Why the break is necessary
- Migration path for existing users (or existing plugins)
-->

## Checklist

- [ ] My code follows the project's code style (see CONTRIBUTING.md)
- [ ] I performed a self-review of my changes
- [ ] I added comments for any non-obvious logic
- [ ] I made corresponding documentation changes
- [ ] My changes generate no new warnings
- [ ] I agree to license my contribution under:
  - **AGPL-3.0-or-later** for changes outside `plugin-api/` (with relicense grant to maintainer)
  - **MIT** for changes inside `plugin-api/`
  (See CONTRIBUTING.md for the full CLA terms.)

<!--
After submitting:
- A maintainer will review and may request changes
- Please respond within a reasonable time, or the PR may be closed
- Be patient — this is a small project with one maintainer
-->
