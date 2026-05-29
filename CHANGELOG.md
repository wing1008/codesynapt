# Changelog

All notable changes to CodeSynapt (formerly `CodeSynapse`, originally `filegraph3d`).

## 0.15.0 — 2026-05-29 (license switch: BSL 1.1 → AGPL-3.0 + Commercial Dual)

### Changed (breaking — license)
- **License: BSL 1.1 → AGPL-3.0-or-later** for the main app. Same dual structure as MariaDB/Plausible/Cal.com:
  - **AGPL-3.0** for community use (free, including internal company use)
  - **Commercial license** available for organizations that need to use CodeSynapt without AGPL's source-disclosure obligation (closed-source SaaS, embedded in proprietary product). Pricing scales with revenue tier (Starter / Growth / Enterprise) — see [LICENSES.md](./LICENSES.md).
  - Plugin API (`plugin-api/`) stays **MIT** — plugin ecosystem unchanged.
- **Why the switch**: BSL converts to Apache automatically in 2030, removing future commercial leverage. AGPL is permanent copyleft + OSI-approved + the modern dual-license standard (Plausible, Cal.com, Sourcegraph, MariaDB).
- **What this means for users**:
  - Personal / internal-company / academic / research use → **unchanged, still free**
  - Modifying CodeSynapt and offering it as a **public hosted service** → must publish modifications under AGPL OR buy a commercial license
  - Distributing modified CodeSynapt inside a proprietary product → same
- **CLA**: contributor license agreement updated so the maintainer (`wing1008`) retains the right to relicense for commercial customers. Plugin API contributions stay MIT.

### Added
- **GitHub Sponsors + Buy me a Coffee links** activated in `.github/FUNDING.yml`.
- README **Support the project** section with sponsor / coffee / commercial-license callouts.
- LICENSES.md fully rewritten — plain-language explanation of the AGPL + Commercial dual model, with revenue-tier guidance for commercial licensing.

### Migration notes
- `package.json` `"license": "AGPL-3.0-or-later"` (was `BUSL-1.1`).
- README badge changed (BSL → AGPL + Commercial-Available).
- Internal docs (AGENTS.md / CLAUDE.md / docs/architecture.md / plugin-api/README.md) updated.
- The old LICENSE text (BSL 1.1 with `[YOUR_NAME]` placeholders) is replaced by the canonical AGPL-3.0 text plus a CodeSynapt-specific preamble and commercial-license pointer.


## 0.14.9 — 2026-05-28 (cs CLI shim + bundled Node + full-text search + 안정성 polish)

### Added
- **`cs` CLI globally on PATH after `.exe` install** — NSIS installer adds `%LOCALAPPDATA%\Programs\CodeSynapt\bin` to user `PATH`. `cs --help` works in any new shell with zero extra setup.
- **Bundled Node 22 LTS** — installer auto-detects system Node (`where node`). If present, bundled Node section is unchecked by default (saves 76 MB). If absent, bundled is checked. Both branches always work — shim tries bundled first, falls back to system PATH `node`.
- **`cs ensure` 두 환경 자동 감지** — installed `.exe` 환경(`%LOCALAPPDATA%\Programs\CodeSynapt\CodeSynapt.exe`)에서는 그걸로 spawn, dev 환경(`node_modules/electron`)에서는 electron 바이너리. spawn 시 `CS_INITIAL_ROOT` env 주입.
- **Full-text search** (`cs search <q>` / `cs_query({action:'search'})` / `GET /search?q=`) — mtime-keyed LRU 캐시 (100 MB), concurrency 32 + per-file 5s timeout, batch 256, early-bail at max=100, regex/case 옵션.
  - Cache invalidation: scanner의 `file-changed` / `file-removed` 이벤트 자동 hook + stat 기반 보험. 변경/추가/제거 모두 자동 반영.
  - **Scan-progress guard**: 초기 scan 진행 중 503 응답 ("scan in progress") — hang 회피. `scanner.initialScanComplete` flag 기준.
  - **Known limitation**: 거대 repo + cold + scan 직후의 race 케이스에서 search가 가끔 hang. AI는 자동으로 Read+Grep fallback. worker_threads 격리는 별도 작업으로 보류.
- **`window.codesynapt` IPC namespace** — preload.cjs가 새 정식 이름 + legacy `window.fg3d` alias 동시 노출. renderer 48 사이트 (`window.fg3d.` → `window.codesynapt.`) 일괄 갱신. 외부 플러그인은 alias로 그대로 동작.

### Changed
- **`asar: false`** — 패키징 시 source를 unpack 상태로. `cs ensure` 및 `cs *` CLI shim이 `node_modules` 외부에서 `codesynapt.cjs`를 require 가능하도록.
- **WebGPU UI 정직성** — 설정 패널의 "GPU only" 라디오를 disabled + greyed out + tooltip "Coming in v0.6 / Always CPU for now". 한국어/영어 i18n 텍스트 모두 정정 (이전 "최고 성능" 약속 제거). backend 코드는 이전부터 정직 stub (`stepGPU = null`).
- **README 3-path 셋업** — Path 1 (.exe), Path 2 (git clone + npm link), Path 3 (CLI/MCP only). `cs init` + `/codesynapt` 슬래시 흐름 명시.
- **CLI 표기 일관성** — README 전반에서 `node packages/core/bin/codesynapt.cjs xxx` → `cs xxx`.

### Fixed
- **NSIS spawn `EINVAL`** (Windows) — `npm.cmd start` + `detached + shell:false` 조합 회피. `require('electron')` 또는 installed `CodeSynapt.exe`를 직접 spawn.
- **`window.fg3d` legacy alias 유지** — 새 namespace로 마이그레이션하되 옛 이름도 같은 객체에 노출해 점진 마이그레이션 가능.
- **`perf-test.js` orphan** → `scripts/perf-test.js` 이동 + `package.json` `"bench": "node scripts/perf-test.js"` 추가. root 정리.

### Build
- Windows 빌드는 **Developer Mode 필수** (winCodeSign 캐시 추출 시 macOS .dylib symlink 권한).
- `build/installer.nsh` NSIS hook: Components 페이지에 "Bundled Node.js 22" + "Add cs command to PATH" 두 옵션. PATH 등록은 `build/installer-bin/add-to-path.ps1` (uninstaller가 `remove-from-path.ps1` 호출) — NSIS StrFunc 의존성 회피.

### Tests
- 68/68 통과 — control-server name/scanner ignore 패턴 fixture 갱신.

