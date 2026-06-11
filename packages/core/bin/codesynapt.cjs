#!/usr/bin/env node
// CodeSynapt CLI — thin wrapper around the running Electron app's
// localhost control API. Run the desktop app or `cs serve` in the
// background; then use `cs <cmd>` from any terminal to inspect / control it.

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Walk up from `start` to the project root. Mirrors codesynapt-mcp.cjs's
// _findProjectRoot so the CLI and MCP agree on which project a directory
// belongs to — STRONG markers (repo/workspace root) win over WEAK (a package),
// nearest WEAK used only when no STRONG found further up.
function _findProjectRoot(start) {
  const STRONG = ['.git', '.hg', '.svn', 'pnpm-workspace.yaml', 'lerna.json', 'go.work', '.codesynaptignore']
  const WEAK = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'composer.json', 'pubspec.yaml']
  const home = path.resolve(os.homedir())
  const fsRoot = path.parse(start).root
  let dir = start, nearestWeak = null
  while (true) {
    for (const m of STRONG) { try { if (fs.existsSync(path.join(dir, m))) return dir } catch {} }
    if (!nearestWeak) { for (const m of WEAK) { try { if (fs.existsSync(path.join(dir, m))) { nearestWeak = dir; break } } catch {} } }
    if (dir === fsRoot || dir === home) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return nearestWeak
}
// The project this CLI invocation targets — cwd walked up to its root. Used to
// resolve the RIGHT per-project daemon and to detect cross-project misroutes.
const PROJECT_ROOT = (() => {
  try { return _findProjectRoot(process.cwd()) || process.cwd() } catch { return process.cwd() }
})()

// Resolve which port the running server is on.
// Priority: explicit env var > THIS project's registered daemon > global lock
// file > default 7707. Preferring the per-project registry entry over the single
// global ~/.codesynapt/port lock is what stops a `cs` command in project A from
// silently hitting project B's daemon that happens to own that lock (the lock is
// last-writer-wins across ALL projects). Registry miss → legacy lock fallback.
function resolvePort() {
  const envPort = process.env.CS_PORT || process.env.FG3D_PORT
  if (envPort) return parseInt(envPort, 10)
  try {
    const registry = require('../lib/registry.cjs')
    const d = registry.readDaemon(registry.projectHash(PROJECT_ROOT), 60000)
    if (d && d.port > 0 && d.port < 65536) return d.port
  } catch { /* registry optional during migration → fall through */ }
  try {
    const lockPath = path.join(os.homedir(), '.codesynapt', 'port')
    if (fs.existsSync(lockPath)) {
      const p = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (p > 0 && p < 65536) return p
    }
  } catch { /* fall through */ }
  return 7707
}
const PORT = resolvePort()
const HOST = '127.0.0.1'

// One-time safety net: even after preferring the registry, a stale entry / global
// lock / port reuse could still point us at another project's daemon. Before the
// first real request, check the daemon's /health.root against our project root and
// warn LOUDLY on mismatch — results would otherwise be silently for the wrong
// project. Warn only (never block); memoized so it costs one /health per process.
let _projectGuard = null
function guardProjectMatch() {
  if (_projectGuard) return _projectGuard
  _projectGuard = new Promise((resolve) => {
    if (process.env.CS_PORT || process.env.FG3D_PORT) return resolve() // user pinned the port on purpose
    const r = http.get({ host: HOST, port: PORT, path: '/health', timeout: 1000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const h = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (h && h.root && PROJECT_ROOT) {
            const a = path.resolve(h.root), b = path.resolve(PROJECT_ROOT)
            const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
            if (!same) {
              process.stderr.write(
                `\n⚠️  codesynapt: daemon on :${PORT} is serving a DIFFERENT project — results are NOT for your cwd.\n` +
                `      daemon root: ${h.root}\n` +
                `      your project: ${PROJECT_ROOT}\n` +
                `   Fix: run \`cs ensure\` here to start this project's daemon, or set CS_PORT to its port.\n\n`)
            }
          }
        } catch { /* health unparriseable — skip the guard */ }
        resolve()
      })
    })
    r.on('error', () => resolve())
    r.on('timeout', () => { r.destroy(); resolve() })
  })
  return _projectGuard
}

function req(method, pathStr, query, body) {
  return guardProjectMatch().then(() => new Promise((resolve, reject) => {
    let qs = ''
    if (query) {
      const parts = []
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      }
      if (parts.length) qs = '?' + parts.join('&')
    }
    const headers = {}
    // When the backend runs with CS_AUTH_TOKEN, control-server gates EVERY
    // request behind Bearer auth (reads included). Without this header every
    // `cs` command 401s once a token is set to enable edits. (CLI half of
    // SEC-002 — the MCP apiReq was already fixed.)
    if (process.env.CS_AUTH_TOKEN) headers['Authorization'] = `Bearer ${process.env.CS_AUTH_TOKEN}`
    let payload = null
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers['Content-Type']   = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const r = http.request({ host: HOST, port: PORT, path: pathStr + qs, method, headers }, (res) => {
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }) }
        catch { resolve({ status: res.statusCode, text }) }
      })
    })
    r.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`codesynapt server is not running at ${HOST}:${PORT}. Start the desktop app first (npm start), or run 'cs serve'. Override port via CS_PORT.`))
      } else reject(err)
    })
    if (payload) r.write(payload)
    r.end()
  }))
}

// Cheap liveness probe for an arbitrary port (used to avoid clobbering a
// still-alive backend's discovery lock). Resolves true iff /health returns 200.
function pingPort(port) {
  return new Promise((res) => {
    const r = http.get({ host: HOST, port, path: '/health', timeout: 800 }, (resp) => { resp.resume(); res(resp.statusCode === 200) })
    r.on('error', () => res(false))
    r.on('timeout', () => { r.destroy(); res(false) })
  })
}

function encId(id) { return id.split('/').map(encodeURIComponent).join('/') }

function printJson(x) { process.stdout.write(JSON.stringify(x, null, 2) + '\n') }
function die(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1) }

const USAGE = `CodeSynapt CLI — usage:

  ── Headless (no desktop app needed) ─────────────────────────
  cs scan [path] [--json]   # one-shot scan, emit graph as JSON
  cs scan [path] --summary  # cheap overview (file count, top hubs)
  cs serve [path] [--port N]
                              # standalone HTTP daemon on 127.0.0.1:N
                              #   serves /summary, /graph, /node/:id,
                              #   /blast/:id, /packages, etc.
                              #   no Electron window — pure CLI/MCP/CI use
  cs ci-diff <base..head> [path] [--format=github-comment|json|plain] [--depth N]
                              # PR impact report: blast radius for every
                              #   file changed between two git refs.
                              #   Default --format=github-comment is
                              #   markdown ready to drop into a PR.
  cs ci-gate <base..head> [path] [--max-blast N] [--max-changed N]
                              # PR gate for CI: fails (exit 1) if change
                              #   set exceeds thresholds.
                              #   --max-blast N    largest single-file blast
                              #   --max-changed N  total changed files

  ── Remote (needs the desktop app running at :7707) ──────────
  cs health
  cs summary                # cheap project overview (Layer 1)
  cs refresh <id>           # force re-scan of one file (defeats staleness)
  cs ls [--limit N] [--ext X] [--min-mass N] [--sort KEY:DIR]
                              #   sort = mass:desc (default) | size:desc | loc:desc
                              #          id:asc | insertion
  cs show <id>              # node detail + imports + importedBy
  cs read <id>              # file content
  cs write <id> <path-or-->  # write file from local path or stdin (-)
  cs edit <id> <find> <replace> [--all]
                              # precise edit: find string is replaced with new string
                              #   --all → replace all occurrences (default: must be unique)
  cs deps <id>              # outgoing edges (this -> X)
  cs users <id>             # incoming edges (X -> this)
  cs orphans                # all files with no in + no out edges (raw list)
                              #   includes entry points / configs / manifests (false-positives).
                              #   For high-confidence cleanup only: \`cs legacy --type orphan\`
  cs find <substring>       # **filename/path** match only. Cheap, no file read.
                              #   "find auth"  → src/auth/login.ts, lib/auth-utils.js …
                              #   For file CONTENTS, use \`cs search\` instead.
  cs search <query> [--regex] [--case] [--max N] [--json]
                              # **full-text CONTENT** search across all tracked files.
                              #   "search RUNPOD_API_KEY" → file:line:col + snippet.
                              #   mtime LRU cache → repeat searches sub-50ms when warm.
                              #   503 (scan in progress) → auto-retries 3× × 2s.
  cs focus <id>             # move app camera to node
  cs open <id>              # open inspector for node
  cs history <id>           # list auto-history snapshots
  cs restore <id> <ts>      # restore file to a history snapshot
  cs external               # list external websites this project calls
  cs packages               # list packages in a monorepo
  cs package <name>         # package detail: files, cross-pkg edges, declared deps
  cs package-graph          # package-to-package edges
  cs legacy [--type T] [--min-conf N]
                              # cleanup audit: T = orphan|path|filename|duplicate
                              #   --min-conf 0.85 → only high-confidence candidates
  cs trace [--limit N] [--tool T]
                              # current session's AI/CLI/MCP trace events (chronological)
  cs trace stats            # top files / tool breakdown / duration for current session
  cs trace sessions         # past sessions in .codesynapt/traces/
  cs trace export <path>    # write current session to JSON
  cs trace clear            # start a fresh session (old one preserved on disk)
  cs blast <id> [n] [dir]   # impact of editing <id>: dependents within n hops
                              #   n   = BFS depth (default 3)
                              #   dir = users|deps (default users)

  ── Function / symbol level (Layer 2) — needs desktop app ────
  cs symbol summary [--json]
                              # function-level overview: symbol/edge counts,
                              #   top hubs (most-called functions), coverage.
                              #   (Layer-2 equivalent of \`cs summary\`.)
  cs symbol find <query> [--json]
                              # functions/classes/… whose NAME contains <query>.
                              #   prints  id  kind  file:line.
  cs symbol callers <name|id> [--json]
                              # who CALLS this function (function-level blast
                              #   surface). Pass a bare name → resolved via find;
                              #   if ambiguous, candidates are listed (pick by id).
  cs symbol callees <name|id> [--json]
                              # what this function CALLS (its outgoing calls).
  cs symbol blast <name|id> [depth] [callers|callees] [--json]
                              # FUNCTION-level impact: what breaks if you change
                              #   this function. depth default 3, dir default callers.
                              #   File-level \`cs blast\` can call a hub file "low
                              #   risk" while a function inside is called everywhere.
  cs symbol node <id> [--json]
                              # one symbol's detail + source body + callers/callees.
                              #   id must be a full symbol id (from find/callers).
                              # Coverage: JS/TS + Python (+ validated tree-sitter
                              #   langs). Other languages: layer-1 only.
  cs safety <id> [--deep] [--json]
                              # 🟢/🟡/🔴 + 한 줄 권고. AI에게 시키기 전
                              #   "이 파일 건드려도 되나" 즉답.
                              #   --deep → 영향받는 파일 전체 리스트
  cs bundle <id> [--budget N] [--depth N] [--json]
                              # AI에게 "이 파일 수정해줘" 시킬 때 함께 줄
                              #   파일 묶음. token 예산(기본 8000) 안에서
                              #   가까운 의존 파일 우선 선택.
  cs env [VAR] [--json]     # .env 변수 ↔ 사용처 매핑. VAR 지정 안 하면
                              #   전체 + 미사용/미선언 상태 표시.
  cs suggest [--top N] [--json]
                              # "AI에게 다음에 시킬 작업" 자동 추천.
                              #   undeclared env, 테스트 없는 hub,
                              #   orphans, unused env, dynamic ratio 등.
  cs feature <keyword> [--json]
                              # "결제" / "auth" 같은 키워드 → 관련 파일
                              #   frontend/backend/shared 분류.
                              #   path 매칭 + 라우트 매칭 + apiCall 매칭.
  cs schema [Model] [--json]
                              # DB 모델 추출 — Prisma / Drizzle /
                              #   SQLAlchemy. Model 지정시 필드 + 사용처.
  cs bench [path]           # 응답시간 벤치마크 (scan + endpoint별 median/p95)
  cs vendors [--json]       # third-party 폴더 자동 감지
                              #   (LICENSE/own manifest/.git/conventional name)
                              #   → .codesynaptignore 권고
  cs secrets [--json]       # frontend 코드에 server-only env 변수
                              #   노출 탐지. public prefix 없는 변수가
                              #   브라우저 번들로 가면 키 유출.
  cs url [PATH] [--json]    # frontend URL → 파일 매핑.
                              #   Next app/pages, Astro, SvelteKit.
                              #   PATH 없으면 전체 등록 routes.
                              #   PATH 있으면 매칭 파일 (dynamic seg
                              #   처리).
  cs ensure [path]            # ensure desktop is running with [path] loaded
                              #   - desktop alive + same root → noop
                              #   - alive + different root    → POST /load (swap)
                              #   - desktop dead              → spawn it with
                              #                                CS_INITIAL_ROOT
                              #   used by /codesynapt slash command to give
                              #   one-shot "open project" UX from Claude Code
  cs init [path] [--agents] [--no-slash-command]
                              # 상시 사용 모드 셋업:
                              #   - CLAUDE.md 또는 AGENTS.md 생성 (사용 규칙)
                              #   - ~/.claude/commands/codesynapt.md 설치
                              #     → 그 후 Claude Code 안에서 \`/codesynapt\`
                              #       치면 cs_* 모드 진입
                              #   - claude mcp add 명령 안내 출력
  cs context [--output FILE] [--max-routes N] [--max-models N] [--watch]
                              # AI context file generator. Aggregates
                              #   summary + packages + url + schema + env +
                              #   external + legacy into a single Markdown
                              #   snapshot (CLAUDE.md / AGENTS.md format).
                              #   Default stdout. --output writes to a file.
                              #   --watch: regen on every snapshot change
                              #   (5 s poll). Requires --output.
  cs preflight [--strict] [--json]
                              # 배포 전 종합 점검. env 미선언, http URL,
                              #   테스트 없는 hub, orphan ratio 등.
                              #   exit 1 if fail (--strict면 warn도 fail).
  cs timeline               # git history → when each file first appeared
  cs tour                   # suggested guided tour of the project
  cs changes                # files modified this session
  cs diff <id>              # show first-seen vs current diff for one file

Env: CS_PORT (default 7707; legacy alias: FG3D_PORT). CS_AUTH_TOKEN for Bearer auth.`

