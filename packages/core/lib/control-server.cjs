// lib/control-server.cjs
//
// Standalone HTTP control surface for filegraph3d. Factory function —
// takes a Scanner instance and a `getCurrentRoot()` callback, returns
// `{ handleControlRequest, startControlServer, stopControlServer }`.
//
// Used by:
//   - electron/main.cjs (full UI — passes IPC callbacks)
//   - bin/codesynapt.cjs serve (headless daemon — no IPC)
//
// This is a deliberate copy of the read-only endpoint logic that
// previously lived only in electron/main.cjs. The Electron copy stays
// untouched in THIS session so the desktop app keeps working unchanged;
// the next session will switch main.cjs to require this module.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ─── i18n strings (en + ko) ──────────────────────────────────
// Keys are stable identifiers; values are functions so we can
// interpolate variables. `t(key, locale, ...args)` is the single entry
// point. Default locale is 'en' (international AI clients).
const I18N = {
  // safety
  'safety.reason.risky_hub':       { en: (n) => `Core hub — ${n} files depend on this`,                   ko: (n) => `핵심 허브 — ${n}개 파일이 의존` },
  'safety.reason.routes':          { en: (n) => `Defines ${n} backend route(s) — API contract risk`,      ko: (n) => `backend 라우트 ${n}개 정의 — API 계약 변경 위험` },
  'safety.reason.external_api':    { en: (n) => `Calls ${n} external API endpoint(s) — keys/URLs at risk`,ko: (n) => `외부 API ${n}곳 호출 — 키/엔드포인트 영향` },
  'safety.reason.http_client':     { en: (n) => `${n} HTTP client call(s)`,                               ko: (n) => `HTTP 클라이언트 호출 ${n}개` },
  'safety.reason.dynamic':         { en: ()  => `Dynamic import patterns — graph may be incomplete`,      ko: ()  => `동적 import 패턴 — 그래프가 불완전할 수 있음` },
  'safety.reason.dependents':      { en: (n) => `${n} files depend on this`,                              ko: (n) => `${n}개 파일이 의존` },
  'safety.reason.safe':            { en: (n) => `Only ${n} dependents, no external impact`,               ko: (n) => `의존 파일 ${n}개로 적음, 외부 영향 없음` },
  'safety.reason.no_tests':        { en: ()  => `No tests would catch breakage here`,                     ko: ()  => `이 파일을 깨면 잡아낼 테스트가 없음` },
  'safety.advice.risky':           { en: (id) => `Don't let an AI edit this without human review. High-impact file.`,                                                                          ko: (id) => `AI에게 시키지 말고 사람이 검토. 영향 큰 파일.` },
  'safety.advice.caution':         { en: (id) => `Before letting an AI edit, ask it to read the dependents first. Use \`cs bundle ${id}\` to pack them into a token budget.`,                  ko: (id) => `AI에게 시키기 전에 의존 파일을 같이 읽으라고 지시. \`cs bundle ${id}\`로 함께 줄 파일 묶음 만들 수 있음.` },
  'safety.advice.safe':            { en: ()  => `Safe to let an AI edit as-is.`,                          ko: ()  => `AI에게 그대로 시켜도 안전.` },

  // preflight
  'preflight.env_undeclared.ok':   { en: ()  => `All used env vars declared in .env*`,                    ko: ()  => `모든 코드 ENV 변수가 .env*에 선언됨` },
  'preflight.env_undeclared.fail': { en: (n) => `${n} env vars used in code but not declared in .env*`,   ko: (n) => `미선언 환경 변수 ${n}개` },
  'preflight.env_undeclared.detail': { en: () => `Will be \`undefined\` at runtime. Ask the AI to add placeholders to .env.example.`, ko: () => `배포 시 undefined로 동작. AI에게 .env.example 추가 요청.` },
  'preflight.secret_leak.ok':      { en: ()  => `No server-only env exposed to frontend`,                 ko: ()  => `frontend에 server-only env 노출 없음` },
  'preflight.secret_leak.fail':    { en: (n) => `${n} server-only env var(s) in frontend code`,           ko: (n) => `frontend 코드에 server-only env 변수 ${n}개 노출` },
  'preflight.secret_leak.detail':  { en: ()  => `Vars without a public prefix (NEXT_PUBLIC_/VITE_) end up in the browser bundle — secret leak.`, ko: () => `public prefix(NEXT_PUBLIC_/VITE_ 등) 없는 변수가 브라우저 번들에 포함됨. 키 유출 위험.` },
  'preflight.http_urls.ok':        { en: ()  => `All external calls use HTTPS`,                           ko: ()  => `외부 호출 모두 HTTPS` },
  'preflight.http_urls.fail':      { en: (n) => `${n} plain http:// external call(s)`,                    ko: (n) => `평문 http:// 외부 호출 ${n}개` },
  'preflight.http_urls.detail':    { en: ()  => `Vulnerable to MITM. Switch to https or move host to env var.`, ko: () => `중간자 공격 가능. https 또는 환경 변수로 도메인 분리.` },
  'preflight.hub_tests.ok':        { en: ()  => `All hub files have at least one test`,                   ko: ()  => `주요 hub 파일 모두 테스트로 보호됨` },
  'preflight.hub_tests.warn':      { en: (n) => `${n} hub file(s) (mass≥10) have no tests`,               ko: (n) => `테스트 없는 hub ${n}개` },
  'preflight.hub_tests.detail':    { en: ()  => `Regression risk after deploy.`,                          ko: ()  => `mass≥10 파일인데 테스트 없음. 배포 후 회귀 위험.` },
  'preflight.orphans.ok':          { en: (p) => `Orphan ratio ${p}% — normal range`,                      ko: (p) => `고립 파일 ${p}% — 정상 범위` },
  'preflight.orphans.warn':        { en: (p, n, tot) => `Orphan ratio ${p}% (${n}/${tot})`,               ko: (p, n, tot) => `고립 파일 비율 ${p}% (${n}/${tot})` },
  'preflight.orphans.detail':      { en: ()  => `>30%. Likely dead code — run \`cs legacy\` to clean.`,   ko: ()  => `30% 초과. 죽은 코드 가능성 — \`cs legacy\` 로 정리.` },
  'preflight.dynamic.info':        { en: (p) => `Dynamic import ratio ${p}%`,                             ko: (p) => `동적 import 비중 ${p}%` },
  'preflight.dynamic.detail':      { en: ()  => `Static analysis is partial here. Caveat for blast/bundle results.`, ko: () => `정적 분석 불완전. blast/bundle 결과에 caveat 있음.` },
  'preflight.env_unused.info':     { en: (n) => `${n} declared env var(s) never used in code`,            ko: (n) => `사용 안 되는 env 변수 ${n}개` },
  'preflight.env_unused.detail':   { en: ()  => `Cleanup candidates. Old keys still in .env are a leak surface.`, ko: () => `.env* 정리 후보. 옛 키 노출 가능.` },
}