### Fixed (계속)
- **`scanner.snapshot()` dynamicPatterns 누락** — `/graph` 응답의 files 배열에 `hasDynamicResolution` / `dynamicPatterns` 필드가 빠져 있어 `summary.dynamicPatternFileCount` (정답 4) vs `/graph` enumeration (0) 카운트 불일치. snapshot()에 두 필드 추가로 일치. `confidence` + `pkg` 도 같이 노출.
- **`/search` 안정성 + 186배 성능 — 5-layer fix** (이전 "Known issues"에 있었던 worker_threads 보류 작업 완료):
  1. **worker_threads 격리** (`packages/core/lib/search-worker.cjs` + `_searchInWorker` in main.cjs) — search를 main thread에서 분리. chokidar/scanner saturation 영향 0.
  2. **`MAX_SEARCH_BYTES = 5 MB`** — Gemma 토크나이저 JSON 같은 거대 파일이 libuv thread를 점유하던 hang 차단. `skipped: [{ reason: 'too-large' }]`로 보고.
  3. **stat skip on cache hit** — chokidar invalidation 메시지를 신뢰. 반복 검색 시 stat 호출 1776 × 회피.
  4. **`scanContent` fast-reject** — `if (hay.indexOf(needle) === -1) return []` 한 줄. 매칭 없는 파일 (대부분) 즉시 skip. **30 초 → 168 ms (186 배 개선)**.
  5. **concurrency 8** — libuv pool 적정선.
- **`cs search` / `cs_query({action:'search'})` 자동 retry** — 503 (scan in progress) 받으면 2 초 wait × 3 회 자동 재시도. 사용자/AI가 첫 503 마주칠 일 사라짐.
- **`/search` benchmark (Aiotv_v2 1776 파일)**:
  - RUNPOD_API_KEY cold 168ms, warm 82ms
  - asjfbnka_miss 45ms (no match — fast-reject 효과)
  - import (max=100, early-bail) 5ms
  - hang 0 (이전 ~50% 빈도로 hang)

### Added (계속)
- **`cs orphans` CLI** — `/graph` 직접 enumeration. confidence-filtered `cs legacy`와 별개로 raw orphan 목록. entry/config/manifest 같은 false-positive 포함, 사용자 직접 분류.
- **`scanner.initialScanComplete` flag** + `/search` scan-progress 가드 — 초기 scan 진행 중에는 503 + retry hint. Worker가 saturated main thread에서 hang하지 않도록.
- **debug 인프라**: `F:/tmp/cs-search-trace.log` 에 main + worker 양쪽 trace append. 향후 디버그 빠름.

### Security (multi-agent audit 후속, 2026-05-28)
- **`server.js` LAN 노출 차단** — 기본 `0.0.0.0` 바인딩이었음. `127.0.0.1` 강제로 카페/공유 wifi의 LAN 사용자 접근 차단.
- **DNS rebinding 방어 — Host 헤더 검증** — `127.0.0.1`/`localhost`/`[::1]` 외 reject (403). control-server.cjs + main.cjs 두 곳. 외부 origin이 7707 호출 차단.
- **CORS `*` → `null`** — cross-origin browser fetch 차단 (CLI/MCP는 CORS 무관, 영향 0).
- **`@electron/fuses` afterPack hook** — `RunAsNode:false` / `NodeOptions:false` / `NodeCliInspect:false` / `CookieEncryption:true`. signed binary의 `ELECTRON_RUN_AS_NODE=1` RCE 벡터 차단.
- **`will-navigate` + permission deny** — main.cjs 의 `web-contents-created` 안에 추가. CSP 외 defense-in-depth.
- **`electron-updater` 통합** — GitHub Releases provider. `autoDownload: false` (사용자 클릭 후 다운로드). `CS_DISABLE_UPDATER=1` env로 옵트아웃 가능. publish 설정 추가 (build.publish = github wing1008/codesynapt).

### Added (계속)
- **`packages/core/lib/logger.cjs`** — minimal NDJSON structured logger (level/module/ts/msg, stderr fallback). pino-equivalent 50줄, runtime dep 0. main.cjs 핵심 7 사이트 (control listen / migration / retention / updater 등) 교체됨, 나머지는 점진.
- **Log retention (30일 default)** — `pruneOldLogs()` boot 시 `~/.codesynapt/audit/*.jsonl` + project `.codesynapt/traces/*.jsonl` 자동 삭제. `CS_AUDIT_RETENTION_DAYS` env override. SECURITY.md 안내.
- **SBOM CI** — `npm sbom --sbom-format=cyclonedx --sbom-type=application > sbom.cyclonedx.json`. release artifact로 첨부 (Linux runner 1회). 기업 도입 가속.
- **PR template label 강제** — `.github/PULL_REQUEST_TEMPLATE.md` 최상단에 "Required — apply a label" 박스 + 11 라벨 enumeration. release-drafter 누락 방지.
- **`scripts/fuses-after-pack.cjs`** — electron-builder `afterPack` hook.

### Known issues / deferred
- 거대 monorepo (50k+ 파일) ripgrep wrap — 현 타겟 (~1k 파일)에 불필요해서 보류.
- WebGPU compute shader 구현 — `stepGPU = null` stub. UI 토글은 disabled + "Coming in v0.6" tooltip으로 정직성 fix됨. backend dispatcher 인프라는 준비됨.
- **자동 Bearer token (`~/.codesynapt/token`)** — CORS `null` + Host 검증으로 80%는 충족. Jupyter 패턴 자동 토큰은 추후 polish.
- **Azure Artifact Signing ($120/년)** + **Apple Developer ($99/년)** — 출시 결정 시.
- **README GIF 3개 + `npm publish` + `.exe` GitHub Release upload** — 채택률 위한 마케팅, 사용자 액션.

## 0.14.6 — 2026-05-27 (.exe installer + opt-in modes + rename cleanup)

### Added
- **NSIS Windows installer** (`CodeSynapt-Setup-${version}.exe`) — `perMachine: false`, `appId: io.codesynapt.desktop` 고정, `deleteAppDataOnUninstall: false`. 같은 `appId` 덕에 0.14.x → 0.14.x+1 upgrade 시 자동 uninstall + install (사용자 데이터 보존).
- **Single-instance lock** (`electron/main.cjs`) — 두 번째 `CodeSynapt.exe` 실행 시 main 창 focus + CS_INITIAL_ROOT가 있으면 그 폴더 load. 7707 포트 / 두 윈도우 충돌 방지.
- **`CS_INITIAL_ROOT` env** + **`POST /load`** — `cs ensure`가 GUI 자동 spawn 또는 swap 시 사용. 슬래시 `/codesynapt` 한 번에 desktop 띄움 + 현재 폴더 자동 로드.
- **`/codesynapt` + `/codesynapt-auto` 슬래시 두 모드** — 기본 OFF, 명시 진입. AUTO는 비-사소 작업만 cs_* 호출.
- **`cs ensure` CLI** — desktop alive 확인 → noop / `POST /load` / electron 바이너리 직접 spawn (Windows `EINVAL` 회피).