// ── Headless: load scanner.js (ESM) and run a one-shot scan ──
async function runHeadlessScan(args) {
  // Parse args: scan [path] [--json|--summary] [--ext js,ts] [--min-mass N]
  let target = null
  let mode = 'json'  // 'json' (full) | 'summary' | 'edges' | 'files'
  let extFilter = null, minMass = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json')         mode = 'json'
    else if (a === '--summary') mode = 'summary'
    else if (a === '--edges')   mode = 'edges'
    else if (a === '--files')   mode = 'files'
    else if (a === '--ext' && args[i+1])      { extFilter = args[++i] }
    else if (a === '--min-mass' && args[i+1]) { minMass = parseInt(args[++i], 10) }
    else if (!a.startsWith('--') && !target) { target = a }
  }
  target = target || process.cwd()
  const path = require('path')
  const fs = require('fs')
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) return die(`path does not exist: ${abs}`)
  if (!fs.statSync(abs).isDirectory()) return die(`not a directory: ${abs}`)

  // scanner.js is ESM; dynamic import from CJS works in Node 18+
  const { Scanner } = await import('../scanner.js')
  const s = new Scanner(abs)
  return new Promise((resolve) => {
    let emitted = false
    // Safety timeout (CI). MUST be cleared on snapshot — otherwise this pending
    // timer keeps the Node event loop alive for the full 60s AFTER the result is
    // already printed, so every `cs scan` appears to hang for a minute.
    const safety = setTimeout(() => {
      if (!emitted) {
        process.stderr.write('scan timed out after 60s\n')
        try { s.stop() } catch {}
        resolve()
        process.exit(2)
      }
    }, 60_000)
    s.on('snapshot', (snap) => {
      if (emitted) return
      emitted = true
      clearTimeout(safety)
      let files = snap.files
      if (extFilter) {
        const exts = new Set(extFilter.split(',').map(x => x.trim()))
        files = files.filter((f) => exts.has(f.ext))
      }
      if (minMass > 0) {
        const inc = new Map()
        for (const e of snap.edges) inc.set(e.t, (inc.get(e.t) || 0) + 1)
        files = files.filter((f) => (inc.get(f.id) || 0) >= minMass)
      }
      if (mode === 'json') {
        printJson({
          root: abs,
          files,
          edges: snap.edges,
          monorepo: snap.monorepo,
          pkgEdges: snap.pkgEdges,
          fileCount: files.length,
          edgeCount: snap.edges.length,
          scannedAt: Date.now(),
        })
      } else if (mode === 'summary') {
        const inc = new Map()
        for (const e of snap.edges) inc.set(e.t, (inc.get(e.t) || 0) + 1)
        const byExt = {}
        for (const f of files) byExt[f.ext || 'other'] = (byExt[f.ext || 'other'] || 0) + 1
        // Exclude doc files (.md cross-links inflate mass and crowd out code hubs)
        const DOC_EXTS = new Set(['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc'])
        const topHubs = files
          .map((f) => ({ id: f.id, mass: inc.get(f.id) || 0, ext: f.ext }))
          .filter((h) => h.mass >= 2 && !DOC_EXTS.has(h.ext))
          .sort((a, b) => b.mass - a.mass)
          .slice(0, 10)
        const orphans = files.filter((f) => (inc.get(f.id) || 0) === 0 && f.importCount === 0).length
        process.stdout.write(`root: ${abs}\n`)
        process.stdout.write(`files: ${files.length}\n`)
        process.stdout.write(`edges: ${snap.edges.length}\n`)
        process.stdout.write(`orphans: ${orphans}\n`)
        if (snap.monorepo && snap.monorepo.kind !== 'none') {
          process.stdout.write(`monorepo: ${snap.monorepo.kind} (${snap.monorepo.packages.length} packages)\n`)
        }
        process.stdout.write(`\next mix:\n`)
        for (const [k, v] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
          process.stdout.write(`  .${k.padEnd(8)} ${v}\n`)
        }
        if (topHubs.length) {
          process.stdout.write(`\ntop hubs:\n`)
          for (const h of topHubs) process.stdout.write(`  m=${String(h.mass).padStart(3)}  ${h.id}\n`)
        }
      } else if (mode === 'edges') {
        for (const e of snap.edges) process.stdout.write(`${e.s}\t${e.k}\t${e.t}\n`)
      } else if (mode === 'files') {
        for (const f of files) process.stdout.write(`${f.id}\n`)
      }
      s.stop()
      resolve()
    })
    s.start()
  })
}

// ── Headless: long-running Scanner + HTTP server ─────────────
async function runHeadlessServe(args) {
  let target = null
  let port = parseInt(process.env.CS_PORT || process.env.FG3D_PORT || '7707', 10)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port' && args[i+1]) port = parseInt(args[++i], 10)
    else if (!a.startsWith('--') && !target) target = a
  }
  target = target || process.cwd()
  const path = require('path')
  const fs = require('fs')
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) return die(`path does not exist: ${abs}`)
  if (!fs.statSync(abs).isDirectory()) return die(`not a directory: ${abs}`)

  const { Scanner } = await import('../scanner.js')
  const { createControlServer } = require('../lib/control-server.cjs')

  let currentRoot = abs
  const scanner = new Scanner(abs)
  const { startControlServer, stopControlServer, epoch: csEpoch } = createControlServer({
    scanner,
    getCurrentRoot: () => currentRoot,
    // No IPC callbacks in headless mode — onBlast/onFocus/onOpen omitted
    authToken: process.env.CS_AUTH_TOKEN || null,
    auditLogDir: path.join(os.homedir(), '.codesynapt', 'audit'),
  })

  process.stderr.write(`[cs] scanning ${abs}\n`)
  scanner.on('snapshot', (snap) => {
    process.stderr.write(`[cs] snapshot: ${snap.files.length} files, ${snap.edges.length} edges\n`)
  })
  scanner.start()

  // A bad file or a rejected promise on a fire-and-forget path must NOT take
  // down a long-lived daemon the agent depends on. Log and keep serving.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[cs] uncaughtException: ${e && e.stack || e}\n`)
  })
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`[cs] unhandledRejection: ${e && e.stack || e}\n`)
  })

  const lockPath = path.join(os.homedir(), '.codesynapt', 'port')
  let lockWritten = false
  let boundPort = port
  try {
    // Scan for a free port from `port` upward (default 7707) instead of dying on
    // EADDRINUSE — a desktop or another daemon may hold the base port. The actual
    // bound port is advertised via the registry + lock so clients discover it.
    let actualPort = null
    for (let p = port; p < port + 25 && actualPort === null; p++) {
      try { const r = await startControlServer(p); actualPort = r.port }
      catch (e) { if (e.code !== 'EADDRINUSE') throw e }
    }
    if (actualPort === null) return die(`no free port in ${port}..${port + 24}`)
    boundPort = actualPort
    // [multi-session ②/2a] Register in the daemon registry keyed by canonical
    // projectHash so the new attach-or-spawn path can discover this daemon by
    // project. Purely ADDITIVE — the single ~/.codesynapt/port lock below stays
    // for the legacy discovery path during migration. `epoch` lets a client
    // detect a daemon restart (→ re-bootstrap). Heartbeat is unref'd so it never
    // keeps the process alive on its own; abnormal exit is covered by the TTL
    // (the entry simply goes stale and gets reaped — no +1/-1 counter to break).
    try {
      const registry = require('../lib/registry.cjs')
      const phash = registry.projectHash(abs)
      const epoch = csEpoch   // [③] same id the control-server reports on /health + /delta
      registry.touch('daemon', phash, { projectRoot: registry.canonicalRoot(abs), port: actualPort, epoch, pid: process.pid, startedAt: Date.now() })
      // [②] heartbeat + self-exit. Refcount = live session/viewer leases that
      // reference THIS project (NOT a counter). Self-exit only after a startup
      // grace AND several consecutive empty ticks, so a just-spawned daemon
      // never reaps itself before its spawning client has attached.
      const _LEASE_TTL = 15000, _GRACE_MS = 20000, _EMPTY_LIMIT = 3
      const _bornAt = Date.now()
      let _emptyTicks = 0
      const hb = setInterval(() => {
        try {
          registry.touch('daemon', phash, { port: actualPort, epoch })
          registry.cleanStale('session', _LEASE_TTL); registry.cleanStale('viewer', _LEASE_TTL)
          const sess = registry.readLive('session', { ttlMs: _LEASE_TTL, filter: (s) => { try { return registry.projectHash(s.projectRoot) === phash } catch { return false } } })
          const view = registry.readLive('viewer', { ttlMs: _LEASE_TTL, filter: (v) => v.attachedProjectHash === phash })
          _emptyTicks = (sess.length + view.length === 0) ? _emptyTicks + 1 : 0
          if (Date.now() - _bornAt > _GRACE_MS && _emptyTicks >= _EMPTY_LIMIT) {
            process.stderr.write('[cs] no live sessions/viewers — daemon self-exit\n')
            try { registry.remove('daemon', phash) } catch {}
            process.exit(0)
          }
        } catch {}
      }, 5000)
      if (hb.unref) hb.unref()
      process.stderr.write(`[cs] registry: daemons/${phash}.json (epoch ${String(epoch).slice(0, 8)})\n`)
    } catch (e) { process.stderr.write(`[cs] warning: registry register failed: ${e.message}\n`) }
    // Advertise the ACTUAL bound port so the CLI / MCP server auto-discover
    // this instance (they read ~/.codesynapt/port). Without this, `cs serve`
    // on any port is invisible to the MCP integration. But NEVER clobber a lock
    // a different live backend already holds — otherwise a 2nd `cs serve` on
    // another port silently repoints discovery off a still-alive first instance,
    // and if this one later dies the lock points at a dead port (mirrors the
    // MCP server's _startInProcessBackend guard).
    try {
      let existing = null
      try { if (fs.existsSync(lockPath)) { const p = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); if (p > 0 && p < 65536) existing = p } } catch {}
      const heldByOther = existing && existing !== actualPort && (await pingPort(existing))
      if (heldByOther) {
        process.stderr.write(`[cs] note: port lock kept at ${existing} (a live backend holds it). This instance on ${actualPort} is reachable, but CLI/MCP auto-discovery points at ${existing}. Use CS_PORT=${actualPort} to target this one.\n`)
      } else {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true })
        fs.writeFileSync(lockPath, String(actualPort))
        lockWritten = true
      }
    } catch (e) { process.stderr.write(`[cs] warning: could not write port lock: ${e.message}\n`) }
    process.stderr.write(`[cs] HTTP API on http://127.0.0.1:${actualPort}\n`)
    process.stderr.write(`[cs] port lock: ${lockPath}\n`)
    process.stderr.write(`[cs] try: curl http://127.0.0.1:${actualPort}/summary\n`)
    process.stderr.write(`[cs] Ctrl-C to stop.\n`)
  } catch (e) {
    return die(`server error: ${e.message}`)
  }

  // Block forever — graceful shutdown on SIGINT/SIGTERM
  const shutdown = async (signal) => {
    process.stderr.write(`\n[cs] ${signal} → shutting down\n`)
    // Only remove the lock if it still points at us (avoid clobbering a newer instance).
    try { if (lockWritten && fs.readFileSync(lockPath, 'utf8').trim() === String(boundPort)) fs.unlinkSync(lockPath) } catch {}
    try { await scanner.stop() } catch {}
    try { await stopControlServer() } catch {}
    process.exit(0)
  }
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Keep process alive
  return new Promise(() => {})
}

// ── CI: headless diff/blast for PR gating + commenting ───────
//
// Both ci-diff and ci-gate share the same pipeline:
//   1. Resolve the git range (e.g. main..HEAD)
//   2. git diff --name-only --diff-filter=ACMR  → changed files
//   3. Scan the repo at HEAD with Scanner
//   4. For each changed file still present, compute its blast radius
//      (transitive dependents, depth=3 by default)
//   5. Summarise + format

function parseGitRange(s) {
  // Accept: `main..HEAD`, `main...HEAD`, single ref → `<ref>..HEAD`
  if (!s) return null
  if (!s.includes('..')) return { base: s, head: 'HEAD', op: '..' }
  const op = s.includes('...') ? '...' : '..'
  const [base, head] = s.split(op)
  return { base, head: head || 'HEAD', op }
}

function execCapture(cmd, args, opts) {
  const { execFileSync } = require('child_process')
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, ...opts })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, error: e.message, stderr: e.stderr?.toString?.() || '' }
  }
}

