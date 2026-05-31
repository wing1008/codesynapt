# CodeSynapt — internal audit (2026-05-31)

Honest, internal-only assessment of weaknesses, hardcoded values
that could bite at deploy time, and prioritised improvement paths.
Written for engineers and for the project owner; no marketing
language.

## 1. Hardcoded / deployment-risky values

### Found and fixed in this audit pass

| File | Issue | Status |
|------|-------|--------|
| `public/app.js` (status-bar `syms` cell) | Fetched `http://127.0.0.1:7707/symbol/summary` with the port literal. Control server tries 7707..7716 to find a free port; the second instance always silently broke. | **Fixed** — now reads `window.codesynapt.controlPort()` via IPC and falls back to 7707. |

### Found, deliberately left as-is (justified)

| File | Value | Why it's OK |
|------|-------|-------------|
| `electron/main.cjs` | Default port 7707 in `CONTROL_DEFAULT_PORT` | Documented, env-overridable (`CS_PORT`/`FG3D_PORT`), and the server auto-bumps on conflict. Hardcoded base is fine. |
| Multiple files | Brand strings `wing1008`, `codesynapt`, repo URL | Intentional — this is the maintainer's project, those values *should* ship as-is. |
| Workflow `secrets.GITHUB_TOKEN` | Standard GitHub-provided token | Standard practice. |
| Three.js / Babel hardcoded options | Library API surfaces | Locked deliberately for repeatable builds. |
| Mac vs others branch (`process.platform === 'darwin'`) | UI-only (titleBarStyle, traffic-light padding) | Standard cross-platform Electron pattern. |

### Found, low risk but should be revisited

| File | Value | Risk level | Notes |
|------|-------|------------|-------|
| `public/app.js` (other fetch / DOM calls — none found other than the one fixed) | — | None | The status-bar fix is the only frontend port usage. |
| Scattered `console.log` (35 occurrences across 10 files) | Build noise | Low | Mostly in `scripts/`, `test.js`, `electron/main.cjs` boot logs. Acceptable. |
| `engines: { node: '>=20' }` | Minimum Node version | Low | Documented in `package.json`. Lockfile is committed. |

## 2. Dependency vulnerabilities (`npm audit`)

Total: **15 vulnerabilities (5 moderate, 10 high)** — every one is in
**devDependencies only**. Runtime / shipping app is not affected.

| Package | Severity | Where | Risk |
|---------|----------|-------|------|
| `esbuild ≤ 0.24.2` | moderate | `vitest` (transitive) | Dev-time only. Dev-server vulnerability — affects `vitest --ui`. We don't use that mode. |
| `vite`, `vite-node`, `@vitest/mocker` | moderate | `vitest` (transitive) | Same chain as above. |
| `vitest 0.0.1–3.0.0-beta.4` | moderate | direct devDep | Pinned to 2.1.9; bump to 4.x would force lots of test refactors. Deferred. |
| `tar ≤ 7.5.10` | high | `electron-builder` (transitive) | Path traversal / symlink poisoning during archive extraction. Only triggered by `npm run dist:*` on Linux/macOS — Windows builds use a different code path. Mitigated by trusting our own build inputs. |
| `@electron/rebuild`, `app-builder-lib` | (inherits `tar`) | `electron-builder` | Same chain. |

**Action:** none required for runtime. `npm audit fix --force` would
bump `electron-builder` to a major version (potential build breakage)
and `vitest` to 4.x (test rewrites). Both should be done **after**
release, not before.

## 3. Functional weaknesses (objective)

What the tool genuinely does worse than its peers today.

### 3.1 Parser / index accuracy