### Changed
- **Window title**: `FileGraph 3D` → `CodeSynapt` (`public/index.html`, `electron/main.cjs:140`).
- **CLI USAGE header**: `filegraph3d CLI — usage:` → `CodeSynapt CLI — usage:`.
- **`localStorage` prefix**: `filegraph3d:*` → `codesynapt:*` (28 occurrences) + **one-time migration** copies legacy keys on first run (old keys retained for safety).
- **Per-project data folder**: `.filegraph3d/` → `.codesynapt/` (history/ + traces/). `migrateLegacyHistoryDir(root)` renames the whole folder on first scan (skipped if both exist).
- **Carbon theme empty prompt**: `$ filegraph3d --init` → `$ cs init`.
- **Download filenames**: `filegraph3d-*.png/json/csv` → `codesynapt-*`.
- **API `GET /` response `name`**: `filegraph3d` → `codesynapt`.

### Build
- `build.appId` = `io.codesynapt.desktop` (절대 변경 금지 — 변경 시 NSIS가 "별개 앱"으로 인식해 업그레이드 충돌).
- Windows 빌드는 **Developer Mode 필수** (winCodeSign 캐시 추출 시 macOS .dylib symlink 권한).

## 0.14.4 — 2026-05-22 (CI matrix + bench memory + suggest i18n + content hash)

### Added
- **GitHub Actions CI matrix** — Node 20 + 22 × Ubuntu / macOS / Windows = 6 조합. `npm ci --omit=optional --omit=dev`로 CLI/MCP-only 설치 경로도 검증. smoke test + vitest 모두 실행.
- **`cs bench` 메모리 측정** — scan 후 heap delta + RSS (MB) 출력.
- **`/suggest?locale=ko`** (i18n 확장) — buildSuggestions에 locale 적용. SUGGEST_STRINGS table (en/ko, 6 categories). CLI `cs suggest --locale ko`.
- **컨텐츠 해시 (P4·3)** — `/file/:id` + `/node/:id` 응답에 `contentHash` (SHA-256). AI가 자기 Read 결과와 비교해 fresh 확정. Lazy (요청 시 계산, scan 시간 영향 없음). 캐싱 (lastSeenAt 기반).

### Tests
- 68/68 (suggest locale 2 + Astro 1 + contentHash 2 추가)

### Decided
- **Stage 3 F2 (2D 다이어그램) 폐기** — 타깃이 CLI/MCP 위주, 3D는 마케팅 자산. Sourcetrail/CodeSee 시장 죽음. 유지보수 부담만 큼.

## 0.14.3 — 2026-05-22 (P3 + P4·6 묶음 — locale + HTTP + auth)

### Added
- **MCP locale 응답 (P3·2)** — `/safety/:id?locale=ko`, `/preflight?locale=ko` 응답을 한국어로. MCP tool은 `locale: 'en'|'ko'` 인자. CLI는 `--locale ko`. 기본은 영어 (international AI 호환).
- **Streamable HTTP MCP transport (P3·3)** — `codesynapt-mcp --http [--port 7708]`. POST /mcp body는 JSON-RPC, 응답도 동일. Anthropic API remote MCP / cloud-hosted client 호환.
- **Bearer token auth (P4·6)** — `CS_AUTH_TOKEN` 환경변수 설정시 모든 control API 요청에 `Authorization: Bearer <token>` 필수.
- **Audit log (P4·6)** — `~/.codesynapt/audit/YYYY-MM-DD.jsonl`에 모든 요청 append (ts/durMs/method/path/status/principal).

### Changed
- `three` (3D renderer) + `ws`를 **`optionalDependencies`로 이동** — CI / SSH / Docker 사용자는 `npm install --omit=optional --omit=dev`로 30 MB 설치 (vs 700 MB).

### Tests
- 63/63 (P3·2 locale 3, P4·6 auth+audit 3 추가)

### Roadmap
- 풀 monorepo 분리 (`packages/core` + `desktop`): 별도 세션
- main.cjs full refactor: 풀 monorepo와 묶음
- OAuth 2.1 full spec: discovery / PKCE / refresh / scoped tokens — 매출 신호 후

## 0.14.2 — 2026-05-22 (P1 + P2 묶음 — accuracy + tests)

### Accuracy (P1 + P2)
- **Express `app.use('/api', router)` prefix 인지 (P1·1)** — `usersRouter.get('/list')` + `app.use('/api/users', usersRouter)` → `/api/users/list` 자동. knownReceivers는 app/router/server/api/fastify/hono/express + Router()/Hono() 팩토리 변수 + 모든 `app.use('/x', X)` 마운트 변수.
- **Nuxt 3 / SvelteKit / Astro file-system server routes (P2·2)** — `server/api/<seg>.ts` (default ANY / `foo.post.ts` suffix / `defineEventHandler({ method })`), `src/routes/.../+server.ts` (named GET/POST exports).
- **SDK instance 추적 (P2·4)** — `const myApi = axios.create(...)` → `myApi.get('/users')` 자동 매칭. got.extend / ky.create / ofetch.create / 팩토리 useApi/createApi/createClient/useFetch도 인지.
- **TRPC procedure 인지 (P2·4)** — `trpc.users.list.useQuery()` → `{ method: 'RPC', url: 'trpc:users.list' }`. 풀스택 매칭에 자동 안 되지만 가시성 확보.

### Reliability
- **vitest framework + 57 테스트 (P2·1)** — parser/scanner/control-server endpoint. CI 매트릭스 준비 완료.
- **Dynamic 신뢰도 점수 (P2·3)** — 각 파일에 `confidence: high | medium | low`.
  - low: eval/new Function/Reflect/exec, @Injectable/@Module/@Controller, container.resolve, `inject<T>('TOKEN')`
  - medium: 그 외 dynamic 패턴
  - high: pure static
  - `/summary.confidence` + `/node/:id.confidence` 노출
- **Third-party 폴더 자동 감지 (P1·2)** — LICENSE+manifest+nested .git+conventional name 휴리스틱. `cs vendors` / `cs_health { action: 'vendors' }`. suggest 규칙에도 medium-priority 추가.

### Developer UX
- **`cs context --watch` (P1·3)** — 파일 변경시 자동 재생성 (5s polling). `--output FILE` 필수.
- **`cs bench` (P1·4)** — scan + 6 endpoint median/p95 측정. README의 "~300 ms SLA" 검증 가능.

### Compatibility
- `~/.codesynapt/port` lock file은 v0.14.1과 동일.
- 모든 v0.14.1 명령 / endpoint 호환.