async function runCiAnalysis(args) {
  const path = require('path')
  const fs = require('fs')
  let rangeStr = null, target = null
  let depth = 3
  const flags = { format: 'github-comment', maxBlast: null, maxChanged: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--format' && args[i+1])         flags.format = args[++i]
    else if (a.startsWith('--format='))        flags.format = a.slice(9)
    else if (a === '--depth' && args[i+1])     depth = parseInt(args[++i], 10)
    else if (a === '--max-blast' && args[i+1]) flags.maxBlast = parseInt(args[++i], 10)
    else if (a === '--max-changed' && args[i+1]) flags.maxChanged = parseInt(args[++i], 10)
    else if (!a.startsWith('--')) {
      if (!rangeStr) rangeStr = a
      else if (!target) target = a
    }
  }
  if (!rangeStr) die('usage: ci-diff <base..head> [path] [--format=...]')
  target = target || process.cwd()
  const abs = path.resolve(target)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    die(`not a directory: ${abs}`)
  }
  const range = parseGitRange(rangeStr)
  if (!range) die(`invalid git range: ${rangeStr}`)

  // 1. git diff — names only, A(dded) C(opied) M(odified) R(enamed)
  const diffArgs = ['diff', '--name-only', '--diff-filter=ACMR', `${range.base}${range.op}${range.head}`]
  const diff = execCapture('git', diffArgs, { cwd: abs })
  if (!diff.ok) {
    die(`git diff failed: ${diff.stderr || diff.error}\n  (is "${abs}" a git repo, and do refs "${range.base}"/"${range.head}" exist?)`)
  }
  const changed = diff.out.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean)

  // 2. Scan the graph for the SAME tree we diffed against.
  //
  // The diff range ends at `head` (a committed ref). The blast radius must
  // be computed from THAT committed tree — not from whatever happens to be in
  // the working directory. If we scanned `abs` directly, uncommitted edits
  // (new files that import a changed file, staged deletions, WIP refactors)
  // would silently inflate or deflate every dependent count, making the PR
  // report disagree with the diff it claims to describe.
  //
  // Design: materialise `head` into a throw-away detached git worktree, scan
  // that, then remove it. This guarantees graph ⇄ diff consistency for any
  // ref. If the repo cannot support a linked worktree (rare: very old git,
  // bare/odd setups), fall back to scanning `abs` and flag it loudly so the
  // numbers are never silently wrong.
  const { Scanner } = await import('../scanner.js')

  // Resolve `head` to a concrete commit so the worktree is deterministic and
  // the report can show exactly what tree it scanned.
  const headRev = execCapture('git', ['rev-parse', '--verify', '--quiet', `${range.head}^{commit}`], { cwd: abs })
  const headCommit = headRev.ok ? headRev.out.trim() : null

  let scanRoot = abs            // directory the Scanner reads
  let worktreeDir = null        // temp linked worktree to clean up
  let scanWarning = null        // surfaced in output when we could not isolate `head`
  let scannedTree = 'working-tree'

  if (headCommit) {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cidiff-'))
    const wt = path.join(tmpBase, 'head')
    const add = execCapture('git', ['worktree', 'add', '--detach', '--quiet', wt, headCommit], { cwd: abs })
    if (add.ok) {
      worktreeDir = wt
      scanRoot = wt
      scannedTree = headCommit.slice(0, 12)
    } else {
      // Could not isolate the committed tree — scan the working dir but be honest.
      try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
      scanWarning = `could not check out ${range.head} into an isolated worktree (${(add.stderr || add.error || '').split('\n')[0]}); blast radius reflects the WORKING TREE at ${abs}, which may differ from ${range.head}.`
    }
  } else {
    scanWarning = `'${range.head}' did not resolve to a commit; blast radius reflects the WORKING TREE at ${abs}, which may differ from the diff.`
  }

  let snap
  try {
    const s = new Scanner(scanRoot)
    snap = await new Promise((resolve) => {
      s.once('snapshot', resolve)
      s.start()
    })
    // We only need the snapshot; stop watching.
    try { s.stop() } catch {}
  } finally {
    if (worktreeDir) {
      // Remove the linked worktree, then the temp parent dir.
      execCapture('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: abs })
      try { fs.rmSync(path.dirname(worktreeDir), { recursive: true, force: true }) } catch {}
      // Prune any dangling administrative entry just in case.
      execCapture('git', ['worktree', 'prune'], { cwd: abs })
    }
  }

  // Build incoming-edge index for blast BFS
  const fileSet = new Set(snap.files.map((f) => f.id))
  const reverseEdges = new Map()  // t -> [s, s, ...]
  for (const e of snap.edges) {
    if (!reverseEdges.has(e.t)) reverseEdges.set(e.t, [])
    reverseEdges.get(e.t).push(e.s)
  }

  function blastFor(id, maxDepth) {
    if (!fileSet.has(id)) return null
    const visited = new Set([id])
    let frontier = new Set([id])
    for (let d = 1; d <= maxDepth; d++) {
      const next = new Set()
      for (const fid of frontier) {
        const users = reverseEdges.get(fid) || []
        for (const u of users) {
          if (visited.has(u)) continue
          visited.add(u); next.add(u)
        }
      }
      if (next.size === 0) break
      frontier = next
    }
    visited.delete(id)
    let tests = 0
    for (const fid of visited) {
      if (/(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$/i.test(fid)) tests++
    }
    return { dependents: visited.size, tests }
  }

  // 3. Per-file blast
  const perFile = []
  let trackedCount = 0
  let untrackedCount = 0
  let deletedCount = 0
  for (const id of changed) {
    if (fileSet.has(id)) {
      const r = blastFor(id, depth)
      perFile.push({ id, status: 'changed', dependents: r.dependents, tests: r.tests })
      trackedCount++
    } else {
      // Either deleted (gone from `head` entirely) or present-but-unscanned
      // (e.g. an extension the Scanner does not graph). Check against the SAME
      // tree we scanned (scanRoot), not the working dir, so the status matches
      // the diff range.
      const full = path.join(scanRoot, id)
      if (fs.existsSync(full)) {
        perFile.push({ id, status: 'untracked-ext', dependents: 0, tests: 0 })
        untrackedCount++
      } else {
        perFile.push({ id, status: 'deleted', dependents: 0, tests: 0 })
        deletedCount++
      }
    }
  }
  perFile.sort((a, b) => b.dependents - a.dependents)
  const maxBlast = perFile.reduce((m, x) => Math.max(m, x.dependents), 0)
  const totalTests = perFile.reduce((s, x) => s + x.tests, 0)
  return {
    root: abs, range,
    changedCount: changed.length,
    trackedCount, untrackedCount, deletedCount,
    perFile, maxBlast, totalTests, depth,
    snapshotFileCount: snap.files.length,
    snapshotEdgeCount: snap.edges.length,
    scannedTree, scanWarning,
    flags,
  }
}

function fmtCiPlain(r) {
  const lines = []
  lines.push(`cs ci-diff — ${r.range.base}${r.range.op}${r.range.head}`)
  lines.push(`root: ${r.root}`)
  lines.push(`scanned tree: ${r.scannedTree}`)
  if (r.scanWarning) lines.push(`WARNING: ${r.scanWarning}`)
  lines.push(`scan: ${r.snapshotFileCount} files, ${r.snapshotEdgeCount} edges`)
  lines.push(`changed: ${r.changedCount} (tracked ${r.trackedCount}, ext-untracked ${r.untrackedCount}, deleted ${r.deletedCount})`)
  lines.push(`max blast (depth ${r.depth}): ${r.maxBlast}   tests touched: ${r.totalTests}`)
  lines.push('')
  lines.push(`${'file'.padEnd(50)}  ${'status'.padEnd(13)}  ${'dep'.padStart(4)}  ${'test'.padStart(4)}`)
  lines.push('-'.repeat(80))
  for (const f of r.perFile) {
    const idShort = f.id.length > 50 ? '…' + f.id.slice(-49) : f.id
    lines.push(`${idShort.padEnd(50)}  ${f.status.padEnd(13)}  ${String(f.dependents).padStart(4)}  ${String(f.tests).padStart(4)}`)
  }
  return lines.join('\n') + '\n'
}

function fmtCiMarkdown(r) {
  const lines = []
  lines.push(`## 📦 cs impact — \`${r.range.base}${r.range.op}${r.range.head}\``)
  lines.push('')
  lines.push(`Scanned ${r.snapshotFileCount} files / ${r.snapshotEdgeCount} edges at \`${r.scannedTree}\`. Changed ${r.changedCount} files (tracked ${r.trackedCount}, ext-untracked ${r.untrackedCount}, deleted ${r.deletedCount}).`)
  lines.push('')
  if (r.scanWarning) {
    lines.push(`> ⚠️ ${r.scanWarning}`)
    lines.push('')
  }
  lines.push(`**Largest single-file blast (depth ${r.depth}):** ${r.maxBlast} dependents  ·  **Tests touched:** ${r.totalTests}`)
  lines.push('')
  const tracked = r.perFile.filter((f) => f.status === 'changed')
  if (tracked.length === 0) {
    lines.push('_No tracked source files changed._')
  } else {
    lines.push('| File | Status | Dependents (≤ depth) | Tests touched |')
    lines.push('|---|---|---:|---:|')
    for (const f of tracked.slice(0, 20)) {
      lines.push(`| \`${f.id}\` | ${f.status} | ${f.dependents} | ${f.tests} |`)
    }
    if (tracked.length > 20) lines.push(`| _…and ${tracked.length - 20} more_ | | | |`)
    const high = tracked.filter((f) => f.dependents >= 10)
    if (high.length) {
      lines.push('')
      lines.push('### ⚠️ High-impact files')
      for (const f of high) lines.push(`- \`${f.id}\` — ${f.dependents} dependents`)
    }
  }
  const other = r.perFile.filter((f) => f.status !== 'changed')
  if (other.length) {
    lines.push('')
    lines.push(`<details><summary>Other changed files (${other.length})</summary>`)
    lines.push('')
    for (const f of other) lines.push(`- \`${f.id}\` (${f.status})`)
    lines.push('</details>')
  }
  lines.push('')
  lines.push(`<sub>Generated by [CodeSynapt](https://github.com/wing1008/codesynapt) · depth ${r.depth}</sub>`)
  return lines.join('\n') + '\n'
}

async function runCiDiff(args) {
  const r = await runCiAnalysis(args)
  const fmt = r.flags.format
  if (fmt === 'json')               process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  else if (fmt === 'plain')         process.stdout.write(fmtCiPlain(r))
  else if (fmt === 'github-comment'
        || fmt === 'markdown'
        || fmt === 'md')            process.stdout.write(fmtCiMarkdown(r))
  else die(`unknown format: ${fmt} (use github-comment | json | plain)`)
}

async function runCiGate(args) {
  const r = await runCiAnalysis(args)
  // Defaults: if neither threshold given, fall back to lenient defaults
  // so the command still does something useful in --help-less invocations.
  const maxBlast   = r.flags.maxBlast   ?? Infinity
  const maxChanged = r.flags.maxChanged ?? Infinity
  const fails = []
  if (r.maxBlast > maxBlast) {
    const worst = r.perFile.filter((f) => f.dependents === r.maxBlast)
    fails.push(`blast: largest single-file impact is ${r.maxBlast} dependents (limit ${maxBlast})`)
    for (const f of worst.slice(0, 3)) fails.push(`  - ${f.id}`)
  }
  if (r.trackedCount > maxChanged) {
    fails.push(`changed: ${r.trackedCount} tracked files changed (limit ${maxChanged})`)
  }
  // Always print a one-line summary, then thresholds
  process.stderr.write(`cs ci-gate — ${r.range.base}${r.range.op}${r.range.head}\n`)
  if (r.scanWarning) process.stderr.write(`WARNING: ${r.scanWarning}\n`)
  process.stderr.write(`scanned tree: ${r.scannedTree}  ·  changed: ${r.trackedCount} tracked  ·  max blast (depth ${r.depth}): ${r.maxBlast}  ·  tests touched: ${r.totalTests}\n`)
  if (fails.length === 0) {
    process.stderr.write(`OK — all thresholds within limits.\n`)
    process.exit(0)
  }
  process.stderr.write(`\nFAIL:\n`)
  for (const line of fails) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE + '\n'); return
  }
  try {
    switch (cmd) {
      case 'scan': {
        // Headless one-shot scan — no desktop app required.
        // Loads scanner.js directly, waits for the initial snapshot,
        // emits result (full JSON or summary) and exits.
        await runHeadlessScan(args)
        break
      }
      case 'serve': {
        // Headless long-running daemon — Scanner + HTTP API, no Electron.
        // Drop-in replacement for the desktop app's :7707 control plane
        // for CLI / MCP / CI usage.
        await runHeadlessServe(args)
        break
      }
      case 'ci-diff': {
        // PR impact report. Headless: scans HEAD, diffs base..head,
        // emits per-file blast radius in markdown/json/plain.
        await runCiDiff(args)
        break
      }
      case 'ci-gate': {
        // PR gate for CI. Same data as ci-diff but exits 1 if any
        // threshold is breached.
        await runCiGate(args)
        break
      }
      case 'health': {
        const r = await req('GET', '/health')
        printJson(r.json); break
      }
      case 'summary': {
        const r = await req('GET', '/summary')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        printJson(r.json); break
      }
      case 'refresh': {
        if (!args[0]) return die('usage: cs refresh <id>')
        const r = await req('POST', '/refresh/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        printJson(r.json); break
      }
      case 'ls': {
        // optional: --limit N --ext X --min-mass N
        const q = {}
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--limit'    && args[i+1]) { q.limit    = args[++i] }
          else if (args[i] === '--ext'      && args[i+1]) { q.ext      = args[++i] }
          else if (args[i] === '--min-mass' && args[i+1]) { q.minMass  = args[++i] }
          else if (args[i] === '--sort'     && args[i+1]) { q.sort     = args[++i] }
        }
        const r = await req('GET', '/graph', q)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        for (const f of r.json.files) process.stdout.write(f.id + '\n')
        if (r.json.meta?.truncated) {
          process.stderr.write(`\n(showing ${r.json.meta.returned} of ${r.json.meta.totalAvailable} — pass --limit higher or filter)\n`)
        }
        break
      }
      case 'show': {
        if (!args[0]) return die('usage: cs show <id>')
        const r = await req('GET', '/node/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'not found')
        printJson(r.json); break
      }
      case 'read': {
        if (!args[0]) return die('usage: cs read <id>')
        const r = await req('GET', '/file/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        process.stdout.write(r.json.content); break
      }
      case 'deps': {
        if (!args[0]) return die('usage: cs deps <id>')
        const r = await req('GET', '/deps/' + encId(args[0]))
        for (const e of r.json) process.stdout.write(`${e.k}\t${e.t}\n`); break
      }
      case 'users': {
        if (!args[0]) return die('usage: cs users <id>')
        const r = await req('GET', '/users/' + encId(args[0]))
        for (const e of r.json) process.stdout.write(`${e.k}\t${e.s}\n`); break
      }
      case 'find': {
        if (!args[0]) return die('usage: cs find <substring>')
        const r = await req('GET', '/find', { q: args[0] })
        for (const id of r.json) process.stdout.write(id + '\n'); break
      }
      case 'orphans': {
        // All files with no incoming and no outgoing edges.
        // Includes entry points, configs, manifests (false-positives) — use
        // `cs legacy --type orphan` for the high-confidence subset only.
        const r = await req('GET', '/graph', { limit: '0' })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const files = r.json.files || []
        const edges = r.json.edges || []
        const inc = new Map(), out = new Map()
        for (const e of edges) {
          inc.set(e.t, (inc.get(e.t) || 0) + 1)
          out.set(e.s, (out.get(e.s) || 0) + 1)
        }
        const orphans = files
          .filter((f) => !inc.get(f.id) && !out.get(f.id))
          .sort((a, b) => (b.loc || 0) - (a.loc || 0))
        const byExt = {}
        for (const o of orphans) byExt[o.ext] = (byExt[o.ext] || 0) + 1
        for (const f of orphans) {
          process.stdout.write(`${f.id}  (${f.ext}, ${f.loc} LOC)\n`)
        }
        const extSummary = Object.entries(byExt).map(([k, v]) => `${k}:${v}`).join(' ')
        process.stdout.write(`\n${orphans.length} orphan${orphans.length===1?'':'s'} (${extSummary})\n`)
        process.stdout.write(`Note: includes entry points/configs/manifests (false-positives).\n`)
        process.stdout.write(`      For high-confidence cleanup only: \`cs legacy --type orphan\`\n`)
        break
      }
      case 'search': {
        // Full-text content search (vs `find` which matches file IDs only).
        if (!args[0]) return die('usage: cs search <query> [--regex] [--case] [--max N] [--json]')
        let query = null
        let regex = false, caseSensitive = false, max = 100, asJson = false
        for (let i = 0; i < args.length; i++) {
          const a = args[i]
          if      (a === '--regex') regex = true
          else if (a === '--case')  caseSensitive = true
          else if (a === '--json')  asJson = true
          else if (a === '--max' && args[i+1]) max = parseInt(args[++i], 10)
          else if (!query) query = a
        }
        if (!query) return die('usage: cs search <query> [--regex] [--case] [--max N]')

        // Retry on 503 (scan in progress) up to 3 times, 2s apart.
        let r
        const params = { q: query, regex: regex ? '1' : '0', case: caseSensitive ? '1' : '0', max: String(max) }
        for (let attempt = 0; attempt < 4; attempt++) {
          r = await req('GET', '/search', params)
          if (r.status !== 503) break
          if (attempt < 3) {
            process.stderr.write(`scan in progress (fileCount=${r.json?.fileCount ?? '?'}), retrying in 2s… [${attempt + 1}/3]\n`)
            await new Promise((res) => setTimeout(res, 2000))
          }
        }
        if (r.status !== 200) return die(r.json?.error || `search failed (status ${r.status})`)

        if (asJson) { printJson(r.json); break }

        const { matches, filesMatched, filesScanned, totalFiles, ms, truncated, cacheStats } = r.json
        if (matches.length === 0) {
          process.stdout.write(`no matches for "${query}" (${filesScanned}/${totalFiles} files, ${ms}ms)\n`)
          break
        }
        // Group by file for readable output
        const byFile = new Map()
        for (const m of matches) {
          if (!byFile.has(m.id)) byFile.set(m.id, [])
          byFile.get(m.id).push(m)
        }
        for (const [id, ms] of byFile) {
          for (const m of ms) {
            process.stdout.write(`${id}:${m.line}:${m.col}  ${m.snippet.trim()}\n`)
          }
        }
        const truncMark = truncated ? ' (truncated)' : ''
        process.stdout.write(`\n${matches.length} match${matches.length===1?'':'es'} in ${filesMatched} file${filesMatched===1?'':'s'}${truncMark} — ${filesScanned}/${totalFiles} scanned, ${ms}ms, cache hit-rate ${cacheStats.hitRate ?? 'n/a'}\n`)
        break
      }
      case 'focus': {
        if (!args[0]) return die('usage: cs focus <id>')
        const r = await req('POST', '/focus/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        process.stdout.write('focused: ' + args[0] + '\n'); break
      }
      case 'open': {
        if (!args[0]) return die('usage: cs open <id>')
        const r = await req('POST', '/open/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        process.stdout.write('opened: ' + args[0] + '\n'); break
      }
      case 'history': {
        if (!args[0]) return die('usage: cs history <id>')
        const r = await req('GET', '/history/' + encId(args[0]))
        if (r.status === 404 && /unknown endpoint/i.test(r.json?.error || '')) {
          return die(`history is not available on the headless server (cs serve) — auto-snapshots require the desktop app.`)
        }
        if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
        if (!Array.isArray(r.json)) return die(`unexpected response from /history: ${JSON.stringify(r.json)}`)
        if (r.json.length === 0) { process.stdout.write(`no history snapshots for ${args[0]}\n`); break }
        for (const v of r.json) {
          const d = new Date(v.ts).toISOString()
          process.stdout.write(`${v.ts}\t${d}\t${v.size}B\n`)
        }
        break
      }
      case 'restore': {
        if (!args[0] || !args[1]) return die('usage: cs restore <id> <ts>')
        const r = await req('POST', '/restore/' + encId(args[0]), { ts: args[1] })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        process.stdout.write('restored\n'); break
      }
      case 'blast': {
        if (!args[0]) return die('usage: cs blast <id> [depth] [dir]')
        const depth = args[1] && /^\d+$/.test(args[1]) ? args[1] : '3'
        const dir = args[2] === 'deps' ? 'deps' : 'users'
        const r = await req('GET', '/blast/' + encId(args[0]), { depth, dir })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        process.stdout.write(`seed: ${j.seed}\n`)
        process.stdout.write(`direction: ${j.direction === 'users' ? 'who imports this (blast radius)' : 'what this imports (closure)'}\n`)
        process.stdout.write(`depth: ${j.depth} hops\n`)
        process.stdout.write(`impact: ${j.totalFiles} files, ${j.totalLoc} LOC, ${(j.totalSize/1024).toFixed(1)} KB\n`)
        process.stdout.write(`est. tokens to read all: ~${j.tokenEstimate.toLocaleString()}\n`)
        process.stdout.write(`categories: source=${j.categories.source} tests=${j.categories.tests} config=${j.categories.config} docs=${j.categories.docs} other=${j.categories.other}\n\n`)
        for (const d of j.byDepth) {
          process.stdout.write(`  hop ${d.depth} (${d.ids.length} files):\n`)
          for (const id of d.ids.slice(0, 50)) process.stdout.write(`    ${id}\n`)
          if (d.ids.length > 50) process.stdout.write(`    … +${d.ids.length - 50} more\n`)
        }
        break
      }
      case 'symbol': {
        // ── Layer-2 (function/symbol) commands. Mirror the /symbol/* HTTP
        //    endpoints (already used by the MCP server). Symbol ids carry #/@,
        //    so they ride the ?id= query param (the control-server accepts both
        //    ?id= and the path tail). Reuse req() exactly like every Layer-1
        //    command — no new transport.
        const sub = args[0]
        const asJson = args.includes('--json')
        const rest = args.slice(1).filter((a) => a !== '--json')

        // Format a symbolNodeView for humans: "kind name  file:line  (cN/eN)".
        const fmtSym = (s) => {
          const loc = s.line ? `${s.file}:${s.line}` : s.file
          const deg = (s.callers !== undefined || s.callees !== undefined)
            ? `  (callers ${s.callers ?? 0}, callees ${s.callees ?? 0})` : ''
          process.stdout.write(`  [${(s.kind || '?').padEnd(8)}] ${s.name}\n      ${loc}${deg}\n      id: ${s.id}\n`)
        }

        // Resolve a name → symbol id via /symbol/find. If the arg already looks
        // like a full symbol id (an exact id match exists), use it directly.
        // Ambiguous bare names → print candidates and exit so the user re-runs
        // with the precise id.
        const resolveSymbol = async (nameOrId) => {
          // A full symbol id (file#name@line) — exactly what find/callers/the
          // picker print — passes straight through. /symbol/find searches by
          // NAME, so feeding it a full id matched nothing ("no symbol matching").
          if (/#.+@\d+$/.test(nameOrId)) return nameOrId
          const fr = await req('GET', '/symbol/find', { q: nameOrId })
          if (fr.status !== 200) die(fr.json?.error || `symbol find failed (status ${fr.status})`)
          const matches = (fr.json && fr.json.matches) || []
          // Exact id match wins (lets you pass an id straight through).
          const exactId = matches.find((m) => m.id === nameOrId)
          if (exactId) return exactId.id
          // Exact name match, single → use it.
          const byName = matches.filter((m) => m.name === nameOrId || m.name.endsWith('.' + nameOrId) || m.name.endsWith('#' + nameOrId))
          const pool = byName.length ? byName : matches
          if (pool.length === 0) {
            die(`no symbol matching "${nameOrId}". Coverage is JS/TS + Python (+ validated tree-sitter langs); other languages are layer-1 only. Try \`cs symbol find ${nameOrId}\`.`)
          }
          if (pool.length === 1) return pool[0].id
          // Ambiguous — list candidates, ask the user to pick by id.
          process.stderr.write(`"${nameOrId}" is ambiguous — ${pool.length} candidates. Re-run with one of these ids:\n\n`)
          for (const m of pool.slice(0, 25)) {
            process.stderr.write(`  ${m.id}\n      [${m.kind}] ${m.file}:${m.line}  (callers ${m.callers ?? 0})\n`)
          }
          if (pool.length > 25) process.stderr.write(`  … +${pool.length - 25} more (narrow the query)\n`)
          process.exit(1)
        }

        if (!sub || sub === 'summary') {
          const r = await req('GET', '/symbol/summary')
          if (r.status === 404) return die(r.json?.error || 'symbol mode requires the desktop app (not available on `cs serve`).')
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          const sc = j.symbolCount ?? j.nodes ?? j.totalSymbols ?? '?'
          const ec = j.edgeCount ?? j.edges ?? j.callEdges ?? '?'
          process.stdout.write(`function-level graph: ${sc} symbols, ${ec} edges\n`)
          if (j.byKind) {
            const kinds = Object.entries(j.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
            if (kinds) process.stdout.write(`by kind: ${kinds}\n`)
          }
          if (j.coverage) {
            const c = j.coverage
            process.stdout.write(`coverage: ${c.filesCovered}/${c.filesTotal} files (${c.coveragePct}%)`)
            if (c.uncoveredLangs && c.uncoveredLangs.length) process.stdout.write(`  · uncovered: ${c.uncoveredLangs.join(' ')}`)
            process.stdout.write(`\n`)
          }
          if (j.topHubs && j.topHubs.length) {
            process.stdout.write(`\ntop hubs (most-called functions):\n`)
            for (const h of j.topHubs.slice(0, 15)) {
              process.stdout.write(`  c=${String(h.callers).padStart(4)}  [${(h.kind || '?').padEnd(8)}] ${h.name}  ${h.file}:${h.line}\n`)
            }
          }
          // Honesty footer — make the static floor and its blind spots explicit
          // rather than letting the symbol counts read as "the whole call graph".
          const _be = j.byEdgeKind || {}
          const _dr = j.declineReasons || {}
          const _precise = _be.call || 0
          const _cand = _be['call-candidate'] || 0
          if (_cand || j.unresolvedAmbiguous) {
            const _stdlib = (_dr['builtin-method'] || 0) + (_dr['builtin-fallback'] || 0)
            const _gap = Math.max(0, (j.unresolvedAmbiguous || 0) - _stdlib)
            process.stdout.write(`\nresolution (static floor — treat as a lower bound, not the whole graph):\n`)
            process.stdout.write(`  ${_precise} precise · ${_cand} ambiguous (candidates shown, not pinned to one target)\n`)
            process.stdout.write(`  ${j.unresolvedAmbiguous || 0} declined = ${_stdlib} stdlib/builtin (correct, not edges) + ${_gap} genuinely unresolved\n`)
            if (j.dynamicSiteCount) {
              process.stdout.write(`  ${j.dynamicSiteCount} dynamic call sites in ${j.dynamicSiteSymbols} symbols (obj[x](), reflection, callbacks) — recorded, statically unresolvable; runtime tracing (cs trace run) fills them.\n`)
            } else {
              process.stdout.write(`  ⚠️  dynamic calls (obj[x](), DI, local callbacks) produce NO edge — only runtime tracing sees them.\n`)
            }
          }
          break
        }

        if (sub === 'accounting') {
          const r = await req('GET', '/symbol/accounting')
          if (r.status === 404) return die(r.json?.error || 'symbol mode requires a running backend (`cs serve` or the desktop app).')
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          process.stdout.write(`symbol accounting — every symbol labelled, unexplained must be 0\n`)
          process.stdout.write(`  total ${j.total} = entries ${j.entries} + reachable ${j.reachable} + possible ${j.possible} + dead ${j.dead}   (unexplained: ${j.unexplained})\n`)
          process.stdout.write(`  entry detection: ${j.entryDetection}\n`)
          process.stdout.write(`  ⚠️  dead = no STATIC evidence of life — a floor, not proof (${j.dynamicSiteCount} dynamic sites + framework-implicit entries can still invoke these)\n`)
          if (j.deadSymbols && j.deadSymbols.length) {
            process.stdout.write(`\ndead candidates (${j.dead}${j.deadTruncated ? ', truncated' : ''}):\n`)
            for (const d of j.deadSymbols.slice(0, 30)) {
              process.stdout.write(`  [${(d.kind || '?').padEnd(8)}] ${d.name}  ${d.file}:${d.line}\n`)
            }
            if (j.deadSymbols.length > 30) process.stdout.write(`  … ${j.deadSymbols.length - 30} more (--json for all)\n`)
          }
          break
        }

        if (sub === 'find') {
          if (!rest[0]) return die('usage: cs symbol find <query> [--json]')
          const q = rest[0]
          const r = await req('GET', '/symbol/find', { q })
          if (r.status === 404) return die(r.json?.error || 'symbol mode requires the desktop app.')
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          const matches = j.matches || []
          if (!matches.length) { process.stdout.write(`no symbols matching "${q}"\n`); break }
          process.stdout.write(`${matches.length} symbol${matches.length === 1 ? '' : 's'} matching "${q}":\n\n`)
          for (const m of matches) fmtSym(m)
          break
        }

        if (sub === 'callers' || sub === 'callees') {
          if (!rest[0]) return die(`usage: cs symbol ${sub} <name|id> [--json]`)
          const id = await resolveSymbol(rest[0])
          const r = await req('GET', '/symbol/' + sub, { id })
          if (r.status === 404) return die(r.json?.error || `symbol not found: ${id}`)
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          const list = j[sub] || []
          const label = sub === 'callers' ? 'callers (who calls this)' : 'callees (what this calls)'
          process.stdout.write(`${label} of ${id}\n`)
          if (!list.length) { process.stdout.write(`  (none)\n`) }
          else for (const s of list) fmtSym(s)
          const cand = sub === 'callers' ? j.candidateCallers : j.candidateCallees
          if (cand && cand.length) {
            process.stdout.write(`\ncandidate* (possible dynamic-dispatch, not confirmed):\n`)
            for (const s of cand) fmtSym(s)
            if (j.candidateNote) process.stdout.write(`\n  ${j.candidateNote}\n`)
          }
          // For callers, ALSO surface referencedBy (the symbol passed as a VALUE —
          // event listener, .map(fn), setTimeout(fn,…)). Without this, a callback-
          // only function shows "callers (none)" and is misread as dead code even
          // though the graph tracks the usage (and never marks it dead).
          if (sub === 'callers') {
            const nodeRes = await req('GET', '/symbol/node', { id })
            const refs = nodeRes.json?.referencedBy || []
            if (refs.length) {
              process.stdout.write(`\nreferenced as a value by (passed as callback/arg — used, NOT dead):\n`)
              for (const s of refs) fmtSym(s)
            }
          }
          break
        }

        if (sub === 'blast') {
          if (!rest[0]) return die('usage: cs symbol blast <name|id> [depth] [callers|callees] [--json]')
          const id = await resolveSymbol(rest[0])
          const depth = rest[1] && /^\d+$/.test(rest[1]) ? rest[1] : '3'
          const direction = rest.includes('callees') ? 'callees' : 'callers'
          const r = await req('GET', '/symbol/blast', { id, depth, direction })
          if (r.status === 404) return die(r.json?.error || `symbol not found: ${id}`)
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          process.stdout.write(`seed: ${j.seed.name}  (${j.seed.file}:${j.seed.line})\n`)
          process.stdout.write(`direction: ${j.direction === 'callers' ? 'who calls this (impact)' : 'what this calls (closure)'}\n`)
          process.stdout.write(`depth: ${j.depth} hops\n`)
          process.stdout.write(`impact: ${j.totalImpacted} symbols across ${j.filesTouched} files\n`)
          if (j.byDepth && j.byDepth.length) {
            process.stdout.write(`by hop: ${j.byDepth.map((d) => `h${d.depth}=${d.count}`).join('  ')}\n`)
          }
          process.stdout.write(`\n`)
          for (const s of (j.impacted || [])) {
            process.stdout.write(`  [${(s.kind || '?').padEnd(8)}] ${s.name}  ${s.file}:${s.line}\n`)
          }
          if (j.truncated) process.stdout.write(`  … (truncated — pass --json for the full list)\n`)
          if (j.caveat) process.stdout.write(`\n  ⚠ ${j.caveat}\n`)
          break
        }

        if (sub === 'node') {
          if (!rest[0]) return die('usage: cs symbol node <id> [--json]\n  (id is a full symbol id — get one from `cs symbol find`)')
          const id = rest[0]
          const r = await req('GET', '/symbol/node', { id })
          if (r.status === 404) return die(r.json?.error || `symbol not found: ${id}`)
          if (r.status !== 200) return die(r.json?.error || `failed (status ${r.status})`)
          const j = r.json
          if (asJson) { printJson(j); break }
          process.stdout.write(`[${j.kind || '?'}] ${j.name}\n`)
          process.stdout.write(`file: ${j.file}:${j.line}${j.exported ? '  (exported)' : ''}\n`)
          process.stdout.write(`callers ${(j.callers || []).length}  ·  callees ${(j.callees || []).length}\n`)
          if (j.callers && j.callers.length) {
            process.stdout.write(`\ncallers:\n`)
            for (const s of j.callers) process.stdout.write(`  [${(s.kind || '?').padEnd(8)}] ${s.name}  ${s.file}:${s.line}\n`)
          }
          if (j.callees && j.callees.length) {
            process.stdout.write(`\ncallees:\n`)
            for (const s of j.callees) process.stdout.write(`  [${(s.kind || '?').padEnd(8)}] ${s.name}  ${s.file}:${s.line}\n`)
          }
          if (j.source || j.body) {
            process.stdout.write(`\n--- source ---\n${j.source || j.body}\n`)
          }
          break
        }

        return die(`unknown symbol subcommand: ${sub}\n  valid: summary | find | callers | callees | blast | node`)
      }
      case 'safety': {
        if (!args[0]) return die('usage: cs safety <id> [--deep] [--json] [--locale ko|en]')
        const id = args[0]
        const deep = args.includes('--deep') ? '1' : null
        const asJson = args.includes('--json')
        let locale = null
        for (let i = 0; i < args.length; i++) if (args[i] === '--locale' && args[i+1]) locale = args[++i]
        const r = await req('GET', '/safety/' + encId(id), { deep, locale })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        const icon = j.level === 'risky' ? '🔴' : j.level === 'caution' ? '🟡' : '🟢'
        const label = j.level === 'risky' ? 'RISKY' : j.level === 'caution' ? 'CAUTION' : 'SAFE'
        process.stdout.write(`${icon} ${label}  ${id}\n`)
        process.stdout.write(`   의존 ${j.dependents}  ·  routes ${j.routes}  ·  외부 API ${j.externalUrls}  ·  테스트 ${j.testsInBlast}\n`)
        for (const r of j.reasons) process.stdout.write(`   · ${r}\n`)
        process.stdout.write(`\n   ${j.advice}\n`)
        if (j.blastFiles) {
          process.stdout.write(`\n   영향받는 파일 (${j.blastFiles.length}):\n`)
          for (const f of j.blastFiles.slice(0, 50)) process.stdout.write(`     ${f}\n`)
          if (j.blastFiles.length > 50) process.stdout.write(`     … +${j.blastFiles.length - 50} more\n`)
        }
        break
      }
      case 'bundle': {
        if (!args[0]) return die('usage: cs bundle <id> [--budget N] [--depth N] [--json]')
        const id = args[0]
        let budget = '8000', depth = '3'
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--budget' && args[i+1]) budget = args[++i]
          else if (args[i] === '--depth' && args[i+1]) depth = args[++i]
        }
        const asJson = args.includes('--json')
        const r = await req('GET', '/bundle/' + encId(id), { budget, depth })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        process.stdout.write(`📦 context bundle for ${j.seed}\n`)
        process.stdout.write(`   token 예산 ${j.budgetTokens.toLocaleString()} 중 ${j.usedTokens.toLocaleString()} 사용\n`)
        process.stdout.write(`   포함 ${j.filesIncluded} / 후보 ${j.totalCandidates} (생략 ${j.filesOmitted})\n\n`)
        for (const f of j.files) {
          process.stdout.write(`   [hop ${f.depth}]  ${f.id}  (${f.tokenCost.toLocaleString()} tok)\n`)
        }
        process.stdout.write(`\n   AI에게 줄 때:\n`)
        process.stdout.write(`     "${j.seed}을 수정하기 전에 위 ${j.filesIncluded}개 파일을 모두 읽어주세요."\n`)
        break
      }
      case 'bench': {
        // Measure scan + per-endpoint response times against the running server.
        let target = null
        for (const a of args) if (!a.startsWith('--') && !target) target = a
        target = target || process.cwd()
        const fs = require('fs')
        const pathMod = require('path')
        const abs = pathMod.resolve(target)
        if (!fs.existsSync(abs)) return die(`path: ${abs} not found`)

        process.stdout.write(`📊 CodeSynapt benchmark — ${abs}\n\n`)
        // 1. Standalone scan timing + memory delta
        const memBefore = process.memoryUsage()
        const t0 = Date.now()
        const { Scanner } = await import('../scanner.js')
        const s = new Scanner(abs)
        const snap = await new Promise((resolve) => {
          s.once('snapshot', resolve); s.start()
        })
        const scanMs = Date.now() - t0
        const memAfter = process.memoryUsage()
        const heapDeltaMB = ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)
        const rssMB = (memAfter.rss / 1024 / 1024).toFixed(1)
        try { s.stop() } catch {}
        process.stdout.write(`  scan (headless):              ${String(scanMs).padStart(6)} ms  (${snap.files.length} files / ${snap.edges.length} edges)\n`)
        process.stdout.write(`  memory after scan:            heap +${heapDeltaMB} MB   ·   RSS ${rssMB} MB\n`)

        // 2. Per-endpoint timing (only if server reachable)
        let serverUp = true
        try { await req('GET', '/health') } catch { serverUp = false }
        if (!serverUp) {
          process.stdout.write(`\n  (server not reachable — endpoint benchmarks skipped. Start \`npm start\` or \`cs serve\` first.)\n`)
          break
        }
        const endpoints = [
          ['GET /health',    'GET', '/health',   null],
          ['GET /summary',   'GET', '/summary',  null],
          ['GET /graph',     'GET', '/graph',    { limit: 100 }],
          ['GET /external',  'GET', '/external', null],
          ['GET /env',       'GET', '/env',      null],
          ['GET /preflight', 'GET', '/preflight', null],
        ]
        process.stdout.write(`\n  endpoint                       median(ms)  p95(ms)  iterations\n`)
        process.stdout.write(`  ${'-'.repeat(60)}\n`)
        for (const [label, method, p, q] of endpoints) {
          const samples = []
          // Warm-up once
          try { await req(method, p, q) } catch {}
          // 10 iterations
          for (let i = 0; i < 10; i++) {
            const start = Date.now()
            try { await req(method, p, q) } catch {}
            samples.push(Date.now() - start)
          }
          samples.sort((a, b) => a - b)
          const median = samples[Math.floor(samples.length / 2)]
          const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
          process.stdout.write(`  ${label.padEnd(30)}  ${String(median).padStart(8)}    ${String(p95).padStart(5)}        10\n`)
        }
        // 3. Live-update latency — for a MEASURED number (save → snapshot) plus
        // token benchmarks, run the standalone harness, which actually times the
        // watcher path instead of asserting the debounce config.
        process.stdout.write(`\n  live-update: ~0.35–0.46 s on real repos (file saved → new snapshot)\n`)
        process.stdout.write(`  ${'-'.repeat(60)}\n`)
        process.stdout.write(`  full speed + token benchmark:  node scripts/benchmark.mjs <repo>\n`)
        break
      }
      case 'vendors': {
        const asJson = args.includes('--json')
        const r = await req('GET', '/vendors')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        if (j.count === 0) {
          process.stdout.write(`✓ third-party 폴더 자동 감지: 없음\n`)
          break
        }
        process.stdout.write(`🔍 third-party 폴더 후보 ${j.count}개 (graph 오염 가능)\n\n`)
        for (const v of j.candidates) {
          const conf = v.confidence >= 0.7 ? '🔴' : v.confidence >= 0.5 ? '🟡' : '🟢'
          process.stdout.write(`  ${conf} ${v.path.padEnd(40)}  conf=${v.confidence}\n`)
          for (const reason of v.reasons) process.stdout.write(`       · ${reason}\n`)
        }
        process.stdout.write(`\n   ${j.tip}\n`)
        break
      }
      case 'secrets': {
        const asJson = args.includes('--json')
        const r = await req('GET', '/secrets')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        if (j.varCount === 0) {
          process.stdout.write(`✓ 노출 위험 변수 없음 — frontend는 모두 public prefix 사용\n`)
          break
        }
        process.stdout.write(`🔴 server-only env 변수 ${j.varCount}개가 frontend 코드에 사용됨 (총 ${j.leakCount}회)\n`)
        process.stdout.write(`   → 브라우저 번들에 포함되어 키 노출 위험.\n\n`)
        for (const v of j.vars) {
          process.stdout.write(`  · ${v.var}  (${v.files.length} files)\n`)
          for (const f of v.files.slice(0, 5)) process.stdout.write(`      - ${f}\n`)
          if (v.files.length > 5) process.stdout.write(`      … +${v.files.length - 5} more\n`)
        }
        process.stdout.write(`\n  해결: 서버 전용이면 server-side route(API)로 이동, 클라이언트 노출 의도면 NEXT_PUBLIC_/VITE_ 등 prefix 추가.\n`)
        break
      }
      case 'url': {
        const asJson = args.includes('--json')
        const p = args[0] && !args[0].startsWith('--') ? args[0] : null
        const r = await req('GET', '/url', p ? { path: p } : null)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        if (p) {
          process.stdout.write(`🔍 "${j.query}" 매칭 — ${j.count}개\n\n`)
          if (j.count === 0) process.stdout.write(`  매칭 없음. cs url (인자 없이)로 등록된 route 확인.\n`)
          for (const m of j.matches) {
            const dyn = m.dynamicCount ? ` [dynamic ${m.dynamicCount}]` : ''
            process.stdout.write(`  · [${m.kind.padEnd(10)}] ${m.url}  →  ${m.id}${dyn}\n`)
          }
        } else {
          process.stdout.write(`🔍 frontend routes — ${j.total}개\n`)
          process.stdout.write(`   by kind: ${Object.entries(j.byKind).map(([k,v]) => `${k}=${v}`).join('  ')}\n\n`)
          for (const r of j.routes.slice(0, 100)) {
            process.stdout.write(`  · [${r.kind.padEnd(10)}] ${r.url.padEnd(40)}  ${r.id}\n`)
          }
          if (j.routes.length > 100) process.stdout.write(`  … +${j.routes.length - 100} more\n`)
        }
        break
      }
      case 'schema': {
        const asJson = args.includes('--json')
        const model = args[0] && !args[0].startsWith('--') ? args[0] : null
        const r = await req('GET', '/schema', model ? { model } : null)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        if (model) {
          // detail view
          process.stdout.write(`📊 model: ${j.model}\n`)
          process.stdout.write(`definitions (${j.definitions.length}):\n`)
          for (const d of j.definitions) {
            process.stdout.write(`  · [${d.kind}] ${d.definedIn}${d.tableName ? `  (table: ${d.tableName})` : ''}\n`)
            for (const f of d.fields.slice(0, 30)) {
              process.stdout.write(`      - ${f.name}: ${f.type}\n`)
            }
            if (d.fields.length > 30) process.stdout.write(`      … +${d.fields.length - 30} more fields\n`)
          }
          process.stdout.write(`\nused in ${j.usedCount} files:\n`)
          for (const f of j.usedIn.slice(0, 30)) process.stdout.write(`  · ${f}\n`)
          if (j.usedIn.length > 30) process.stdout.write(`  … +${j.usedIn.length - 30} more\n`)
        } else {
          // overview
          process.stdout.write(`📊 DB schema overview — ${j.total} models\n`)
          if (j.total === 0) { process.stdout.write(`  (none detected — supports Prisma .prisma / Drizzle pgTable / SQLAlchemy Base)\n`); break }
          process.stdout.write(`  by kind: ${Object.entries(j.byKind).map(([k,v]) => `${k}=${v}`).join('  ')}\n\n`)
          for (const f of j.files) {
            process.stdout.write(`  ${f.file}:\n`)
            for (const m of f.models) {
              process.stdout.write(`    · ${m.name}${m.tableName && m.tableName !== m.name ? `  (${m.tableName})` : ''}  [${m.kind}, ${m.fieldCount} fields]\n`)
            }
          }
        }
        break
      }
      case 'ensure': {
        // Make sure the desktop is running and has [path] loaded.
        // Intended to be called by `/codesynapt` slash command so the user
        // gets a one-shot "open my project" experience from Claude Code.
        const fs = require('fs')
        const path = require('path')
        const os = require('os')
        const cp = require('child_process')

        let target = null
        for (let i = 0; i < args.length; i++) {
          if (!args[i].startsWith('--') && !target) target = args[i]
        }
        target = target || process.cwd()
        const abs = path.resolve(target)
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) die(`not a directory: ${abs}`)

        // Helper: re-read lock file (PORT was captured at module load; new
        // desktop may bind a different port).
        const readPortLock = () => {
          try {
            const lockPath = path.join(os.homedir(), '.codesynapt', 'port')
            if (fs.existsSync(lockPath)) {
              const p = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
              if (p > 0 && p < 65536) return p
            }
          } catch {}
          return null
        }
        const pingHealth = (port) => new Promise((resolve) => {
          const r = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1500 }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
              catch { resolve(null) }
            })
          })
          r.on('error', () => resolve(null))
          r.on('timeout', () => { r.destroy(); resolve(null) })
          r.end()
        })
        const postLoad = (port, p) => new Promise((resolve, reject) => {
          const payload = JSON.stringify({ path: p })
          const r = http.request({ host: '127.0.0.1', port, path: '/load', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 60000 }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
              catch { resolve({ status: res.statusCode, body: null }) }
            })
          })
          r.on('error', reject)
          r.write(payload); r.end()
        })

        // ── [B] Registry/daemon mode — DEFAULT ON (set CS_REGISTRY=0 to force the
        // legacy desktop-spawn path below). Ensure the per-project HEADLESS
        // `cs serve` daemon, NOT the desktop: the desktop is now opened separately
        // by the human as a pure viewer. One daemon per project (registry O_EXCL
        // lock) makes /codesynapt deterministic regardless of launch order, and the
        // MCP attaches to the SAME daemon. See docs/design-multi-session.md.
        //
        // NOTE: the daemon self-exits when no MCP session / viewer lease references
        // it (idle-reap, by design). `cs ensure` only pre-warms it; the MCP that
        // follows (steps 2-3 of /codesynapt) registers the session lease that keeps
        // it alive. Running `cs ensure` ALONE will spin a daemon that reaps itself
        // shortly after — that is expected, not a failure.
        let _registry = null
        try { _registry = require('../lib/registry.cjs') } catch { /* optional during migration */ }
        if (_registry && process.env.CS_REGISTRY !== '0') {
          const DAEMON_TTL_MS = 15000
          const phash = _registry.projectHash(abs)
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          const sameRoot = (a) => {
            if (!a) return false
            const A = path.resolve(a)
            return process.platform === 'win32' ? A.toLowerCase() === abs.toLowerCase() : A === abs
          }
          const spawnDaemon = () => {
            const child = cp.spawn(process.execPath, [__filename, 'serve', abs], {
              detached: true, stdio: 'ignore', env: { ...process.env },
            })
            child.unref()
          }

          const budgetMs = 240_000
          const startedAt = Date.now()
          let spawned = false
          let lastProgressAt = 0
          while (Date.now() - startedAt < budgetMs) {
            const d = _registry.readDaemon(phash, DAEMON_TTL_MS)
            if (d && d.port) {
              const h = await pingHealth(d.port)
              if (h && h.status === 200 && sameRoot(h.body?.root)) {
                if (h.body.initialScanComplete === true) {
                  process.stdout.write(`✅ daemon ready at :${d.port} (${h.body.fileCount} files, ${h.body.edgeCount ?? 0} edges, ${((Date.now()-startedAt)/1000).toFixed(1)}s)\n`)
                  printJson({ ok: true, action: spawned ? 'spawned' : 'attached', mode: 'daemon', port: d.port, root: abs, fileCount: h.body.fileCount, edgeCount: h.body.edgeCount })
                  process.exit(0)
                }
                const now = Date.now()
                if (now - lastProgressAt > 4000) {
                  lastProgressAt = now
                  const phase = h.body.scanPhase || 'scanning'
                  process.stdout.write((phase === 'building'
                    ? `⏳ building graph (resolving edges)… ${h.body.fileCount} files`
                    : `⏳ scanning… ${h.body.fileCount} files`) + '\n')
                }
              }
            }
            if (!spawned) {
              // No live daemon serving this project → race to spawn exactly one.
              // The O_EXCL lock serialises concurrent ensures/MCPs: winner spawns,
              // losers keep polling readDaemon for the winner's published port.
              const lock = _registry.acquireDaemonLock(phash, { pid: process.pid }, DAEMON_TTL_MS)
              if (lock.won) {
                spawnDaemon(); spawned = true
                process.stdout.write(`🚀 starting headless daemon (cs serve ${abs})\n`)
              }
            }
            await sleep(500)
          }
          // Timed out polling — a daemon that's up but still scanning is NOT an error.
          const d2 = _registry.readDaemon(phash, DAEMON_TTL_MS)
          if (d2 && d2.port) {
            const h = await pingHealth(d2.port)
            if (h && h.status === 200 && sameRoot(h.body?.root)) {
              process.stdout.write(`⏳ daemon up at :${d2.port} and still scanning ${abs} — proceed (the MCP connects when the scan finishes) or re-run \`cs ensure\`.\n`)
              printJson({ ok: true, action: 'loading', mode: 'daemon', port: d2.port, root: abs, note: 'scan in progress (not an error)' })
              process.exit(0)
            }
          }
          die(`daemon did not become ready for ${abs} within ${budgetMs/1000}s. Set CS_REGISTRY=0 to use the legacy desktop launch.`)
        }

        // Stage 1 (legacy desktop-spawn path — only when CS_REGISTRY=0): desktop alive?
        const initialPort = readPortLock() || PORT
        const h1 = await pingHealth(initialPort)
        if (h1 && h1.status === 200) {
          const root = h1.body?.root
          if (root && path.resolve(root) === abs) {
            process.stdout.write(`✅ desktop already running at :${initialPort} with ${abs} (${h1.body.fileCount} files)\n`)
            printJson({ ok: true, action: 'noop', port: initialPort, root: abs, fileCount: h1.body.fileCount })
            break
          }
          // Alive but loaded a different (or no) project → swap via /load
          process.stdout.write(`📂 swapping desktop project: ${root || '(none)'} → ${abs}\n`)
          try {
            const r = await postLoad(initialPort, abs)
            if (r.status !== 200) die(`load failed: ${r.body?.error || r.status}`)
            process.stdout.write(`✅ loaded (${r.body.fileCount} files)\n`)
            printJson({ ok: true, action: 'loaded', port: initialPort, ...r.body })
          } catch (e) { die(`load request failed: ${e.message}`) }
          break
        }

        // Stage 2: desktop is dead → spawn it.
        //
        // Two environments to handle:
        //   (a) Installed via NSIS .exe — fg3dRoot = INSTDIR\resources\app.
        //       The packaged desktop is at INSTDIR\CodeSynapt.exe (siblings of
        //       resources\). Spawn it directly with no args; the packaged
        //       electron auto-runs its bundled main.
        //   (b) Dev / npm install — fg3dRoot = repo root with node_modules.
        //       Use require('electron') for the absolute electron binary path
        //       and pass '.' so electron runs main.cjs.
        const fg3dRoot = path.resolve(__dirname, '..', '..', '..')
        const pkgJson = path.join(fg3dRoot, 'package.json')
        if (!fs.existsSync(pkgJson)) die(`cannot find codesynapt root at ${fg3dRoot} — install may be broken`)

        // (a) Installed environment: INSTDIR\CodeSynapt.exe
        const installedExe = path.resolve(fg3dRoot, '..', '..', 'CodeSynapt.exe')
        let spawnExe = null
        let spawnArgs = []
        let spawnCwd = fg3dRoot

        if (fs.existsSync(installedExe)) {
          spawnExe = installedExe
          spawnArgs = []                   // packaged electron self-launches main
          spawnCwd  = path.dirname(installedExe)
        } else {
          // (b) Dev environment: require('electron')
          try {
            const electronExe = require(path.join(fg3dRoot, 'node_modules', 'electron'))
            if (typeof electronExe === 'string' && fs.existsSync(electronExe)) {
              spawnExe = electronExe
              spawnArgs = ['.']
            }
          } catch (e) { /* fall through to error */ }
        }

        if (!spawnExe) {
          die(`Cannot locate CodeSynapt desktop binary.\n` +
              `  Tried installed: ${installedExe}\n` +
              `  Tried dev:       ${path.join(fg3dRoot, 'node_modules', 'electron')}\n` +
              `  → Install the desktop app, or run \`npm install\` in ${fg3dRoot}.`)
        }

        process.stdout.write(`🚀 starting desktop (${spawnExe}, CS_INITIAL_ROOT=${abs})\n`)
        const child = cp.spawn(spawnExe, spawnArgs, {
          cwd: spawnCwd,
          env: { ...process.env, CS_INITIAL_ROOT: abs },
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        })
        child.unref()

        // Stage 3: poll /health until the desktop has loaded `abs` AND finished
        // its first scan (initialScanComplete). Declaring "ready" at fileCount>0
        // used to return a half-built graph (edges still resolving) — callers
        // then saw edgeCount 0. The full first scan of a large repo can take a
        // couple of minutes on Windows, so give it room.
        const timeoutMs = 240_000
        const startedAt = Date.now()
        let last = null
        let lastProgressAt = 0
        while (Date.now() - startedAt < timeoutMs) {
          await new Promise((r) => setTimeout(r, 1000))
          const port = readPortLock() || initialPort
          const h = await pingHealth(port)
          if (h && h.status === 200) {
            last = { port, ...h.body }
            const root = h.body?.root
            if (root && path.resolve(root) === abs) {
              if (h.body.initialScanComplete === true) {
                process.stdout.write(`✅ desktop ready at :${port} (${h.body.fileCount} files, ${h.body.edgeCount ?? 0} edges, ${((Date.now()-startedAt)/1000).toFixed(1)}s)\n`)
                printJson({ ok: true, action: 'spawned', port, root: abs, fileCount: h.body.fileCount, edgeCount: h.body.edgeCount, elapsedMs: Date.now()-startedAt })
                process.exit(0)
              }
              // Not done yet — surface what stage it's in, throttled.
              const now = Date.now()
              if (now - lastProgressAt > 4000) {
                lastProgressAt = now
                const phase = h.body.scanPhase || 'scanning'
                const msg = phase === 'building'
                  ? `⏳ building graph (resolving edges)… ${h.body.fileCount} files`
                  : `⏳ scanning… ${h.body.fileCount} files`
                process.stdout.write(`${msg}\n`)
              }
            }
          }
        }
        // Timed out polling — but distinguish "still working" from real failure.
        // If the desktop is up with the right root (just hasn't finished its
        // first scan), that is NOT an error: say so and exit clean.
        if (last && last.root && path.resolve(last.root) === abs) {
          const phase = last.scanPhase || 'scanning'
          const stage = phase === 'building' ? 'building the edge graph' : 'scanning files'
          process.stdout.write(`⏳ desktop is up at :${last.port} and still ${stage} for ${abs} — the first scan of a large repo can take a while. It will be ready shortly; just proceed (the MCP connects when the scan finishes) or re-run \`cs ensure\`.\n`)
          printJson({ ok: true, action: 'loading', port: last.port, root: abs, fileCount: last.fileCount || 0, scanPhase: phase, note: 'scan in progress (not an error)' })
          process.exit(0)
        }
        die(`desktop did not load ${abs} within ${timeoutMs/1000}s. last health: ${JSON.stringify(last)}`)
      }
      case 'init': {
        // One-shot setup for opt-in mode:
        //   1. Generate CLAUDE.md (or AGENTS.md) in target project — project
        //      snapshot only, NO always-on rules. Default behavior is OFF.
        //   2. Install TWO Claude Code slash commands:
        //        ~/.claude/commands/codesynapt.md       — force cs_*-first mode
        //        ~/.claude/commands/codesynapt-auto.md  — auto mode (non-trivial only)
        //   3. Print exact `claude mcp add` command for the user to copy.
        // Does NOT execute mcp add or npm start automatically — those have
        // user-specific side effects (auth, port choice) so we print
        // copy-paste commands instead.
        const fs = require('fs')
        const path = require('path')
        const os = require('os')
        let target = null
        let outputName = 'CLAUDE.md'
        let installSlash = true   // default: install Claude Code slash command
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--agents') outputName = 'AGENTS.md'
          else if (args[i] === '--output' && args[i+1]) outputName = args[++i]
          else if (args[i] === '--no-slash-command') installSlash = false
          else if (!args[i].startsWith('--') && !target) target = args[i]
        }
        target = target || process.cwd()
        const abs = path.resolve(target)
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) die(`not a directory: ${abs}`)

        // Generate context with rules (call /summary first to ensure server reachable)
        const health = await req('GET', '/health').catch(() => null)
        if (!health || health.status !== 200) {
          process.stderr.write(`⚠ codesynapt server not reachable. Start it first:\n`)
          process.stderr.write(`    cd ${process.cwd()} && npm start         (desktop)\n`)
          process.stderr.write(`    OR\n`)
          process.stderr.write(`    cs serve ${abs}                          (headless daemon)\n`)
          process.exit(1)
        }
        // Re-invoke ourselves to generate CLAUDE.md
        const { spawnSync } = require('child_process')
        const outFile = path.join(abs, outputName)
        // Don't silently destroy an existing CLAUDE.md/AGENTS.md — it may hold
        // hand-written agent instructions. Back it up before regenerating.
        if (fs.existsSync(outFile)) {
          const bak = outFile + '.bak'
          try {
            fs.copyFileSync(outFile, bak)
            process.stderr.write(`ℹ existing ${outputName} backed up to ${path.basename(bak)}\n`)
          } catch (e) {
            die(`refusing to overwrite ${outputName}: could not back it up — ${e.message}`)
          }
        }
        const r = spawnSync(process.execPath, [__filename, 'context', '--output', outFile], { stdio: 'inherit' })
        if (r.status !== 0) die('context generation failed')

        // Install Claude Code slash commands (user-level: ~/.claude/commands/)
        //   - codesynapt.md       → force mode (cs_* preferred for any non-trivial)
        //   - codesynapt-auto.md  → auto mode (cs_* only on non-trivial; skips typos/docs)
        let slashForceFile = null
        let slashAutoFile = null
        let installSlashStates = null
        if (installSlash) {
          const slashDir = path.join(os.homedir(), '.claude', 'commands')
          slashForceFile = path.join(slashDir, 'codesynapt.md')
          slashAutoFile  = path.join(slashDir, 'codesynapt-auto.md')

          const forceBody = [
            '---',
            'description: CodeSynapt FORCE mode — auto-launch desktop, load cwd, prefer cs_* MCP tools for every non-trivial query/edit',
            '---',
            '',
            '**Step 1 (do this immediately, via Bash):**',
            '',
            '```',
            'cs ensure',
            '```',
            '',
            'This makes sure the CodeSynapt desktop app is running with the current working directory loaded. It is a no-op if the desktop is already loaded with the same folder; otherwise it auto-launches or swaps. Wait for it to print `✅` (up to 60s on first launch).',
            '',
            '**Step 2:** From this point on in the session, treat CodeSynapt as the primary code-intelligence backend. Before edits, queries, or "what does this code do" style questions, prefer the cs_* MCP tools over reading raw files or running shell commands.',
            '',
            '**Step 3:** call `cs_summary({action:\'project\'})` once now to load the project shape (~300 tokens).',
            '',
            '**For the rest of the session, follow these rules:**',
            '',
            '| When | Tool |',
            '|---|---|',
            '| **Impact analysis** — user says "비활성화", "제거", "지워", "리팩토링", "안전", "영향", "범위", "깨지나", "쓰는 곳", "disable", "remove", "delete", "refactor", "safe to", "impact", "affected", "blast" | **MUST `cs_blast({action:\'safety\', id})` FIRST** — do NOT answer impact questions via grep/read alone. cs_blast is exactly for this. |',
            '| About to edit a file ≥ 100 LOC, hub file, or refactor | `cs_blast({action:\'safety\', id})` first |',
            '| Safety 🟡 or 🔴 | `cs_blast({action:\'bundle\', id, budget:8000})` to pack context |',
            '| 🔴 RISKY verdict | STOP, surface to user, ask for confirmation |',
            '| "Find the X feature / Y screen / where is the X page" | `cs_intent({action:\'feature\'|\'url\'|\'schema\'})` (NOT grep) |',
            '| Dependency questions ("who uses X?", "X 쓰는 곳", "X 참조하는") | `cs_query({action:\'users\'|\'deps\', id})` (NOT grep) |',
            '| Editing non-trivial files | prefer `cs_change({action:\'edit\', id, find, replace})` over your own Edit tool (auto-snapshots + 3D pulse) |',
            '| Before suggesting a significant commit/deploy | `cs_health({action:\'preflight\'})` |',
            '| User asks "what next?" / 뭐 할까 | `cs_health({action:\'suggest\', top:5})` |',
            '| Korean user | add `locale: \'ko\'` to safety/preflight/suggest |',
            '',
            '**Hard rule for impact questions**: if the user asks "if I remove/disable/refactor X, what breaks?" — the answer comes from `cs_blast({action:\'safety\', id: X})`. Read+Grep is the fallback, NOT the first move. Doing impact analysis without cs_blast in FORCE mode is a bug.',
            '',
            '**Skip cs_* for trivial work**: typos, comment-only changes, formatting, single-literal swaps, README/docs edits, brand-new files in this session, general conversation, or "explain X" questions.',
            '',
            "If the user later types `/clear` or starts a new session, this mode resets. To re-enter, call `/codesynapt` again.",
          ].join('\n') + '\n'

          const autoBody = [
            '---',
            'description: CodeSynapt AUTO mode — auto-launch desktop + load cwd, then call cs_* only for non-trivial work',
            '---',
            '',
            '**Step 1 (do this immediately, via Bash):**',
            '',
            '```',
            'cs ensure',
            '```',
            '',
            'This makes sure the CodeSynapt desktop app is running with the current working directory loaded. No-op if already loaded; otherwise auto-launches or swaps. Wait for the `✅` line (up to 60s).',
            '',
            "**Step 2:** From this point on in the session, the CodeSynapt MCP server is available. **Do not call cs_* tools for trivial work** — but DO call them automatically when the work is non-trivial (per the table below). When in doubt, lean toward NOT calling.",
            '',
            '**Skip cs_* entirely for:**',
            '- Typos, comment-only changes, formatting, single literal swaps',
            '- README / docs / CHANGELOG edits',
            '- Single-line bug fixes in a leaf file',
            '- General conversation / Q&A / "explain X" questions',
            '- Brand-new files the user just created this session',
            '',
            '**Call cs_* automatically when:**',
            '',
            '| Situation | Tool to call |',
            '|---|---|',
            '| First message about an unfamiliar project | `cs_summary({action:\'project\'})` once (~300 tokens) |',
            '| **Impact / removal / refactor questions** ("X 비활성화하면?", "X 제거해도 돼?", "리팩토링 영향", "what breaks if I remove X", "is it safe to delete X") | **MUST `cs_blast({action:\'safety\', id: X})` FIRST**. This is the #1 use case for cs_*. Read+Grep for impact is wrong tool. |',
            '| Refactor / rename / signature change / removed export / multi-file edit | `cs_blast({action:\'safety\', id})` first |',
            '| Safety 🟡 or 🔴 | `cs_blast({action:\'bundle\', id, budget:8000})` |',
            '| 🔴 RISKY verdict | STOP, surface to user, ask for confirmation |',
            '| "Find the X feature / Y screen / where is the X page" | `cs_intent({action:\'feature\'|\'url\'|\'schema\'})` (NOT grep) |',
            '| "Who uses X?" / "X 쓰는 곳" / "Is X used anywhere?" | `cs_query({action:\'users\', id})` (NOT grep) |',
            '| Editing a file ≥ 100 LOC or known hub | prefer `cs_change({action:\'edit\', id, find, replace})` |',
            '| Before suggesting a significant commit/deploy | `cs_health({action:\'preflight\'})` |',
            '| User asks "what next?" / 뭐 할까 / open-ended | `cs_health({action:\'suggest\', top:5})` |',
            '| Korean user | add `locale: \'ko\'` to safety/preflight/suggest |',
            '',
            "If the user later types `/clear` or starts a new session, this mode resets. To re-enter, call `/codesynapt-auto` again. For stricter mode (cs_* preferred for everything), call `/codesynapt` instead.",
          ].join('\n') + '\n'

          // Write when the file is missing OR its content drifted from the
          // current contract — a bare existence guard would silently keep a
          // stale slash-command body across upgrades, so a re-run of `cs init`
          // must refresh it. Track which files were created vs refreshed so the
          // checklist reports the truth instead of always claiming "installed".
          const slashState = (file, body) => {
            try {
              if (!fs.existsSync(file)) return 'created'
              return fs.readFileSync(file, 'utf8') === body ? 'unchanged' : 'updated'
            } catch { return 'created' }
          }
          let slashForceState = null, slashAutoState = null
          try {
            fs.mkdirSync(slashDir, { recursive: true })
            slashForceState = slashState(slashForceFile, forceBody)
            slashAutoState  = slashState(slashAutoFile,  autoBody)
            if (slashForceState !== 'unchanged') fs.writeFileSync(slashForceFile, forceBody, 'utf8')
            if (slashAutoState  !== 'unchanged') fs.writeFileSync(slashAutoFile,  autoBody,  'utf8')
            installSlashStates = { force: slashForceState, auto: slashAutoState }
          } catch (e) {
            slashForceFile = null
            slashAutoFile = null
            process.stderr.write(`⚠ could not write slash command(s): ${e.message}\n`)
          }
        }

        // Print setup checklist
        const selfMcp = path.resolve(__dirname, 'codesynapt-mcp.cjs')
        process.stdout.write(`\n✅ CodeSynapt setup (opt-in mode — OFF by default)\n\n`)
        process.stdout.write(`  1. ${outputName} written to ${outFile}\n`)
        process.stdout.write(`     → project snapshot only. No always-on rules.\n\n`)
        if (slashForceFile && fs.existsSync(slashForceFile) && slashAutoFile && fs.existsSync(slashAutoFile)) {
          // Report the truth: created (new), refreshed (drifted contract rewritten),
          // or up to date (unchanged) — not a blanket "installed" on every re-run.
          const verb = (s) => s === 'created' ? 'created' : s === 'updated' ? 'refreshed' : 'up to date'
          const fState = installSlashStates?.force ?? 'created'
          const aState = installSlashStates?.auto ?? 'created'
          process.stdout.write(`  2. Two Claude Code slash commands:\n`)
          process.stdout.write(`     ${slashForceFile}  (${verb(fState)})\n`)
          process.stdout.write(`     ${slashAutoFile}  (${verb(aState)})\n\n`)
          process.stdout.write(`     Inside a Claude Code session, type one of:\n`)
          process.stdout.write(`       /codesynapt        — FORCE mode: cs_* preferred for every non-trivial query/edit\n`)
          process.stdout.write(`       /codesynapt-auto   — AUTO mode: cs_* only on non-trivial work; skips typos/docs\n\n`)
        } else {
          process.stdout.write(`  2. (Slash commands skipped — pass --no-slash-command to opt out, or check permissions on ~/.claude/commands/)\n\n`)
        }
        process.stdout.write(`  3. Register the MCP server with your AI client (one-time):\n\n`)
        process.stdout.write(`     Claude Code:\n`)
        process.stdout.write(`       claude mcp add codesynapt node ${selfMcp}\n\n`)
        process.stdout.write(`     Cursor / Continue / others: see docs/mcp-setup.md\n\n`)
        process.stdout.write(`  4. Keep the desktop app (or 'cs serve') running while you work.\n`)
        process.stdout.write(`     Lock file: ~/.codesynapt/port — CLI/MCP auto-discovers it.\n\n`)
        process.stdout.write(`  5. (Optional) Auto-refresh ${outputName} on every change:\n`)
        process.stdout.write(`       cs context --output ${outFile} --watch\n\n`)
        process.stdout.write(`Usage:\n`)
        process.stdout.write(`  - Default: AI does NOT call cs_* tools (mode OFF).\n`)
        process.stdout.write(`  - Type \`/codesynapt\`       to enter FORCE mode (cs_* preferred for everything non-trivial).\n`)
        process.stdout.write(`  - Type \`/codesynapt-auto\`  to enter AUTO mode  (cs_* only when warranted; skips trivial).\n`)
        process.stdout.write(`  - \`/clear\` or new session → resets back to OFF.\n`)
        break
      }
      case 'context': {
        // Aggregate snapshot for AI agents (CLAUDE.md / AGENTS.md style).
        let outputFile = null
        let maxRoutes = 30, maxModels = 30
        let watchMode = false
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--output' && args[i+1]) outputFile = args[++i]
          else if (args[i] === '--max-routes' && args[i+1]) maxRoutes = parseInt(args[++i], 10)
          else if (args[i] === '--max-models' && args[i+1]) maxModels = parseInt(args[++i], 10)
          else if (args[i] === '--watch') watchMode = true
        }
        if (watchMode && !outputFile) return die('--watch requires --output FILE')
        const [summary, packages, urls, schema, env, external, legacy] = await Promise.all([
          req('GET', '/summary').then((r) => r.json).catch(() => null),
          req('GET', '/packages').then((r) => r.json).catch(() => null),
          req('GET', '/url').then((r) => r.json).catch(() => null),
          req('GET', '/schema').then((r) => r.json).catch(() => null),
          req('GET', '/env').then((r) => r.json).catch(() => null),
          req('GET', '/external').then((r) => r.json).catch(() => null),
          req('GET', '/legacy').then((r) => r.json).catch(() => null),
        ])
        if (!summary) return die('control API unreachable')

        const lines = []
        const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        const safeRoot = (summary.root || '').replace(/\\/g, '/')
        lines.push(`# Project context for AI agents`)
        lines.push(``)
        lines.push(`> Generated by [CodeSynapt](https://github.com/wing1008/codesynapt) on ${now}.`)
        lines.push(`> Snapshot — for live data prefer the MCP tools (\`cs_query\`, \`cs_blast\`, etc.).`)
        lines.push(``)
        lines.push(`**Root:** \`${safeRoot}\``)
        lines.push(`**Files tracked:** ${summary.fileCount}  ·  **Edges:** ${summary.edgeCount}  ·  **Orphans:** ${summary.orphanCount}`)
        const exts = Object.entries(summary.extMix || {}).map(([k,v]) => `${k}=${v}`).join(', ')
        if (exts) lines.push(`**Language mix:** ${exts}`)
        if (packages?.kind && packages.kind !== 'none') {
          lines.push(`**Monorepo:** ${packages.kind} (${packages.packages?.length || 0} packages)`)
        }
        lines.push(``)

        if (summary.topHubs?.length) {
          lines.push(`## Top hub files (most-imported)`)
          for (const h of summary.topHubs.slice(0, 10)) {
            lines.push(`- \`${h.id}\`  (${h.incoming} importers)`)
          }
          lines.push(``)
        }

        if (packages?.packages?.length) {
          lines.push(`## Packages`)
          for (const p of packages.packages.slice(0, 20)) {
            lines.push(`- **${p.name}** (\`${p.relRoot || '.'}\`) — ${p.fileCount} files, ${p.loc} LOC, ${p.kind || 'unknown'} ${p.language || ''}`)
          }
          lines.push(``)
        }

        if (urls?.routes?.length) {
          lines.push(`## Frontend routes (URL → file)`)
          for (const r of urls.routes.slice(0, maxRoutes)) {
            lines.push(`- \`${r.url}\` → \`${r.id}\` *(${r.kind})*`)
          }
          if (urls.routes.length > maxRoutes) lines.push(`- _…+${urls.routes.length - maxRoutes} more — call \`cs_intent({action:'url'})\` for the full list_`)
          lines.push(``)
        }

        if (schema?.total > 0) {
          lines.push(`## DB models`)
          for (const m of (schema.models || []).slice(0, maxModels)) {
            lines.push(`- **${m.name}**${m.tableName && m.tableName !== m.name ? ` (\`${m.tableName}\`)` : ''} — ${m.kind}, ${m.fieldCount} fields — \`${m.definedIn}\``)
          }
          if ((schema.models || []).length > maxModels) lines.push(`- _…+${schema.models.length - maxModels} more_`)
          lines.push(``)
        }

        if (env?.vars?.length) {
          const declared = env.vars.filter((v) => v.declaredIn.length > 0)
          const undeclared = env.vars.filter((v) => v.status === 'undeclared')
          if (declared.length) {
            lines.push(`## Environment variables`)
            lines.push(`Declared in: ${env.envFiles.map((e) => `\`${e.id}\``).join(', ') || '(none)'}`)
            lines.push('')
            lines.push('```')
            for (const v of declared.slice(0, 50)) lines.push(`${v.var.padEnd(36)} used in ${v.usedIn.length} file(s)`)
            if (declared.length > 50) lines.push(`# …+${declared.length - 50} more`)
            lines.push('```')
            if (undeclared.length > 0) {
              lines.push(``)
              lines.push(`> ⚠️ ${undeclared.length} variable(s) used in code but **not** in any \`.env*\` file. Likely deploy-time bombs:`)
              lines.push(``)
              lines.push('```')
              for (const v of undeclared.slice(0, 20)) lines.push(`${v.var.padEnd(36)} used in ${v.usedIn.length} file(s)`)
              lines.push('```')
            }
            lines.push(``)
          }
        }

        if (external?.domains?.length) {
          lines.push(`## External services this project calls`)
          for (const d of external.domains.slice(0, 20)) {
            lines.push(`- **${d.domain}** — ${d.callers.length} call(s)`)
          }
          lines.push(``)
        }

        if (legacy?.summary?.totalCandidates > 0) {
          lines.push(`## Cleanup candidates (legacy audit)`)
          const top = legacy.summary.topCandidates || []
          for (const c of top.slice(0, 15)) {
            lines.push(`- \`${c.id}\` — ${c.category} (confidence ${c.confidence?.toFixed?.(2) || '?'})`)
          }
          lines.push(`Total candidates: ${legacy.summary.totalCandidates}. Run \`cs_health({action:'legacy'})\` for the full list.`)
          lines.push(``)
        }

        lines.push(`---`)
        lines.push(``)
        lines.push(`## CodeSynapt MCP — opt-in modes`)
        lines.push(``)
        lines.push(`The CodeSynapt MCP server is registered for this project, but **it is OFF by default**.`)
        lines.push(`The AI will not call cs_* tools unless one of the two modes below has been explicitly entered.`)
        lines.push(``)
        lines.push(`- **\`/codesynapt\`** — force mode. AI prefers cs_* tools for any non-trivial code question or edit until \`/clear\` or new session.`)
        lines.push(`- **\`/codesynapt-auto\`** — auto mode. AI calls cs_* only for non-trivial work (refactors, hub files, multi-file edits, dependency questions). Skips trivial edits, typos, docs.`)
        lines.push(``)
        lines.push(`If neither command has been typed in the current session, treat this file as project notes only — do NOT call cs_* tools.`)
        lines.push(``)
        lines.push(`## How to use this file`)
        lines.push(`- Drop into project root as \`CLAUDE.md\`, \`AGENTS.md\`, or \`.cursor/rules\` — the AI reads it on each turn for the snapshot.`)
        lines.push(`- Regenerate: \`cs context --output CLAUDE.md\` (or \`--watch\` for auto-regen).`)
        lines.push(``)

        const md = lines.join('\n')
        if (outputFile) {
          const fs = require('fs')
          fs.writeFileSync(outputFile, md, 'utf8')
          process.stderr.write(`wrote ${md.length.toLocaleString()} chars to ${outputFile}\n`)
        } else {
          process.stdout.write(md)
        }
        if (watchMode) {
          process.stderr.write(`watching for changes (poll 5s, regen on snapshot change). Ctrl-C to stop.\n`)
          let lastScannedAt = summary?.meta?.scannedAt || 0
          // Re-invoke ourselves whenever the server's snapshot updates.
          const { spawn } = require('child_process')
          setInterval(async () => {
            try {
              const r = await req('GET', '/summary')
              const at = r.json?.meta?.scannedAt
              if (at && at !== lastScannedAt) {
                lastScannedAt = at
                const child = spawn(process.execPath, [__filename, 'context',
                  '--output', outputFile,
                  '--max-routes', String(maxRoutes),
                  '--max-models', String(maxModels)
                ], { stdio: 'inherit' })
                child.on('error', () => {})
              }
            } catch { /* server gone — keep polling */ }
          }, 5000)
          await new Promise(() => {})   // block forever
        }
        break
      }
      case 'preflight': {
        const asJson = args.includes('--json')
        const strict = args.includes('--strict')
        let locale = null
        for (let i = 0; i < args.length; i++) if (args[i] === '--locale' && args[i+1]) locale = args[++i]
        const r = await req('GET', '/preflight', locale ? { locale } : null)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        const banner = j.overall === 'ok' ? '🟢 OK — 배포 가능'
                     : j.overall === 'warn' ? '🟡 WARN — 검토 권장'
                     : '🔴 FAIL — 배포 비추천'
        process.stdout.write(`${banner}\n`)
        process.stdout.write(`fail ${j.counts.fail}  ·  warn ${j.counts.warn}  ·  info ${j.counts.info}  ·  ok ${j.counts.ok}\n\n`)
        for (const c of j.checks) {
          const icon = c.status === 'fail' ? '✖' : c.status === 'warn' ? '⚠' : c.status === 'info' ? 'ℹ' : '✓'
          process.stdout.write(`${icon}  ${c.title}\n`)
          if (c.detail) process.stdout.write(`     ${c.detail}\n`)
          if (c.evidence && c.evidence.length) {
            const ev = c.evidence.slice(0, 5)
            for (const e of ev) {
              const line = typeof e === 'string' ? e : JSON.stringify(e)
              process.stdout.write(`     · ${line}\n`)
            }
            if (c.evidence.length > 5) process.stdout.write(`     · … +${c.evidence.length - 5} more\n`)
          }
          process.stdout.write(`\n`)
        }
        // Exit code
        if (j.overall === 'fail') process.exit(1)
        if (strict && j.overall === 'warn') process.exit(1)
        break
      }
      case 'feature': {
        if (!args[0]) return die('usage: cs feature <keyword> [--json]')
        const kw = args[0]
        const asJson = args.includes('--json')
        const r = await req('GET', '/feature/' + encodeURIComponent(kw))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        process.stdout.write(`🔍 "${kw}" 관련 파일 (heuristic) — ${j.total}개\n`)
        process.stdout.write(`   frontend ${j.counts.frontend}  ·  backend ${j.counts.backend}  ·  shared ${j.counts.shared}\n\n`)
        const sec = (label, list) => {
          if (list.length === 0) return
          process.stdout.write(`${label} (${list.length}):\n`)
          for (const f of list.slice(0, 40)) {
            const via = f.via === 'path' ? '' : ` [via ${f.via}]`
            process.stdout.write(`  · ${f.id}${via}\n`)
          }
          if (list.length > 40) process.stdout.write(`  … +${list.length - 40} more\n`)
          process.stdout.write(`\n`)
        }
        sec('Frontend', j.frontend)
        sec('Backend',  j.backend)
        sec('Shared',   j.shared)
        if (j.total === 0) process.stdout.write(`   매칭 없음. 다른 키워드로 시도하거나 cs find 사용.\n`)
        break
      }
      case 'suggest': {
        const asJson = args.includes('--json')
        let top = '10', locale = null
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--top' && args[i+1]) top = args[++i]
          else if (args[i] === '--locale' && args[i+1]) locale = args[++i]
        }
        const r = await req('GET', '/suggest', { top, locale })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        process.stdout.write(`📋 AI에게 시킬 다음 작업 추천 (${j.total}개 중 상위 ${j.suggestions.length})\n`)
        process.stdout.write(`   현재 상태: 파일 ${j.contextSnapshot.fileCount} / 엣지 ${j.contextSnapshot.edgeCount} / 고립 ${j.contextSnapshot.orphanCount}\n`)
        if (j.suggestions.length === 0) {
          process.stdout.write(`\n   ✓ 깨끗합니다 — 추천 사항 없음.\n`)
          break
        }
        process.stdout.write(`\n`)
        for (let i = 0; i < j.suggestions.length; i++) {
          const s = j.suggestions[i]
          const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢'
          process.stdout.write(`${icon} [${s.priority.toUpperCase().padEnd(6)}] ${s.title}\n`)
          process.stdout.write(`     이유: ${s.why}\n`)
          process.stdout.write(`     ▶ ${s.advice}\n\n`)
        }
        break
      }
      case 'env': {
        const asJson = args.includes('--json')
        const v = args[0] && !args[0].startsWith('--') ? args[0] : null
        const r = await req('GET', '/env', v ? { var: v } : null)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (asJson) { printJson(j); break }
        if (v) {
          // single-var detail
          process.stdout.write(`var: ${j.var}\n`)
          process.stdout.write(`declared in (${j.declaredIn.length}):\n`)
          for (const f of j.declaredIn) process.stdout.write(`  · ${f}\n`)
          process.stdout.write(`used in (${j.usedIn.length}):\n`)
          for (const f of j.usedIn) process.stdout.write(`  · ${f}\n`)
          if (j.declaredIn.length === 0) process.stdout.write(`\n⚠ undeclared — .env에 정의 안 됨. 배포시 실패 가능.\n`)
          if (j.usedIn.length === 0) process.stdout.write(`\n⚠ unused — 어디서도 안 씀. .env에서 제거 후보.\n`)
        } else {
          // overview
          process.stdout.write(`.env files (${j.envFiles.length}):\n`)
          for (const e of j.envFiles) process.stdout.write(`  · ${e.id}  (${e.keyCount} keys)\n`)
          process.stdout.write(`\nvariables: ${j.counts.total}  (ok ${j.counts.ok}  ·  unused ${j.counts.unused}  ·  undeclared ${j.counts.undeclared})\n\n`)
          const status = (s) => s === 'ok' ? '✓' : s === 'undeclared' ? '⚠ no .env' : '⚠ unused'
          for (const v of j.vars) {
            process.stdout.write(`  ${status(v.status).padEnd(11)}  ${v.var.padEnd(32)}  decl=${v.declaredIn.length} used=${v.usedIn.length}\n`)
          }
        }
        break
      }
      case 'changes': {
        const r = await req('GET', '/changes')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        if (!r.json.length) { process.stdout.write('no files modified this session\n'); break }
        process.stdout.write(`${r.json.length} files modified this session:\n\n`)
        for (const c of r.json) {
          const stamp = new Date(c.lastAt).toISOString().replace('T', ' ').slice(5, 19)
          const sd = c.sizeDelta >= 0 ? `+${c.sizeDelta}B` : `${c.sizeDelta}B`
          const ld = c.locDelta >= 0 ? `+${c.locDelta}` : `${c.locDelta}`
          process.stdout.write(`${stamp}  ×${c.count}  loc:${ld}  size:${sd}  ${c.id}\n`)
        }
        break
      }
      case 'diff': {
        if (!args[0]) return die('usage: cs diff <id>')
        const r = await req('GET', '/changes/' + encId(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        process.stdout.write(`--- ${j.id} (first seen ${new Date(j.firstAt).toISOString()})\n`)
        process.stdout.write(`+++ ${j.id} (now)\n`)
        for (const ln of j.lines) {
          if (ln.tag === 'eq')   process.stdout.write(`  ${ln.text}\n`)
          else if (ln.tag === 'add') process.stdout.write(`+ ${ln.text}\n`)
          else if (ln.tag === 'del') process.stdout.write(`- ${ln.text}\n`)
        }
        break
      }
      case 'tour': {
        const r = await req('GET', '/tour')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        process.stdout.write(`guided tour through ${j.stops.length} stops (project has ${j.totalFiles} files):\n\n`)
        for (let i = 0; i < j.stops.length; i++) {
          const s = j.stops[i]
          process.stdout.write(`${i + 1}. [${s.kind.toUpperCase()}] ${s.id}\n   ${s.hint}\n\n`)
        }
        break
      }
      case 'timeline': {
        const r = await req('GET', '/timeline')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (!j.isGit) return die(j.error || 'not a git repo')
        process.stdout.write(`git timeline: ${j.commitCount} commits, ${new Date(j.firstAt).toISOString().slice(0,10)} → ${new Date(j.lastAt).toISOString().slice(0,10)}\n\n`)
        for (const p of j.points.slice(0, 30)) {
          const d = new Date(p.ts).toISOString().slice(0, 10)
          process.stdout.write(`${d}  ${p.hash.slice(0, 8)}  +${p.addedFiles.length} files  ${p.subject.slice(0, 60)}\n`)
        }
        if (j.points.length > 30) process.stdout.write(`… +${j.points.length - 30} more commits\n`)
        break
      }
      case 'external': {
        const r = await req('GET', '/external')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const { domains, totalCalls } = r.json
        process.stdout.write(`총 ${totalCalls}개 호출, ${domains.length}개 도메인\n\n`)
        for (const d of domains) {
          process.stdout.write(`${d.domain} (${d.callers.length})\n`)
          for (const c of d.callers) process.stdout.write(`  ${c.method.padEnd(6)} ${c.url}\n    from ${c.file}\n`)
          process.stdout.write('\n')
        }
        break
      }
      case 'packages': {
        const r = await req('GET', '/packages')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (!j.packages.length) {
          process.stdout.write(`not a monorepo (kind: ${j.kind})\n`)
          break
        }
        process.stdout.write(`monorepo type: ${j.kind} (${j.packages.length} packages)\n\n`)
        const nameW = Math.max(8, ...j.packages.map((p) => p.name.length))
        process.stdout.write(`${'name'.padEnd(nameW)}  files   loc     in→  →out  path\n`)
        for (const p of j.packages) {
          process.stdout.write(
            `${p.name.padEnd(nameW)}  ` +
            `${String(p.fileCount).padStart(5)}  ` +
            `${String(p.loc).padStart(6)}  ` +
            `${String(p.crossPackageDependents).padStart(3)}  ` +
            `${String(p.crossPackageImports).padStart(4)}  ` +
            `${p.relRoot}\n`
          )
        }
        break
      }
      case 'package': {
        if (!args[0]) return die('usage: cs package <name>')
        const r = await req('GET', '/package/' + encodeURIComponent(args[0]))
        if (r.status !== 200) return die(r.json?.error || 'not found')
        const j = r.json
        process.stdout.write(`package: ${j.name} (${j.language}, ${j.fileCount} files)\n`)
        process.stdout.write(`root:    ${j.relRoot}\n`)
        process.stdout.write(`kind:    ${j.kind}\n\n`)
        if (j.declared.length) {
          process.stdout.write(`declared deps (${j.declared.length}):\n`)
          for (const d of j.declared.slice(0, 20)) {
            process.stdout.write(`  ${d.kind.padEnd(16)}  ${d.name}@${d.spec}\n`)
          }
          if (j.declared.length > 20) process.stdout.write(`  … +${j.declared.length - 20} more\n`)
          process.stdout.write('\n')
        }
        if (j.outgoingEdges.length) {
          process.stdout.write(`cross-package imports (→ other packages, ${j.outgoingEdges.length}):\n`)
          for (const e of j.outgoingEdges.slice(0, 20)) {
            process.stdout.write(`  ${e.s} → [${e.toPkg}] ${e.t}\n`)
          }
          if (j.outgoingEdges.length > 20) process.stdout.write(`  … +${j.outgoingEdges.length - 20} more\n`)
          process.stdout.write('\n')
        }
        if (j.incomingEdges.length) {
          process.stdout.write(`cross-package dependents (← from other packages, ${j.incomingEdges.length}):\n`)
          for (const e of j.incomingEdges.slice(0, 20)) {
            process.stdout.write(`  [${e.fromPkg}] ${e.s} → ${e.t}\n`)
          }
          if (j.incomingEdges.length > 20) process.stdout.write(`  … +${j.incomingEdges.length - 20} more\n`)
          process.stdout.write('\n')
        }
        process.stdout.write(`top files by mass:\n`)
        for (const f of j.files.slice(0, 10)) {
          process.stdout.write(`  m=${String(f.mass).padStart(3)}  ${f.id}\n`)
        }
        break
      }
      case 'write': {
        if (!args[0] || !args[1]) return die('usage: cs write <id> <path-or-->\n  use "-" to read content from stdin')
        const srcPath = args[1]
        let content
        if (srcPath === '-') {
          // Read from stdin
          content = await new Promise((resolve) => {
            let buf = ''
            process.stdin.setEncoding('utf8')
            process.stdin.on('data', (c) => buf += c)
            process.stdin.on('end', () => resolve(buf))
          })
        } else {
          try { content = require('fs').readFileSync(srcPath, 'utf8') }
          catch (e) { return die(`failed to read ${srcPath}: ${e.message}`) }
        }
        const r = await req('POST', '/write/' + encId(args[0]), null, { content })
        if (r.status !== 200) return die(r.json?.error || 'failed')
        process.stdout.write(`wrote ${r.json.size}B to ${args[0]}\n`)
        break
      }
      case 'edit': {
        if (!args[0] || args[1] === undefined || args[2] === undefined) {
          return die('usage: cs edit <id> <find> <replace> [--all]')
        }
        const all = args.includes('--all')
        const body = { find: args[1], replace: args[2], replaceAll: all }
        const r = await req('POST', '/edit/' + encId(args[0]), null, body)
        if (r.status !== 200) {
          if (r.status === 409) return die(`${r.json.error} (${r.json.occurrences} occurrences — pass --all or refine find string)`)
          if (r.status === 404) return die(`find string not found: ${r.json.find}`)
          return die(r.json?.error || 'failed')
        }
        process.stdout.write(`edited ${args[0]} (${r.json.replacements} replacement${r.json.replacements > 1 ? 's' : ''})\n`)
        break
      }
      case 'trace': {
        const sub = args[0]
        if (sub === 'run') {
          // cs trace run -- <command...>  → run the command under the V8 CPU
          // profiler, turn the sampled call tree into observed call edges, and
          // classify them against the static graph (confirm / resolve-candidate
          // / NEW dynamic). Leg C, Phase 1. See docs/design-runtime-tracing.md.
          const dashIdx = process.argv.indexOf('--')
          const cmd = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : []
          if (!cmd.length) return die('usage: cs trace run [--no-merge] -- <command>   (e.g. cs trace run -- npm test)')
          // merge default ON: an observed edge is a real edge — it joins the live
          // graph and persists (mtime-guarded). --no-merge = report-only.
          const flagPart = args.slice(0, args.indexOf('--') >= 0 ? args.indexOf('--') : args.length)
          const doMerge = !flagPart.includes('--no-merge')
          const cp = require('child_process')
          const urlMod = require('url')
          const profDir = path.join(PROJECT_ROOT, '.codesynapt', 'traces', `prof-${Date.now()}`)
          try { fs.mkdirSync(profDir, { recursive: true }) } catch (e) { return die(`cannot create profile dir: ${e.message}`) }
          // Hold a session lease for the whole run so an idle `cs serve` daemon
          // does NOT idle-reap mid-trace (a long `npm test` easily outlives the
          // ~20s grace). Uses the same registry lease the MCP/desktop use; the
          // observe POST at the end then still has a live backend to hit.
          const _traceReg = (() => { try { return require('../lib/registry.cjs') } catch { return null } })()
          let _leaseTimer = null
          const _leaseId = `trace-${process.pid}`
          const _releaseLease = () => {
            if (_leaseTimer) { clearInterval(_leaseTimer); _leaseTimer = null }
            if (_traceReg) { try { _traceReg.remove('session', _leaseId) } catch {} }
          }
          if (_traceReg) {
            try {
              const root = _traceReg.canonicalRoot ? _traceReg.canonicalRoot(PROJECT_ROOT) : PROJECT_ROOT
              const _lease = () => { try { _traceReg.touch('session', _leaseId, { projectRoot: root, startedAt: Date.now(), kind: 'trace' }) } catch {} }
              _lease()
              _leaseTimer = setInterval(_lease, 5000)
              if (_leaseTimer.unref) _leaseTimer.unref()
            } catch {}
          }
          const nodeOpts = `${process.env.NODE_OPTIONS || ''} --cpu-prof --cpu-prof-dir=${profDir}`.trim()
          process.stdout.write(`tracing: ${cmd.join(' ')}\n  (CPU profiler attached — observed edges cover only paths the run exercises)\n\n`)
          const code = await new Promise((resolve) => {
            const ch = cp.spawn(cmd[0], cmd.slice(1), {
              cwd: PROJECT_ROOT, stdio: 'inherit', shell: true,
              env: { ...process.env, NODE_OPTIONS: nodeOpts },
            })
            ch.on('exit', (c) => resolve(c == null ? 1 : c))
            ch.on('error', (e) => { process.stderr.write(`spawn failed: ${e.message}\n`); resolve(127) })
          })
          // Collect every .cpuprofile the run (and its child node procs) wrote.
          let profiles = []
          try { profiles = fs.readdirSync(profDir).filter((f) => f.endsWith('.cpuprofile')) } catch {}
          if (!profiles.length) {
            _releaseLease()
            process.stdout.write(`\nno .cpuprofile produced (command not a Node process, or it crashed before exit). exit=${code}\n`)
            break
          }
          const urlToRel = (u) => {
            if (!u || u.startsWith('node:') || u.includes('node_modules')) return null
            let abs
            try { abs = u.startsWith('file:') ? urlMod.fileURLToPath(u) : u } catch { return null }
            if (!abs || !path.isAbsolute(abs)) return null
            const rel = path.relative(PROJECT_ROOT, abs)
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
            return rel.split(path.sep).join('/')
          }
          process.stderr.write(`  ${profiles.length} profile(s) collected, extracting call edges…\n`)
          const seen = new Set(); const pairs = []
          for (const pf of profiles) {
            let prof
            try { prof = JSON.parse(fs.readFileSync(path.join(profDir, pf), 'utf8')) } catch { continue }
            const byId = new Map(); for (const n of prof.nodes || []) byId.set(n.id, n)
            for (const n of prof.nodes || []) {
              if (!n.children) continue
              const cfRel = urlToRel(n.callFrame?.url)
              if (!cfRel) continue
              const cl = (n.callFrame.lineNumber | 0) + 1
              for (const cid of n.children) {
                const c = byId.get(cid); if (!c) continue
                const efRel = urlToRel(c.callFrame?.url); if (!efRel) continue
                const el = (c.callFrame.lineNumber | 0) + 1
                const k = `${cfRel}:${cl}>${efRel}:${el}`
                if (seen.has(k)) continue; seen.add(k)
                pairs.push({ cf: cfRel, cl, ef: efRel, el })
              }
            }
          }
          process.stderr.write(`  ${pairs.length} frame-edges → classifying against the static graph (port ${PORT})…\n`)
          let r
          try { r = await req('POST', '/symbol/observe', null, { edges: pairs, merge: doMerge }) }
          catch (e) { _releaseLease(); return die(`could not reach this project's backend (${e.code || e.message}) — keep the desktop app or \`cs serve\` running.`) }
          _releaseLease()
          if (r.status === 404) return die('symbol mode unavailable on this backend (need `cs serve` or the desktop app running for THIS project).')
          if (r.status !== 200) return die(r.json?.error || `observe failed (status ${r.status})`)
          const rep = r.json
          if (args.includes('--json')) { printJson(rep); break }
          process.stdout.write(`\n── runtime trace (exit=${code}, ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, ${pairs.length} raw frame-edges) ──\n`)
          process.stdout.write(`  observed call edges: ${rep.observedEdges}\n`)
          process.stdout.write(`    ${rep.confirmedStatic} confirm a static call · ${rep.confirmedCandidate} resolve a candidate · ${rep.newDynamic} NEW (dynamic, invisible to static)\n`)
          process.stdout.write(`  coverage: ${rep.symbolsTouched}/${rep.totalSymbols} symbols touched (runtime sees only exercised paths — NOT completeness)\n`)
          if (rep.merged !== undefined) {
            process.stdout.write(`  merged into live graph: ${rep.merged} observed edge${rep.merged === 1 ? '' : 's'}${rep.persisted ? ' — persisted (survives rebuilds until the involved files change)' : ''}\n`)
          } else {
            process.stdout.write(`  (--no-merge: report only, graph unchanged)\n`)
          }
          if (rep.newDynamicSamples && rep.newDynamicSamples.length) {
            process.stdout.write(`\n  new dynamic edges (static could not see these):\n`)
            for (const s of rep.newDynamicSamples.slice(0, 15)) process.stdout.write(`    ${s.from}  →  ${s.to}\n`)
          }
          // Persist the observed report alongside the AI-activity traces.
          try {
            const outPath = path.join(PROJECT_ROOT, '.codesynapt', 'traces', `runtime-${Date.now()}.json`)
            fs.writeFileSync(outPath, JSON.stringify({ ...rep, command: cmd.join(' '), exit: code }, null, 2))
            process.stdout.write(`\n  saved → ${path.relative(PROJECT_ROOT, outPath)}\n`)
          } catch (e) { if (process.env.CS_DBG) process.stderr.write(`persist failed: ${e.message}\n`) }
          try { fs.rmSync(profDir, { recursive: true, force: true }) } catch {}
          break
        }
        if (sub === 'stats') {
          const r = await req('GET', '/trace/stats')
          if (r.status !== 200) return die(r.json?.error || 'failed')
          const j = r.json
          const dur = j.durationMs ? (j.durationMs / 1000).toFixed(1) + 's' : '—'
          process.stdout.write(`session ${j.sessionId}\n`)
          process.stdout.write(`events: ${j.eventCount} on ${j.fileCount} files · duration ${dur}\n\n`)
          process.stdout.write(`tool breakdown:\n`)
          for (const [tool, n] of Object.entries(j.byTool).sort((a, b) => b[1] - a[1])) {
            process.stdout.write(`  ${tool.padEnd(12)} ${n}\n`)
          }
          process.stdout.write(`\ntop files:\n`)
          for (const f of j.topFiles.slice(0, 15)) {
            process.stdout.write(`  ×${String(f.count).padStart(3)}  ${f.id}\n`)
          }
          break
        }
        if (sub === 'sessions') {
          const r = await req('GET', '/trace/sessions')
          if (r.status !== 200) return die(r.json?.error || 'failed')
          const j = r.json
          if (!j.sessions.length) { process.stdout.write('no past sessions\n'); break }
          process.stdout.write(`${j.sessions.length} session(s):\n\n`)
          for (const s of j.sessions) {
            const stamp = new Date(s.startedAt).toISOString().replace('T', ' ').slice(0, 19)
            const cur = s.isCurrent ? ' (current)' : ''
            process.stdout.write(`  ${stamp}  ${s.eventCount} events  ${(s.size/1024).toFixed(1)}KB  id=${s.sessionId}${cur}\n`)
          }
          break
        }
        if (sub === 'export') {
          if (!args[1]) return die('usage: cs trace export <path>')
          const r = await req('POST', '/trace/export', { path: args[1] })
          if (r.status !== 200) return die(r.json?.error || 'failed')
          process.stdout.write(`exported ${r.json.eventCount} events → ${r.json.path}\n`)
          break
        }
        if (sub === 'clear') {
          const r = await req('POST', '/trace/clear')
          if (r.status !== 200) return die(r.json?.error || 'failed')
          process.stdout.write(`new session: ${r.json.newSessionId}\n`)
          break
        }
        // default: recent log
        const q = {}
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--limit' && args[i+1]) q.limit = args[++i]
          else if (args[i] === '--tool' && args[i+1]) q.tool = args[++i]
        }
        const r = await req('GET', '/trace', q)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (!j.events.length) { process.stdout.write('no trace events in current session\n'); break }
        for (const e of j.events) {
          const stamp = new Date(e.ts).toISOString().replace('T', ' ').slice(11, 23)
          process.stdout.write(`${stamp}  ${e.tool.padEnd(10)}  ${e.id}\n`)
        }
        if (j.meta?.totalAvailable > j.events.length) {
          process.stderr.write(`\n(showing ${j.events.length} of ${j.meta.totalAvailable})\n`)
        }
        break
      }
      case 'legacy': {
        const q = {}
        let minConf = 0
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--type'     && args[i+1]) q.type = args[++i]
          else if (args[i] === '--min-conf' && args[i+1]) minConf = parseFloat(args[++i])
        }
        const r = await req('GET', '/legacy', q)
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        const s = j.summary
        process.stdout.write(`migration audit: ${s.candidateCount}/${s.totalFiles} files flagged (${s.totalLoc} loc)\n`)
        process.stdout.write(`  orphan ${s.byCategory.orphan}  path ${s.byCategory.path}  filename ${s.byCategory.filename}  duplicate ${s.byCategory.duplicate}\n\n`)
        const fmt = (x, cat) => {
          const c = x.confidence.toFixed(2)
          process.stdout.write(`  [${c}] ${cat.padEnd(8)} ${x.id}\n         ${x.reason}\n`)
        }
        const ofMin = (arr) => arr.filter((x) => x.confidence >= minConf)
        if (j.orphans && ofMin(j.orphans).length) {
          process.stdout.write(`orphans (${ofMin(j.orphans).length}):\n`)
          for (const x of ofMin(j.orphans).slice(0, 50)) fmt(x, 'orphan')
          if (j.orphans.length > 50) process.stdout.write(`  … +${j.orphans.length - 50} more\n`)
          process.stdout.write('\n')
        }
        if (j.pathPatterns && ofMin(j.pathPatterns).length) {
          process.stdout.write(`path-pattern (${ofMin(j.pathPatterns).length}):\n`)
          for (const x of ofMin(j.pathPatterns).slice(0, 50)) fmt(x, x.pattern)
          process.stdout.write('\n')
        }
        if (j.filenamePatterns && ofMin(j.filenamePatterns).length) {
          process.stdout.write(`filename-pattern (${ofMin(j.filenamePatterns).length}):\n`)
          for (const x of ofMin(j.filenamePatterns).slice(0, 50)) fmt(x, x.marker)
          process.stdout.write('\n')
        }
        if (j.duplicates && j.duplicates.length) {
          process.stdout.write(`duplicate logical names (${j.duplicates.length}):\n`)
          for (const d of j.duplicates.slice(0, 30)) {
            process.stdout.write(`  ${d.basename}\n`)
            for (const f of d.files) {
              const tag = f.isCurrent ? ' (current?)' : f.hasLegacyMarker ? ' (legacy?)' : ''
              process.stdout.write(`    m=${String(f.mass).padStart(3)}  ${f.id}${tag}\n`)
            }
          }
        }
        break
      }
      case 'package-graph': {
        const r = await req('GET', '/package-graph')
        if (r.status !== 200) return die(r.json?.error || 'failed')
        const j = r.json
        if (!j.edges.length) { process.stdout.write('no cross-package edges\n'); break }
        process.stdout.write(`${j.edges.length} cross-package edges:\n\n`)
        for (const e of j.edges) {
          process.stdout.write(`  ${e.s.padEnd(24)} → ${e.t.padEnd(24)}  (×${e.count}, ${e.kinds.join(',')})\n`)
        }
        break
      }
      default:
        die(`unknown command: ${cmd}\n\n${USAGE}`)
    }
  } catch (err) {
    die(err.message)
  }
}

main()