| Area | What we do | What's missing | Severity |
|------|------------|----------------|----------|
| **Symbol coverage** | 32–94 % of codegraph's symbol count on the six benchmark repos | Expression-level identifier nodes (every `x.y` chain is one node in codegraph) | Mid — affects "how many things can the AI ask about" |
| **TS edge count** | excalidraw 1,394 edges vs codegraph 31,251 (4 %) | ref edges with strict resolver miss too many cross-file relations; tsconfig paths helped but only +20 % | High — visible in the bench |
| **Kotlin / Swift `call_expression` coverage** | nameOf() catches function names, but call resolution to imported methods still weak | tree-sitter query tuning for Kotlin's `selector_expression`, Swift `navigation_expression` final hops | Mid |
| **Type-aware method matching** | Minimal PoC: `new X()` and TS `let x: X` only | Parameter types, function-return inference, generic-aware resolution, scope chains beyond enclosing function | High — `obj.method()` still randomly resolves on ambiguity |
| **Re-export chain effect on the bench** | Implemented and correct, but bench impact = +2 edges on excalidraw | Most resolver hits are call-edges with the loose any-file fallback, so re-export gain is hidden | Low — code is right, measurement just doesn't surface it |
| **Inheritance chain method lookup** | extends/implements edges exist, but the resolver doesn't yet follow them | When `Foo extends Bar` and a call is `foo.barMethod()`, we don't try `Bar.barMethod` after `Foo.barMethod` misses | Mid — needed for OOP-heavy codebases |
| **Route handler extraction** | Express / Fastify / Hono done | FastAPI (`@app.get`), NestJS (`@Get()`), Gin (`r.GET`), Spring (`@GetMapping`), Rails (`get '/'`) | Mid |
| **DB schema coverage** | Prisma, Drizzle, Mongoose, TypeORM, SQLAlchemy | Sequelize, Knex, MikroORM, Ent (Go), Diesel (Rust), Hibernate (Java) | Low — long tail |
| **Cross-language FFI** | WASM / `.node` addon / ctypes / JNI / `extern "C"` | gRPC / protobuf message → handler, JNI method → Java target | Low |

### 3.2 Comparative ground we haven't claimed

| Capability | Who has it | We don't because |
|------------|------------|------------------|
| **Compiler-grade type inference** | Sourcegraph (LSIF), Cursor (real LSP / tsserver) | We use heuristics. Closing this gap means embedding `typescript` or running language servers — 2–3 weeks. |
| **20+ language support** | Sourcegraph, Cursor | We support 9 with varying fidelity. tree-sitter-wasms bundles ~30, so adding 10 more is mostly wiring (1 week). |
| **Editor-native experience** | Cursor (IS the editor), Continue.dev (VS Code extension) | We're a desktop app + MCP. A VS Code extension is the obvious next surface (~2–3 weeks). |
| **Auto-install across AI agents** | codegraph: `codegraph install` registers MCP in 8 agents | We require manual MCP config edits. `codesynapt install` is a few days of work. |
| **Persistent on-disk index** | codegraph (SQLite, 5–110 MB) | We're memory-only. Strength for small / medium projects, real limitation past ~50k files. |
| **Enterprise features** | Sourcegraph (sole focus) | No SSO, audit log, RBAC, multi-repo cross-search. Out of scope for the indie target. |
| **Headless / CI mode** | Sourcegraph, Aider, Repomix | We have `cs serve` headless mode but it's underdocumented; needs a dedicated install story. |

### 3.3 Unmeasured assumptions

| Claim | Status |
|-------|--------|
| "3–79× faster indexing than codegraph" | Measured on six repos up to 3,482 files. Untested past that. |
| "0–5 ms query latency" | Same — in-memory map lookup; safe extrapolation but no proof beyond bench size. |
| "AI agent answers cheaper with CodeSynapt" | **Not measured.** Requires `claude -p` runs with `ANTHROPIC_API_KEY`. Pure speculation otherwise. |
| "Symbol-mode parsers ship accurate Kotlin/Swift call edges" | We patched the name extraction but tree-sitter query tuning is still partial. Real-world OkHttp tests pass; broader Kotlin codebases unverified. |
| "AGPL + commercial dual works for our use case" | The license is set; we have not yet validated the commercial sales workflow with a real customer. |

## 4. Stability and operational gaps

| Gap | Impact | Notes |
|-----|--------|-------|
| **No production crash telemetry** | If users hit issues we never hear about them | Intentional (offline-by-design), but means we're blind to real-world failure modes. |
| **No automated end-to-end test** for the full electron+MCP+desktop flow | Manual smoke tests only | Add one Playwright run per release. |
| **No load test** on the in-memory symbol graph | We don't know the memory ceiling | Run with a synthetic 50k-symbol repo, plot memory growth. |
| **Auto-updater is on but unverified at scale** | `electron-updater` ships, but we've only tested 0.14.4 → 0.14.5 silent upgrade | Verify each release cycle. |
| **No rate limiting on `/symbol/explore`** | A pathological client could spam expensive scans | Localhost-only so risk is low; add a 1-req/sec cap to be safe. |
| **`startScanner` cancellation** | Mid-scan project swap leaves the old chokidar watcher to finish naturally | Works in practice but is wasted work; a real cancel token would help. |
| **No `.codesynaptignore` documentation in README** | Power users won't discover the escape hatch | Mention in README. |

