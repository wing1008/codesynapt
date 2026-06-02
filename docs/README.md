# codesynapt documentation

This folder contains the main application docs. For **plugin development**,
see [`../plugin-api/`](../plugin-api/).

## For users

| Doc | What's in it |
|---|---|
| [installation.md](./installation.md) | Pre-built downloads, building from source, OS-specific notes, permissions, build verification |
| [features.md](./features.md) | Every feature in the app: graph, file tree, search, active sets, themes, exports |
| [controls.md](./controls.md) | Keyboard shortcuts, mouse / pointer interactions, accessibility |

## For developers

| Doc | What's in it |
|---|---|
| [architecture.md](./architecture.md) | How codesynapt works under the hood — parser, scanner, layout, rendering pipeline |
| [../plugin-api/README.md](../plugin-api/README.md) | Plugin development (themes, exporters, parsers, etc) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contributing code back to the main repo |

## For maintainers

| Doc | What's in it |
|---|---|
| [maintainer/publishing.md](./maintainer/publishing.md) | Release process, version bumps, signing builds, attaching artifacts |
| [../SECURITY.md](../SECURITY.md) | Security policy and vulnerability disclosure |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history |

## Root-level files (not in this folder)

These live in the repo root because GitHub auto-detects them or users
expect them there:

| File | Why root |
|---|---|
| [`../README.md`](../README.md) | Landing page — shown on the repo homepage |
| [`../LICENSE`](../LICENSE) | Required at root for legal clarity |
| [`../LICENSES.md`](../LICENSES.md) | Plain-language explanation of dual licensing |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Convention — users look here first |
| [`../SECURITY.md`](../SECURITY.md) | GitHub auto-detects (Security tab) |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | GitHub auto-detects (shown on PR) |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | GitHub auto-detects (shown on Issues) |
| [`../AGENTS.md`](../AGENTS.md) | AI coding agent guide |

## `.github/` folder

Repository configuration for GitHub:

| File | What it does |
|---|---|
| [`../.github/SUPPORT.md`](../.github/SUPPORT.md) | Where users go for help — auto-linked from Issues |
| [`../.github/LABELS.md`](../.github/LABELS.md) | Label conventions (maintainer reference) |
| [`../.github/FUNDING.yml`](../.github/FUNDING.yml) | Sponsor button configuration |
| [`../.github/dependabot.yml`](../.github/dependabot.yml) | Automated dependency updates |
| [`../.github/release-drafter.yml`](../.github/release-drafter.yml) | Release notes drafter config |
| [`../.github/labeler.yml`](../.github/labeler.yml) | Auto-labeler config |
| `../.github/ISSUE_TEMPLATE/` | Bug, feature, plugin issue templates |
| `../.github/PULL_REQUEST_TEMPLATE.md` | PR template |
| `../.github/workflows/` | CI, build, release-drafter, labeler workflows |

