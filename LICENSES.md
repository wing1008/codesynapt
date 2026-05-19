# Licensing overview

filegraph3d uses **dual licensing**. This document explains what that
means in plain language. For the actual legal text, see:

- **[LICENSE](./LICENSE)** — Business Source License 1.1 (main app)
- **[plugin-api/LICENSE](./plugin-api/LICENSE)** — MIT (plugin API)

## The short version

| Part of the project | License | What you can do |
|---|---|---|
| **Main app** — everything outside `plugin-api/` | BSL 1.1 | Free for personal/internal/academic use; commercial redistribution requires permission |
| **Plugin API** — everything inside `plugin-api/` | MIT | Use, modify, distribute, sell — under any license you choose |

## What you can do without asking

### ✅ Allowed under BSL 1.1 (main app)

- **Personal use** of any kind — running it on your own computer for
  any reason
- **Internal use within a business or organization** of any size —
  using filegraph3d to analyze your own or your employer's codebases
- **Academic, educational, research use** — including in classrooms,
  papers, and student projects
- **Inspection and learning** — reading the code, copying snippets
  for educational purposes
- **Forks for personal modification** — make your own private variant
- **Inclusion as a non-primary component** — if dependency visualization
  is not the main feature of your product, you can include filegraph3d

### ✅ Allowed under MIT (plugin API)

Everything. The MIT license covers:

- Build plugins under any license (including proprietary, including
  selling them)
- Fork the plugin API
- Embed plugin API types in your own tools

## What requires a commercial license

### ⛔ Requires permission under BSL 1.1

- **Offering filegraph3d as a paid SaaS** to third parties
- **Selling builds of filegraph3d** (your own packaged versions)
- **Including filegraph3d in a competing commercial product** whose
  primary purpose overlaps with filegraph3d (i.e., another dependency
  visualization tool)

For commercial licensing, contact: `[YOUR_EMAIL]`.

### Things that are NOT commercial use

These are commonly mistaken but are actually fine:

- Your company uses filegraph3d to analyze its codebase ✅ (this is
  internal use, allowed)
- You're a freelancer and use filegraph3d while working on a client
  project ✅ (you're not redistributing filegraph3d)
- Your company sells a product that ships with filegraph3d as a
  bundled developer tool, but the product is something else (e.g., a
  full IDE) ✅ (non-primary use)
- You publish a tutorial / book / video using filegraph3d ✅

## The automatic conversion

The Business Source License is **time-limited**. On **2030-05-14**,
all versions of filegraph3d licensed under BSL automatically convert
to **Apache License 2.0** — which is a permissive open-source license
with no commercial restrictions.

This means:

- Even if filegraph3d is abandoned, the community gets full rights in
  2030
- You can rely on long-term availability
- The "commercial restrictions" are temporary, not perpetual

For each new release, the Change Date may be reset to four years from
that release. But every individual version *does* eventually convert.

## Why this model?

The author wanted three things at once:

1. **Code transparency** — so users can inspect, learn, audit, and
   build plugins
2. **Sustainable maintenance** — by preserving the option to monetize
   commercially if needed to fund ongoing work
3. **A safety net for the community** — so the code is never truly
   locked away

BSL 1.1 (the same license used by Sentry, MariaDB, CockroachDB, and
others) provides all three. Pure MIT would give up #2 entirely; pure
closed-source would give up #1 and #3.

The plugin API stays MIT specifically so the ecosystem can flourish
without any licensing friction. Plugin authors keep full control of
their work.

## Third-party dependencies

filegraph3d bundles several open-source dependencies, all under
permissive licenses (MIT, Apache-2.0, BSD, ISC). The complete list
is verifiable via:

```sh
npm run license-check
```

Key dependencies:

| Package | License |
|---|---|
| `@babel/parser`, `@babel/traverse` | MIT |
| `chokidar` | MIT |
| `three` | MIT |
| `ws` | MIT |
| `electron` | MIT |
| `electron-builder` | MIT |

## Questions

- **General questions about the license** — open a [discussion](https://github.com/YOUR_USER/filegraph3d/discussions)
- **Commercial licensing inquiries** — email `[YOUR_EMAIL]`
- **Reporting a license violation** — open a private issue or contact
  the author directly

This document is for clarity, not a substitute for the legal text in
[LICENSE](./LICENSE) and [plugin-api/LICENSE](./plugin-api/LICENSE). In
case of conflict, those files govern.