function t(key, locale, ...args) {
  const e = I18N[key]
  if (!e) return key
  const fn = e[locale === 'ko' ? 'ko' : 'en']
  return fn(...args)
}

// Localized strings for buildSuggestions. Larger surface than I18N so
// kept as a separate nested table for readability.
const SUGGEST_STRINGS = {
  en: {
    undeclared: {
      title:  (n) => `${n} undeclared env var(s)`,
      why:    ()  => `Code reads them but no .env* declares them — will be undefined at runtime.`,
      advice: (s) => `Ask the AI: "Add placeholders for these to .env.example — ${s}"`,
    },
    hub_no_tests: {
      title:  (n) => `${n} hub file(s) without tests`,
      why:    ()  => `Lots of files import these, but no test covers them. AI edits can silently break downstream.`,
      advice: (id, m) => `Ask the AI: "Write a unit test for ${id} — ${m} files import it."`,
    },
    orphans: {
      title:  (n) => `${n} orphan files (likely dead code)`,
      why:    ()  => `Imported by nothing, importing nothing. Often abandoned experiments / unused components.`,
      advice: (id) => `Ask the AI: "Are ${id} and friends actually used anywhere? Remove them if not." (\`cs legacy\` for the full audit)`,
    },
    unused_env: {
      title:  (n) => `${n} unused env var(s)`,
      why:    ()  => `Declared in .env* but no code reads them. Stale keys / leftover surface.`,
      advice: (s) => `Ask the AI: "Remove or confirm usage of these env vars — ${s}"`,
    },
    vendors: {
      title:  (n) => `${n} third-party folder(s) in graph`,
      why:    (s) => `${s} etc. look vendored. They pollute hub / orphan / env results.`,
      advice: (lines) => `Add to .codesynaptignore (one per line, trailing /):\n  ${lines}`,
    },
    dynamic: {
      title:  (p) => `Dynamic import ratio ${p}%`,
      why:    ()  => `Static analysis misses some dependency edges. blast / bundle results have caveats here.`,
      advice: (id) => `Ask the AI: "Can we convert ${id || 'the dynamic imports'} to static imports?"`,
    },
  },
  ko: {
    undeclared: {
      title:  (n) => `미선언 환경 변수 ${n}개`,
      why:    ()  => `코드는 사용하는데 .env*에 정의 안 됨. 배포시 undefined로 동작하거나 실패.`,
      advice: (s) => `AI에게: ".env.example에 다음 변수들의 placeholder 추가해줘 — ${s}"`,
    },
    hub_no_tests: {
      title:  (n) => `테스트 없는 허브 파일 ${n}개`,
      why:    ()  => `많은 파일이 import하는 핵심인데 테스트로 보호 안 됨. AI 수정시 다른 곳 깨질 위험.`,
      advice: (id, m) => `AI에게: "${id} 에 대한 unit test 작성해줘 — ${m}개 파일이 이걸 import함"`,
    },
    orphans: {
      title:  (n) => `고립 파일 ${n}개 (의심 죽은 코드)`,
      why:    ()  => `아무도 import하지 않고, 아무것도 import하지 않음. 보통 옛 실험/사용 안 되는 컴포넌트.`,
      advice: (id) => `AI에게: "${id} 등 다음 파일들이 실제 쓰이는지 확인하고 죽은 코드면 제거해줘"  (\`cs legacy\` 로 자세히)`,
    },
    unused_env: {
      title:  (n) => `사용 안 되는 환경 변수 ${n}개`,
      why:    ()  => `.env*에 있지만 코드에서 아무도 안 씀. 옛 키 노출 위험 + 정리 후보.`,
      advice: (s) => `AI에게: ".env에서 다음 변수들 제거 또는 사용처 확인해줘 — ${s}"`,
    },
    vendors: {
      title:  (n) => `Third-party 폴더 ${n}개 graph에 포함됨`,
      why:    (s) => `${s} 등이 vendored 코드로 보임. graph 분석/hub/orphan 결과가 오염될 수 있음.`,
      advice: (lines) => `.codesynaptignore에 추가 (한 줄씩, 끝에 /):\n  ${lines}`,
    },
    dynamic: {
      title:  (p) => `동적 import 패턴 비중 ${p}%`,
      why:    ()  => `정적 분석으로 의존성 추적이 어려움. blast/bundle 결과가 일부 누락됨.`,
      advice: (id) => `AI에게: "${id || '동적 import 사용처'} 등 정적 import로 가능한지 검토"`,
    },
  },
}

