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
const PORT = resolvePort()
const HOST = '127.0.0.1'

function apiReq(method, pathStr, query, body) {
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
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }) }
        catch { resolve({ status: res.statusCode, data: text }) }
      })
    })
    r.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`codesynapt server is not running at ${HOST}:${PORT}. Start the desktop app first, or run 'cs serve'. Override port via CS_PORT.`))
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
        case 'project':        return (await apiReq('GET', '/summary')).data
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
      'RULE: 🔴 RISKY → STOP, surface to user, do not auto-edit. 🟡 CAUTION → call bundle first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['radius', 'safety', 'bundle'] },
        id:     { type: 'string' },
        depth:  { type: 'number', description: 'radius / bundle BFS depth (1-10, default 3)' },
        dir:    { type: 'string', enum: ['users', 'deps'], description: 'radius direction (default users)' },
        deep:   { type: 'boolean', description: 'safety — include full impacted file list' },
        budget: { type: 'number', description: 'bundle — token budget (default 8000)' },
        locale: { type: 'string', enum: ['en', 'ko'], description: 'safety — response language (reasons + advice). default en.' },
      },
      required: ['action', 'id'],
    },
    handler: async ({ action, id, depth, dir, deep, budget, locale }) => {
      if (!id) bad('id is required')
      switch (action) {
        case 'radius':
          return (await apiReq('GET', '/blast/' + encId(id), { depth: depth ?? 3, dir: dir ?? 'users' })).data
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
        serverInfo: { name: 'codesynapt', version: '0.2.0' },
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
      const result = await tool.handler(params.arguments || {})
      return respond(id, {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      })
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
        version: '0.1.0',
        endpoints: ['POST /mcp', 'GET /mcp/events (SSE)'],
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
}