## 5. Documentation gaps

| Topic | Status |
|-------|--------|
| Headless / CI mode (`cs serve`) | Mentioned in CHANGELOG, not in README |
| Symbol mode endpoints (`/symbol/*`) | Plan doc only, no user guide |
| `cs_symbol_*` MCP tool usage examples | Tool descriptions only |
| Troubleshooting (port already in use, no MCP detected, etc.) | None |
| Comparison vs codegraph / Cursor / Sourcegraph | Internal notes only — should ship a public comparison page eventually |
| Telemetry / privacy stance | Mentioned in README but no dedicated page |

## 6. Prioritised improvement plan

### Sprint 1 (this week — high value, low cost)

1. **`codesynapt install` MCP-config writer** (2–3 days). One command registers the server in Claude Code / Cursor / Codex / opencode. Removes the biggest sticking point vs codegraph.
2. **Hybrid `/symbol/explore` response** (half day). Top 3 entries with full body, the rest signatures only. Cuts first-call tokens by ~40 % to match codegraph's profile.
3. **FastAPI / Gin / NestJS route handler extraction** (2 days). The Express coverage we shipped is good; the rest are next-easiest wins.
4. **Document `cs serve` headless mode** in README (half day).
5. **Add `.codesynaptignore` reference** to README (half day).

### Sprint 2 (1–2 weeks)

6. **Inheritance-aware method resolution** (3–4 days). If `foo.method()` misses on `Foo.method`, walk extends chain to `Bar.method`. Reuses the inheritance edges we already emit.
7. **Tree-sitter Kotlin / Swift query tuning** (2 days). Close the remaining `selector_expression` / `navigation_expression` gaps surfaced in OkHttp/Alamofire.
8. **VS Code extension scaffold** (1 week). Inline node info + symbol-mode answers in the editor sidebar.
9. **50k-symbol load test + memory profile** (1 day). We need real numbers before we promise anything about big repos.

### Sprint 3 (3–4 weeks)

10. **`typescript` compiler API integration for TS type inference** (2–3 weeks). Brings us within striking distance of Cursor/Sourcegraph on TS accuracy.
11. **Agent benchmark with `ANTHROPIC_API_KEY`** (~$33, half day). The codegraph headline number, re-run honestly against CodeSynapt.
12. **Optional persistent index** (1 week). For repos > 20k files only. Default stays in-memory — speed is the moat.

### Deferred / explicit non-goals

- LSP server replacement (not our market — Cursor/Sourcegraph win there).
- Enterprise SSO/RBAC (out of scope).
- Hosted cloud service (changes the business model; not now).
- AI model lock-in (agent-agnostic via MCP is the strategic choice).

## 7. Risk register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Real user installs the desktop app, port 7707 is taken, status-bar `syms` cell silently fails | **Was high — fixed** in this audit pass | IPC lookup now used. Smoke-test on second instance before release. |
| Larger TS monorepo (>10k files) blows memory limits we never tested | Mid | Run the 50k-symbol load test in Sprint 2 before any "scales to monorepo" claim. |
| `electron-builder` tar vulnerability is exploited via a malicious dependency in our own `package.json` | Low (we control inputs) | Upgrade `electron-builder` in the next major release window. |
| Sourcegraph or codegraph ships a "3D viewer plugin" and erases our visual differentiation | Mid (12–24 month horizon) | Compound the visual lead — live trace, blast radius pulse, time-lapse — make the *integration* (not the 3D itself) the moat. |
| AI agent ecosystem shifts away from MCP | Low–mid | Keep adapter layer thin; cs_symbol_* can be exposed via a REST shim if MCP loses adoption. |

## 8. What this audit did *not* cover

- Localization completeness (the i18n table has hardcoded fall-throughs we didn't enumerate).
- Accessibility audit of the desktop UI.
- Internationalised file paths (CJK / RTL filenames in symbol IDs).
- A real penetration test of the control server. Port is localhost-only with DNS-rebinding defence, but a focused test hasn't been done.

---

*Reviewed against the codebase at commit `a0d7b15` (2026-05-31).
Re-run this audit at every major version bump.*
