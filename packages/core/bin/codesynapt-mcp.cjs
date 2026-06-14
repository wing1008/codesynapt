#!/usr/bin/env node
// CodeSynapt MCP server — stdio JSON-RPC 2.0. Bridges Claude Code (or
// any MCP client) to the running Electron app's localhost control API.
//
// Register with Claude Code:
//   claude mcp add codesynapt node /absolute/path/to/bin/codesynapt-mcp.cjs

const http = require('http')
const readline = require('readline')
const fs = require('fs')
const path = require('path')
const os = require('os')
const pkg = (() => { try { return require('../../../package.json') } catch { return { version: '0.0.0' } } })()

// Resolve which port the running server is on.
// Priority: explicit env var > lock file (written by server) > default 7707.
function resolvePort() {
  const envPort = process.env.CS_PORT || process.env.FG3D_PORT
  if (envPort) return parseInt(envPort, 10)
  try {
    const lockPath = path.join(os.homedir(), '.codesynapt', 'port')
    if (fs.existsSync(lockPath)) {
      const p = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (p > 0 && p < 65536) return p
    }
  } catch { /* fall through */ }
  return 7707
}
let PORT = resolvePort()
const HOST = '127.0.0.1'

// ── Auto-start backend ───────────────────────────────────────────────
// The MCP server bridges to a control-server. If none is running (no live
// desktop app / `cs serve`), spawn one in-process scanning CS_ROOT||cwd — so
// setup is a single `claude mcp add` with nothing else to keep running.
let _backendReady = null

// [multi-session ②/2b] Registry-based attach-or-spawn. DEFAULT ON
// (set CS_REGISTRY=0 to force the legacy port-scan path below). When on, this MCP
// is a pure client: it attaches to the per-project detached `cs serve` daemon
// (discovered via daemons/<projectHash>.json) or spawns one, then registers its
// own session lease + heartbeat. See docs/design-multi-session.md.
let _registry = null
try { _registry = require('../lib/registry.cjs') } catch { /* optional during migration */ }
const USE_REGISTRY = process.env.CS_REGISTRY !== '0' && !!_registry
const SESSION_ID = (() => { try { return require('crypto').randomUUID() } catch { return Date.now() + '-' + process.pid } })()
const _DAEMON_TTL_MS = 15000   // = poll(5s) × 3
const _HEARTBEAT_MS = 5000
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let _sessionHb = null
function _registerSession(root, port) {
  try {
    _registry.touch('session', SESSION_ID, {
      sessionId: SESSION_ID, projectRoot: _registry.canonicalRoot(root),
      port, pid: process.pid, label: path.basename(root) || root, startedAt: Date.now(),
    })
    if (!_sessionHb) {
      _sessionHb = setInterval(() => { try { _registry.touch('session', SESSION_ID, { port }) } catch {} }, _HEARTBEAT_MS)
      if (_sessionHb.unref) _sessionHb.unref()
    }
  } catch { /* lease is best-effort */ }
}
function _spawnDaemon(root) {
  const cp = require('child_process')
  const serveBin = path.join(__dirname, 'codesynapt.cjs')
  const child = cp.spawn(process.execPath, [serveBin, 'serve', root], { detached: true, stdio: 'ignore', env: { ...process.env } })
  child.unref()
}
// Discover-or-spawn the per-project daemon, then register our session lease.
async function _ensureViaRegistry() {
  const want = _intendedRoot()
  const phash = _registry.projectHash(want)
  let spawned = false
  for (let i = 0; i < 60; i++) {   // ~30s budget (cold start of a daemon)
    const d = _registry.readDaemon(phash, _DAEMON_TTL_MS)
    if (d && d.port && await _ping(d.port) && _sameRoot(await _backendRoot(d.port), want)) {
      PORT = d.port
      _registerSession(want, d.port)
      return
    }
    if (!spawned) {
      // No live daemon serving this project → race to spawn exactly one. The
      // O_EXCL lock serialises concurrent MCPs; winner spawns, loser polls.
      const lock = _registry.acquireDaemonLock(phash, { pid: process.pid }, _DAEMON_TTL_MS)
      if (lock.won) { _spawnDaemon(want); spawned = true }
      // The winner's `cs serve` writes its real port post-bind (②/2a) — poll
      // readDaemon for it on the next iterations (whether we won or lost).
    }
    await _sleep(500)
  }
  // Registry path didn't converge → don't leave the agent blind; self-host.
  process.stderr.write('[cs-mcp] registry attach-or-spawn timed out; self-hosting in-process\n')
  await _startInProcessBackend()
  _registerSession(want, PORT)
}

function _lockPort() {
  try {
    const lp = path.join(os.homedir(), '.codesynapt', 'port')
    if (fs.existsSync(lp)) { const p = parseInt(fs.readFileSync(lp, 'utf8').trim(), 10); if (p > 0 && p < 65536) return p }
  } catch {}
  return null
}

