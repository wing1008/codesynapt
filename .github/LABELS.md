# Label conventions

> Maintainer reference. Lists every label this repository uses, what
> it means, and which automation depends on it.

filegraph3d uses GitHub labels for three purposes:

1. **Triage** — what kind of issue/PR is this?
2. **Release-drafter categorization** — which section of the release notes?
3. **Version resolution** — does this trigger major/minor/patch?

Auto-labeler ([`.github/labeler.yml`](./labeler.yml)) applies many of
these automatically based on changed files; the rest the maintainer
applies during triage.

## Label inventory

### Type — kind of work

| Label | Color | Used by | Description |
|---|---|---|---|
| `bug` | `#d73a4a` red | Bug Report template, release-drafter | Something not working as expected |
| `enhancement` | `#a2eeef` light blue | Feature Request template, release-drafter (minor bump) | A new feature or enhancement |
| `feature` | `#a2eeef` light blue | release-drafter (minor bump) | Same as `enhancement`; either is accepted |
| `documentation` | `#0075ca` blue | Auto-labeler (`*.md`, `docs/`), release-drafter | Documentation-only change |
| `chore` | `#cccccc` gray | release-drafter | Maintenance work, no user impact |
| `refactor` | `#cccccc` gray | release-drafter | Code cleanup without behavior change |

### Area — which part of the codebase

| Label | Color | Used by | Description |
|---|---|---|---|
| `plugin-api` | `#9b59b6` purple | Plugin Issue template, Auto-labeler, release-drafter | Touches `plugin-api/`, `plugin-loader.cjs`, or `plugin-host.js` |
| `ui` | `#e879a6` pink | Auto-labeler, release-drafter | Touches `public/style.css`, `index.html`, or `app.js` |
| `theme` | `#e879a6` pink | Auto-labeler, release-drafter | Theme-related changes |
| `ci` | `#f9c513` yellow | Auto-labeler, release-drafter | GitHub Actions / build scripts |
| `dependencies` | `#0366d6` blue | Dependabot, Auto-labeler, release-drafter | Dependency updates |

### Process — workflow state

| Label | Color | Used by | Description |
|---|---|---|---|
| `needs-triage` | `#fbca04` yellow | All issue/PR templates | Maintainer hasn't reviewed yet |
| `good-first-issue` | `#7057ff` purple | Maintainer (manual) | Beginner-friendly issue for new contributors |
| `help-wanted` | `#008672` green | Maintainer (manual) | Maintainer would welcome a PR |
| `duplicate` | `#cfd3d7` gray | Maintainer (manual), release-drafter (excluded) | Duplicate of an existing issue/PR |
| `invalid` | `#e4e669` light yellow | Maintainer (manual), release-drafter (excluded) | Not a real bug or out of scope |
| `wontfix` | `#ffffff` white | Maintainer (manual), release-drafter (excluded) | Won't be acted on |
| `question` | `#d876e3` light purple | release-drafter (excluded) | Question rather than work item |
| `skip-changelog` | `#cccccc` gray | release-drafter (excluded) | Don't include in release notes |

### Impact — for release-drafter version bumping

| Label | Used by | Effect |
|---|---|---|
| `breaking-change` | release-drafter | Major version bump (1.0 → 2.0) |
| `major` | release-drafter | Major version bump |
| `minor` | release-drafter | Minor version bump (1.0 → 1.1) |
| `patch` | release-drafter | Patch version bump (1.0 → 1.0.1) |

If no version label is set, release-drafter defaults to **patch**.

### Special — release-drafter categories

These appear in release notes but are usually applied via the labels
above:

| Label | Release-notes section |
|---|---|
| `security` | 🔒 Security |
| `performance` / `perf` | ⚡ Performance |
| `fix` / `bugfix` | 🐛 Bug fixes (same as `bug`) |
| `cleanup` | 🧰 Maintenance |

## First-time setup

To create all these labels in a fresh repository, run from the
repo root (requires the [`gh` CLI](https://cli.github.com/)):

```sh
# Type labels
gh label create bug                 --color d73a4a --description "Something not working as expected"
gh label create enhancement         --color a2eeef --description "A new feature or improvement"
gh label create feature             --color a2eeef --description "Same as enhancement"
gh label create documentation       --color 0075ca --description "Documentation-only change"
gh label create chore               --color cccccc --description "Maintenance work"
gh label create refactor            --color cccccc --description "Code cleanup, no behavior change"

# Area labels
gh label create plugin-api          --color 9b59b6 --description "Plugin API surface"
gh label create ui                  --color e879a6 --description "UI / styles"
gh label create theme               --color e879a6 --description "Theme system"
gh label create ci                  --color f9c513 --description "Build / CI / automation"
gh label create dependencies        --color 0366d6 --description "Dependency updates"

# Process labels
gh label create needs-triage        --color fbca04 --description "Awaiting maintainer review"
gh label create good-first-issue    --color 7057ff --description "Beginner-friendly"
gh label create help-wanted         --color 008672 --description "Maintainer would welcome a PR"
gh label create duplicate           --color cfd3d7 --description "Duplicate of another issue"
gh label create invalid             --color e4e669 --description "Not a real bug or out of scope"
gh label create wontfix             --color ffffff --description "Won't be acted on"
gh label create question            --color d876e3 --description "Question rather than work item"
gh label create skip-changelog      --color cccccc --description "Exclude from release notes"

# Impact labels
gh label create breaking-change     --color b60205 --description "Triggers major version bump"
gh label create major               --color b60205 --description "Major version bump"
gh label create minor               --color 1d76db --description "Minor version bump"
gh label create patch               --color cccccc --description "Patch version bump"

# Special categorization
gh label create security            --color ee0701 --description "Security fix or hardening"
gh label create performance         --color 00a86b --description "Performance improvement"
```

Or paste this as a single block.

## When to add a new label

Add a label when:

- The release-drafter or labeler config references it
- A common category of issue keeps appearing in the wild
- It helps newcomers find their first contribution

Don't add a label for:

- One-off classifications ("issue raised by Alice on Tuesday")
- States the existing labels already cover
- Aesthetic categorization without functional purpose

When adding, update both:

1. This file
2. The relevant config file (`labeler.yml` and/or `release-drafter.yml`)