## 0.14.1 — 2026-05-22 (post-rebrand cleanup)

### Fixed — root-cause fixes (not workarounds)

- **Port 7707 in-use no longer disables the control API.** `startControlServer` now tries the 10 ports `7707..7716` and writes the winning port to `~/.codesynapt/port` (a lock file). CLI / MCP read that file to find the live server. Multiple instances (e.g. desktop app + one-off `cs serve`) now coexist instead of one silently disabling the other.
- **Bin file names** match the package: `bin/fg3d.cjs` → `bin/codesynapt.cjs`, `bin/fg3d-mcp.cjs` → `bin/codesynapt-mcp.cjs`. `package.json` `bin` paths updated; all docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/`, GitHub Action) updated.
- **Error messages and log prefix** no longer leak the old name. `[fg3d]` console prefix → `[cs]`. `"filegraph3d app is not running"` → `"codesynapt server is not running"`.
- **`claude mcp add codesynapt`** registration string in README and Action README now points at `bin/codesynapt-mcp.cjs`.

### Compatibility

- `FG3D_PORT` env var still works (legacy fallback).
- Old `bin/fg3d.cjs` / `bin/fg3d-mcp.cjs` paths **removed** — re-run `npm install` (or `npm link` for global use) to register the new bin names.

## 0.14.0 — 2026-05-22 (Re-rebrand: CodeSynapse → CodeSynapt, npm collision fix)

### Why
Discovered `codesynapse@1.1.1` already on npm (christianjohnson, MIT) —
a real-time codebase visualization tool with 3D graph, very similar
concept. Three months old, 7 versions. Publishing under the same name
would have caused search collisions and made us look like a fork.

Renamed to **CodeSynapt** — same neural-network metaphor, distinct
identifier. npm + GitHub + Google search all clean.

### Renamed — BREAKING

- **Package name**: `codesynapse` → `codesynapt`
- **GitHub repo**: `wing1008/codesynapse` → `wing1008/codesynapt` (old URL auto-redirects)
- **CLI bin**: `codesynapse` → `codesynapt` (the `cs` alias unchanged)
- **MCP server bin**: `codesynapse-mcp` → `codesynapt-mcp`
- **MCP tool prefix** (`cs_*`) — unchanged ("cs" = Code Synapt, same as Code Synapse)
- **Env var** (`CS_PORT`) — unchanged

Re-register: `claude mcp add codesynapt node /abs/path/bin/fg3d-mcp.cjs`

## 0.13.0 — 2026-05-22 (Rebrand → CodeSynapse)

### Renamed — BREAKING

- **Package name**: `filegraph3d` → `codesynapse`
- **GitHub repo**: `wing1008/filegraph3d` → `wing1008/codesynapse` (old URL auto-redirects)
- **MCP tool prefix**: `fg3d_*` → `cs_*`  (e.g. `fg3d_blast` → `cs_blast`).
  Re-register: `claude mcp add codesynapse node /abs/path/bin/fg3d-mcp.cjs`
- **CLI alias added**: `cs` (in addition to existing `fg3d`); both invoke the same binary.
- **`bin` field**:
  - `codesynapse` and `cs` → `./bin/fg3d.cjs`
  - `codesynapse-mcp` → `./bin/fg3d-mcp.cjs`
  - (Old `fg3d` / `fg3d-mcp` bin names removed.)

### Why
- `filegraph3d` was a literal description (file + graph + 3D), hard to pronounce, not unique in search.
- `CodeSynapse` evokes neural connections = code dependencies, AI-friendly, brandable.
- _(See 0.14.0 above — turned out npm `codesynapse` was already taken.)_

### Notes
- File names `bin/fg3d.cjs` / `bin/fg3d-mcp.cjs` kept for this release to minimise diff churn.
- `FG3D_PORT` env var still works; `CS_PORT` added with the same meaning.

## 0.12.0 — 2026-05-22 (포지셔닝 + 통합)

### Repositioned
- README headline → **"MCP-native code graph for AI agents — see blast radius live"**
- ~300 ms incremental update SLA documented (chokidar + 60 ms debounce)
- "no re-indexing, no cloud" differentiator (the gap Ry Walker's
  code-intelligence comparison flagged across 13 tools).

### Changed — BREAKING

- **MCP tools: 37 → 8 intent-shaped tools.** Each takes an `action`
  enum that selects the underlying endpoint.
  - `fg3d_summary` (project / health / packages / package_graph / package_detail)
  - `fg3d_query`   (list / node / deps / users / find / read)
  - `fg3d_blast`   (radius / safety / bundle)
  - `fg3d_intent`  (feature / url / schema / external)
  - `fg3d_health`  (env / secrets / preflight / suggest / legacy)
  - `fg3d_change`  (write / edit / refresh / history / restore)
  - `fg3d_trace`   (log / stats / sessions / session / clear / changes / diff / tour / timeline)
  - `fg3d_ui`      (focus / open) — desktop only
  - Old names (`fg3d_blast_radius`, `fg3d_safety`, `fg3d_external_urls`…) **removed**.
    Re-register: `claude mcp add filegraph3d node /abs/path/bin/fg3d-mcp.cjs`.

### Added — headless / CI / context

- **`fg3d scan [path]`** — one-shot headless scan (JSON / summary /
  edges / files). No desktop window needed.
- **`fg3d serve [path] --port N`** — standalone HTTP API daemon. Same
  endpoint surface as the Electron app, for CI / SSH / Docker.
- **`fg3d ci-diff <base..head>`** — PR impact report
  (`--format=github-comment | json | plain`). Pulls git diff,
  computes per-file blast radius, emits Markdown ready to drop into
  a PR comment.
- **`fg3d ci-gate <base..head>`** — same data, exits 1 on threshold
  breach (`--max-blast N` / `--max-changed N`). For CI step.
- **`.github/actions/blast-radius/`** — composite GitHub Action that
  posts/updates a single Markdown PR comment per push + optional gate.
- **`fg3d context [--output FILE]`** — aggregates summary + packages +
  url + schema + env + external + legacy into a single Markdown
  context file. Drop into project root as `CLAUDE.md` / `AGENTS.md` /
  `.cursor/rules` for AI agents to load on each turn.

### Added — new MCP / CLI capabilities

- **`fg3d safety`** — 🟢/🟡/🔴 "is it safe for AI to edit this?" verdict
  in one call (dependents + routes + external APIs + dynamic patterns
  + test coverage).
- **`fg3d bundle`** — pack closest neighbours into a token budget;
  ready to feed to the editor before a refactor.
- **`fg3d env [VAR]`** — `.env` cross-reference: declared vs used,
  status `ok | unused | undeclared` (catches deploy-time bombs).
- **`fg3d secrets`** — server-only env vars accidentally used in
  frontend code (security check, integrated into preflight).
- **`fg3d suggest`** — rule-based "next thing to ask the AI to fix",
  priority sorted, includes copy-pasteable prompts.
- **`fg3d feature <keyword>`** — keyword → frontend / backend / shared
  file cluster (heuristic).
- **`fg3d url [PATH]`** — URL ↔ file mapping (Next.js app + pages
  router, Astro, SvelteKit; route groups + dynamic segments handled).
- **`fg3d schema [Model]`** — DB model extraction (Prisma / Drizzle /
  SQLAlchemy) with field list + usage cross-reference.
- **`fg3d preflight`** — comprehensive deploy-readiness check
  (undeclared env / http URLs / hub tests / orphans / dynamic / leaks).

### Added — language support

- **C# / Swift / PowerShell / Clojure / RST** — real parsers replace
  the previous TRACKED_EXT-only stubs (no more silently-zero imports).
- **`.ipynb` (Jupyter)** — extract code cells, dispatch to Python
  parser, route external URLs from cell content only (no JSON
  metadata noise).
- **Dart (Flutter)** — import / export / part / part-of, `dart:` /
  `package:` skipped, relative paths from current file.
- **Next.js file-system API routes** auto-detected
  (`app/api/*/route.ts` + `pages/api/*`). Restores ~30% of cross-stack
  edges (94 → 123 on a real Next.js app).

### Improved — apiCalls extraction

- `$fetch` / `ofetch` / `useAsyncData` (Nuxt 3 / Nitro)
- template literal prefix (`fetch(\`/api/users/\${id}\`)` → `/api/users/`)
- dedup (method + url) to prevent double-counting when both fetch and
  nitro regexes match the same call.

### Refactored

- **`lib/control-server.cjs`** — extracted control-plane factory used
  by both Electron and `fg3d serve`. Same HTTP surface, no logic
  duplicated between desktop and headless. (Partial — main.cjs still
  owns the legacy endpoints; full migration planned.)

### Compatibility note

The MCP tool rename is the only breaking change. CLI commands and HTTP
endpoints unchanged.

## Unreleased — 2026-05-18 session

### Added — AI agent integration

- **HTTP control API** on `127.0.0.1:7707` (env override `FG3D_PORT`).
  17 endpoints: `/health`, `/summary`, `/graph` (paginated + sortable),
  `/node/:id`, `/file/:id`, `/deps/:id`, `/users/:id`, `/find?q=`,
  `/external`, `/blast/:id`, `/timeline`, `/tour`, `/history/:id`,
  `/changes`, `POST /focus/:id`, `POST /open/:id`, `POST /restore/:id`,
  `POST /refresh/:id`. Local-only, no auth (loopback trusted).
- **CLI** at `bin/fg3d.cjs` — 19 commands, thin wrapper around the
  HTTP API. `npm link` registers `fg3d`, `fg3d-mcp`, `filegraph3d-server`
  globally.
- **MCP server** at `bin/fg3d-mcp.cjs` — hand-rolled stdio JSON-RPC
  2.0, zero dependencies (~150 lines). 19 tools exposed to Claude Code
  / Cursor / Continue / Cline. Register once with
  `claude mcp add filegraph3d node /abs/path/bin/fg3d-mcp.cjs`. See
  [docs/mcp-setup.md](./docs/mcp-setup.md).

### Added — graph features

- **Live AI agent visualization** — every MCP/CLI call pulses the
  touched node in 3D with a ripple + color tint per tool type (cyan
  read, yellow focus, red write, etc). A cyan→magenta navigation
  trail line connects the last ~32 touched nodes so you can see the
  agent's path through the codebase. AI trace overlay panel
  (bottom-right) logs each operation live.
- **Blast radius predictor** — `fg3d blast <id>` / `fg3d_blast_radius`
  returns BFS impact (totalFiles, totalLoc, tokenEstimate, categories
  split into tests/source/config/docs/other, byDepth). Highlights
  affected nodes in magenta when called.
- **Time-lapse mode** — ⏱ button in topbar. Reads `git log
  --diff-filter=A` to build a per-file birth timeline; slider hides
  nodes that didn't exist yet at the chosen commit; Play button
  animates 25 s start→end.
- **Guided tour** — 🧭 button. Heuristic-selected stops (entry points
  matching `^(?:src/)?(?:index|main|app|server|cli|bin)\.`, top hubs
  by incoming-import count, top external-API integration files).
  Camera flies to each stop with a short rationale.
- **Project summary** (`fg3d_summary`, ~300 tokens) — Layer-1
  overview: fileCount/edgeCount, top 5 folders, top 10 hubs, ext mix,
  orphan count, dynamic-pattern file count, external domains.
  Version-counter cache; invalidates on snapshot.
- **External URL inventory** — `fg3d external` lists every external
  host the project calls (http/https/ws/wss), grouped by domain.
  Combines structured `apiCalls` detection (fetch/axios/got/ky/SWR/
  React Query/requests/httpx/aiohttp) + a generic URL grep over all
  source files so URLs in `.env.example`, comments, hardcoded
  constants are captured.
- **Dynamic pattern detection** — parser flags files using
  `require(expr)`, `import(expr)`, template-literal imports, `eval`,
  `new Function`, `Reflect`, `importlib`, `__import__`, `exec`,
  `getattr`. Surfaced as `hasDynamicResolution: true` +
  `dynamicPatterns: [...]` on each node so AI doesn't treat them as
  reliably orphan.
- **Session changes panel** (📝) — every file modified this session
  (any source: AI, you, external editor). Click a row to focus the
  node; click `+` to expand a line-by-line LCS diff from first-seen
  to current content.
- **Auto file history** (opt-in via Settings) — per-file timestamped
  snapshots in `.filegraph3d/history/`, capped at 3 per file. Same
  dedup logic for chokidar re-fires. Inspector shows view/restore
  buttons; `fg3d_restore` MCP tool can roll back.
- **Inspector overhaul** — connection badge
  (🟢 connected / 🟡 no incoming / 🟠 orphan) based on actual import
  graph. Full-file textarea editor with 500 ms debounced auto-save
  via new `write-file` IPC. History panel + content panel.
- **i18n (Korean / English)** — top-bar `EN` / `한` toggle. Strings
  via `data-i18n` attributes + `t(key)` helper, persisted to
  `localStorage`. Covers settings panel, hints bar, AI panels,
  inspector badges, status bar, dialog, drop overlay, welcome.
- **File tree root display** — folder name + full path now show at
  the top of the file tree panel so users know which root is loaded
  without checking the topbar.

### Added — response meta + freshness control

- **Standardized `meta` envelope** on every API response:
  `{ scannedAt, serverTime, tokenEstimate, totalAvailable?, returned?,
  offset?, limit?, sort?, truncated? }`. Lets the AI budget tokens
  and self-check freshness.
- **Pagination + sort** on `/graph`: `?limit=N&offset=N&ext=ts&minMass=3&sort=mass:desc`.
  Default sort is `mass:desc` so even a bare `limit=10` returns the
  10 most-imported files (instead of garbage insertion-order). Other
  sorts: `size:desc`, `loc:desc`, `id:asc`, `insertion` (opt-out).
- **`fg3d_refresh(id)`** — force re-scan of one file in ms.
  Recommended call before high-stakes mutations to defeat staleness.

### Added — camera / scene polish

- **Cursor-anchored zoom-in** (dolly toward cursor) +
  **center-drift zoom-out** (like Obsidian) for a more intuitive
  graph navigation pattern.
- **Unlocked vertical camera tilt** (`phi` clamp removed) — pole pass
  works smoothly via dynamic `camera.up` recomputation.
- **Spherical force-directed layout** — removed disk-flattening force
  + spherical node seeding. Cluster reaches a clean sphere instead
  of a flattened pancake.
- **Idle auto-rotate** — after 4 s of no user input, the camera
  rotates slowly around the focus target. Instantly stops on any
  interaction.
- **Scene-wide heartbeat** — subtle sine modulation on node size /
  emit so the graph feels alive at rest.
- **AI trace pulse + ripple + trail** — recently-touched nodes pulse
  in their tool-color tint with a 700 ms ripple burst on each call;
  a cyan→magenta line traces the agent's navigation path through the
  graph (additive blending, fades over 8 s).

### Changed

- **Default label budget** reduced from 60 → 10 simultaneous labels.
  Top 10 by mass (or focused node + closest neighbors when a node is
  selected).
- **`read-file` IPC** size cap raised 500 KB → 2 MB; content slicing
  removed so the inspector textarea shows the entire file.
- **Scanner ignores `.filegraph3d/`** so the auto-history folder
  doesn't appear in the graph.

### Fixed

- **`pathLabel` was getting overwritten by the translation system**
  after a folder was loaded — removed its `data-i18n` attribute and
  switched to manual translated init only when no folder is loaded.
- **`status.files` JS overwrote translated label** by setting the
  cell's `innerHTML` — refactored to use `t('status.files')` inside
  the template literal so it survives lang toggle + per-tick
  re-renders.

## Unreleased — 2026-05-15 session

### Fixed
- **CSP blocked `<script type="importmap">`** — `public/index.html`
  meta CSP did not permit the inline import map, which made the bare
  specifier `import * as THREE from 'three'` fail to resolve. App.js
  never executed, so every UI button was inert. Added the SHA-256 hash
  for the importmap inline (`'sha256-NfHJr+xcDJiAGqHYgFEaR5vX+0YDa2Tbke39iP8L6uY='`)
  to `script-src`.
- **Three.js r160 `BufferAttribute.updateRange` is getter-only** —
  the previous setter-style writes (`attr.updateRange = { offset, count }`)
  threw `TypeError` every frame, so nodes / edges never rendered.
  Replaced all six call sites in `public/app.js` with
  `attr.clearUpdateRanges(); attr.addUpdateRange(start, count)` (the
  r159+ API). No deprecation warnings.
- **Left panels overlapped and intercepted clicks** on the 3D nodes.
  Replaced floating `position: fixed` panels with a proper 3-column
  CSS Grid layout (body grid: rows `topbar / main / statusbar`;
  columns `leftRail / canvas / rightRail`). Overlays (welcome,
  dialogs, toasts, settings, inspector, searchbar, hints) remain
  `position: fixed`.
- **File tree toggle disappeared with the panel.** Added a topbar
  toggle button (🗂) so the tree can be reopened regardless of its
  state; `T` shortcut and in-panel `−` button still work.
- **Disconnected nodes drifted off into the distance.** Tightened the
  soft world cap (linear+quadratic growth) and added a hard clamp at
  `R_SOFT × 1.85` that teleports outliers back onto the shell. A
  cold-state check enforces the clamp even when the simulation has
  settled.

### Added
- **Refresh button** in the topbar (↻, `F5`) — rescans the currently
  loaded folder via existing `loadFolder` IPC. Disabled when no folder
  is open, animates a rotation while a rescan is in flight.
- **Layout sliders** in Settings (persisted to localStorage):
  - **node distance** (0.3×–3×) — scales repulsion and spring rest
    length, expanding/compacting the layout. Triggers a soft reheat.
  - **node size** (0.3×–3×) — multiplies the rendered point size.
    Default was rebased: today's `1.0×` matches what `0.3×` produced
    before. (Old `node_size` localStorage entry is auto-cleared.)
  - **max world size** (60–300) — radius of the world soft cap.
    Smaller values produce tighter, more compact graphs; larger
    values allow more spread.
  - **reset to defaults** button — restores all three sliders.
- **Full-stack edges** (`kind: 'api'`) — connect client API call sites
  to server route handlers. `parser.js` now extracts:
  - JS/TS/JSX/TSX/Vue/Svelte/Astro routes (Express, Fastify, Koa,
    Hono, Express-router) and API calls (`fetch`, `axios`, `got`,
    `ky`, `request`, SWR / React Query hooks).
  - Python routes (Flask `@app.route` + `methods=`, FastAPI
    `@app.get/post/...`, `@router.X`) and API calls
    (`requests`/`httpx`/`aiohttp`/`session`).
  `scanner.js` builds a route index across all files, then matches
  each `apiCall` URL (after `normalizeUrlPath`) against route regexes
  (`:id`, `{id}`, `<int:id>`, `*` supported). Method-aware: a
  `GET` call matches `GET` and `ALL` routes only. Duplicates and
  self-calls are dropped. Visually identical to import edges; the
  `k: 'api'` field is recorded in the data.

### Changed
- **Drag direction (horizontal)** — flipped sign of `cam.theta` delta
  in the pointermove handler. Left/right drag now feels natural for
  the user's preferred orbit direction. Vertical (`cam.phi`) unchanged.
- **Node glow disabled** — `nodeMat` blending changed from
  `AdditiveBlending` to `NormalBlending`, and `glowTexture` reshaped
  to a sharper-edged disk (no halo). Background nebula sprites and
  starfield are unchanged.
- **Resize uses canvas, not window** — `resize()` now reads
  `canvas.clientWidth/Height`, and a `ResizeObserver` on the canvas
  triggers it whenever a rail toggles. Labels and `pickAtNDC` also
  use canvas coordinates so picking works correctly in the new
  middle-column layout.

### Notes / known limits
- Full-stack matching does NOT understand Express router mount
  prefixes (`app.use('/api', router)`). Template-literal URLs are not
  interpolated; only bare-string URLs match.
- File-based routing (Next.js `app/api/...`, Nuxt server routes) is
  not inferred from filenames.

## v0.11.1 — Infrastructure & automation

### Added
- **Issue templates** for bug reports, feature requests, and plugin
  API issues. Each pre-fills labels and routes to the right docs.
- **Pull request template** with a checklist covering testing,
  documentation, and CLA agreement.
- **Issue chooser config** (`.github/ISSUE_TEMPLATE/config.yml`) that
  routes questions to Discussions, security to private channel, and
  commercial inquiries to LICENSES.md. Blank issues disabled.
- **Dependabot configuration** with weekly checks, grouped patch/minor
  updates, separate tracking for plugin-api dependencies, and major
  Electron/three.js bumps held back for manual review.
- **CI workflow** (`.github/workflows/ci.yml`) running on every push
  and PR: syntax checks on all `.js`/`.cjs` files, license compliance,
  parser smoke test on three OSes, markdown link validation.
- **SHA-256 checksum generation** for release artifacts. Per-OS
  `SHA256SUMS-<os>.txt` files attached to each release for build
  verification (as promised in `docs/installation.md`).
- **Status badges** on README and plugin-api/README — license, version,
  CI, build, platform support.
- **`AGENTS.md`** — guide for AI coding agents (Claude Code, Cursor,
  Codex, Aider) describing project conventions, hard rules, common
  pitfalls, and the maintainer's expectations.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1, adapted for a
  one-maintainer project with realistic enforcement expectations.
- **`.github/SUPPORT.md`** — routing doc for help requests. GitHub
  auto-links this from the "Help" panel on Issues.
- **`.github/FUNDING.yml`** — placeholder for the Sponsor button.
  Includes commented-out templates for GitHub Sponsors, Buy Me a
  Coffee, Ko-fi, Patreon, Open Collective, Liberapay, Tidelift, and
  Polar. Maintainer enables whichever they actually set up.
- **release-drafter** automation: rolling draft of next release notes
  is maintained as PRs merge. 10 release-note categories (Breaking,
  Features, Bug fixes, Plugin system, UI/themes, Performance, Security,
  Documentation, Maintenance, Dependencies). Auto-determines major /
  minor / patch version bump from PR labels.
- **Auto-labeler** (`actions/labeler@v5`) that applies labels to PRs
  based on changed files — `*.md` → `documentation`, `plugin-api/**`
  → `plugin-api`, `.github/workflows/**` → `ci`, etc. Saves manual
  labeling effort and improves release-drafter accuracy.
- **`.github/LABELS.md`** — full label conventions reference with
  one-line descriptions, colors, and `gh label create` commands for
  first-time setup.
- **Maintainer publishing guide** rewritten with the new release-drafter
  flow: review draft, polish, bump version files, tag, push, CI builds
  and attaches binaries automatically.

### Changed
- Build workflow now generates `generate_release_notes: true` for
  automated release page content.
- `CONTRIBUTING.md` Submitting section expanded with template guidance
  and explicit accept/reject criteria.

## v0.11.0 — Plugin system + dual licensing

### Added
- **Plugin API** (`plugin-api/`) — MIT-licensed package for building
  themes, exporters, parsers, layouts, panels, and context-menu
  actions. Full TypeScript types, documentation, and four working
  examples.
- **Plugin loader** in main process: discovers plugins in the user's
  data directory, validates manifests (id pattern, type, permissions),
  prevents path traversal, and gracefully reports invalid plugins.
- **Plugin host** in renderer: isolates plugins in their own Function
  scope, mediates all app access through a curated `ctx` object,
  enforces permissions, and manages lifecycle/disposables.
- Plugin themes appear automatically in Settings → Appearance.
- "Open plugin folder…" button in Settings.
- `docs/` directory structure: installation, features, controls,
  architecture, maintainer guides.

### Changed
- **License: MIT → BSL 1.1** for the main app. Plugin API stays MIT.
  Auto-converts to Apache 2.0 on 2030-05-14.
- README rewritten as a concise landing page; detailed docs moved to
  `docs/`.
- `bus.on()` now returns an unsubscribe function (plugin requirement).
- `bus.off()` method added for symmetric API.

## v0.10.1 — OS/license/compatibility audit

### Changed
- Electron upgraded v28 → v41 (v28 is EOL).
- electron-builder upgraded v24 → v25.
- Node.js minimum bumped 18 → 20.
- macOS: hardened runtime enabled with `build/entitlements.mac.plist`.
- Linux: added `.tar.gz` target as fuse2-free alternative to AppImage.
- CSP strengthened: `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`.

### Added
- `scripts/license-check.js` — fails the build if any dependency uses
  a non-permissive license.
- `SECURITY.md` documenting data handling, supported versions, and
  vulnerability reporting.
- README permissions section explaining file access requirements.

## v0.10.0 — Active set curation

### Added
- **Active sets and pipelines** — user-curated "what's really live"
  markings. Star individual files or group them into named pipelines.
  Non-active files dim or hide depending on mode.
- File tree star icons with folder badges (`★3`) showing starred
  counts under collapsed folders.
- Pipelines panel (left bottom): create, rename inline, toggle on/off,
  delete with confirmation.
- Context panel: large star toggle, pipeline membership tags,
  "Add to pipeline…" dropdown.
- Filter badge bar shows active-set mode with one-click disable.

### Changed
- Visual emphasis system: active files at full brightness with 1.15×
  size pop; non-active dim to 0.12 or hide entirely.

## v0.9.2 — Click & interaction hardening

Stability patch focused on edge cases around mouse/pointer interaction,
async race conditions, and rare input scenarios.

### Fixed
- **Canvas drag**: switched from mouse events to Pointer Events with
  `setPointerCapture`, so drags now survive the cursor leaving the
  window, going to another monitor, or the window losing focus.
  Previously a drag could "stick" if mouse-up landed outside the
  window.
- **Stale hover on fast click**: when clicking quickly after a hover,
  the throttled hover state (32 ms) could still point to the
  previously hovered node. Click now re-picks at the actual click
  position.
- **Snapshot during drag**: if a file is deleted from disk while you
  drag its node, the drag now terminates cleanly instead of
  continuing to manipulate a removed object.
- **Open-folder double-click**: re-entrancy guard prevents the user
  from spawning multiple OS folder pickers by rapid-clicking.
- **Inspector row click on deleted file**: now shows a toast "File
  not in graph" instead of failing silently.
- **Empty-graph exports**: PNG/JSON/CSV buttons now show a clear
  toast when there's nothing to export rather than producing empty
  files.
- **Large JSON export**: 100k+ node exports show a brief warning
  toast, and serialization is deferred to the next tick so the
  toast actually paints before the UI freeze.
- **Glob escaping in file tree**: clicking a folder named e.g.
  `(legacy)` or `[archived]` now filters correctly (glob meta
  characters are escaped). The glob compiler also recognizes `\X`
  as a literal-character escape.
- **IME composition in search**: filter is no longer applied to
  partial Korean/Japanese/Chinese characters mid-composition.
  Filter is also now debounced 90 ms to reduce work during fast
  typing.
- **Project dialog**: backdrop click closes the dialog (standard
  UX). Previously you had to use ✕ or Esc.
- **Drag-drop overlay**: now reliably hides on dragend / blur / drop
  even when the dragenter/leave counters fall out of sync (which
  happens when crossing nested element boundaries). Overlay also
  only appears for file drags, not text/link drags.
- **Drop of a file instead of folder**: shows a toast directing the
  user to use Open Folder, instead of silently failing.
- **Minimap interaction**: also moved to Pointer Events with
  capture. Guard added so clicking on an empty minimap (no graph
  loaded) doesn't change the camera target.

### Internal
- All async click handlers (`pickFolder`, `loadFolder` from drop)
  now have try/catch with toast on failure.
- `state.draggingNode` is cleared in `applySnapshot` if its target
  node was removed.

## v0.9.1 — Stabilization patch

Internal refactor and bug fixes; no user-facing feature changes.

### Fixed
- `applyFilter` was being reassigned via function-declaration overwrite,
  which would silently fail in some bundlers or under strict-mode
  optimizations. Filter changes now propagate via a central event bus.
- Selected and hovered node IDs are now cleared automatically when the
  referenced node is removed from a snapshot (previously stale
  references could persist, causing inspector or context-panel to
  show "ghost" data for deleted files).
- `selectNode` now defensively clears the selection if called with an
  id that doesn't exist in the current graph.
- Connected-component count in the status bar now refreshes for graphs
  of any size once the simulation has settled, instead of being
  permanently shown as `—` for 50k+ node graphs.
- Folder-grouping and pause toggles now update the active-filter badge
  bar (previously they only took effect silently).
- Project info dialog is now dismissed when the user closes the folder
  (previously it could linger displaying the previous root's data).
- Path-traversal check in `read-file` IPC handler now uses
  `path.relative` instead of `startsWith`, which correctly handles
  prefix-confusable paths like `/proj` vs `/proj2`.
- `startScanner` now resets `currentRoot` and emits an error toast on
  scanner-start failure instead of leaving the previous root in place.
- The minimap was running its own `requestAnimationFrame` loop in
  parallel with the main render loop. Merged into a single RAF for
  better scheduling and slightly lower idle CPU.

### Internal
- Introduced a central event bus (`bus.on` / `bus.emit`) to replace the
  ad-hoc `window.__xxxRefresh` pattern. Five subsystems (file tree,
  recent files, context panel, project dialog bootstrap, filter
  badges) now subscribe explicitly. The bus is exposed at
  `window.__bus` for in-browser debugging.
- Three separate `window` keydown listeners (general shortcuts, T,
  1-3) merged into a single listener for predictable ordering.
- Removed dead code: `sortByMass` declaration, `shouldIgnoreDir`
  method.
- Responsive media queries added for screens narrower than 1280,
  1024, and 800 pixels (previously the right rail and inspector
  would overlap on small windows).
- All side panels (file tree, right rail, status bar, recent files,
  stats, filter badges) are now hidden in the welcome / no-folder
  state.

## v0.9.0 — Side panels

- Added file tree (left top) — hierarchical view with collapse/expand,
  folder-scoped filtering on click, file selection on click. Performant
  even at 100k+ files because only expanded branches are rendered.
- Added recent files panel (left bottom) — last 8 selected files,
  persisted per root.
- Added active-filter badge bar (topbar) — shows currently-applied
  filters with ✕ to clear individually.
- Added status bar (bottom) — file/edge/component counts, simulation
  state, last-change time, backend mode, FPS.
- Added `T` shortcut for file tree, `M` for right rail.

## v0.8.0 — Right rail

- Added 1:1 minimap (top right) — 2D top-down view of the entire graph
  with click/drag to move the main camera target.
- Added context panel (right, under minimap) — shows selected node
  details, or project info when nothing is selected.
- Added project info dialog — runs on first folder open to capture
  name, version, stack, description, notes. Persisted per root.
- Right rail toggleable via search-bar button or `M` shortcut.

## v0.7.0 — Polish

- Empty-space click clears selection.
- Full keyboard shortcuts (`Esc`, `/`, `Space`, `R`, `S`, `Ctrl+F`,
  `Ctrl+,`, `Ctrl+O`).
- Search modes: substring / glob / regex; highlight-only or
  hide-non-matching.
- Match count display.
- `.gitignore` is now honored automatically.
- Scan progress toast.
- Graph statistics panel (overview, top hubs, extensions).
- Screenshot export (PNG), data export (JSON, CSV).
- Camera presets (default / top-down / side) + custom slots 1-3.
- electron-builder configuration for Mac / Win / Linux.
- GitHub Actions workflow for automated multi-platform builds.

## v0.6.0 — Backend dispatcher

- Added physics-backend dispatcher (Auto / GPU / CPU) with WebGPU
  device initialization and contention-based auto-fallback.
- Settings panel UI for backend selection.
- Window minimize / hide events drive auto-pause; window obscuration
  no longer pauses the simulation.

## v0.5.0 — Scale optimization

- Single `THREE.Points` + custom shader for all nodes (1 draw call).
- Linked-list flat spatial grid (allocation-free).
- Round-robin repulsion + spring sampling — work per tick bounded
  independently of N.
- Inlined float math in hot loops.
- Label pool (60 reusable DIVs).
- CPU NDC projection picking, throttled.
- Coast-only fast path when simulation settles.

## v0.4.0 — Fluid interactions

- d3-force style alpha cooling with reheat on interaction.
- 3D node dragging (intersect drag plane).
- Smooth camera zoom (critically damped).
- Scale-in animation for new nodes.

## v0.3.0 — Galactic visualization

- Cosmic dark theme with starfield, nebulae, additive glow halos.
- Mass-weighted physics where hubs behave like suns.

## v0.2.0 — Electron desktop app

- Wrapped in Electron with native menu, folder picker, drag-drop,
  recent folders, window state persistence.

## v0.1.0 — Initial

- Node.js HTTP+WebSocket server + vanilla JS frontend using three.js.
- Multi-language parser (15+ languages).