function _ping(port) {
  return new Promise((res) => {
    const r = http.get({ host: HOST, port, path: '/health', timeout: 800 }, (resp) => { resp.resume(); res(resp.statusCode === 200) })
    r.on('error', () => res(false))
    r.on('timeout', () => { r.destroy(); res(false) })
  })
}

// The project this MCP instance should serve (CS_ROOT, else the project root
// detected from cwd). Resolved up-front so we only attach to a backend that is
// actually serving THIS project (not, say, a desktop open on another repo).
function _intendedRoot() {
  let root = path.resolve(process.env.CS_ROOT || process.cwd())
  if (!process.env.CS_ROOT) {
    try { if (fs.existsSync(root) && fs.statSync(root).isDirectory()) { const f = _findProjectRoot(root); if (f) root = f } } catch {}
  }
  return root
}
const _sameRoot = (a, b) => !!a && !!b && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
function _backendRoot(port) {
  return new Promise((res) => {
    const r = http.get({ host: HOST, port, path: '/summary', timeout: 1500 }, (resp) => {
      let d = ''; resp.on('data', (c) => d += c); resp.on('end', () => { try { res(path.resolve(JSON.parse(d).root)) } catch { res(null) } })
    })
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null) })
  })
}

function ensureBackend() {
  if (_backendReady) return _backendReady
  _backendReady = (async () => {
    if (USE_REGISTRY) return _ensureViaRegistry()
    const want = _intendedRoot()
    // Reuse an already-running backend that serves THIS project — the desktop
    // app open on this repo, or a `cs serve` — so the agent's calls flow there
    // and the desktop shows them live (trace trail + blast pulse). Check the
    // fast paths (current PORT, lock file) first, then SCAN the port range:
    // the lock can be empty/stale and the desktop may have fallen back off the
    // default port (7707 taken → 7708…), in which case [PORT, lock] alone would
    // miss it and we'd wrongly self-host a disconnected backend.
    const base = parseInt(process.env.CS_PORT || '7707', 10)
    const cands = [PORT, _lockPort()]
    for (let p = base; p < base + 25; p++) cands.push(p)
    const seen = new Set()
    for (const cand of cands) {
      if (!cand || seen.has(cand)) continue
      seen.add(cand)
      if (await _ping(cand) && _sameRoot(await _backendRoot(cand), want)) { PORT = cand; return }
    }
    await _startInProcessBackend()   // nothing serving this project → self-host
  })()
  return _backendReady
}

// Walk up from `start` to the nearest project root (a directory containing a
// recognizable marker). Returns null if none is found before the home/drive
// boundary. This is what makes the agent scan the *project* regardless of which
// subdirectory it was launched from — the real fix; the home/root check below
// is only a fallback.
function _findProjectRoot(start) {
  // STRONG markers = repo / workspace root: they win, so a monorepo root is
  // chosen over a nested sub-package. WEAK markers = a project; the nearest one
  // is used only when no strong marker is found further up.
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

async function _startInProcessBackend() {
  let root = path.resolve(process.env.CS_ROOT || process.cwd())
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`CS_ROOT/cwd is not a directory: ${root}`)
  // Resolve the real project root by walking up to the nearest marker, so the
  // agent scans the project even when launched from a subdirectory. An explicit
  // CS_ROOT is honored as-is (the user chose it).
  if (!process.env.CS_ROOT) { const found = _findProjectRoot(root); if (found) root = found }
  // Fallback guard: never scan a drive root or the home directory.
  if (root === path.parse(root).root || root === path.resolve(os.homedir())) {
    throw new Error(`codesynapt: no project found at '${process.cwd()}' — looked for .git / package.json / go.mod / Cargo.toml / pyproject.toml up to your home folder. Run the agent inside a project, or set CS_ROOT to a project path.`)
  }
  const { Scanner } = await import('../scanner.js')
  const { createControlServer } = require('../lib/control-server.cjs')
  const scanner = new Scanner(root)
  const { startControlServer } = createControlServer({
    scanner,
    getCurrentRoot: () => root,
    authToken: process.env.CS_AUTH_TOKEN || null,
    auditLogDir: path.join(os.homedir(), '.codesynapt', 'audit'),
  })
  const firstScan = new Promise((res) => {
    let done = false
    scanner.once('snapshot', () => { if (!done) { done = true; res() } })
    setTimeout(() => { if (!done) { done = true; res() } }, 25000)
  })
  scanner.start()
  let bound = null
  const base = parseInt(process.env.CS_PORT || '7707', 10)
  for (let p = base; p < base + 25 && !bound; p++) {
    try { const r = await startControlServer(p); bound = r.port } catch (e) { if (e.code !== 'EADDRINUSE') throw e }
  }
  if (!bound) throw new Error('no free port for the in-process backend')
  PORT = bound
  // Advertise via the lock for `cs` CLI discovery — but NEVER clobber a lock a
  // different live backend already holds (e.g. a desktop on another project),
  // so multiple projects can coexist without stealing each other's discovery.
  try {
    const existing = _lockPort()
    const heldByOther = existing && existing !== bound && (await _ping(existing))
    if (!heldByOther) {
      const lp = path.join(os.homedir(), '.codesynapt', 'port')
      fs.mkdirSync(path.dirname(lp), { recursive: true })
      fs.writeFileSync(lp, String(bound))
      const clean = () => { try { if (fs.readFileSync(lp, 'utf8').trim() === String(bound)) fs.unlinkSync(lp) } catch {} }
      process.on('exit', clean)
      process.on('SIGINT', () => { clean(); process.exit(0) })
      process.on('SIGTERM', () => { clean(); process.exit(0) })
    }
  } catch {}
  process.stderr.write(`[codesynapt-mcp] auto-started backend on 127.0.0.1:${bound} scanning ${root}\n`)
  await firstScan
}

