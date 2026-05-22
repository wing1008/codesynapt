#!/usr/bin/env node
// filegraph3d MCP server — stdio JSON-RPC 2.0. Bridges Claude Code (or
// any MCP client) to the running Electron app's localhost:7707 API.
//
// Register with Claude Code:
//   claude mcp add filegraph3d node /absolute/path/to/bin/fg3d-mcp.cjs

const http = require('http')
const readline = require('readline')

const PORT = parseInt(process.env.CS_PORT || process.env.FG3D_PORT || '7707', 10)
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
        reject(new Error(`filegraph3d app is not running at ${HOST}:${PORT}. Start the desktop app first. Override port via FG3D_PORT env var.`))
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
      'Project structure overview. Call this FIRST when working on a new repo to know what you\'re dealing with.\n' +
      'actions:\n' +
      '  · project  — file count, edges, top hubs, top folders, ext mix, orphan count (cheap, Layer 1)\n' +
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
      '  · find   — substring search across file ids (requires q)\n' +
      '  · read   — file content, up to 2 MB (requires id)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'node', 'deps', 'users', 'find', 'read'] },
        id:     { type: 'string', description: 'file id, root-relative (e.g. src/auth.ts)' },
        q:      { type: 'string', description: 'find action — substring' },
        limit:  { type: 'number', description: 'list action — page size (0 = all)' },
        offset: { type: 'number', description: 'list action — pagination offset' },
        ext:    { type: 'string', description: 'list action — filter by extension (e.g. "ts")' },
        minMass:{ type: 'number', description: 'list action — only files with ≥ N importers' },
        sort:   { type: 'string', description: 'list action — mass:desc | size:desc | loc:desc | id:asc | insertion' },
      },
      required: ['action'],
    },
    handler: async ({ action, id, q, limit, offset, ext, minMass, sort }) => {
      switch (action) {
        case 'list':
          return (await apiReq('GET', '/graph', {
            limit: limit ?? 0, offset: offset ?? 0, ext, minMass, sort,
          })).data
        case 'node':  if (!id) bad('node requires id');  return (await apiReq('GET', '/node/' + encId(id))).data
        case 'deps':  if (!id) bad('deps requires id');  return (await apiReq('GET', '/deps/' + encId(id))).data
        case 'users': if (!id) bad('users requires id'); return (await apiReq('GET', '/users/' + encId(id))).data
        case 'find':  if (!q)  bad('find requires q');   return (await apiReq('GET', '/find', { q })).data
        case 'read':  if (!id) bad('read requires id');  return (await apiReq('GET', '/file/' + encId(id))).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_blast',
    description:
      'Impact analysis before editing — answers "is it safe to change this file?".\n' +
      'actions:\n' +
      '  · radius — transitive dependents/dependencies via BFS, with token estimate (id, depth=3, dir=users|deps)\n' +
      '  · safety — 🟢/🟡/🔴 verdict + reasons + one-line advice (id, deep=true returns full file list)\n' +
      '  · bundle — pack closest neighbours within token budget, ready to feed to the editor (id, budget=8000, depth=3)\n' +
      'Call `safety` before any edit; `bundle` before reading neighbour context; `radius` for deeper analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['radius', 'safety', 'bundle'] },
        id:     { type: 'string' },
        depth:  { type: 'number', description: 'radius / bundle BFS depth (1-10, default 3)' },
        dir:    { type: 'string', enum: ['users', 'deps'], description: 'radius direction (default users)' },
        deep:   { type: 'boolean', description: 'safety — include full impacted file list' },
        budget: { type: 'number', description: 'bundle — token budget (default 8000)' },
      },
      required: ['action', 'id'],
    },
    handler: async ({ action, id, depth, dir, deep, budget }) => {
      if (!id) bad('id is required')
      switch (action) {
        case 'radius':
          return (await apiReq('GET', '/blast/' + encId(id), { depth: depth ?? 3, dir: dir ?? 'users' })).data
        case 'safety':
          return (await apiReq('GET', '/safety/' + encId(id), { deep: deep ? '1' : null })).data
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
      'Project health checks + next-step recommendations. Use before deploys or when "what should I work on next?".\n' +
      'actions:\n' +
      '  · env       — env vars: declared vs used cross-reference (var optional — overview if omitted)\n' +
      '  · secrets   — server-only env leaked into frontend bundles (security check)\n' +
      '  · preflight — comprehensive deploy-readiness (undeclared env / http URLs / hub tests / orphans / dynamic / leaks)\n' +
      '  · suggest   — rule-based "next thing to ask the AI to fix" (high/medium/low). Best opening move when stuck.\n' +
      '  · legacy    — orphan/path/filename/duplicate cleanup candidates with confidence scores (type optional)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['env', 'secrets', 'preflight', 'suggest', 'legacy'] },
        var:    { type: 'string', description: 'env action — single variable focus' },
        top:    { type: 'number', description: 'suggest — max suggestions (default 10)' },
        type:   { type: 'string', enum: ['orphan', 'path', 'filename', 'duplicate'], description: 'legacy — filter to one category' },
      },
      required: ['action'],
    },
    handler: async ({ action, var: v, top, type }) => {
      switch (action) {
        case 'env':       return (await apiReq('GET', '/env', v ? { var: v } : null)).data
        case 'secrets':   return (await apiReq('GET', '/secrets')).data
        case 'preflight': return (await apiReq('GET', '/preflight')).data
        case 'suggest':   return (await apiReq('GET', '/suggest', { top: top ?? 10 })).data
        case 'legacy':    return (await apiReq('GET', '/legacy', type ? { type } : null)).data
        default: bad('unknown action: ' + action)
      }
    },
  },

  {
    name: 'cs_change',
    description:
      'File modifications + history. All writes are auto-snapshotted (if history enabled) and pulse green in the 3D view.\n' +
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
      '  · sessions — past sessions saved on disk (.filegraph3d/traces)\n' +
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
        serverInfo: { name: 'filegraph3d', version: '0.2.0' },
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

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  handle(msg)
})
