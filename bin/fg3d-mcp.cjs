#!/usr/bin/env node
// filegraph3d MCP server — stdio JSON-RPC 2.0. Bridges Claude Code (or
// any MCP client) to the running Electron app's localhost:7707 API.
//
// Register with Claude Code:
//   claude mcp add filegraph3d node /absolute/path/to/bin/fg3d-mcp.cjs

const http = require('http')
const readline = require('readline')

const PORT = parseInt(process.env.FG3D_PORT || '7707', 10)
const HOST = '127.0.0.1'

function apiReq(method, pathStr, query) {
  return new Promise((resolve, reject) => {
    let qs = ''
    if (query) {
      const parts = []
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      }
      if (parts.length) qs = '?' + parts.join('&')
    }
    const r = http.request({ host: HOST, port: PORT, path: pathStr + qs, method }, (res) => {
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }) }
        catch { resolve({ status: res.statusCode, data: body }) }
      })
    })
    r.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`filegraph3d app is not running at ${HOST}:${PORT}. Start the desktop app first. Override port via FG3D_PORT env var.`))
      } else reject(err)
    })
    r.end()
  })
}

function encId(id) { return id.split('/').map(encodeURIComponent).join('/') }

// ─── Tool definitions ──────────────────────────────────────────
const TOOLS = [
  {
    name: 'fg3d_health',
    description: '현재 filegraph3d 앱 상태 — 어느 폴더 로드됐는지, 파일/엣지 수, 히스토리 활성 여부',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/health')).data,
  },
  {
    name: 'fg3d_summary',
    description: 'Layer 1 프로젝트 개요 — 작업 시작 전 가장 먼저 호출하세요. fileCount/edgeCount, 상위 폴더/허브, ext mix, orphan 수, 동적 패턴 파일 수, 외부 도메인. ~2KB로 90% 컨텍스트 제공. 이걸 본 다음에 fg3d_get_node로 좁혀가세요.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/summary')).data,
  },
  {
    name: 'fg3d_refresh',
    description: '특정 파일을 강제 재스캔 — 중요 작업(삭제, 대규모 리팩토링) 직전에 호출해서 stale 데이터 위험 제거. ms 단위로 빠름. lastSeenAt이 응답 meta에 포함됨',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('POST', '/refresh/' + encId(id))).data,
  },
  {
    name: 'fg3d_list_nodes',
    description: '전체 그래프 데이터 (파일 + 엣지). 큰 프로젝트는 토큰 부담이 크니 가능하면 fg3d_summary부터 호출하고, 필요하면 limit/ext/minMass로 좁혀서 호출. 응답 meta.totalAvailable/truncated 참고',
    inputSchema: {
      type: 'object',
      properties: {
        limit:   { type: 'number', description: '반환할 파일 최대 수 (생략 시 전부)' },
        offset:  { type: 'number', description: '시작 인덱스', default: 0 },
        ext:     { type: 'string', description: '확장자 필터 (예: "ts")' },
        minMass: { type: 'number', description: '최소 import 수 (허브 파일만 보기)' },
        sort:    { type: 'string', description: '정렬: mass:desc(기본) / size:desc / loc:desc / id:asc / insertion', default: 'mass:desc' },
      },
    },
    handler: async ({ limit, offset, ext, minMass, sort } = {}) => (
      await apiReq('GET', '/graph', { limit, offset, ext, minMass, sort })
    ).data,
  },
  {
    name: 'fg3d_get_node',
    description: '특정 파일 노드의 상세 정보 (확장자, LOC, 사이즈, mass, imports, importedBy)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '루트 기준 상대 파일 경로 (예: src/utils/helper.js)' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/node/' + encId(id))).data,
  },
  {
    name: 'fg3d_read_file',
    description: '파일 내용 읽기 (2MB 초과 시 거부). 클로드 코드의 Read 도구와 같지만 filegraph3d가 인식하는 현재 활성 폴더 기준',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '루트 기준 상대 경로' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/file/' + encId(id))).data,
  },
  {
    name: 'fg3d_get_deps',
    description: '이 파일이 import하는 파일들 (outgoing edges). 어떤 라이브러리/모듈을 쓰는지 확인',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/deps/' + encId(id))).data,
  },
  {
    name: 'fg3d_get_users',
    description: '이 파일을 import하는 파일들 (incoming edges). "이 파일 수정하면 어디가 영향받는가" 추적',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/users/' + encId(id))).data,
  },
  {
    name: 'fg3d_find',
    description: '파일 ID에 부분 문자열이 포함된 노드 검색 (최대 100개)',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '검색어' } },
      required: ['q'],
    },
    handler: async ({ q }) => (await apiReq('GET', '/find', { q })).data,
  },
  {
    name: 'fg3d_focus',
    description: 'filegraph3d UI에서 특정 노드로 카메라 포커스 이동 (사용자에게 시각적으로 보임)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('POST', '/focus/' + encId(id))).data,
  },
  {
    name: 'fg3d_open',
    description: 'filegraph3d UI에서 파일 인스펙터 패널 열기 (파일 내용이 화면에 표시됨)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('POST', '/open/' + encId(id))).data,
  },
  {
    name: 'fg3d_history',
    description: '파일의 자동 히스토리 스냅샷 목록 (최대 3개). 각 항목 { ts, size }',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/history/' + encId(id))).data,
  },
  {
    name: 'fg3d_restore',
    description: '파일을 특정 시점의 히스토리 스냅샷으로 복원 (디스크에 덮어쓰기)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ts: { type: 'number', description: 'fg3d_history가 반환한 타임스탬프 값' },
      },
      required: ['id', 'ts'],
    },
    handler: async ({ id, ts }) => (await apiReq('POST', '/restore/' + encId(id), { ts })).data,
  },
  {
    name: 'fg3d_external_urls',
    description: '프로젝트가 호출하는 외부 웹사이트/API 목록. 도메인별로 그룹화되어 어떤 외부 서비스를 쓰는지, 어느 파일에서 호출하는지 확인 가능',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/external')).data,
  },
  {
    name: 'fg3d_session_changes',
    description: '이번 세션 동안 수정된 파일 목록 (AI 에이전트가 편집한 파일들). 각 항목: id, 첫/마지막 변경 시각, 변경 횟수, 사이즈/LOC 증감',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/changes')).data,
  },
  {
    name: 'fg3d_session_diff',
    description: '특정 파일의 첫 감지 시점부터 현재까지의 변경 내용 (line-by-line diff). 이번 세션 중 AI가 정확히 뭘 바꿨는지 확인',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async ({ id }) => (await apiReq('GET', '/changes/' + encId(id))).data,
  },
  {
    name: 'fg3d_tour',
    description: '프로젝트 가이드 투어 — 진입점, 허브 파일, 외부 API 통합 지점 등 핵심 파일들을 순서대로 알려주는 학습 시작점. 새 프로젝트 처음 볼 때, AI가 사용자에게 "이 프로젝트는 이렇게 생겼다" 설명할 때 사용',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/tour')).data,
  },
  {
    name: 'fg3d_timeline',
    description: '프로젝트의 git 히스토리 타임라인 — 각 파일이 언제 처음 추가됐는지 (`git log --diff-filter=A` 기반). 첫 호출은 느릴 수 있고 (큰 리포는 수 초), 이후엔 캐시됨. 프로젝트 진화 분석에 사용',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/timeline')).data,
  },
  {
    name: 'fg3d_blast_radius',
    description: '파일 수정 영향도 예측 — 이 파일을 고치면 어떤 파일들이 영향받는지 BFS로 추적. 토큰 비용 추정 + 파일 카테고리 분류(테스트/소스/설정/문서). 작업 시작 전 스코프 파악에 사용',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '대상 파일 ID' },
        depth: { type: 'number', description: 'BFS 깊이 (기본 3, 1-10)', default: 3 },
        direction: { type: 'string', enum: ['users', 'deps'], description: 'users = 이 파일을 import하는 것들 추적 (영향 범위) / deps = 이 파일이 import하는 것들 추적 (의존성 클로저)', default: 'users' },
      },
      required: ['id'],
    },
    handler: async ({ id, depth, direction }) => (
      await apiReq('GET', '/blast/' + encId(id), { depth: depth ?? 3, dir: direction ?? 'users' })
    ).data,
  },
  {
    name: 'fg3d_suggest',
    description: '현재 코드 상태를 보고 "AI에게 다음에 시킬 작업"을 우선순위 순으로 추천. high/medium/low priority. 규칙: 미선언 환경 변수, 테스트 없는 hub 파일, 고립(죽은) 파일, 사용 안 되는 환경 변수, 동적 import 비중. 비개발자가 "다음 뭐 시켜?" 막힐 때 첫 호출 추천.',
    inputSchema: {
      type: 'object',
      properties: { top: { type: 'number', description: '최대 추천 수 (기본 10)', default: 10 } },
    },
    handler: async ({ top }) => (await apiReq('GET', '/suggest', { top: top ?? 10 })).data,
  },
  {
    name: 'fg3d_env',
    description: '.env 파일에 선언된 환경 변수와 소스 코드에서 실제 사용되는 환경 변수를 cross-reference. 응답: declared/used/status(ok|unused|undeclared). undeclared = 코드는 쓰는데 .env에 없음 → 배포시 실패 가능. unused = .env에는 있는데 안 씀 → 키 노출/정리 후보. var 지정시 단일 변수 상세.',
    inputSchema: {
      type: 'object',
      properties: { var: { type: 'string', description: '특정 변수 이름 (대문자, 옵션)' } },
    },
    handler: async ({ var: v }) => (await apiReq('GET', '/env', v ? { var: v } : null)).data,
  },
  {
    name: 'fg3d_safety',
    description: '🟢/🟡/🔴 "AI에게 이 파일 수정시켜도 되나" 신호등. dependents/routes/외부 API/dynamic 패턴/테스트 유무를 종합. 비개발자가 AI 작업 승인 전, 또는 AI가 수정 전 self-check용. risky면 사람이 검토 권장.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '대상 파일 ID' },
        deep: { type: 'boolean', description: 'true면 영향받는 파일 전체 리스트도 반환', default: false },
      },
      required: ['id'],
    },
    handler: async ({ id, deep }) => (await apiReq('GET', '/safety/' + encId(id), { deep: deep ? '1' : null })).data,
  },
  {
    name: 'fg3d_bundle',
    description: '파일 수정 전 함께 읽어야 할 의존 파일을 token 예산 안에서 자동 추출. AI가 "X 고쳐줘" 요청 받았을 때, 이 도구로 컨텍스트를 먼저 묶고 그 파일들을 읽은 뒤 수정. depth 안에서 mass 높은 파일 우선 선택.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '수정 대상 파일 ID' },
        budget: { type: 'number', description: '토큰 예산 (기본 8000)', default: 8000 },
        depth: { type: 'number', description: 'BFS 깊이 (1-10, 기본 3)', default: 3 },
      },
      required: ['id'],
    },
    handler: async ({ id, budget, depth }) => (await apiReq('GET', '/bundle/' + encId(id), { budget: budget ?? 8000, depth: depth ?? 3 })).data,
  },
  {
    name: 'fg3d_list_packages',
    description: '모노레포의 패키지 목록 조회. 응답에 kind(pnpm/npm-workspaces/yarn/lerna/turbo/nx/python-uv/multi-package/single/none), 각 패키지의 name/relRoot/fileCount/loc/cross-package edges 포함. 모노레포 아니면 packages가 빈 배열. 모노레포 작업 시작 시 가장 먼저 호출하세요.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/packages')).data,
  },
  {
    name: 'fg3d_get_package',
    description: '특정 패키지 상세 정보 — 파일 목록(mass 정렬), 선언된 의존성(package.json), cross-package imports/dependents. 패키지 하나 리팩토링 전에 호출해서 외부 의존 표면 파악.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '패키지 이름 (fg3d_list_packages 응답의 name 필드)' } },
      required: ['name'],
    },
    handler: async ({ name }) => (await apiReq('GET', '/package/' + encodeURIComponent(name))).data,
  },
  {
    name: 'fg3d_package_graph',
    description: '패키지 단위 의존성 그래프 — 패키지간 엣지 목록(count 내림차순). 어떤 패키지가 어떤 패키지를 얼마나 많이 import하는지 한눈에. 패키지 분리/병합 결정 전 사용.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/package-graph')).data,
  },
  {
    name: 'fg3d_write_file',
    description: '파일 전체를 새 내용으로 덮어쓰기 (디스크 저장 + 자동 히스토리 스냅샷 + 3D 시각 트레이스). 작은 파일이나 완전 재작성용. 라인 일부만 바꾸려면 fg3d_edit_file 사용 권장. **주의**: 이 도구는 디스크에 실제 변경을 가하므로 사용자가 작업 폴더를 트러스트한 상태에서만 호출. 응답에 size 포함. fg3d UI에서 해당 노드가 초록색 펄스로 표시되어 사용자가 어떤 파일이 수정됐는지 즉시 봅니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id:      { type: 'string', description: '루트 기준 상대 파일 경로 (예: src/auth.js)' },
        content: { type: 'string', description: '파일 새 전체 내용' },
      },
      required: ['id', 'content'],
    },
    handler: async ({ id, content }) => {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({ content })
        const r = http.request({
          host: HOST, port: PORT,
          path: '/write/' + encId(id),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            try { resolve(JSON.parse(text)) } catch { resolve(text) }
          })
        })
        r.on('error', (e) => reject(e))
        r.write(body); r.end()
      })
    },
  },
  {
    name: 'fg3d_edit_file',
    description: '파일 일부만 정밀 편집 — Claude Code의 Edit 도구와 동일한 의미: find 문자열을 replace로 교체. find가 파일 내 유일해야 안전 (여러 번 등장하면 replaceAll:true 명시 또는 더 구체적 find로). **응답 에러 코드**: 404 = find not found, 409 = ambiguous (count > 1). 라인 단위가 아니라 정확한 문자열 매치이므로 들여쓰기·공백 포함해서 전달. 히스토리·트레이스 자동 기록. write_file보다 토큰 효율적이고 의도 보존 잘 됨.',
    inputSchema: {
      type: 'object',
      properties: {
        id:         { type: 'string', description: '루트 기준 상대 경로' },
        find:       { type: 'string', description: '교체할 정확한 문자열 (공백·들여쓰기 포함)' },
        replace:    { type: 'string', description: '새 문자열' },
        replaceAll: { type: 'boolean', description: 'find가 여러 번 등장할 때 모두 교체 (기본 false → 유일성 강제)', default: false },
      },
      required: ['id', 'find', 'replace'],
    },
    handler: async ({ id, find, replace, replaceAll }) => {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({ find, replace, replaceAll: replaceAll === true })
        const r = http.request({
          host: HOST, port: PORT,
          path: '/edit/' + encId(id),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            try { resolve(JSON.parse(text)) } catch { resolve(text) }
          })
        })
        r.on('error', (e) => reject(e))
        r.write(body); r.end()
      })
    },
  },
  {
    name: 'fg3d_trace_log',
    description: '현재 AI 세션의 트레이스 로그 — 어떤 도구가 어떤 파일을 언제 만졌는지 시간순. fg3d_summary 호출 후 "방금 내가 본 파일들 다시 정리"용. tool/limit 필터.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '최근 N개만 (생략 시 전체)' },
        tool:  { type: 'string', description: '특정 도구만 (예: read, focus, blast)' },
      },
    },
    handler: async ({ limit, tool } = {}) => (await apiReq('GET', '/trace', { limit, tool })).data,
  },
  {
    name: 'fg3d_trace_stats',
    description: '현재 세션 통계 — 어떤 파일을 가장 많이 봤는지(topFiles), 도구별 분포(byTool), 세션 시작·종료 시각, 시간 히스토그램. 작업 마무리 시 "오늘 뭘 했나" 보고용.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/trace/stats')).data,
  },
  {
    name: 'fg3d_trace_sessions',
    description: '이전 트레이스 세션 목록 — `.filegraph3d/traces/`에 저장된 과거 세션들. 이전 작업 다시 보고 싶을 때 호출 후 sessionId를 fg3d_trace_session에 전달.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => (await apiReq('GET', '/trace/sessions')).data,
  },
  {
    name: 'fg3d_legacy_audit',
    description: '레거시/마이그레이션 감사 — 정리 후보 파일을 4종 카테고리로 분류하고 confidence(0..1) 점수 부여. orphan(고립 파일), path(_legacy/_archive/etc 경로), filename(_old/_v1/.bak 등 이름), duplicate(같은 logical-name + legacy 표식). 각 항목에 reason 포함. confidence > 0.85는 대체로 안전, 0.5~0.85는 확인 필요. summary.topCandidates 100개로 한눈 파악. 큰 프로젝트 청소 시작 시 1순위 호출.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['orphan', 'path', 'filename', 'duplicate'], description: '특정 카테고리만 보고 싶을 때 (생략 시 전부)' },
      },
    },
    handler: async ({ type } = {}) => (
      await apiReq('GET', '/legacy', type ? { type } : null)
    ).data,
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
        serverInfo: { name: 'filegraph3d', version: '0.1.0' },
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