async function apiReq(method, pathStr, query, body) {
  await ensureBackend()
  return new Promise((resolve, reject) => {
    let qs = ''
    if (query) {
      const parts = []
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      }
      if (parts.length) qs = '?' + parts.join('&')
    }
    const headers = {}
    // When the backend is started with CS_AUTH_TOKEN, control-server gates
    // EVERY request behind `Authorization: Bearer <token>` — including reads.
    // The in-process backend we auto-start reads the same env var, so without
    // this header every cs_* tool 401s the moment a user sets the token to
    // enable edits. (SEC-002)
    // [③/3b] Tag every backend request with this MCP's session id so a shared
    // per-project daemon attributes traces to this session (isolated per-session
    // view; the graph stays shared). Harmless against backends that ignore it.
    headers['X-CS-Session'] = SESSION_ID
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
        let data
        try { data = JSON.parse(text) } catch { data = text }
        // Several actions (symbol/trace/history/legacy) are desktop-only and
        // 404 against the headless `cs serve` backend. Turn the bare 404 into
        // an actionable message instead of a confusing "unknown endpoint".
        if (res.statusCode === 404 && data && typeof data === 'object' && /unknown endpoint/i.test(data.error || '')) {
          data = { error: `'${method} ${pathStr}' is not available on the headless server (cs serve). This action requires the desktop app.` }
        }
        resolve({ status: res.statusCode, data })
      })
    })
    r.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`codesynapt backend not reachable at ${HOST}:${PORT}. It auto-starts in-process; check stderr for errors. Override target with CS_PORT, or scan a specific folder with CS_ROOT.`))
      } else reject(err)
    })
    if (payload) r.write(payload)
    r.end()
  })
}

function encId(id) { return id.split('/').map(encodeURIComponent).join('/') }
function bad(msg) { throw new Error(msg) }

// ─── Tool definitions ──────────────────────────────────────────
//
// Consolidated from 37 narrow tools into 8 intent-shaped tools.
// Each tool takes `action` enum that selects the underlying endpoint,
// plus any tool-specific parameters. This matches the 2026 MCP best
// practice: tool count low, organised by user intent rather than by
// REST endpoint mirror. The Electron app's /<endpoint> HTTP API is
// unchanged — only the MCP surface is consolidated.

