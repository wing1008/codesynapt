# CodeSynapt blast radius — GitHub Action

Post a Markdown PR comment summarising the dependency blast radius of every changed file, and optionally fail the build if a threshold is breached.

## Usage

`.github/workflows/blast-radius.yml`:

```yaml
name: PR blast radius
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  blast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # need full history for git diff
      - uses: actions/setup-node@v4
        with: { node-version: '20' }

      - uses: ./.github/actions/blast-radius   # local action — or point at wing1008/codesynapt/blast-radius@v1 once published
        with:
          comment: 'true'
          max-blast: 50         # optional gate: fail if largest single-file blast > 50
          max-changed: 30       # optional gate: fail if >30 tracked files changed
```

## Inputs

| name | default | description |
|---|---|---|
| `base` | PR base SHA | Git ref to diff against |
| `head` | PR head SHA | Git ref to compare |
| `depth` | `3` | BFS depth for blast radius (1-10) |
| `comment` | `true` | Post Markdown comment on the PR |
| `max-blast` | `0` | Fail build if largest single-file blast exceeds N (0 = no gate) |
| `max-changed` | `0` | Fail build if >N tracked files changed (0 = no gate) |
| `github-token` | `${{ github.token }}` | Token with `pull-requests:write` |

## Outputs

| name | description |
|---|---|
| `changed` | Number of tracked files changed |
| `max-blast` | Largest single-file blast |
| `tests-touched` | Number of test files inside the blast set |

## What the comment looks like

> ## 📦 CodeSynapt impact — `main..HEAD`
>
> Scanned 1,245 files / 3,402 edges. Changed 4 files (tracked 4, ext-untracked 0, deleted 0).
>
> **Largest single-file blast (depth 3):** 31 dependents · **Tests touched:** 4
>
> | File | Status | Dependents (≤ depth) | Tests touched |
> |---|---|---:|---:|
> | `src/auth.ts` | changed | 31 | 4 |
> | `src/api/users.ts` | changed | 12 | 2 |
>
> ### ⚠️ High-impact files
> - `src/auth.ts` — 31 dependents

## How it works

1. Resolves base + head SHAs from the PR (or explicit inputs).
2. `git fetch` with full history so the diff range exists locally.
3. `cs ci-diff <base>..<head> --format=github-comment` — produces Markdown.
4. Posts or updates a single PR comment marked with `<!-- codesynapt-blast-radius -->`.
5. If `max-blast` / `max-changed` set, runs `cs ci-gate` — exits 1 on breach.

## Why

AI-merged PRs are up +98% YoY but review time is up +91%. The bottleneck is reviewers eyeballing "how big is this actually?". This action puts that estimate in the PR description before a human looks.