function createControlServer(opts) {
  const {
    scanner,                 // Scanner instance
    getCurrentRoot,          // () => absolute path of scanned root
    onBlast,                 // optional (payload) => void  IPC: highlight blast
    onFocus,                 // optional (id) => void        IPC: focus node
    onOpen,                  // optional (id) => void        IPC: open in editor
    authToken,               // optional string. If set, require `Authorization: Bearer <token>` on every request.
    auditLogDir,             // optional absolute path. If set, every request is appended to <dir>/YYYY-MM-DD.jsonl
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
  // Lazy SHA-256 of file content. Used for fresh-data verification
  // (AI compares its own Read result hash against this; match = fresh).
  // Cached on the file object so repeated calls are O(1).
  function fileContentHash(f) {
    if (!f || !f.absPath) return null
    if (f._cachedHash && f._cachedHashAt === f.lastSeenAt) return f._cachedHash
    try {
      const buf = fs.readFileSync(f.absPath)
      const h = crypto.createHash('sha256').update(buf).digest('hex')
      f._cachedHash = h
      f._cachedHashAt = f.lastSeenAt
      return h
    } catch { return null }
  }

  function findNode(id) {
    const f = scanner.files.get(id)
    if (!f) return null
    return {
      id: f.id, ext: f.ext, loc: f.loc, size: f.size,
      importCount: f.imports.length,
      hasDynamicResolution: (f.dynamicPatterns || []).length > 0,
      dynamicPatterns: f.dynamicPatterns || [],
      confidence: f.confidence || 'high',
      contentHash: fileContentHash(f),
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
    // Confidence distribution — graph completeness signal per file.
    const conf = { high: 0, medium: 0, low: 0 }
    for (const f of files) {
      const c = f.confidence || 'high'
      if (conf[c] != null) conf[c]++
      else conf.high++
    }
    return {
      root: getCurrentRoot(),
      fileCount: files.length,
      edgeCount: scanner.edges.length,
      extMix, topFolders, topHubs,
      orphanCount,
      dynamicPatternFileCount: dynamicCount,
      confidence: conf,
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

  // Token-compact view of a blast result for AI agents: keep every scalar
  // summary (counts, tokenEstimate, categories) but cap the per-hop id lists
  // and the file sample so a large blast doesn't cost tens of thousands of
  // tokens. The full lists remain available via `?compact` off / `full=1`.
  function compactBlast(r, perHop = 25) {
    return {
      seed: r.seed, direction: r.direction, depth: r.depth,
      totalFiles: r.totalFiles, totalLoc: r.totalLoc, totalSize: r.totalSize,
      tokenEstimate: r.tokenEstimate, categories: r.categories,
      topFiles: r.files.slice(0, perHop).map((f) => f.id),
      byDepth: r.byDepth.map((d) => ({
        depth: d.depth,
        count: d.ids.length,
        ids: d.ids.slice(0, perHop),
        truncated: Math.max(0, d.ids.length - perHop),
      })),
      compact: true,
      note: r.totalFiles > perHop
        ? `compact view: ${r.totalFiles} files total, showing top ${perHop}/hop. Re-query with full=1 for complete lists.`
        : undefined,
    }
  }

  // ── Secret leak: server-only env in client code ───────────────
  // Detect env vars used in frontend files that don't carry a
  // framework "public" prefix — these will be bundled and shipped to
  // the browser, leaking secrets.
  const PUBLIC_PREFIX_RE = /^(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|STORYBOOK)_/
  function buildSecretLeak() {
    const leaks = []
    for (const f of scanner.files.values()) {
      const usage = f.envUsage || []
      if (usage.length === 0) continue
      const cls = classifyFile(f)
      if (cls !== 'frontend') continue
      // Skip CSS/HTML — they can't read process.env at runtime anyway
      if (/\.(?:css|scss|sass|less|html|htm)$/i.test(f.id)) continue
      for (const v of usage) {
        if (PUBLIC_PREFIX_RE.test(v)) continue   // explicitly public — OK
        leaks.push({ var: v, file: f.id })
      }
    }
    // Aggregate by var
    const byVar = new Map()
    for (const l of leaks) {
      if (!byVar.has(l.var)) byVar.set(l.var, [])
      byVar.get(l.var).push(l.file)
    }
    const items = [...byVar.entries()].map(([v, files]) => ({ var: v, files })).sort((a, b) => a.var.localeCompare(b.var))
    return {
      leakCount: leaks.length,
      varCount: items.length,
      vars: items,
    }
  }

  // ── Frontend URL ↔ file mapping ───────────────────────────────
  // File-system based routing for Next.js (app + pages), Astro, SvelteKit.
  // Converts file id → URL path; resolveUrl(input) finds best match.
  function idToRoute(id) {
    let m, url = null, kind = null
    // Next.js app router: src/app/<seg>/page.<ext>
    if ((m = id.match(/^(?:src\/)?app\/(.+)\/page\.(?:tsx|jsx|ts|js|mdx)$/))) {
      url = '/' + m[1]; kind = 'next-app'
    }
    // Next.js app router root: src/app/page.<ext>
    else if (/^(?:src\/)?app\/page\.(?:tsx|jsx|ts|js|mdx)$/.test(id)) {
      url = '/'; kind = 'next-app'
    }
    // Next.js pages router: src/pages/<seg>.<ext>  (skip _app, _document, api/)
    else if ((m = id.match(/^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/))) {
      const seg = m[1]
      if (seg === '_app' || seg === '_document' || seg.startsWith('api/')) return null
      url = '/' + seg.replace(/\/index$/, '').replace(/^index$/, ''); kind = 'next-pages'
      if (url === '') url = '/'
    }
    // Astro: src/pages/<seg>.{astro,md,mdx}
    else if ((m = id.match(/^(?:src\/)?pages\/(.+)\.(?:astro|md|mdx)$/))) {
      url = '/' + m[1].replace(/\/index$/, '').replace(/^index$/, '')
      if (url === '') url = '/'
      kind = 'astro'
    }
    // SvelteKit: src/routes/<seg>/+page.<ext>  or  src/routes/+page.<ext>
    else if ((m = id.match(/^(?:src\/)?routes\/(.+)\/\+page\.(?:svelte|js|ts)$/))) {
      url = '/' + m[1]; kind = 'sveltekit'
    }
    else if (/^(?:src\/)?routes\/\+page\.(?:svelte|js|ts)$/.test(id)) {
      url = '/'; kind = 'sveltekit'
    }
    if (!url) return null
    // Normalize: strip Next.js route groups `(name)/`
    url = url.replace(/\/\([^)]+\)\//g, '/').replace(/^\/\([^)]+\)/, '').replace(/\/\([^)]+\)$/, '')
    // Dynamic segments: [...slug] → *, [slug] → :slug
    url = url.replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1')
    if (url === '') url = '/'
    return { id, url, kind }
  }
  function buildAllRoutes() {
    const routes = []
    for (const f of scanner.files.values()) {
      const r = idToRoute(f.id)
      if (r) routes.push(r)
    }
    // Sort: static segments before dynamic
    const staticness = (u) => -((u.match(/:|\*/g) || []).length)
    routes.sort((a, b) => staticness(b.url) - staticness(a.url) || a.url.localeCompare(b.url))
    return routes
  }
  function matchUrl(input) {
    if (!input) return []
    let q = input.startsWith('/') ? input : '/' + input
    q = q.replace(/\?.*$/, '').replace(/#.*$/, '')  // strip query/hash
    if (q.length > 1) q = q.replace(/\/$/, '')
    const all = buildAllRoutes()
    const inSegs = q === '/' ? [''] : q.slice(1).split('/')
    const matches = []
    for (const r of all) {
      const rPath = r.url === '/' ? '/' : r.url.replace(/\/$/, '')
      const rSegs = rPath === '/' ? [''] : rPath.slice(1).split('/')
      // Exact length match unless route has catchall *
      const hasCatchall = rSegs[rSegs.length - 1] === '*'
      if (!hasCatchall && rSegs.length !== inSegs.length) continue
      if (hasCatchall && rSegs.length > inSegs.length) continue
      let ok = true, dynamicCount = 0
      for (let i = 0; i < rSegs.length; i++) {
        const rs = rSegs[i], is = inSegs[i] ?? ''
        if (rs === '*') { dynamicCount++; break }
        if (rs.startsWith(':')) { dynamicCount++; continue }
        if (rs !== is) { ok = false; break }
      }
      if (ok) matches.push({ ...r, dynamicCount })
    }
    // Best match = fewest dynamic segments
    matches.sort((a, b) => a.dynamicCount - b.dynamicCount)
    return matches
  }
  function buildUrlIndex(input) {
    if (input) {
      const matches = matchUrl(input)
      return { query: input, matches, count: matches.length }
    }
    const all = buildAllRoutes()
    const byKind = {}
    for (const r of all) byKind[r.kind] = (byKind[r.kind] || 0) + 1
    return { total: all.length, byKind, routes: all }
  }

  // ── DB schema index ───────────────────────────────────────────
  // Aggregates models extracted from Prisma / Drizzle / SQLAlchemy
  // across the whole repo and indexes them by name.
  function buildSchemas(filter) {
    const all = []  // { kind, name, tableName, fields, definedIn }
    for (const f of scanner.files.values()) {
      for (const m of (f.dbModels || [])) {
        all.push({ ...m, definedIn: f.id })
      }
    }
    if (filter) {
      // Detail view for one model: full definition + usage in code.
      const matches = all.filter((m) => m.name === filter || m.tableName === filter)
      if (matches.length === 0) return null
      // Heuristic usage: identifier substring grep on tracked files.
      // Skip the schema file itself.
      const usedIn = []
      const re = new RegExp('\\b' + filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
      for (const f of scanner.files.values()) {
        if (matches.some((m) => m.definedIn === f.id)) continue
        // Cheap content re-read for usage detection. Models are queried
        // rarely so this is acceptable.
        try {
          const fs = require('fs')
          const content = fs.readFileSync(f.absPath, 'utf8')
          if (re.test(content)) usedIn.push(f.id)
        } catch {}
        if (usedIn.length >= 200) break
      }
      return { model: filter, definitions: matches, usedIn, usedCount: usedIn.length }
    }
    // Overview
    const byKind = {}
    for (const m of all) byKind[m.kind] = (byKind[m.kind] || 0) + 1
    const byFile = new Map()
    for (const m of all) {
      const arr = byFile.get(m.definedIn) || []
      arr.push({ kind: m.kind, name: m.name, tableName: m.tableName, fieldCount: m.fields.length })
      byFile.set(m.definedIn, arr)
    }
    return {
      total: all.length,
      byKind,
      files: [...byFile.entries()].map(([file, models]) => ({ file, models })),
      models: all.map((m) => ({
        kind: m.kind, name: m.name, tableName: m.tableName,
        fieldCount: m.fields.length, definedIn: m.definedIn,
      })),
    }
  }

  // ── Preflight: deploy-readiness check ─────────────────────────
  // Aggregates existing signals into a single go/no-go for non-devs.
  // Each item has status: 'fail' | 'warn' | 'info' | 'ok'.
  // Overall: 'fail' if any fail; 'warn' if any warn but no fail; else 'ok'.
  function buildPreflight(opts = {}) {
    const checks = []
    const env = buildEnv()
    const files = [...scanner.files.values()]
    const ext = getExternalUrls()
    const loc = opts.locale === 'ko' ? 'ko' : 'en'

    // 1. Undeclared env vars → FAIL
    const undeclared = env.vars.filter((v) => v.status === 'undeclared')
    checks.push(undeclared.length === 0 ? {
      key: 'env-undeclared', status: 'ok',
      title: t('preflight.env_undeclared.ok', loc),
    } : {
      key: 'env-undeclared', status: 'fail',
      title:  t('preflight.env_undeclared.fail',   loc, undeclared.length),
      detail: t('preflight.env_undeclared.detail', loc),
      evidence: undeclared.slice(0, 10).map((v) => v.var),
    })

    // 1.5. Secret leak — server-only env in frontend code → FAIL
    const leaks = buildSecretLeak()
    checks.push(leaks.varCount === 0 ? {
      key: 'secret-leak', status: 'ok',
      title: t('preflight.secret_leak.ok', loc),
    } : {
      key: 'secret-leak', status: 'fail',
      title:  t('preflight.secret_leak.fail',   loc, leaks.varCount),
      detail: t('preflight.secret_leak.detail', loc),
      evidence: leaks.vars.slice(0, 10).map((v) => ({ var: v.var, sample: v.files[0] })),
    })

    // 2. Plain http:// external URLs → FAIL (security)
    const httpUrls = []
    for (const d of ext.domains) {
      if (d.proto === 'http') {
        for (const c of d.callers.slice(0, 5)) httpUrls.push({ url: c.url, file: c.file })
      }
    }
    checks.push(httpUrls.length === 0 ? {
      key: 'http-urls', status: 'ok',
      title: t('preflight.http_urls.ok', loc),
    } : {
      key: 'http-urls', status: 'fail',
      title:  t('preflight.http_urls.fail',   loc, httpUrls.length),
      detail: t('preflight.http_urls.detail', loc),
      evidence: httpUrls.slice(0, 10),
    })

    // 3. Hubs without tests → WARN
    const incoming = new Map()
    for (const e of scanner.edges) incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    const hubs = files
      .map((f) => ({ ...f, mass: incoming.get(f.id) || 0 }))
      .filter((f) => f.mass >= 10)
    const testCovered = (id) => {
      const users = scanner.edges.filter((e) => e.t === id)
      return users.some((e) => /(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$/i.test(e.s))
    }
    const uncoveredHubs = hubs.filter((h) => !testCovered(h.id))
    checks.push(uncoveredHubs.length === 0 ? {
      key: 'hub-tests', status: 'ok',
      title: t('preflight.hub_tests.ok', loc),
    } : {
      key: 'hub-tests', status: 'warn',
      title:  t('preflight.hub_tests.warn',   loc, uncoveredHubs.length),
      detail: t('preflight.hub_tests.detail', loc),
      evidence: uncoveredHubs.slice(0, 5).map((h) => ({ id: h.id, mass: h.mass })),
    })

    // 4. Orphan ratio > 30% → WARN
    const outgoing = new Map()
    for (const e of scanner.edges) outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
    const orphans = files.filter((f) =>
      (incoming.get(f.id) || 0) === 0 &&
      (outgoing.get(f.id) || 0) === 0 &&
      !/\.(?:md|mdx|rst|json|ya?ml|toml|html?|css|scss|sass|less)$/i.test(f.id)
    )
    const orphanRatio = files.length ? orphans.length / files.length : 0
    const orphanPct = Math.round(orphanRatio * 100)
    checks.push(orphanRatio < 0.3 ? {
      key: 'orphans', status: 'ok',
      title: t('preflight.orphans.ok', loc, orphanPct),
    } : {
      key: 'orphans', status: 'warn',
      title:  t('preflight.orphans.warn',   loc, orphanPct, orphans.length, files.length),
      detail: t('preflight.orphans.detail', loc),
    })

    // 5. Dynamic import ratio > 10% → INFO
    const dynamicFiles = files.filter((f) => (f.dynamicPatterns || []).length > 0)
    const dynRatio = files.length ? dynamicFiles.length / files.length : 0
    if (dynRatio > 0.1) {
      checks.push({
        key: 'dynamic', status: 'info',
        title:  t('preflight.dynamic.info',   loc, Math.round(dynRatio * 100)),
        detail: t('preflight.dynamic.detail', loc),
      })
    }

    // 6. Unused env → INFO
    const unused = env.vars.filter((v) => v.status === 'unused')
    if (unused.length > 0) {
      checks.push({
        key: 'env-unused', status: 'info',
        title:  t('preflight.env_unused.info',   loc, unused.length),
        detail: t('preflight.env_unused.detail', loc),
        evidence: unused.slice(0, 10).map((v) => v.var),
      })
    }

    const failCount = checks.filter((c) => c.status === 'fail').length
    const warnCount = checks.filter((c) => c.status === 'warn').length
    const infoCount = checks.filter((c) => c.status === 'info').length
    const okCount   = checks.filter((c) => c.status === 'ok').length
    let overall
    if (failCount > 0)      overall = 'fail'
    else if (warnCount > 0) overall = 'warn'
    else                    overall = 'ok'
    return { overall, counts: { fail: failCount, warn: warnCount, info: infoCount, ok: okCount }, checks }
  }

  // ── Feature → files clustering ────────────────────────────────
  // Heuristic mapping from a feature keyword ("payment", "auth", …) to
  // related source files, bucketed into frontend / backend / shared.
  // Matching: id substring OR route path substring (case-insensitive).
  // Classification: id-path patterns first (most reliable), then ext.
  function classifyFile(f) {
    const id = f.id.toLowerCase()
    // Explicit backend paths (Next.js api routes, Express, Rails, etc.)
    if (/^(?:src\/)?(?:app\/api|api|server|backend|routes|controllers|handlers)(?:\/|$)/.test(id)) return 'backend'
    // Explicit frontend paths
    if (/^(?:src\/)?(?:app|pages|components|ui|screens|views|widgets|public|styles)(?:\/|$)/.test(id)) {
      // Inside src/app/api/ etc was already caught above
      return 'frontend'
    }
    // Ext fallback
    if (/\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html|htm)$/i.test(f.id)) return 'frontend'
    if (/\.(?:py|pyi|rb|php|go|java|kt|rs|cs|swift)$/i.test(f.id)) return 'backend'
    return 'shared'
  }
  function buildFeature(keyword) {
    if (!keyword || typeof keyword !== 'string') return null
    const needle = keyword.toLowerCase()
    const matched = []
    for (const f of scanner.files.values()) {
      const idMatch = f.id.toLowerCase().includes(needle)
      let routeMatch = false
      if (!idMatch && f.routes) {
        for (const r of f.routes) {
          if ((r.path || '').toLowerCase().includes(needle)) { routeMatch = true; break }
        }
      }
      let apiMatch = false
      if (!idMatch && !routeMatch && f.apiCalls) {
        for (const c of f.apiCalls) {
          if ((c.url || '').toLowerCase().includes(needle)) { apiMatch = true; break }
        }
      }
      if (idMatch || routeMatch || apiMatch) {
        matched.push({
          id: f.id,
          ext: f.ext,
          via: idMatch ? 'path' : routeMatch ? 'route' : 'api-call',
        })
      }
    }
    const buckets = { frontend: [], backend: [], shared: [] }
    for (const m of matched) {
      const f = scanner.files.get(m.id)
      const c = classifyFile(f)
      buckets[c].push(m)
    }
    for (const b of Object.values(buckets)) b.sort((a, b) => a.id.localeCompare(b.id))
    return {
      keyword,
      total: matched.length,
      counts: {
        frontend: buckets.frontend.length,
        backend: buckets.backend.length,
        shared: buckets.shared.length,
      },
      frontend: buckets.frontend,
      backend: buckets.backend,
      shared: buckets.shared,
    }
  }

  // ── Next-best-action suggestions ──────────────────────────────
  // Rule-based recommendations for what to ask the AI next. Each
  // suggestion includes a priority (high|medium|low), a one-line title,
  // a reason (why it matters), an advice (what to ask the AI), and
  // concrete evidence (file ids, var names, counts).
  function buildSuggestions(topN = 10, opts = {}) {
    const suggestions = []
    const sum = buildSummaryCached()
    const env = buildEnv()
    const files = [...scanner.files.values()]
    const loc = opts.locale === 'ko' ? 'ko' : 'en'
    const sg = SUGGEST_STRINGS[loc]

    // 1. Undeclared env vars — code reads them but no .env declares them.
    //    Almost always means deploy will fail or read undefined.
    const undeclared = env.vars.filter((v) => v.status === 'undeclared')
    if (undeclared.length > 0) {
      const sample = undeclared.slice(0, 5).map((v) => v.var).join(', ') + (undeclared.length > 5 ? ' …' : '')
      suggestions.push({
        priority: 'high',
        title:   sg.undeclared.title(undeclared.length),
        why:     sg.undeclared.why(),
        advice:  sg.undeclared.advice(sample),
        evidence: { count: undeclared.length, vars: undeclared.slice(0, 10).map((v) => v.var) },
      })
    }

    // 2. Hubs without tests — files many things import, but no test covers.
    //    Risk: AI edit breaks downstream silently.
    const incoming = new Map()
    for (const e of scanner.edges) incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    const hubs = files
      .map((f) => ({ ...f, mass: incoming.get(f.id) || 0 }))
      .filter((f) => f.mass >= 10)
      .sort((a, b) => b.mass - a.mass)
    const testCovered = (id) => {
      // crude: any file that imports id AND looks like a test
      const users = scanner.edges.filter((e) => e.t === id)
      return users.some((e) => /(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec)\.[a-z]+$/i.test(e.s))
    }
    const uncoveredHubs = hubs.filter((h) => !testCovered(h.id))
    if (uncoveredHubs.length > 0) {
      const worst = uncoveredHubs.slice(0, 3)
      suggestions.push({
        priority: 'high',
        title:   sg.hub_no_tests.title(uncoveredHubs.length),
        why:     sg.hub_no_tests.why(),
        advice:  sg.hub_no_tests.advice(worst[0].id, worst[0].mass),
        evidence: { count: uncoveredHubs.length, top: worst.map((h) => ({ id: h.id, mass: h.mass })) },
      })
    }

    // 3. Orphans — files imported by nothing AND import nothing. Dead code.
    const outgoing = new Map()
    for (const e of scanner.edges) outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
    const orphans = files.filter((f) =>
      (incoming.get(f.id) || 0) === 0 &&
      (outgoing.get(f.id) || 0) === 0 &&
      !/(?:^|\/)(?:__tests__|test|tests|spec|e2e)\/|\.(?:test|spec|d)\.[a-z]+$/i.test(f.id) &&
      !/\.(md|mdx|rst|json|ya?ml|toml|html?|css|scss|sass|less)$/i.test(f.id)
    )
    if (orphans.length >= 10) {
      suggestions.push({
        priority: 'medium',
        title:   sg.orphans.title(orphans.length),
        why:     sg.orphans.why(),
        advice:  sg.orphans.advice(orphans[0].id),
        evidence: { count: orphans.length, sample: orphans.slice(0, 5).map((f) => f.id) },
      })
    }

    // 4. Unused env vars — declared in .env* but no code reads them.
    //    Could be: legacy leftover, OR a secret left in .env that's not
    //    rotated. Either way, candidate for cleanup.
    const unused = env.vars.filter((v) => v.status === 'unused')
    if (unused.length > 0) {
      const sample = unused.slice(0, 5).map((v) => v.var).join(', ') + (unused.length > 5 ? ' …' : '')
      suggestions.push({
        priority: 'medium',
        title:   sg.unused_env.title(unused.length),
        why:     sg.unused_env.why(),
        advice:  sg.unused_env.advice(sample),
        evidence: { count: unused.length, vars: unused.slice(0, 10).map((v) => v.var) },
      })
    }

    // 4.5. Vendor folders not ignored — graph quality signal.
    //      If a project has third-party folders not in .codesynaptignore,
    //      hubs/orphans/env results get polluted by vendored code.
    const vendors = scanner.vendorCandidates || []
    const highConfVendors = vendors.filter((v) => v.confidence >= 0.5)
    if (highConfVendors.length > 0) {
      const sample = highConfVendors.map((v) => v.path).slice(0, 3).join(', ')
      const lines  = highConfVendors.slice(0, 5).map((v) => v.path + '/').join('\n  ')
      suggestions.push({
        priority: 'medium',
        title:   sg.vendors.title(highConfVendors.length),
        why:     sg.vendors.why(sample),
        advice:  sg.vendors.advice(lines),
        evidence: { count: highConfVendors.length, top: highConfVendors.slice(0, 5) },
      })
    }

    // 5. Dynamic-pattern share — graph completeness signal.
    //    >10% of files using dynamic import means AI/blast suggestions
    //    are less reliable here; either refactor or accept caveat.
    const dynamicFiles = files.filter((f) => (f.dynamicPatterns || []).length > 0)
    const dynRatio = files.length ? dynamicFiles.length / files.length : 0
    if (dynRatio > 0.1) {
      suggestions.push({
        priority: 'low',
        title:   sg.dynamic.title(Math.round(dynRatio * 100)),
        why:     sg.dynamic.why(),
        advice:  sg.dynamic.advice(dynamicFiles[0]?.id),
        evidence: { count: dynamicFiles.length, ratio: dynRatio.toFixed(3), sample: dynamicFiles.slice(0, 5).map((f) => f.id) },
      })
    }

    // Sort by priority then take top N
    const order = { high: 0, medium: 1, low: 2 }
    suggestions.sort((a, b) => order[a.priority] - order[b.priority])
    return {
      suggestions: suggestions.slice(0, topN),
      total: suggestions.length,
      contextSnapshot: {
        fileCount: sum.fileCount,
        edgeCount: sum.edgeCount,
        orphanCount: sum.orphanCount,
        envVarStatus: env.counts,
      },
    }
  }

  // ── Vendor candidates (third-party auto-detect) ──────────────
  function buildVendors() {
    return {
      candidates: scanner.vendorCandidates || [],
      count: (scanner.vendorCandidates || []).length,
      tip: 'Copy paths into .codesynaptignore (one per line, trailing /) to hide from the graph.',
    }
  }

  // ── Env var index ─────────────────────────────────────────────
  // Cross-reference vars declared in .env files vs vars actually used
  // in source code. Catches:
  //   - declared-but-unused (dead config, possible secret leak)
  //   - used-but-undeclared (missing from .env.example → deploy will fail)
  function buildEnv(filter) {
    const declared = new Map()  // var -> [envFile.id]
    for (const env of (scanner.envFiles || [])) {
      for (const k of env.keys) {
        if (!declared.has(k)) declared.set(k, [])
        declared.get(k).push(env.id)
      }
    }
    const used = new Map()      // var -> [code file.id]
    for (const f of scanner.files.values()) {
      const usage = f.envUsage || []
      for (const v of usage) {
        if (!used.has(v)) used.set(v, [])
        used.get(v).push(f.id)
      }
    }
    // Optional: focus on one var
    if (filter) {
      return {
        var: filter,
        declaredIn: declared.get(filter) || [],
        usedIn:     used.get(filter) || [],
      }
    }
    const allVars = new Set([...declared.keys(), ...used.keys()])
    const items = []
    for (const v of allVars) {
      const d = declared.get(v) || []
      const u = used.get(v) || []
      items.push({
        var: v,
        declaredIn: d,
        usedIn: u,
        status: d.length === 0 ? 'undeclared'
              : u.length === 0 ? 'unused'
              : 'ok',
      })
    }
    items.sort((a, b) => a.var.localeCompare(b.var))
    return {
      envFiles: (scanner.envFiles || []).map((e) => ({ id: e.id, keyCount: e.keys.length })),
      vars: items,
      counts: {
        total: items.length,
        ok: items.filter((x) => x.status === 'ok').length,
        unused: items.filter((x) => x.status === 'unused').length,
        undeclared: items.filter((x) => x.status === 'undeclared').length,
      },
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
    const loc = opts.locale === 'ko' ? 'ko' : 'en'

    const reasons = []
    let level = 'safe'
    if (dependents > 30) {
      level = 'risky'
      reasons.push(t('safety.reason.risky_hub', loc, dependents))
    }
    if (routeCount > 0) {
      if (level === 'safe') level = 'caution'
      reasons.push(t('safety.reason.routes', loc, routeCount))
    }
    if (externalUrlCount > 0) {
      if (level === 'safe') level = 'caution'
      reasons.push(t('safety.reason.external_api', loc, externalUrlCount))
    }
    if (apiCallCount > 0 && level === 'safe') {
      level = 'caution'
      reasons.push(t('safety.reason.http_client', loc, apiCallCount))
    }
    if (dynamic) {
      if (level === 'safe') level = 'caution'
      reasons.push(t('safety.reason.dynamic', loc))
    }
    if (dependents > 5 && dependents <= 30 && level === 'safe') {
      level = 'caution'
      reasons.push(t('safety.reason.dependents', loc, dependents))
    }
    if (level === 'safe') {
      reasons.push(t('safety.reason.safe', loc, dependents))
    }

    let advice
    if (level === 'risky')        advice = t('safety.advice.risky', loc, id)
    else if (level === 'caution') advice = t('safety.advice.caution', loc, id)
    else                          advice = t('safety.advice.safe', loc, id)

    if (testsInBlast === 0 && dependents > 0 && level !== 'safe') {
      reasons.push(t('safety.reason.no_tests', loc))
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

  // ── Audit log ─────────────────────────────────────────────────
  // Append every request line to ~/.codesynapt/audit/YYYY-MM-DD.jsonl
  // (or whatever auditLogDir was passed). Failure to write must not
  // block the response — wrap in try/catch.
  function auditWrite(entry) {
    if (!auditLogDir) return
    try {
      const day = new Date().toISOString().slice(0, 10)
      const file = path.join(auditLogDir, `${day}.jsonl`)
      fs.mkdirSync(auditLogDir, { recursive: true })
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    } catch { /* silent */ }
  }

  // ── Main router ───────────────────────────────────────────────
  function handleControlRequest(req, res) {
    const startTs = Date.now()
    // ─── DNS-rebinding defense: validate Host header ──────────
    // Browsers can be tricked into resolving attacker.com → 127.0.0.1
    // and firing requests at our localhost port. Rejecting Host headers
    // that aren't loopback closes this attack class.
    const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase()
    if (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost' && hostHeader !== '[::1]') {
      writeJson(res, 403, { error: 'forbidden host: ' + hostHeader })
      return
    }
    // Audit on response finish (status code captured by then)
    if (auditLogDir) {
      res.on('finish', () => {
        auditWrite({
          ts: startTs,
          durMs: Date.now() - startTs,
          method: req.method,
          path: req.url,
          status: res.statusCode,
          principal: req._principal || 'anonymous',
        })
      })
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        // CORS is intentionally restrictive — only same-origin loopback.
        // CLI/MCP don't use CORS (no Origin header), so they're unaffected.
        'Access-Control-Allow-Origin': 'null',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      return res.end()
    }
    // Bearer token validation (only if authToken is configured)
    if (authToken) {
      const hdr = req.headers.authorization || ''
      if (!hdr.startsWith('Bearer ') || hdr.slice(7) !== authToken) {
        req._principal = 'invalid'
        return writeJson(res, 401, { error: 'unauthorized — Authorization: Bearer <token> required' })
      }
      req._principal = 'authenticated'
    }
    const url = new URL(req.url, `http://${req.headers.host}`)
    const parts = url.pathname.split('/').filter(Boolean)
    const [seg0, ...rest] = parts
    const idFromRest = () => decodeURIComponent(rest.join('/'))

    try {
      if (req.method === 'GET' && parts.length === 0) {
        return writeJson(res, 200, {
          name: 'codesynapt',
          mode: 'headless',
          endpoints: [
            'GET /health', 'GET /summary', 'GET /graph', 'GET /node/:id',
            'GET /file/:id', 'GET /deps/:id', 'GET /users/:id', 'GET /find?q=',
            'GET /external', 'GET /blast/:id', 'GET /packages',
            'GET /package/:name', 'GET /package-graph',
            'GET /safety/:id', 'GET /bundle/:id', 'GET /env [/?var=NAME]',
            'GET /suggest [?top=N]', 'GET /feature/:keyword', 'GET /preflight',
            'GET /schema [?model=Name]', 'GET /url [?path=/...]', 'GET /secrets',
            'GET /vendors',
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
          const buf = fs.readFileSync(full)
          const contentHash = crypto.createHash('sha256').update(buf).digest('hex')
          return writeJson(res, 200, {
            id, content: buf.toString('utf8'),
            contentHash,
            size: stat.size,
          })
        } catch (e) {
          // Missing path is a client error (bad id), not a server fault.
          if (e.code === 'ENOENT') return writeJson(res, 404, { error: 'not found', id })
          return writeJson(res, 500, { error: e.message })
        }
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
      if (req.method === 'GET' && seg0 === 'env' && rest.length === 0) {
        const v = url.searchParams.get('var')
        return writeJson(res, 200, withMeta(buildEnv(v)))
      }
      if (req.method === 'GET' && seg0 === 'secrets' && rest.length === 0) {
        return writeJson(res, 200, withMeta(buildSecretLeak()))
      }
      if (req.method === 'GET' && seg0 === 'vendors' && rest.length === 0) {
        return writeJson(res, 200, withMeta(buildVendors()))
      }
      if (req.method === 'GET' && seg0 === 'url' && rest.length === 0) {
        const p = url.searchParams.get('path')
        return writeJson(res, 200, withMeta(buildUrlIndex(p)))
      }
      if (req.method === 'GET' && seg0 === 'schema' && rest.length === 0) {
        const model = url.searchParams.get('model')
        const r = buildSchemas(model)
        if (model && !r) return writeJson(res, 404, { error: 'model not found', model })
        return writeJson(res, 200, withMeta(r))
      }
      if (req.method === 'GET' && seg0 === 'preflight' && rest.length === 0) {
        const locale = url.searchParams.get('locale')
        return writeJson(res, 200, withMeta(buildPreflight({ locale })))
      }
      if (req.method === 'GET' && seg0 === 'feature' && rest.length > 0) {
        const r = buildFeature(idFromRest())
        if (!r) return writeJson(res, 400, { error: 'usage: GET /feature/<keyword>' })
        return writeJson(res, 200, withMeta(r))
      }
      if (req.method === 'GET' && seg0 === 'suggest' && rest.length === 0) {
        const top = parseInt(url.searchParams.get('top') || '10', 10)
        const locale = url.searchParams.get('locale')
        return writeJson(res, 200, withMeta(buildSuggestions(top, { locale })))
      }
      if (req.method === 'GET' && seg0 === 'safety' && rest.length > 0) {
        const id = idFromRest()
        const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('deep') === 'true'
        const locale = url.searchParams.get('locale')
        const r = buildSafety(id, { deep, locale })
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
        // IPC highlight always uses the full file set (desktop UI unaffected).
        if (onBlast) { try { onBlast({ seed: id, ids: r.files.map((f) => f.id) }) } catch {} }
        if (url.searchParams.get('compact')) {
          const lim = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '25', 10)))
          return writeJson(res, 200, compactBlast(r, lim))
        }
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