const TOOLS = [
  {
    name: 'cs_summary',
    description:
      'WHEN: once at the start of a new session on an unfamiliar project (skip if user is just chatting or working on a single small file). ~300 tokens.\n' +
      'Project structure overview.\n' +
      'actions:\n' +
      '  · project  — file count, edges, top hubs, top folders, ext mix, orphan count, confidence distribution (cheap, Layer 1)\n' +
      '  · health   — is the desktop app running, current root, history flag\n' +
      '  · packages — monorepo packages with file counts and cross-package edges\n' +
      '  · package_graph — package-to-package edge list (visual overview)\n' +
      '  · package_detail — files + declared deps + cross-pkg edges for one package (requires name)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['project', 'health', 'packages', 'package_graph', 'package_detail'] },
        name:   { type: 'string', description: 'package_detail action — package name from packages list' },
      },
      required: ['action'],
    },
    handler: async ({ action, name }) => {
      switch (action) {
        case 'health':         return (await apiReq('GET', '/health')).data
        case 'project': {
          const data = (await apiReq('GET', '/summary')).data
          // Turn the one tool agents reliably read into the gate for the ones they
          // skip: name the next action explicitly, tied to the hub list just shown.
          if (data && typeof data === 'object') {
            data._guidance = 'Before editing any high-importer (hub) file listed above, call cs_blast({action:"safety", id}) FIRST — editing a hub blind can break its importers. When you edit a SPECIFIC function/method inside a large or hub file, ALSO call cs_blast({action:"function", id:"<functionName>"}): file-level safety can call a 5000-line hub "low risk" (few importers) while a function inside it is called from everywhere — file-level cannot see that internal coupling, function-level can. For "who uses X" use cs_query({action:"users", id}) rather than grep.'
          }
          return data
        }
        case 'packages':       return (await apiReq('GET', '/packages')).data
        case 'package_graph':  return (await apiReq('GET', '/package-graph')).data
        case 'package_detail':
          if (!name) bad('package_detail requires { name }')
          return (await apiReq('GET', '/package/' + encodeURIComponent(name))).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_query',
    description:
      'Code exploration — look up files, dependencies, content.\n' +
      'actions:\n' +
      '  · list   — paginated graph (filter by ext / minMass; sort=mass:desc default). Big repos: use limit.\n' +
      '  · node   — one file\'s metadata + imports + importedBy (requires id)\n' +
      '  · deps   — what this file imports (requires id)\n' +
      '  · users  — what imports this file = blast surface (requires id)\n' +
      '  · find   — file-ID/path substring search (requires q). For *contents*, use search.\n' +
      '  · search — full-text CONTENT search across all tracked files (requires q). Returns line:col + snippet. mtime LRU cache → repeat queries are sub-50ms. WHEN: variable rename, hardcoded string hunt, i18n key tracking, "where is X used as text".\n' +
      '  · read   — file content, up to 2 MB (requires id)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'node', 'deps', 'users', 'find', 'search', 'read'] },
        id:     { type: 'string', description: 'file id, root-relative (e.g. src/auth.ts)' },
        q:      { type: 'string', description: 'find / search action — substring or regex pattern' },
        limit:  { type: 'number', description: 'list action — page size (0 = all)' },
        offset: { type: 'number', description: 'list action — pagination offset' },
        ext:    { type: 'string', description: 'list action — filter by extension (e.g. "ts")' },
        minMass:{ type: 'number', description: 'list action — only files with ≥ N importers' },
        sort:   { type: 'string', description: 'list action — mass:desc | size:desc | loc:desc | id:asc | insertion' },
        regex:         { type: 'boolean', description: 'search action — treat q as regex (default false)' },
        caseSensitive: { type: 'boolean', description: 'search action — case-sensitive match (default false)' },
        max:    { type: 'number', description: 'search action — max total matches before early-bail (default 100)' },
      },
      required: ['action'],
    },
    handler: async ({ action, id, q, limit, offset, ext, minMass, sort, regex, caseSensitive, max }) => {
      switch (action) {
        case 'list':
          return (await apiReq('GET', '/graph', {
            limit: limit ?? 0, offset: offset ?? 0, ext, minMass, sort,
          })).data
        case 'node':  if (!id) bad('node requires id');  return (await apiReq('GET', '/node/' + encId(id))).data
        case 'deps':  if (!id) bad('deps requires id');  return (await apiReq('GET', '/deps/' + encId(id))).data
        case 'users': if (!id) bad('users requires id'); return (await apiReq('GET', '/users/' + encId(id))).data
        case 'find':  if (!q)  bad('find requires q');   return (await apiReq('GET', '/find', { q })).data
        case 'search': {
          // 503 (scan in progress) → retry up to 3 times, 2 s apart.
          if (!q) bad('search requires q')
          const sParams = { q, regex: regex ? '1' : '0', case: caseSensitive ? '1' : '0', max: String(max ?? 100) }
          let sr
          for (let attempt = 0; attempt < 4; attempt++) {
            sr = await apiReq('GET', '/search', sParams)
            if (sr.status !== 503) break
            if (attempt < 3) await new Promise((res) => setTimeout(res, 2000))
          }
          if (sr.status !== 200) bad(`search failed: ${sr.data?.error || 'status ' + sr.status}`)
          return sr.data
        }
        case 'read':  if (!id) bad('read requires id');  return (await apiReq('GET', '/file/' + encId(id))).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_blast',
    description:
      'WHEN: before NON-TRIVIAL file edits — refactors, function-signature changes, removed exports, multi-file work, hub files. SKIP for typos / comments / single-literal changes / docs.\n' +
      'Impact analysis — answers "is it safe to change this file?".\n' +
      'actions:\n' +
      '  · safety — 🟢/🟡/🔴 verdict + reasons + one-line advice (the usual first call). (id, deep=true returns full impacted list)\n' +
      '  · bundle — pack closest neighbours within token budget — call when safety=🟡/🔴 to load the right context (id, budget=8000, depth=3)\n' +
      '  · radius — transitive dependents/dependencies via BFS, with token estimate (deeper analysis when needed) (id, depth=3, dir=users|deps)\n' +
      '  · function — FUNCTION-level blast: what breaks if you change a specific function/method, not just its file. Use when editing one function inside a large/hub file — a file with few importers can still hold a function called from everywhere (file-level blast misses this). id = function/method name; optional file= to disambiguate; dir=users(callers, default)|deps(callees). Coverage: JS/TS + Python only.\n' +
      'RULE: 🔴 RISKY → STOP, surface to user, do not auto-edit. 🟡 CAUTION → call bundle first.\n' +
      'CAVEAT: if the response has a `caveat` field, the impact set contains files using dynamic/reflective/DI deps that static analysis CANNOT resolve — the real blast may be LARGER. Do NOT treat the count as complete; inspect caveat.dynamicFiles directly.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['radius', 'safety', 'bundle', 'function'] },
        id:     { type: 'string', description: 'file id for radius/safety/bundle; function/method NAME for action:function' },
        file:   { type: 'string', description: 'function — narrow to this file when several functions share the name' },
        depth:  { type: 'number', description: 'radius / bundle BFS depth (1-10, default 3)' },
        dir:    { type: 'string', enum: ['users', 'deps'], description: 'radius direction (default users)' },
        deep:   { type: 'boolean', description: 'safety — include full impacted file list' },
        budget: { type: 'number', description: 'bundle — token budget (default 8000)' },
        locale: { type: 'string', enum: ['en', 'ko'], description: 'safety — response language (reasons + advice). default en.' },
        full:   { type: 'boolean', description: 'radius — return the complete per-hop file lists (default false: token-compact top-25/hop + counts)' },
      },
      required: ['action', 'id'],
    },
    handler: async ({ action, id, depth, dir, deep, budget, locale, full, file }) => {
      if (!id) bad('id is required')
      switch (action) {
        case 'function': {
          // Resolve the function NAME to a symbol, then function-level blast.
          const fr = (await apiReq('GET', '/symbol/find', { q: id })).data
          let matches = (fr && fr.matches) || []
          if (file) matches = matches.filter((mn) => mn.file === file || mn.file.endsWith('/' + file) || mn.file.endsWith(file))
          if (!matches.length) return { error: `no symbol named "${id}"${file ? ' in ' + file : ''}`, hint: 'retry without file=, or this language may not be symbol-covered (JS/TS + Python only)' }
          if (matches.length > 1) return { ambiguous: true, message: `${matches.length} symbols named "${id}" — pass file: to disambiguate`, candidates: matches.map((mn) => ({ id: mn.id, file: mn.file, line: mn.line, kind: mn.kind, callers: mn.callers })) }
          return (await apiReq('GET', '/symbol/blast', { id: matches[0].id, depth: depth ?? 3, direction: dir === 'deps' ? 'callees' : 'callers' })).data
        }
        case 'radius':
          // Compact by default — a large blast's full per-hop list can cost
          // tens of thousands of tokens; the agent gets counts + top files and
          // can re-query with full=true if it truly needs every path.
          return (await apiReq('GET', '/blast/' + encId(id), {
            depth: depth ?? 3, dir: dir ?? 'users', compact: full ? null : '1',
          })).data
        case 'safety':
          return (await apiReq('GET', '/safety/' + encId(id), { deep: deep ? '1' : null, locale })).data
        case 'bundle':
          return (await apiReq('GET', '/bundle/' + encId(id), { budget: budget ?? 8000, depth: depth ?? 3 })).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_intent',
    description:
      'Mapping from human intent ("payment feature", "/billing URL", "User model") to source files.\n' +
      'actions:\n' +
      '  · feature  — keyword → frontend/backend/shared file clusters (requires keyword)\n' +
      '  · url      — URL path → file (Next.js app/pages, Astro, SvelteKit). Without path returns all routes. (path optional)\n' +
      '  · schema   — DB models (Prisma / Drizzle / SQLAlchemy). With model returns definition + usage. (model optional)\n' +
      '  · external — every external URL the project calls (grouped by domain)\n' +
      'Use when the user describes something by domain language rather than file name.',
    inputSchema: {
      type: 'object',
      properties: {
        action:  { type: 'string', enum: ['feature', 'url', 'schema', 'external'] },
        keyword: { type: 'string', description: 'feature action' },
        path:    { type: 'string', description: 'url action (optional — overview if omitted)' },
        model:   { type: 'string', description: 'schema action (optional — overview if omitted)' },
      },
      required: ['action'],
    },
    handler: async ({ action, keyword, path, model }) => {
      switch (action) {
        case 'feature':
          if (!keyword) bad('feature requires keyword')
          return (await apiReq('GET', '/feature/' + encodeURIComponent(keyword))).data
        case 'url':       return (await apiReq('GET', '/url',    path  ? { path }  : null)).data
        case 'schema':    return (await apiReq('GET', '/schema', model ? { model } : null)).data
        case 'external':  return (await apiReq('GET', '/external')).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_health',
    description:
      'WHEN: \n' +
      '  · preflight: before suggesting commit/deploy on a SIGNIFICANT change (skip for typo/doc-only)\n' +
      '  · suggest:   user is open-ended ("what next?") or you finished a task and have spare attention\n' +
      '  · env / secrets / vendors / legacy: on-demand diagnosis\n' +
      'Project health checks + next-step recommendations.\n' +
      'actions:\n' +
      '  · env       — env vars: declared vs used cross-reference (var optional — overview if omitted)\n' +
      '  · secrets   — server-only env leaked into frontend bundles. RULE: fail at preflight, surface to user.\n' +
      '  · vendors   — third-party folder auto-detect → suggests .codesynaptignore entries.\n' +
      '  · preflight — comprehensive deploy-readiness. RULE: do not suggest commit/deploy if overall=fail.\n' +
      '  · suggest   — rule-based "next thing to ask the AI to fix" (high/medium/low). Best opening move when stuck.\n' +
      '  · legacy    — orphan/path/filename/duplicate cleanup candidates with confidence scores (type optional)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['env', 'secrets', 'vendors', 'preflight', 'suggest', 'legacy'] },
        var:    { type: 'string', description: 'env action — single variable focus' },
        top:    { type: 'number', description: 'suggest — max suggestions (default 10)' },
        type:   { type: 'string', enum: ['orphan', 'path', 'filename', 'duplicate'], description: 'legacy — filter to one category' },
        locale: { type: 'string', enum: ['en', 'ko'], description: 'preflight / suggest — response language. default en.' },
      },
      required: ['action'],
    },
    handler: async ({ action, var: v, top, type, locale }) => {
      switch (action) {
        case 'env':       return (await apiReq('GET', '/env', v ? { var: v } : null)).data
        case 'secrets':   return (await apiReq('GET', '/secrets')).data
        case 'vendors':   return (await apiReq('GET', '/vendors')).data
        case 'preflight': return (await apiReq('GET', '/preflight', locale ? { locale } : null)).data
        case 'suggest':   return (await apiReq('GET', '/suggest', { top: top ?? 10, locale })).data
        case 'legacy':    return (await apiReq('GET', '/legacy', type ? { type } : null)).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_change',
    description:
      'WHEN: editing a file ≥ 100 LOC, or a hub file, or anything cs_blast called caution/risky on.\n' +
      'SKIP for: typos / comments / formatting / brand-new files you just created this session — your own Edit tool is fine there.\n' +
      'Why prefer over own Edit when non-trivial: auto-snapshots, audit log, green pulse on the 3D node, AI trace overlay.\n' +
      'PREREQ for non-trivial: call cs_blast({action:\'safety\'}) first; if 🔴 do not proceed.\n' +
      'File modifications + history.\n' +
      'actions:\n' +
      '  · write   — overwrite file entirely (id, content). For full rewrites or small files.\n' +
      '  · edit    — precise find→replace (id, find, replace, replaceAll). Like Claude Code Edit tool.\n' +
      '              Errors: 404=find not found, 409=ambiguous (count>1 without replaceAll).\n' +
      '  · refresh — force re-parse one file (id). Use after external tools modified the file.\n' +
      '  · history — list auto-snapshots for a file (id)\n' +
      '  · restore — roll a file back to a snapshot (id, ts)',
    inputSchema: {
      type: 'object',
      properties: {
        action:     { type: 'string', enum: ['write', 'edit', 'refresh', 'history', 'restore'] },
        id:         { type: 'string' },
        content:    { type: 'string', description: 'write action — new full content' },
        find:       { type: 'string', description: 'edit action — exact string to replace (whitespace-sensitive)' },
        replace:    { type: 'string', description: 'edit action — new string' },
        replaceAll: { type: 'boolean', description: 'edit action — replace every occurrence (default false → must be unique)' },
        ts:         { type: 'number', description: 'restore action — snapshot timestamp from history' },
      },
      required: ['action', 'id'],
    },
    handler: async ({ action, id, content, find, replace, replaceAll, ts }) => {
      if (!id) bad('id is required')
      switch (action) {
        case 'write':
          if (typeof content !== 'string') bad('write requires content')
          return (await apiReq('POST', '/write/' + encId(id), null, { content })).data
        case 'edit':
          if (typeof find !== 'string' || typeof replace !== 'string') bad('edit requires find and replace')
          return (await apiReq('POST', '/edit/' + encId(id), null, { find, replace, replaceAll: replaceAll === true })).data
        case 'refresh':
          return (await apiReq('POST', '/refresh/' + encId(id))).data
        case 'history':
          return (await apiReq('GET', '/history/' + encId(id))).data
        case 'restore':
          if (!ts) bad('restore requires ts')
          return (await apiReq('POST', '/restore/' + encId(id), { ts })).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_trace',
    description:
      'AI session traces + project history — review what an AI did, navigate the codebase chronologically.\n' +
      'actions:\n' +
      '  · log      — current session events (tool, id, ts). Filters: limit, tool.\n' +
      '  · stats    — top files / tool breakdown / duration for current session\n' +
      '  · sessions — past sessions saved on disk (.codesynapt/traces)\n' +
      '  · session  — one past session detail (requires sessionId)\n' +
      '  · clear    — start a fresh session (previous archived)\n' +
      '  · changes  — files modified this session (with current vs first-seen size/loc)\n' +
      '  · diff     — first-seen → current diff for one file (requires id)\n' +
      '  · tour     — heuristic guided tour of the project (entry points + hubs + API hotspots)\n' +
      '  · timeline — git history → when each tracked file first appeared',
    inputSchema: {
      type: 'object',
      properties: {
        action:    { type: 'string', enum: ['log', 'stats', 'sessions', 'session', 'clear', 'changes', 'diff', 'tour', 'timeline'] },
        limit:     { type: 'number', description: 'log — only the most recent N' },
        tool:      { type: 'string', description: 'log — filter by tool name' },
        sessionId: { type: 'number', description: 'session — past session id from sessions list' },
        id:        { type: 'string', description: 'diff — file id' },
      },
      required: ['action'],
    },
    handler: async ({ action, limit, tool, sessionId, id }) => {
      switch (action) {
        case 'log':       return (await apiReq('GET', '/trace', { limit, tool })).data
        case 'stats':     return (await apiReq('GET', '/trace/stats')).data
        case 'sessions':  return (await apiReq('GET', '/trace/sessions')).data
        case 'session':
          if (!sessionId) bad('session requires sessionId')
          return (await apiReq('GET', '/trace/session/' + sessionId)).data
        case 'clear':     return (await apiReq('POST', '/trace/clear')).data
        case 'changes':   return (await apiReq('GET', '/changes')).data
        case 'diff':
          if (!id) bad('diff requires id')
          return (await apiReq('GET', '/changes/' + encId(id))).data
        case 'tour':      return (await apiReq('GET', '/tour')).data
        case 'timeline':  return (await apiReq('GET', '/timeline')).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_ui',
    description:
      'Desktop app UI control — focus the camera on a node, or open the inspector. Desktop-only side effect.\n' +
      'actions:\n' +
      '  · focus — move the 3D camera to a node and highlight it (requires id)\n' +
      '  · open  — open the inspector panel for a node (requires id)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['focus', 'open'] },
        id:     { type: 'string' },
      },
      required: ['action', 'id'],
    },
    handler: async ({ action, id }) => {
      if (!id) bad('id is required')
      switch (action) {
        case 'focus': return (await apiReq('POST', '/focus/' + encId(id))).data
        case 'open':  return (await apiReq('POST', '/open/'  + encId(id))).data
        default: bad('unknown action: ' + action)
      }
    },
  },
  // ─── Symbol mode (codegraph-equivalent layer) ──────────────────
  // Three tools mirroring codegraph's most-used three. File mode tools
  // above stay available — agents pick whichever matches the question.
  {
    name: 'cs_symbol_summary',
    description:
      'Symbol-mode project overview: total symbols, breakdown by kind (function/class/struct/…) and edge kind, plus honesty counters (dynamicSiteCount = call sites static analysis cannot name; declineReasons). Triggers the symbol scan on first call after a project is loaded. Use this once at the start of a symbol-level investigation.\n' +
      'Pass accounting:true for the completeness partition instead — every symbol labelled entry/reachable/possible/dead (unexplained always 0; dead = static floor with caveats, NOT proof). Use it for "what code is unused?" questions.',
    inputSchema: { type: 'object', properties: {
      accounting: { type: 'boolean', description: 'return the accounting partition (entry/reachable/possible/dead) instead of the summary' },
    }, additionalProperties: false },
    handler: async (a) => (await apiReq('GET', a && a.accounting ? '/symbol/accounting' : '/symbol/summary')).data,
  },
  {
    name: 'cs_symbol_search',
    description:
      'Symbol-mode search and graph navigation. Four actions:\n' +
      '  · find    — symbols whose name contains `q` (case-insensitive)\n' +
      '  · callers — symbols that call this symbol id\n' +
      '  · callees — symbols that this symbol id calls\n' +
      '  · node    — one symbol with its source body\n' +
      'Use after cs_symbol_summary when an answer needs a specific function or class, not just the project shape.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['find', 'callers', 'callees', 'node'] },
        q:      { type: 'string', description: 'search query (action=find)' },
        id:     { type: 'string', description: 'symbol id (action=callers/callees/node)' },
        limit:  { type: 'number', description: 'max results (action=find), default 50' },
      },
      required: ['action'],
    },
    handler: async ({ action, q, id, limit }) => {
      switch (action) {
        case 'find':
          if (!q) bad('q is required for action=find')
          return (await apiReq('GET', '/symbol/find?q=' + encodeURIComponent(q) + (limit ? '&limit=' + limit : ''))).data
        case 'callers':
          if (!id) bad('id is required for action=callers')
          return (await apiReq('GET', '/symbol/callers/' + encId(id))).data
        case 'callees':
          if (!id) bad('id is required for action=callees')
          return (await apiReq('GET', '/symbol/callees/' + encId(id))).data
        case 'node':
          if (!id) bad('id is required for action=node')
          return (await apiReq('GET', '/symbol/node/' + encId(id))).data
        default: bad('unknown action: ' + action)
      }
    },
  },
  {
    name: 'cs_symbol_explore',
    description:
      'One-shot answer for a natural-language architecture question.\n' +
      'Returns symbols grouped by lifecycle (exact_match / active / entry /\n' +
      'normal / semantic / deprecated / legacy / test / aux / orphan).\n' +
      'Pick the group that matches the intent:\n' +
      '  · exact_match — your query is a literal symbol name\n' +
      '  · active      — symbols other code calls a lot (live production)\n' +
      '  · entry       — exported main / handler / route / CLI bin\n' +
      '  · semantic    — pulled in by embedding similarity only (synonyms)\n' +
      '  · deprecated / legacy / test / aux / orphan — usually skip\n' +
      'Each entry carries inDegree, outDegree, classification, ageDays,\n' +
      'and semSim so you can filter without a second call.',
    inputSchema: {
      type: 'object',
      properties: {
        q:      { type: 'string', description: 'the natural-language question' },
        budget: { type: 'number', description: 'token budget for snippet bodies (default 8000)' },
      },
      required: ['q'],
    },
    handler: async ({ q, budget }) => {
      if (!q) bad('q is required')
      let u = '/symbol/explore?q=' + encodeURIComponent(q)
      if (budget) u += '&budget=' + budget
      return (await apiReq('GET', u)).data
    },
  },
]

// ─── JSON-RPC over stdio ───────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codesynapt', version: pkg.version },
        // Clients (e.g. Claude Code) surface this in context every session, so the
        // usage contract does not depend on a slash command read once and forgotten.
        instructions:
          'CodeSynapt exposes this project\'s dependency graph. Use it proactively instead of guessing from partial file reads:\n' +
          '• New/unfamiliar project: call cs_summary({action:"project"}) once (~300 tokens) for structure + top hubs.\n' +
          '• BEFORE editing a hub or any non-trivial file: cs_blast({action:"safety", id}) first. A file with many importers (see summary topHubs) can break callers you have not read — do not edit a hub blind.\n' +
          '• "who uses / imports / references X": cs_query({action:"users", id}) — the graph is exact and cheaper than grep.\n' +
          '• Before committing a change set: cs_health({action:"preflight"}).\n' +
          'CAVEAT: results are static import-level; dynamic/reflective/DI coupling and within-file complexity are not fully captured — treat blast counts as a floor, not the whole risk.',
      })
    }
    if (method === 'notifications/initialized') {
      return  // notification — no response
    }
    if (method === 'tools/list') {
      return respond(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return respondError(id, -32601, `unknown tool: ${params?.name}`)
      // A tool's own failure (bad args, nonexistent id, …) is a TOOL result with
      // isError:true — NOT a JSON-RPC protocol error. Protocol errors are for
      // malformed requests; surfacing tool errors as -32000 made clients treat a
      // recoverable "no such symbol" as a transport fault (insp-004 #54).
      try {
        const result = await tool.handler(params.arguments || {})
        return respond(id, {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        })
      } catch (err) {
        return respond(id, {
          content: [{ type: 'text', text: `error: ${err && err.message ? err.message : String(err)}` }],
          isError: true,
        })
      }
    }
    if (method === 'ping') {
      return respond(id, {})
    }
    respondError(id, -32601, `unknown method: ${method}`)
  } catch (err) {
    respondError(id, -32000, err.message)
  }
}

