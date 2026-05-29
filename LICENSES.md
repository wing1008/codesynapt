# Licensing overview

CodeSynapt uses **dual licensing**. This document explains what that
means in plain language. For the actual legal text, see:

- **[LICENSE](./LICENSE)** — GNU Affero General Public License v3.0 (main app)
- **[plugin-api/LICENSE](./plugin-api/LICENSE)** — MIT (plugin API)

## The short version

| Part of the project | License | What you can do |
|---|---|---|
| **Main app** — everything outside `plugin-api/` | **AGPL-3.0** | Free for any use; if you modify it and offer it as a network service, you must share your source under AGPL too |
| **Plugin API** — everything inside `plugin-api/` | **MIT** | Use, modify, distribute, sell — under any license you choose |

## What you can do without asking (AGPL-3.0)

- **Personal use** — run it on your own computer for any reason
- **Internal use within a business or organization** — use CodeSynapt
  to analyze your own or your employer's codebases. Running it internally
  for your team does NOT trigger AGPL's network-share clause.
- **Academic, educational, research use**
- **Inspection and learning** — read the code, copy snippets
- **Forks for personal modification** — make your own private variant
- **Build plugins under any license** — including proprietary, including selling them (plugin API is MIT)

## When does AGPL apply?

AGPL-3.0's copyleft kicks in when **you offer a modified version to others
over a network**:

- Modified CodeSynapt running as a **hosted SaaS** that other people sign up for? → You must publish your modified source under AGPL.
- Modified CodeSynapt **bundled into a closed-source product** you distribute? → Same — derived work must be AGPL.
- Modified CodeSynapt running **only inside your company**, used by your own employees? → AGPL does NOT require disclosure. Internal use is free.
- **Unmodified** CodeSynapt as part of your workflow? → No obligations beyond keeping the LICENSE file with it.

This is the same model used by Plausible Analytics, Cal.com, MongoDB
Compass, and many other modern OSS projects.

## What a commercial license unlocks

If AGPL's copyleft is incompatible with your use case (e.g. you want
to ship a modified version in a closed-source SaaS, or embed CodeSynapt
inside a proprietary product), a **commercial license** lifts those
obligations.

Pricing scales with deployment size and revenue:

| Tier | Who | Typical pricing |
|---|---|---|
| **Open Source** | Anyone OK with AGPL | Free |
| **Starter** | Individuals / sub-$100k annual revenue | Contact for quote |
| **Growth** | $100k–$1M annual revenue | Per-developer or revenue-based |
| **Enterprise** | $1M+ annual revenue | Negotiated (revenue %, support SLA, etc.) |

For commercial licensing inquiries, open a GitHub Discussion or contact:
**wing1008** on GitHub (DM via issues or use the contact form linked
from the project README).

## What is NOT commercial use

These are commonly mistaken but are actually fine under AGPL-3.0
without a commercial license:

- Your company uses CodeSynapt internally to analyze its codebase ✅
- You're a freelancer running CodeSynapt while working on a client project ✅
- You ship CodeSynapt **unmodified** as part of a developer workflow ✅
- You publish a tutorial / book / video using CodeSynapt ✅
- You contribute back upstream improvements ✅ (this is what AGPL encourages)

## Plugin API (MIT)

Everything inside `plugin-api/` is **MIT-licensed**. This means:

- Build plugins under any license (including proprietary, including selling them)
- Fork the plugin API
- Embed plugin API types in your own tools
- The MIT boundary is intentional — we want a thriving plugin ecosystem
  without AGPL "viral" concerns

## Why dual-licensed?

CodeSynapt is built and maintained by **one person in their spare time**
(wing1008). The dual model balances three goals:

1. **Freedom to use** — anyone can use CodeSynapt for any purpose
2. **Sustainability** — companies building businesses on top of CodeSynapt
   contribute back, either as code (AGPL) or as a commercial license fee
3. **Plugin ecosystem** — plugin authors aren't constrained by AGPL

This is the same approach used by:

- **MariaDB** (GPL + Commercial)
- **MySQL** (GPL + Commercial)
- **Plausible Analytics** (AGPL + Enterprise)
- **Cal.com** (AGPL + Enterprise)
- **Sourcegraph** (AGPL + Enterprise)

## Third-party dependencies

CodeSynapt bundles several open-source dependencies, all under
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
| `electron-updater` | MIT |
| `@electron/fuses` | MIT |

### Bundled runtime (Windows installer only)

The Windows `.exe` installer bundles a copy of Node.js 22 LTS (the
`node.exe` binary, ~76 MB) as an optional install component. If your
system already has Node.js installed, the installer auto-detects it
and skips the bundle to save disk space.

| Bundled binary | Version | License | Source |
|---|---|---|---|
| Node.js | 22.11.0 LTS (Jod) | MIT | <https://nodejs.org/dist/v22.11.0/> |

Node.js is itself a project bundling many components (V8, libuv,
OpenSSL, etc.) — each with their own permissive license. Full
attribution: <https://github.com/nodejs/node/blob/main/LICENSE>.

## Questions

If you're unsure whether your use case requires a commercial license,
open a GitHub Discussion and we'll help clarify. **There are no
gotchas — internal company use is always free under AGPL-3.0.**
