// lib/control-server.cjs
//
// Standalone HTTP control surface for filegraph3d. Factory function —
// takes a Scanner instance and a `getCurrentRoot()` callback, returns
// `{ handleControlRequest, startControlServer, stopControlServer }`.
//
// Used by:
//   - electron/main.cjs (full UI — passes IPC callbacks)
//   - bin/fg3d-serve.cjs (headless daemon — no IPC)
//
// This is a deliberate copy of the read-only endpoint logic that
// previously lived only in electron/main.cjs. The Electron copy stays
// untouched in THIS session so the desktop app keeps working unchanged;
// the next session will switch main.cjs to require this module.

const http = require('http')
const fs = require('fs')
const path = require('path')

function createControlServer(opts) {
  const {
    scanner,                 // Scanner instance
    getCurrentRoot,          // () => absolute path of scanned root
    onBlast,                 // optional (payload) => void  IPC: highlight blast
    onFocus,                 // optional (id) => void        IPC: focus node
    onOpen,                  // optional (id) => void        IPC: open in editor
  } = opts
  if (!scanner) throw new Error('createControlServer: scanner is required')
  if (typeof getCurrentRoot !== 'function') throw new Error('createControlServer: getCurrentRoot fn is required')

  // ── Utilities ─────────────────────────────────────────────────
  function writeJson(res, status, data) {
    const body = JSON.stringify(data)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end(body)
  }
  function isInsideRoot(root, full) {
    const r = path.resolve(root)
    const f = path.resolve(full)
    return f === r || f.startsWith(r + path.sep)
  }
  function estimateTokens(obj) {
    try { return Math.ceil(JSON.stringify(obj).length / 4) } catch { return 0 }
  }
  function withMeta(payload, extra = {}) {
    const meta = {
      scannedAt: scanner._lastSnapshotAt || Date.now(),
      serverTime: Date.now(),
      ...extra,
    }
    meta.tokenEstimate = estimateTokens({ ...payload, meta })
    return { ...payload, meta }
  }

  // ── Graph state ───────────────────────────────────────────────
  function getGraphState() {
    return { root: getCurrentRoot(), ...scanner.snapshot() }
  }
  function findNode(id) {
    const f = scanner.files.get(id)
    if (!f) return null
    return {
      id: f.id, ext: f.ext, loc: f.loc, size: f.size,
      importCount: f.imports.length,
      hasDynamicResolution: (f.dynamicPatterns || []).length > 0,
      dynamicPatterns: f.dynamicPatterns || [],
      lastSeenAt: f.lastSeenAt,
    }
  }
  function getDeps(id) { return scanner.edges.filter((e) => e.s === id) }
  function getUsers(id) { return scanner.edges.filter((e) => e.t === id) }
  function searchFiles(q) {
    if (!q) return []
    const needle = q.toLowerCase()
    const out = []
    for (const f of scanner.files.values()) {
      if (f.id.toLowerCase().includes(needle)) out.push(f.id)
      if (out.length >= 100) break
    }
    return out
  }

  // ── Summary (cached on snapshotVersion) ───────────────────────
  let _summaryCache = { version: -1, data: null }
  function buildSummary() {
    const files = [...scanner.files.values()]
    const byExt = {}
    let dynamicCount = 0
    const incoming = new Map(), outgoing = new Map()
    for (const e of scanner.edges) {
      incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
      outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
    }
    for (const f of files) {
      byExt[f.ext || 'other'] = (byExt[f.ext || 'other'] || 0) + 1
      if ((f.dynamicPatterns || []).length > 0) dynamicCount++
    }
    const topHubs = files
      .map((f) => ({ id: f.id, incoming: incoming.get(f.id) || 0, ext: f.ext }))
      .filter((h) => h.incoming >= 2)
      .sort((a, b) => b.incoming - a.incoming).slice(0, 10)
    const folderCount = new Map()
    for (const f of files) {
      const p = f.id.includes('/') ? f.id.slice(0, f.id.lastIndexOf('/')) : '(root)'
      const top = p.split('/')[0] || '(root)'
      folderCount.set(top, (folderCount.get(top) || 0) + 1)
    }
    const topFolders = [...folderCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([p, n]) => ({ path: p, files: n }))
    let orphanCount = 0
    for (const f of files) {
      if ((incoming.get(f.id) || 0) === 0 && (outgoing.get(f.id) || 0) === 0) orphanCount++
    }
    const extMix = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .reduce((o, [k, v]) => (o[k] = v, o), {})
    const ext = getExternalUrls()
    return {
      root: getCurrentRoot(),
      fileCount: files.length,
      edgeCount: scanner.edges.length,
      extMix, topFolders, topHubs,
      orphanCount,
      dynamicPatternFileCount: dynamicCount,
      externalDomainCount: ext.domains.length,
      externalDomainsTop: ext.domains.slice(0, 5).map((d) => d.domain),
      historyEnabled: false,  // headless daemon does not write history
    }
  }
  function buildSummaryCached() {
    const v = scanner.snapshotVersion || 0
    if (_summaryCache.version === v && _summaryCache.data) return _summaryCache.data
    const data = buildSummary()
    if (scanner.snapshotVersion === v) _summaryCache = { version: v, data }
    return data
  }

  // ── External URL aggregator ───────────────────────────────────
  function getExternalUrls() {
    const byDomain = new Map()
    let total = 0
    const add = (rawUrl, fileId, methodHint) => {
      const m = rawUrl.match(/^(https?|wss?):\/\/([^\/:?#]+)/i)
      if (!m) return
      const proto = m[1].toLowerCase()
      const domain = m[2].toLowerCase()
      let bucket = byDomain.get(domain)
      if (!bucket) { bucket = { domain, proto, callers: [] }; byDomain.set(domain, bucket) }
      bucket.callers.push({ file: fileId, url: rawUrl, method: methodHint || (proto.startsWith('ws') ? 'WS' : 'GET') })
      total++
    }
    for (const f of scanner.files.values()) {
      if (f.apiCalls && f.apiCalls.length) {
        for (const c of f.apiCalls) if (/^https?:\/\//i.test(c.url)) add(c.url, f.id, c.method || 'GET')
      }
      if (f.externalUrls && f.externalUrls.length) {
        for (const u of f.externalUrls) add(u.url, f.id, null)
      }
    }
    for (const bucket of byDomain.values()) {
      const seen = new Set()
      bucket.callers = bucket.callers.filter((c) => {
        const k = c.file + '|' + c.url + '|' + c.method
        if (seen.has(k)) return false
        seen.add(k); return true
      })
    }
    total = 0
    for (const b of byDomain.values()) total += b.callers.length
    const domains = [...byDomain.values()].sort((a, b) => b.callers.length - a.callers.length)
    return { domains, totalCalls: total }
  }

  // ── Blast radius ──────────────────────────────────────────────
  function computeBlastRadius(id, depth = 3, direction = 'users') {
    if (!scanner.files.has(id)) return null
    const visited = new Set([id])
    let frontier = new Set([id])
    const byDepth = [{ depth: 0, ids: [id] }]
    for (let d = 1; d <= depth; d++) {
      const next = new Set()
      for (const fid of frontier) {
        const edges = direction === 'users' ? getUsers(fid) : getDeps(fid)
        for (const e of edges) {
          const neighbor = direction === 'users' ? e.s : e.t
          if (visited.has(neighbor)) continue
          visited.add(neighbor); next.add(neighbor)
        }
      }
      if (next.size === 0) break
      byDepth.push({ depth: d, ids: [...next] })
      frontier = next
    }
    const files = [...visited].map((fid) => {
      const f = scanner.files.get(fid)
      return f ? { id: fid, ext: f.ext, loc: f.loc, size: f.size } : null
    }).filter(Boolean)
    const totalSize = files.reduce((s, f) => s + f.size, 0)
    const totalLoc  = files.reduce((s, f) => s + f.loc, 0)
    const tokenEstimate = Math.round(totalSize / 4)
    const categories = { tests: 0, source: 0, config: 0, docs: 0, other: 0 }
    for (const f of files) {
      if (/(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$/i.test(f.id)) categories.tests++
      else if (/\.(?:json|ya?ml|toml|env|config|conf|ini|lock)(?:\.\w+)?$|^\.[a-z]+rc/i.test(f.id)) categories.config++
      else if (/\.(?:md|mdx|txt|rst|adoc)$/i.test(f.id)) categories.docs++
      else if (f.ext) categories.source++
      else categories.other++
    }
    return {
      seed: id, direction, depth,
      totalFiles: files.length, totalSize, totalLoc, tokenEstimate, categories,
      files: files.sort((a, b) => b.size - a.size).slice(0, 200),
      byDepth,
    }
  }

  // ── Safety signal ─────────────────────────────────────────────
  // Quick "is it safe to let an AI edit this?" verdict for non-developers.
  // Three buckets:
  //   🔴 RISKY    — high blast OR backend endpoint OR external API
  //   🟡 CAUTION  — medium blast OR routes OR dynamic patterns
  //   🟢 SAFE     — low blast, leaf-ish
  // Returns { id, level, score, reasons:[], blast:{...}, advice }.
  function buildSafety(id, opts = {}) {
    const f = scanner.files.get(id)
    if (!f) return null
    const blast = computeBlastRadius(id, 3, 'users')
    const dependents = blast.totalFiles - 1  // exclude self
    const routeCount   = (f.routes   || []).length
    const apiCallCount = (f.apiCalls || []).length
    const externalUrlCount = (f.externalUrls || []).length
    const dynamic = (f.dynamicPatterns || []).length > 0
    const testsInBlast = blast.categories.tests

    const reasons = []
    let level = 'safe'
    if (dependents > 30) {
      level = 'risky'
      reasons.push(`핵심 허브 — ${dependents}개 파일이 의존`)
    }
    if (routeCount > 0) {
      if (level === 'safe') level = 'caution'
      reasons.push(`backend 라우트 ${routeCount}개 정의 — API 계약 변경 위험`)
    }
    if (externalUrlCount > 0) {
      if (level === 'safe') level = 'caution'
      reasons.push(`외부 API ${externalUrlCount}곳 호출 — 키/엔드포인트 영향`)
    }
    if (apiCallCount > 0 && level === 'safe') {
      level = 'caution'
      reasons.push(`HTTP 클라이언트 호출 ${apiCallCount}개`)
    }
    if (dynamic) {
      if (level === 'safe') level = 'caution'
      reasons.push(`동적 import 패턴 — 그래프가 불완전할 수 있음`)
    }
    if (dependents > 5 && dependents <= 30 && level === 'safe') {
      level = 'caution'
      reasons.push(`${dependents}개 파일이 의존`)
    }
    if (level === 'safe') {
      reasons.push(`의존 파일 ${dependents}개로 적음, 외부 영향 없음`)
    }

    let advice
    if (level === 'risky')   advice = `AI에게 시키지 말고 사람이 검토. 영향 큰 파일.`
    else if (level === 'caution') advice = `AI에게 시키기 전에 의존 파일을 같이 읽으라고 지시. \`fg3d bundle ${id}\`로 함께 줄 파일 묶음 만들 수 있음.`
    else                     advice = `AI에게 그대로 시켜도 안전.`

    if (testsInBlast === 0 && dependents > 0 && level !== 'safe') {
      reasons.push(`이 파일을 깨면 잡아낼 테스트가 없음`)
    }

    return {
      id, level, dependents,
      routes: routeCount, apiCalls: apiCallCount, externalUrls: externalUrlCount,
      dynamic, testsInBlast,
      blastTokenEstimate: blast.tokenEstimate,
      reasons, advice,
      blastFiles: opts.deep ? blast.files.map((bf) => bf.id) : undefined,
    }
  }

  // ── AI context bundle ─────────────────────────────────────────
  // Pack the seed file + its closest dependents into a context bundle
  // that fits inside a token budget. The intent is to hand this to an
  // AI agent ("read these N files before editing X") so the agent has
  // the right neighbours without burning the whole context window.
  function buildBundle(id, budgetTokens = 8000, depth = 3) {
    const seed = scanner.files.get(id)
    if (!seed) return null
    const blast = computeBlastRadius(id, depth, 'users')
    // Order: seed first, then by ascending depth and descending mass
    // (most-used neighbours first within each depth ring).
    const incoming = new Map()
    for (const e of scanner.edges) incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    const ordered = []
    for (const ring of blast.byDepth) {
      const ringFiles = ring.ids
        .map((fid) => scanner.files.get(fid))
        .filter(Boolean)
        .sort((a, b) => (incoming.get(b.id) || 0) - (incoming.get(a.id) || 0))
      for (const f of ringFiles) ordered.push({ file: f, depth: ring.depth })
    }
    // Greedily pack within token budget. Each file costs ceil(size / 4).
    const picked = []
    let usedTokens = 0
    for (const { file, depth: d } of ordered) {
      const cost = Math.ceil((file.size || 0) / 4)
      if (usedTokens + cost > budgetTokens && picked.length > 0) break
      picked.push({ id: file.id, depth: d, ext: file.ext, loc: file.loc, tokenCost: cost })
      usedTokens += cost
    }
    const remaining = ordered.length - picked.length
    return {
      seed: id,
      budgetTokens,
      usedTokens,
      depthSearched: depth,
      files: picked,
      filesIncluded: picked.length,
      filesOmitted: remaining,
      totalCandidates: ordered.length,
    }
  }

  // ── Packages (monorepo) ───────────────────────────────────────
  let _packagesCache = { version: -1, data: null }
  function buildPackagesCached() {
    const v = scanner.snapshotVersion || 0
    if (_packagesCache.version === v && _packagesCache.data) return _packagesCache.data
    const m = scanner.monorepo
    if (!m || m.kind === 'none' || !m.packages.length) {
      const empty = { kind: m?.kind || 'none', packages: [], pkgEdges: [], rootIsPackage: !!m?.rootIsPackage }
      _packagesCache = { version: v, data: empty }; return empty
    }
    const filesByPkg = new Map()
    for (const f of scanner.files.values()) {
      if (!f.pkg) continue
      const arr = filesByPkg.get(f.pkg) || []
      arr.push(f); filesByPkg.set(f.pkg, arr)
    }
    const edgesIn = new Map(), edgesOut = new Map()
    for (const e of scanner.edges) {
      const sf = scanner.files.get(e.s), tf = scanner.files.get(e.t)
      if (!sf || !tf) continue
      if (sf.pkg && sf.pkg !== tf.pkg) edgesOut.set(sf.pkg, (edgesOut.get(sf.pkg) || 0) + 1)
      if (tf.pkg && sf.pkg !== tf.pkg) edgesIn.set(tf.pkg,  (edgesIn.get(tf.pkg)  || 0) + 1)
    }
    const packages = m.packages.map((p) => {
      const files = filesByPkg.get(p.name) || []
      const loc = files.reduce((s, f) => s + (f.loc || 0), 0)
      const size = files.reduce((s, f) => s + (f.size || 0), 0)
      return {
        name: p.name, relRoot: p.relRoot, manifest: p.manifest,
        language: p.language, kind: p.kind,
        fileCount: files.length, loc, size,
        crossPackageImports: edgesOut.get(p.name) || 0,
        crossPackageDependents: edgesIn.get(p.name) || 0,
      }
    })
    const data = { kind: m.kind, rootIsPackage: m.rootIsPackage, packages, pkgEdges: scanner.pkgEdges || [] }
    if (scanner.snapshotVersion === v) _packagesCache = { version: v, data }
    return data
  }
  function buildPackageDetail(name) {
    const m = scanner.monorepo
    const pkg = m?.packages?.find((p) => p.name === name)
    if (!pkg) return null
    const files = []
    const incoming = new Map()
    for (const e of scanner.edges) incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    for (const f of scanner.files.values()) {
      if (f.pkg !== name) continue
      files.push({ id: f.id, ext: f.ext, loc: f.loc, size: f.size, mass: incoming.get(f.id) || 0 })
    }
    files.sort((a, b) => b.mass - a.mass)
    const outgoingEdges = [], incomingEdges = []
    for (const e of scanner.edges) {
      const sf = scanner.files.get(e.s), tf = scanner.files.get(e.t)
      if (!sf || !tf || !sf.pkg || !tf.pkg || sf.pkg === tf.pkg) continue
      if (sf.pkg === name) outgoingEdges.push({ s: e.s, t: e.t, k: e.k, toPkg: tf.pkg })
      if (tf.pkg === name) incomingEdges.push({ s: e.s, t: e.t, k: e.k, fromPkg: sf.pkg })
    }
    let declared = []
    try {
      if (pkg.manifest === 'package.json') {
        const j = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'))
        const collect = (field) => {
          if (!j[field]) return
          for (const [k, v] of Object.entries(j[field])) declared.push({ name: k, spec: v, kind: field })
        }
        collect('dependencies'); collect('devDependencies'); collect('peerDependencies')
      }
    } catch {}
    return {
      name, relRoot: pkg.relRoot, manifest: pkg.manifest,
      language: pkg.language, kind: pkg.kind,
      fileCount: files.length, files,
      outgoingEdges, incomingEdges, declared,
    }
  }

  // ── Write/edit (optional — only enabled if writeEnabled=true) ─
  function writeFile(id, content) {
    const root = getCurrentRoot()
    const full = path.join(root, id)
    if (!isInsideRoot(root, full)) return { ok: false, error: 'outside root' }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content, 'utf8')
      return { ok: true, path: full, bytes: Buffer.byteLength(content, 'utf8') }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // ── Main router ───────────────────────────────────────────────
  function handleControlRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      return res.end()
    }
    const url = new URL(req.url, `http://${req.headers.host}`)
    const parts = url.pathname.split('/').filter(Boolean)
    const [seg0, ...rest] = parts
    const idFromRest = () => decodeURIComponent(rest.join('/'))

    try {
      if (req.method === 'GET' && parts.length === 0) {
        return writeJson(res, 200, {
          name: 'filegraph3d',
          mode: 'headless',
          endpoints: [
            'GET /health', 'GET /summary', 'GET /graph', 'GET /node/:id',
            'GET /file/:id', 'GET /deps/:id', 'GET /users/:id', 'GET /find?q=',
            'GET /external', 'GET /blast/:id', 'GET /packages',
            'GET /package/:name', 'GET /package-graph',
            'GET /safety/:id', 'GET /bundle/:id',
            'POST /write/:id', 'POST /edit/:id',
          ],
        })
      }
      if (req.method === 'GET' && seg0 === 'health') {
        return writeJson(res, 200, {
          ok: true, mode: 'headless',
          root: getCurrentRoot(),
          fileCount: scanner.files.size,
          edgeCount: scanner.edges.length,
        })
      }
      if (req.method === 'GET' && seg0 === 'summary') {
        return writeJson(res, 200, withMeta(buildSummaryCached()))
      }
      if (req.method === 'GET' && seg0 === 'graph') {
        const data = getGraphState()
        const limit  = parseInt(url.searchParams.get('limit')  || '0', 10)
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)
        const extFilter = url.searchParams.get('ext')
        const minMass = parseInt(url.searchParams.get('minMass') || '0', 10)
        const sort = url.searchParams.get('sort') || 'mass:desc'
        let inc = null
        const needsInc = sort.startsWith('mass') || minMass > 0
        if (needsInc) {
          inc = new Map()
          for (const e of scanner.edges) inc.set(e.t, (inc.get(e.t) || 0) + 1)
        }
        let files = data.files.slice()
        if (extFilter) files = files.filter((f) => f.ext === extFilter)
        if (minMass > 0) files = files.filter((f) => (inc.get(f.id) || 0) >= minMass)
        if (sort !== 'insertion') {
          const [key, dirRaw] = sort.split(':')
          const dir = dirRaw === 'asc' ? 1 : -1
          const getter = key === 'mass' ? ((f) => inc.get(f.id) || 0)
                       : key === 'size' ? ((f) => f.size)
                       : key === 'loc'  ? ((f) => f.loc)
                       : key === 'id'   ? null : null
          if (getter) files.sort((a, b) => dir * (getter(a) - getter(b)))
          else if (key === 'id') files.sort((a, b) => dir * a.id.localeCompare(b.id))
        }
        const totalAvailable = files.length
        const sliced = limit > 0 ? files.slice(offset, offset + limit) : files
        return writeJson(res, 200, withMeta(
          { root: data.root, files: sliced, edges: data.edges },
          { totalAvailable, returned: sliced.length, offset, limit: limit || sliced.length,
            sort, truncated: limit > 0 && (offset + limit) < totalAvailable }
        ))
      }
      if (req.method === 'GET' && seg0 === 'node' && rest.length > 0) {
        const id = idFromRest()
        const node = findNode(id)
        if (!node) return writeJson(res, 404, { error: 'not found' })
        return writeJson(res, 200, withMeta({
          ...node, imports: getDeps(id), importedBy: getUsers(id),
        }))
      }
      if (req.method === 'GET' && seg0 === 'file' && rest.length > 0) {
        const id = idFromRest()
        const root = getCurrentRoot()
        const full = path.join(root, id)
        if (!isInsideRoot(root, full)) return writeJson(res, 400, { error: 'outside root' })
        try {
          const stat = fs.statSync(full)
          if (!stat.isFile()) return writeJson(res, 404, { error: 'not a file' })
          if (stat.size > 2_000_000) return writeJson(res, 413, { error: 'file too large', size: stat.size })
          return writeJson(res, 200, { id, content: fs.readFileSync(full, 'utf8') })
        } catch (e) { return writeJson(res, 500, { error: e.message }) }
      }
      if (req.method === 'GET' && seg0 === 'deps' && rest.length > 0) {
        return writeJson(res, 200, getDeps(idFromRest()))
      }
      if (req.method === 'GET' && seg0 === 'users' && rest.length > 0) {
        return writeJson(res, 200, getUsers(idFromRest()))
      }
      if (req.method === 'GET' && seg0 === 'find') {
        return writeJson(res, 200, searchFiles(url.searchParams.get('q') || ''))
      }
      if (req.method === 'GET' && seg0 === 'external') {
        return writeJson(res, 200, getExternalUrls())
      }
      if (req.method === 'GET' && seg0 === 'safety' && rest.length > 0) {
        const id = idFromRest()
        const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('deep') === 'true'
        const r = buildSafety(id, { deep })
        if (!r) return writeJson(res, 404, { error: 'not found' })
        return writeJson(res, 200, withMeta(r))
      }
      if (req.method === 'GET' && seg0 === 'bundle' && rest.length > 0) {
        const id = idFromRest()
        const budget = parseInt(url.searchParams.get('budget') || '8000', 10)
        const depth = Math.max(1, Math.min(10, parseInt(url.searchParams.get('depth') || '3', 10)))
        const r = buildBundle(id, budget, depth)
        if (!r) return writeJson(res, 404, { error: 'not found' })
        return writeJson(res, 200, withMeta(r))
      }
      if (req.method === 'GET' && seg0 === 'blast' && rest.length > 0) {
        const id = idFromRest()
        const depth = Math.max(1, Math.min(10, parseInt(url.searchParams.get('depth') || '3', 10)))
        const dir = url.searchParams.get('dir') === 'deps' ? 'deps' : 'users'
        const r = computeBlastRadius(id, depth, dir)
        if (!r) return writeJson(res, 404, { error: 'not found' })
        if (onBlast) { try { onBlast({ seed: id, ids: r.files.map((f) => f.id) }) } catch {} }
        return writeJson(res, 200, r)
      }
      if (req.method === 'GET' && seg0 === 'packages' && rest.length === 0) {
        return writeJson(res, 200, withMeta(buildPackagesCached()))
      }
      if (req.method === 'GET' && seg0 === 'package' && rest.length > 0) {
        const d = buildPackageDetail(idFromRest())
        if (!d) return writeJson(res, 404, { error: 'package not found' })
        return writeJson(res, 200, withMeta(d))
      }
      if (req.method === 'GET' && seg0 === 'package-graph') {
        const data = buildPackagesCached()
        return writeJson(res, 200, withMeta({
          kind: data.kind,
          packages: data.packages.map((p) => ({ name: p.name, fileCount: p.fileCount })),
          edges: data.pkgEdges,
        }))
      }
      if (req.method === 'POST' && seg0 === 'focus' && rest.length > 0) {
        const id = idFromRest()
        if (!scanner.files.has(id)) return writeJson(res, 404, { error: 'not found' })
        if (onFocus) { try { onFocus(id) } catch {} }
        return writeJson(res, 200, { ok: true, id, dispatched: !!onFocus })
      }
      if (req.method === 'POST' && seg0 === 'open' && rest.length > 0) {
        const id = idFromRest()
        if (!scanner.files.has(id)) return writeJson(res, 404, { error: 'not found' })
        if (onOpen) { try { onOpen(id) } catch {} }
        return writeJson(res, 200, { ok: true, id, dispatched: !!onOpen })
      }
      if (req.method === 'POST' && (seg0 === 'write' || seg0 === 'edit') && rest.length > 0) {
        const id = idFromRest()
        const root = getCurrentRoot()
        const full = path.join(root, id)
        if (!isInsideRoot(root, full)) return writeJson(res, 400, { error: 'outside root' })
        let bodyChunks = []
        req.on('data', (c) => bodyChunks.push(c))
        req.on('end', () => {
          let body
          try { body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) }
          catch { return writeJson(res, 400, { error: 'invalid JSON body' }) }
          if (seg0 === 'write') {
            if (typeof body.content !== 'string') return writeJson(res, 400, { error: 'usage: { "content": "..." }' })
            const r = writeFile(id, body.content)
            if (!r.ok) return writeJson(res, 500, r)
            return writeJson(res, 200, withMeta({ ...r, id }))
          }
          if (typeof body.find !== 'string' || typeof body.replace !== 'string') {
            return writeJson(res, 400, { error: 'usage: { "find": "...", "replace": "...", "replaceAll": false }' })
          }
          let content
          try { content = fs.readFileSync(full, 'utf8') }
          catch (e) { return writeJson(res, 500, { error: 'read failed: ' + e.message }) }
          const findStr = body.find
          if (!findStr) return writeJson(res, 400, { error: 'find string cannot be empty' })
          let count = 0, idx = 0
          while ((idx = content.indexOf(findStr, idx)) !== -1) { count++; idx += findStr.length }
          if (count === 0) return writeJson(res, 404, { error: 'find string not found' })
          const replaceAll = body.replaceAll === true
          if (!replaceAll && count > 1) {
            return writeJson(res, 409, {
              error: `find string is not unique (${count} occurrences). Pass replaceAll:true.`,
              occurrences: count,
            })
          }
          const next = replaceAll
            ? content.split(findStr).join(body.replace)
            : content.replace(findStr, body.replace)
          const r = writeFile(id, next)
          if (!r.ok) return writeJson(res, 500, r)
          return writeJson(res, 200, withMeta({ ...r, id, replacements: replaceAll ? count : 1 }))
        })
        return
      }
      return writeJson(res, 404, { error: 'unknown endpoint', path: url.pathname })
    } catch (e) {
      return writeJson(res, 500, { error: e.message })
    }
  }

  // ── Server lifecycle ──────────────────────────────────────────
  let server = null
  function startControlServer(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      if (server) return resolve({ port, alreadyRunning: true })
      server = http.createServer(handleControlRequest)
      server.on('error', (err) => {
        server = null
        reject(err)
      })
      server.listen(port, host, () => resolve({ port, host }))
    })
  }
  function stopControlServer() {
    return new Promise((resolve) => {
      if (!server) return resolve()
      server.close(() => { server = null; resolve() })
    })
  }

  return { handleControlRequest, startControlServer, stopControlServer }
}

module.exports = { createControlServer }