// ─── Transports: stdio (default) or HTTP (--http) ──────────────
//
// stdio is the default MCP transport (Claude Code, Cursor, Continue).
// HTTP is the 2026 MCP standard "Streamable HTTP" — POST /mcp body
// is a JSON-RPC request, response is the JSON-RPC response. Used by
// remote / cloud-hosted MCP clients that can't spawn a subprocess.
//
// Usage:
//   codesynapt-mcp                       # stdio (default)
//   codesynapt-mcp --http                # HTTP on default port 7708
//   codesynapt-mcp --http --port 9999    # HTTP on custom port

const cliArgs = process.argv.slice(2)
const isHttp = cliArgs.includes('--http')
let httpPort = 7708   // distinct from control API's 7707
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--port' && cliArgs[i+1]) httpPort = parseInt(cliArgs[++i], 10)
}

if (isHttp) {
  // HTTP transport — POST /mcp with JSON-RPC body
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin',  '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        name: 'codesynapt-mcp',
        transport: 'streamable-http',
        version: pkg.version,
        endpoints: ['POST /mcp'],
        toolCount: TOOLS.length,
      }))
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        let msg
        try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid json"}') }
        // Capture the response from handle() instead of writing to stdout
        const captured = await new Promise((resolve) => {
          const original = process.stdout.write
          let buf = ''
          process.stdout.write = (s) => { buf += s; return true }
          handle(msg).finally(() => {
            process.stdout.write = original
            resolve(buf.trim())
          })
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(captured || '{}')
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  server.listen(httpPort, '127.0.0.1', () => {
    process.stderr.write(`[cs-mcp] HTTP transport on http://127.0.0.1:${httpPort}/mcp\n`)
  })
} else {
  // stdio transport (default)
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    handle(msg)
  })
  // The client closed stdin (Claude Code / Cursor disconnected) — exit instead
  // of lingering as a zombie that holds the in-process backend port and scanner
  // watchers open (insp-004 #53).
  rl.on('close', () => process.exit(0))
  process.stdin.on('end', () => process.exit(0))
}
