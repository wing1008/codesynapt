import * as THREE from 'three'
import * as backend from './backend.js'
import { initPlugins, pluginRegistry } from './plugin-host.js'

// stepGPU is null until v0.6 implements WebGPU compute shaders.
// backend.runStep() will detect this and stay on CPU.
const stepGPU = null

// Symbol-mode state. Declared at the top of the module: the status-bar
// renderer (renderStatusBar) reads it far earlier than its original
// definition further down, which threw a TDZ ReferenceError and aborted
// module evaluation (so the snapshot listener never registered → blank app).
const symbolModeState = { count: null, edges: null, loading: false, lastRoot: null }

// One-time localStorage migration: `filegraph3d:*` → `codesynapt:*`.
// Renamed from FileGraph 3D in 0.14.6. We copy old keys (don't delete)
// so downgrading still works. Marker key prevents re-running.
;(function migrateLocalStorage() {
  try {
    const marker = 'codesynapt:_migrated_from_filegraph3d'
    if (localStorage.getItem(marker) === '1') return
    let copied = 0
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('filegraph3d:')) continue
      const newKey = 'codesynapt:' + k.slice('filegraph3d:'.length)
      if (localStorage.getItem(newKey) !== null) continue   // don't overwrite
      const v = localStorage.getItem(k)
      if (v != null) { localStorage.setItem(newKey, v); copied++ }
    }
    localStorage.setItem(marker, '1')
    if (copied > 0) console.log(`[codesynapt] migrated ${copied} localStorage key(s) from filegraph3d:*`)
  } catch (e) { /* private mode / quota / etc — skip */ }
})()

// ═══════════════════════════════════════════════════════════════
//  Central event bus
//
//  Replaces the ad-hoc window.__xxxRefresh pattern that accumulated
//  during development. Subsystems subscribe to events; producers
//  emit. Single place to debug "why didn't the file tree update".
//
//  Events emitted by core:
//    snapshot:applied   — graph mutated (nodes/edges changed)
//    selection:changed  — selectedId changed (id may be null)
//    filter:changed     — filterText/syntax/mode/hidden exts changed
//    focus:changed      — focusDepth or showAllConnected changed
//    graph:cleared      — graph wiped (close folder)
//
//  Listeners are never removed (subsystems live for the app's
//  lifetime), so this is a write-once-read-many design.
// ═══════════════════════════════════════════════════════════════
const bus = (() => {
  const listeners = new Map()  // event name -> Set<fn>
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      // Return an unsubscribe handle. Plugin authors depend on this
      // to clean up event subscriptions during deactivate().
      return () => {
        const set = listeners.get(event)
        if (set) set.delete(fn)
      }
    },
    off(event, fn) {
      const set = listeners.get(event)
      if (set) set.delete(fn)
    },
    emit(event, payload) {
      const set = listeners.get(event)
      if (!set) return
      for (const fn of set) {
        try { fn(payload) }
        catch (err) { console.error(`bus listener for ${event} threw:`, err) }
      }
    },
    // For DevTools debugging — `window.__bus.listenerCount()` etc.
    _listenerCount(event) {
      return listeners.get(event)?.size || 0
    },
    _allEvents() {
      return [...listeners.keys()]
    },
  }
})()
window.__bus = bus

// ═══════════════════════════════════════════════════════════════
//  Capacity — pre-allocated to avoid per-frame allocation pressure
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  i18n — Korean / English. state.lang persists in localStorage,
//  changes via the language toggle button in the top bar.
// ═══════════════════════════════════════════════════════════════
const LANG_KEY = 'codesynapt:lang'
const T = {
  ko: {
    // Top bar
    'lang.toggle.title': '언어 전환 (한국어 / English)',
    'topbar.open_folder.title': '폴더 열기 (Ctrl+O)',
    'topbar.open_folder.label': '폴더 열기…',
    'topbar.refresh.title':     '현재 폴더 다시 스캔 (F5)',
    'topbar.project_switch.title':'프로젝트 전환 (★ 즐겨찾기 + 최근)',
    'psw.title':                  '프로젝트',
    'psw.recent':                 '최근',
    'psw.empty':                  '아직 등록된 프로젝트 없음. 폴더 열고 ★ +로 추가',
    'psw.pin_current.title':      '현재 폴더를 즐겨찾기에 추가',
    'psw.rename.prompt':          '프로젝트 이름:',
    'psw.unpin.confirm':          '즐겨찾기에서 제거할까요?',
    'psw.open_failed':            '폴더 열기 실패: {err}',
    'psw.no_current':             '먼저 폴더를 여세요',
    'psw.pinned':                 '★ 즐겨찾기에 추가됨',
    'topbar.tree_toggle.title': '파일 트리 토글 (T)',
    // Search bar
    'search.placeholder':   '파일 필터… ( / 누르면 포커스)',
    'search.syntax.title':  '검색 구문: 일반 | 글롭 | 정규식',
    'search.mode.title':    '매칭 모드: 하이라이트 | 숨김',
    'search.pause.title':   '레이아웃 일시정지 (Space)',
    'search.recenter.title':'카메라 중앙 (R)',
    'search.zoom_in.title': '확대 (휠 위)',
    'search.zoom_out.title':'축소 (휠 아래)',
    'search.stats.title':   '그래프 통계 (S)',
    'search.rightrail.title':'오른쪽 패널 토글 (M)',
    'search.changes.title': 'AI 작업물 — 이번 세션에 변경된 파일',
    'search.timelapse.title':'타임랩스 — git 히스토리 재생',
    'search.packages.title':'모노레포 패키지 보기',
    'search.legacy.title':  '레거시 청소 후보 감사 (마이그레이션)',
    'search.settings.title':'설정 (Ctrl/Cmd+,)',
    'search.more.title':    '더 많은 도구',
    'sb.group.search':      '검색',
    'sb.group.view':        '뷰',
    'sb.group.ai':          'AI 도구',
    'sb.group.more':        '더보기',
    'more.timelapse':       '타임랩스',
    'more.packages':        '패키지',
    'more.legacy':          '레거시 감사',
    'more.tour':            '투어',
    'search.tour.title':    '코드베이스 가이드 투어 — 진입점·허브 순회',
    'kicker.tour':          '가이드 투어 · 진입점 & 허브',
    'tour.loading':         '투어 불러오는 중…',
    'tour.empty':           '투어 항목 없음',
    'more.lang':            '언어 전환',
    'more.settings':        '설정',
    // Panel titles (kickers)
    'kicker.ai_work':       'ai 작업물 · 세션 변경',
    'kicker.timelapse':     '타임랩스',
    'kicker.packages':      '모노레포 · 패키지',
    'kicker.settings':      '설정',
    // Packages panel
    'packages.not_monorepo':    '모노레포 아님 (감지: {kind})',
    'packages.meta_summary':    '{kind} · {count}개 패키지 · 패키지간 엣지 {crossEdges}개',
    'packages.group_by_package':'패키지로 묶기',
    'packages.group_by_package_on':'폴더로 되돌리기',
    'packages.detected_toast':  '모노레포 감지: {kind} ({count}개 패키지). 📦 버튼에서 확인',
    'packages.declared':        '선언된 의존성 ({n})',
    'packages.outgoing':        '이 패키지가 import하는 (→ 타 패키지, {n})',
    'packages.incoming':        '이 패키지를 import하는 (← 타 패키지, {n})',
    'packages.top_files':       '주요 파일 (mass 순 · 상위 {n})',
    // Legacy / migration audit
    'kicker.legacy_audit':      '정리 · 마이그레이션 감사',
    'legacy.loading':           '분석 중…',
    'legacy.empty':             '폴더가 로드되지 않음',
    'legacy.meta_summary':      '청소 후보 {n}/{total}개 · 총 {loc} loc',
    'legacy.min_conf':          '최소 신뢰도',
    'legacy.highlight':         '3D 하이라이트',
    'legacy.highlight_on':      '3D 하이라이트 ✓',
    'legacy.no_items_for_conf': '현재 신뢰도 임계값 이상 항목 없음',
    'legacy.no_duplicates':     '중복 logical-name 없음',
    'legacy.tab.orphan':        'orphan',
    'legacy.tab.path':          '경로',
    'legacy.tab.filename':      '파일명',
    'legacy.tab.duplicate':     '중복',
    'legacy.dup.current':       '현재',
    'legacy.dup.legacy':        '레거시',
    'kicker.files':         '파일',
    'kicker.pipelines':     '파이프라인',
    'kicker.recent':        '최근',
    'kicker.sessions':      '세션',
    'sessions.refresh.title': '세션 목록 새로고침',
    'sessions.empty':       '활성 세션 없음 — Claude Code에서 /codesynapt 실행 시 표시됨',
    'sessions.view':        '보기',
    'sessions.detach':      '분리',
    'sessions.viewing':     '보는 중',
    'sessions.dead_daemon': '데몬 꺼짐',
    'sessions.attach_failed': '연결 실패',
    'recent.empty':         '최근 본 파일이 없음',
    'inspector.empty':      '파일을 선택하면 정보가 표시됩니다',
    'kicker.legend':        '확장자',
    'kicker.ai_trace':      'ai 트레이스',
    'kicker.inspector':     '인스펙터',
    'kicker.overview':      '미니맵',
    'kicker.project':       '프로젝트',
    'kicker.graph_stats':   '그래프 통계',
    'kicker.project_info':  '프로젝트 정보',
    // File tree / pipelines
    'ft.collapse_all.title':'전부 접기',
    'ft.hide.title':        '트리 숨김 (T)',
    'pp.add.title':         '새 파이프라인',
    'pp.mode.title':        '흐림/숨김 모드 전환',
    'recent.clear.title':   '최근 파일 비우기',
    'minimap.hide.title':   '미니맵 숨김',
    'project.edit.title':   '프로젝트 정보 편집',
    // Settings panel
    'settings.physics.title':       '물리 백엔드',
    'settings.physics.help':        '매 프레임 노드 위치를 어떻게 계산할지. 큰 그래프에선 GPU가 훨씬 빠르지만 다른 앱과 그래픽카드를 공유.',
    'settings.physics.auto':        '자동',
    'settings.physics.auto.sub':    'GPU가 한가하면 사용, 다른 앱이 GPU 점유 중이면 CPU로 전환 (권장 — 현재는 항상 CPU)',
    'settings.physics.gpu':         'GPU 전용 (v0.6 예정)',
    'settings.physics.gpu.sub':     'WebGPU compute shader는 아직 구현 안 됨 — 활성화하면 CPU fallback',
    'settings.physics.gpu.tip':     'v0.6에 활성화 예정. 현재는 항상 CPU.',
    'settings.physics.cpu':         'CPU 전용',
    'settings.physics.cpu.sub':     'GPU를 일체 안 씀. Wan / Stable Diffusion / 학습 중에 유용',
    'settings.physics.active':      '활성',
    'settings.physics.gpu_time':    'GPU 시간',
    'settings.physics.status':      '상태',
    'settings.focus.title':         '포커스 전파',
    'settings.focus.help':          '파일에 호버하거나 클릭하면 관련 파일들이 링으로 강조됨. 깊이는 파급 hop 수. <strong>모두 연결된 거 표시</strong>를 켜면 한계 무시하고 도달 가능한 모든 파일 강조.',
    'settings.focus.depth':         '깊이',
    'settings.focus.hops':          'hops',
    'settings.focus.show_all':      '모두 연결된 거 표시',
    'settings.focus.legend.selected': '선택한 파일',
    'settings.focus.legend.direct':   '직접 연결',
    'settings.focus.legend.one':      '1단계 떨어진 거',
    'settings.focus.legend.two':      '2단계 떨어진 거',
    'settings.focus.legend.beyond':   '관련 없음 / 깊이 초과',
    'settings.layout.title':        '레이아웃',
    'settings.layout.help':         '파일 배치 방식에 영향을 주는 선택 옵션.',
    'settings.layout.cluster':      '폴더별로 파일 묶기',
    'settings.layout.node_distance':'노드 간격',
    'settings.layout.node_size':    '노드 크기',
    'settings.layout.max_world':    '월드 최대 크기',
    'settings.layout.folder_strength': '폴더 클러스터 중력',
    'settings.layout.folder_spread':   '폴더 클러스터 거리',
    'settings.layout.folder_opacity':  '폴더 영역 투명도',
    'settings.layout.reset':        '기본값으로 리셋',
    'settings.appearance.title':    '외관',
    'settings.appearance.help':     '인터페이스 비주얼 테마. 그래프 자체는 모든 테마에서 동일 — 패널/타이포/장식만 바뀜.',
    'settings.export.title':        '내보내기',
    'settings.export.help':         '현재 화면을 PNG로 저장하거나 그래프 데이터를 JSON으로 내보내서 다른 분석 도구에 사용.',
    'settings.export.png':          '📷 PNG 스크린샷',
    'settings.export.json':         '⤓ JSON 그래프',
    'settings.export.csv':          '⤓ CSV 엣지',
    'settings.history.title':       '파일 히스토리',
    'settings.camera.title':        '카메라 프리셋',
    'settings.camera.help':         '시점별 빠른 각도. Cmd/Ctrl + 1/2/3으로 저장, 1/2/3으로 복원.',
    'settings.camera.default':      '기본',
    'settings.camera.top':          '위에서',
    'settings.camera.side':         '옆에서',
    // History settings (existing)
    'history.settings.help': '파일을 저장하거나 외부에서 수정될 때마다 파일당 최근 3개 버전을 자동 백업. 저장 위치: <code>.codesynapt/history/</code>. 기본 OFF.',
    'history.settings.toggle': '자동 히스토리 활성화',
    // AI trace panel
    'trace.panel.empty':    '대기 중… (MCP/CLI 호출 시 여기 표시)',
    // Full trace panel
    'kicker.ai_trace_full': 'ai 트레이스 · 세션',
    'trace.full.title':     '전체 트레이스 보기',
    'trace.filter.all':     '전체 도구',
    'trace.replay.title':   '리플레이 (3D 펄스 재생)',
    'trace.export.title':   'JSON으로 내보내기',
    'trace.clear.title':    '현재 세션 클리어 (디스크 보존)',
    'trace.sessions.title': '이전 세션 보기',
    'trace.tab.log':        '로그',
    'trace.tab.stats':      '통계',
    'trace.tab.sessions':   '세션',
    'trace.meta':           '세션 {session} · {events} 이벤트 · {files} 파일 · {duration}',
    'trace.no_events':      '아직 트레이스 이벤트 없음 — CLI/MCP/HTTP API 호출 시 기록됨',
    'trace.loading':        '로딩…',
    'trace.no_sessions':    '저장된 세션 없음',
    'trace.session_load_failed': '세션 로드 실패',
    'trace.current':        '현재',
    'trace.no_replay':      '재생할 이벤트 없음',
    'trace.cleared':        '세션 클리어됨',
    'trace.exported':       '{n}개 이벤트를 {path}에 저장',
    'trace.stats.by_tool':  '도구별 호출 수',
    'trace.stats.timeline': '시간대별 활동',
    'trace.stats.top_files':'가장 많이 접근한 파일',
    // Inspector badges
    'badge.orphan.title':    '아무 곳에서도 import되지 않고, 어떤 것도 import하지 않음 — 잔재 가능성',
    'badge.orphan.label':    '🟠 orphan',
    'badge.leaf.title':      '다른 파일이 이 파일을 import하지 않음 (진입점이거나 잔재)',
    'badge.leaf.label':      '🟡 no incoming',
    'badge.connected.title': '{n}개 파일이 이 파일을 import함 — 활성 파일',
    'badge.connected.label': '🟢 connected · in:{in} out:{out}',
    'badge.conf.title':      '그래프 신뢰도 — 이 파일의 import/의존 분석이 얼마나 확실한지',
    'badge.conf.high':       '🟢 신뢰 높음',
    'badge.conf.medium':     '🟡 신뢰 중간',
    'badge.conf.low':        '🔴 신뢰 낮음',
    'badge.dynamic.title':   '동적 import/호출 감지 — 정적 분석이 일부 의존성을 놓칠 수 있음 (영향범위는 최소치)',
    'badge.dynamic.label':   '⚡ 동적 {n}',
    // History panel (per-file)
    'history.electron.required': 'Electron 외 환경: 히스토리 비활성',
    'history.off':              '자동 히스토리 OFF — 설정에서 켜기',
    'history.none':             '아직 저장된 버전 없음 — 첫 저장 시 자동 생성',
    'history.view':             '보기',
    'history.restore':          '복원',
    'history.snap_not_found':   '스냅샷을 찾을 수 없음',
    'history.viewing':          '이전 버전 보기 ({when}) — 저장 차단됨, 복원 누르면 적용',
    'history.restore_failed':   '복원 실패: {err}',
    'history.restored':         '이전 버전으로 복원됨',
    // Editor save status
    'editor.editing':           '편집 중…',
    'editor.save_unavailable':  '저장 불가 (Electron 외 환경)',
    'editor.saved':             '저장됨',
    'editor.unsaved':           '저장 안됨 (autosave 꺼짐 · Ctrl+S 또는 Diff 버튼)',
    'editor.error':             '오류: {err}',
    'editor.autosave':          '자동저장',
    'editor.autosave.title':    '체크 해제 시 수동 저장 모드 (Ctrl+S 또는 Diff 버튼)',
    'editor.diff.title':        'Diff 미리보기 (Ctrl+S)',
    'editor.diff.title_modal':  '저장 전 변경사항 확인',
    'editor.diff.no_changes':   '변경사항 없음',
    'editor.diff.save':         '✓ 저장',
    'editor.diff.cancel':       '✕ 되돌리기',
    'editor.diff.skip_next':    '다음부터 바로 저장 (이번 세션 동안)',
    // Changes panel
    'changes.empty':             '아직 수정된 파일 없음.<br>AI(Claude Code/Cursor)나 에디터로 파일을 저장하면 여기 표시됩니다.',
    'changes.requires_electron': 'Changes 패널은 데스크탑 앱에서만 사용 가능',
    'symbols.requires_electron': '심볼(함수) 레이어는 데스크탑 앱에서만 사용 가능',
    // Tour / Time-lapse
    'timelapse.requires_electron':  '타임랩스는 데스크탑 앱에서만 사용 가능',
    // Hints bar
    'hints.drag':    '드래그',
    'hints.orbit':   '회전',
    'hints.scroll':  '스크롤',
    'hints.zoom':    '줌',
    'hints.click':   '클릭',
    'hints.inspect': '인스펙트',
    'hints.hover':   '호버',
    'hints.focus':   '포커스',
    // Welcome
    'welcome.coord.visualizer': '시각화 도구',
    'welcome.coord.offline':    '오프라인',
    'welcome.subtitle':         '의존성 천문대 · 디렉터리 가리키면 그래프가 그려짐',
    'welcome.begin':            '시작',
    'welcome.open_folder':      '폴더 열기',
    'welcome.drag_hint':        '또는 폴더를 이 창에 드래그',
    // Project dialog
    'dialog.help':         '이 코드베이스에 대한 컨텍스트를 추가하세요. 파일 선택이 없을 때 오른쪽 패널에 표시되고 세션 간 유지됩니다. 모두 선택 사항 — 나중에 추가해도 됨.',
    'dialog.name':         '이름',
    'dialog.version':      '버전',
    'dialog.stack':        '스택',
    'dialog.description':  '설명',
    'dialog.notes':        '노트',
    'dialog.description.ph':'이게 뭘 하는지?',
    'dialog.notes.ph':     '아키텍처, 컨벤션, 기억할 만한 거…',
    'dialog.name.ph':      '내 멋진 프로젝트',
    'dialog.stack.ph':     'React, TypeScript, Postgres…',
    'dialog.skip':         '건너뛰기',
    'dialog.save':         '저장',
    // Drop overlay / scan
    'drop.overlay':        '스캔할 폴더를 놓으세요',
    'scan.scanning':       '스캔 중…',
    'scan.building':       '그래프 빌드 중…',
    'scan.files':          '파일',
    // Status bar units
    'status.files':        '파일',
    'status.edges':        '엣지',
    'status.comp':         '컴포넌트',
    'status.symbols':      '심볼',
    'status.symbols.title':'심볼 그래프 (codegraph 호환 레이어). 클릭해서 빌드 — function/class 단위로 인덱싱.',
    'status.files.title':  '그래프의 전체 파일',
    'status.edges.title':  '전체 연결',
    'status.comp.title':   '연결된 컴포넌트',
    'status.state.title':  '시뮬레이션 상태',
    'status.changed.title':'마지막 파일 변경',
    'status.backend.title':'물리 백엔드',
    'status.fps.title':    '초당 프레임',
    'status.last_change':  '마지막 변경',
    'sim.paused':          '일시정지',
    'sim.dragging':        '드래그 중',
    'sim.settled':         '안정화됨',
    'sim.simulating':      '시뮬레이션 중',
    'sim.cooling':         '식는 중',
  },
  en: {
    // Top bar
    'lang.toggle.title': 'Switch language (한국어 / English)',
    'topbar.open_folder.title': 'Open Folder (Ctrl+O)',
    'topbar.open_folder.label': 'Open Folder…',
    'topbar.refresh.title':     'Rescan current folder (F5)',
    'topbar.project_switch.title':'Switch project (★ pinned + recent)',
    'psw.title':                  'projects',
    'psw.recent':                 'recent',
    'psw.empty':                  'No pinned projects yet. Open a folder and click ★ + to add it.',
    'psw.pin_current.title':      'Pin current folder',
    'psw.rename.prompt':          'Project name:',
    'psw.unpin.confirm':          'Remove from pinned?',
    'psw.open_failed':            'Failed to open: {err}',
    'psw.no_current':             'Open a folder first',
    'psw.pinned':                 '★ Pinned',
    'topbar.tree_toggle.title': 'Toggle file tree (T)',
    'search.placeholder':   'filter files… ( / to focus )',
    'search.syntax.title':  'Search syntax: plain | glob | regex',
    'search.mode.title':    'Match mode: highlight | hide',
    'search.pause.title':   'Pause layout (Space)',
    'search.recenter.title':'Recenter camera (R)',
    'search.zoom_in.title': 'Zoom in (scroll up)',
    'search.zoom_out.title':'Zoom out (scroll down)',
    'search.stats.title':   'Graph stats (S)',
    'search.rightrail.title':'Toggle right panel (M)',
    'search.changes.title': 'AI work — files changed this session',
    'search.timelapse.title':'Time-lapse: replay git history',
    'search.packages.title':'View monorepo packages',
    'search.legacy.title':  'Legacy / migration audit — cleanup candidates',
    'search.settings.title':'Settings (Ctrl/Cmd+,)',
    'search.more.title':    'More tools',
    'sb.group.search':      'search',
    'sb.group.view':        'view',
    'sb.group.ai':          'AI tools',
    'sb.group.more':        'more',
    'more.timelapse':       'Time-lapse',
    'more.packages':        'Packages',
    'more.legacy':          'Legacy audit',
    'more.tour':            'Tour',
    'search.tour.title':    'guided tour — entry points & hubs',
    'kicker.tour':          'guided tour · entry & hubs',
    'tour.loading':         'loading tour…',
    'tour.empty':           'no tour stops',
    'more.lang':            'Language',
    'more.settings':        'Settings',
    'kicker.ai_work':       'ai work · session changes',
    'kicker.timelapse':     'time-lapse',
    'kicker.packages':      'monorepo · packages',
    'kicker.settings':      'settings',
    // Packages panel
    'packages.not_monorepo':    'not a monorepo (detected: {kind})',
    'packages.meta_summary':    '{kind} · {count} packages · {crossEdges} cross-package edges',
    'packages.group_by_package':'Group by package',
    'packages.group_by_package_on':'Revert to folders',
    'packages.detected_toast':  'monorepo detected: {kind} ({count} packages). Open via 📦',
    'packages.declared':        'declared dependencies ({n})',
    'packages.outgoing':        'this package imports (→ other pkgs, {n})',
    'packages.incoming':        'this package is imported by (← other pkgs, {n})',
    'packages.top_files':       'top files (by mass · {n})',
    // Legacy audit
    'kicker.legacy_audit':      'cleanup · migration audit',
    'legacy.loading':           'analyzing…',
    'legacy.empty':             'no folder loaded',
    'legacy.meta_summary':      '{n}/{total} cleanup candidates · {loc} loc total',
    'legacy.min_conf':          'min confidence',
    'legacy.highlight':         'Highlight in 3D',
    'legacy.highlight_on':      'Highlight in 3D ✓',
    'legacy.no_items_for_conf': 'no items above current confidence threshold',
    'legacy.no_duplicates':     'no logical-name duplicates',
    'legacy.tab.orphan':        'orphan',
    'legacy.tab.path':          'path',
    'legacy.tab.filename':      'filename',
    'legacy.tab.duplicate':     'duplicate',
    'legacy.dup.current':       'current',
    'legacy.dup.legacy':        'legacy',
    'kicker.files':         'files',
    'kicker.pipelines':     'pipelines',
    'kicker.recent':        'recent',
    'kicker.sessions':      'sessions',
    'sessions.refresh.title': 'Refresh session list',
    'sessions.empty':       'No active sessions — they appear when /codesynapt runs in Claude Code',
    'sessions.view':        'view',
    'sessions.detach':      'detach',
    'sessions.viewing':     'viewing',
    'sessions.dead_daemon': 'daemon off',
    'sessions.attach_failed': 'attach failed',
    'recent.empty':         'No recently viewed files',
    'inspector.empty':      'Select a file to see its info',
    'kicker.legend':        'extensions',
    'kicker.ai_trace':      'ai trace',
    'kicker.inspector':     'inspector',
    'kicker.overview':      'overview',
    'kicker.project':       'project',
    'kicker.graph_stats':   'graph stats',
    'kicker.project_info':  'project info',
    'ft.collapse_all.title':'Collapse all',
    'ft.hide.title':        'Hide tree (T)',
    'pp.add.title':         'New pipeline',
    'pp.mode.title':        'Toggle dim/hide mode',
    'recent.clear.title':   'Clear recent files',
    'minimap.hide.title':   'Hide minimap',
    'project.edit.title':   'Edit project info',
    'settings.physics.title':       'physics backend',
    'settings.physics.help':        'How node positions get computed each frame. GPU is much faster for large graphs but shares your graphics card with other apps.',
    'settings.physics.auto':        'Auto',
    'settings.physics.auto.sub':    'Use GPU when free; switch to CPU when GPU is busy (recommended — currently always CPU)',
    'settings.physics.gpu':         'GPU only (planned for v0.6)',
    'settings.physics.gpu.sub':     'WebGPU compute shaders not yet implemented — enabling falls back to CPU',
    'settings.physics.gpu.tip':     'Coming in v0.6. Always CPU for now.',
    'settings.physics.cpu':         'CPU only',
    'settings.physics.cpu.sub':     "Don't touch the GPU at all. Useful while running Wan / Stable Diffusion / training",
    'settings.physics.active':      'active',
    'settings.physics.gpu_time':    'gpu time',
    'settings.physics.status':      'status',
    'settings.focus.title':         'focus propagation',
    'settings.focus.help':          'When you hover or click a file, related files are highlighted in rings. Depth controls how many hops the ripple spreads. Use <strong>Show all connected</strong> to skip the limit and highlight every reachable file.',
    'settings.focus.depth':         'depth',
    'settings.focus.hops':          'hops',
    'settings.focus.show_all':      'Show all connected',
    'settings.focus.legend.selected': 'selected file',
    'settings.focus.legend.direct':   'directly connected',
    'settings.focus.legend.one':      'one degree away',
    'settings.focus.legend.two':      'two degrees away',
    'settings.focus.legend.beyond':   'unrelated / beyond depth',
    'settings.layout.title':        'layout',
    'settings.layout.help':         'Optional layout tweaks that affect how files arrange themselves.',
    'settings.layout.cluster':      'Cluster files by folder',
    'settings.layout.node_distance':'node distance',
    'settings.layout.node_size':    'node size',
    'settings.layout.max_world':    'max world size',
    'settings.layout.folder_strength': 'folder cluster strength',
    'settings.layout.folder_spread':   'folder cluster spread',
    'settings.layout.folder_opacity':  'folder area opacity',
    'settings.layout.reset':        'reset to defaults',
    'settings.appearance.title':    'appearance',
    'settings.appearance.help':     'Visual theme for the interface. The graph itself looks the same across themes — only the panels, typography, and decorations change.',
    'settings.export.title':        'export',
    'settings.export.help':         'Save the current view as a PNG image, or export the graph data as JSON for use in other analysis tools.',
    'settings.export.png':          '📷 PNG screenshot',
    'settings.export.json':         '⤓ JSON graph',
    'settings.export.csv':          '⤓ CSV edges',
    'settings.history.title':       'file history',
    'settings.camera.title':        'camera presets',
    'settings.camera.help':         'Quick angles for different perspectives. Use Cmd/Ctrl + 1/2/3 to save the current view; press 1/2/3 to restore it.',
    'settings.camera.default':      'default',
    'settings.camera.top':          'top-down',
    'settings.camera.side':         'side',
    'history.settings.help': 'Auto-backups the latest 3 versions of each file on every save or external change. Stored in <code>.codesynapt/history/</code>. Default OFF.',
    'history.settings.toggle': 'Enable auto history',
    'trace.panel.empty':    'Idle… (MCP/CLI calls appear here)',
    // Full trace panel
    'kicker.ai_trace_full': 'ai trace · session',
    'trace.full.title':     'View full trace',
    'trace.filter.all':     'all tools',
    'trace.replay.title':   'Replay (re-emit 3D pulses)',
    'trace.export.title':   'Export to JSON',
    'trace.clear.title':    'Clear current session (disk preserved)',
    'trace.sessions.title': 'View past sessions',
    'trace.tab.log':        'log',
    'trace.tab.stats':      'stats',
    'trace.tab.sessions':   'sessions',
    'trace.meta':           'session {session} · {events} events · {files} files · {duration}',
    'trace.no_events':      'no trace events yet — CLI/MCP/HTTP API calls are logged here',
    'trace.loading':        'loading…',
    'trace.no_sessions':    'no saved sessions',
    'trace.session_load_failed': 'failed to load session',
    'trace.current':        'current',
    'trace.no_replay':      'no events to replay',
    'trace.cleared':        'session cleared',
    'trace.exported':       '{n} events exported to {path}',
    'trace.stats.by_tool':  'tool breakdown',
    'trace.stats.timeline': 'activity timeline',
    'trace.stats.top_files':'most-accessed files',
    'badge.orphan.title':    'Nothing imports this and it imports nothing — possible dead file',
    'badge.orphan.label':    '🟠 orphan',
    'badge.leaf.title':      'No other file imports this (entry point or unused)',
    'badge.leaf.label':      '🟡 no incoming',
    'badge.connected.title': '{n} files import this — active',
    'badge.connected.label': '🟢 connected · in:{in} out:{out}',
    'badge.conf.title':      "graph confidence — how certain this file's import/dependency analysis is",
    'badge.conf.high':       '🟢 high conf',
    'badge.conf.medium':     '🟡 med conf',
    'badge.conf.low':        '🔴 low conf',
    'badge.dynamic.title':   'dynamic import/call detected — static analysis may miss some deps (blast radius is a floor)',
    'badge.dynamic.label':   '⚡ dynamic {n}',
    'history.electron.required': 'Not Electron — history disabled',
    'history.off':              'Auto history OFF — enable in Settings',
    'history.none':             'No versions saved yet — first save creates one',
    'history.view':             'View',
    'history.restore':          'Restore',
    'history.snap_not_found':   'Snapshot not found',
    'history.viewing':          'Viewing older version ({when}) — saving disabled, click Restore to apply',
    'history.restore_failed':   'Restore failed: {err}',
    'history.restored':         'Restored to previous version',
    'editor.editing':           'editing…',
    'editor.save_unavailable':  'Save unavailable (not Electron)',
    'editor.saved':             'saved',
    'editor.unsaved':           'unsaved (autosave off · Ctrl+S or Diff button)',
    'editor.error':             'error: {err}',
    'editor.autosave':          'auto-save',
    'editor.autosave.title':    'Uncheck for manual save mode (Ctrl+S or Diff button)',
    'editor.diff.title':        'Preview diff (Ctrl+S)',
    'editor.diff.title_modal':  'Review changes before saving',
    'editor.diff.no_changes':   'No changes',
    'editor.diff.save':         '✓ Save',
    'editor.diff.cancel':       '✕ Revert',
    'editor.diff.skip_next':    'Save without prompting (this session)',
    'changes.empty':             'No files modified yet.<br>Edits by AI (Claude Code / Cursor) or your editor will appear here.',
    'changes.requires_electron': 'Changes panel requires the desktop app',
    'symbols.requires_electron': 'Symbol (function) layer requires the desktop app',
    'timelapse.requires_electron':  'Time-lapse requires the desktop app',
    'hints.drag':    'drag',
    'hints.orbit':   'orbit',
    'hints.scroll':  'scroll',
    'hints.zoom':    'zoom',
    'hints.click':   'click',
    'hints.inspect': 'inspect',
    'hints.hover':   'hover',
    'hints.focus':   'focus',
    'welcome.coord.visualizer': 'visualizer',
    'welcome.coord.offline':    'offline',
    'welcome.subtitle':         'a dependency observatory · point at any directory, watch the graph form',
    'welcome.begin':            'begin',
    'welcome.open_folder':      'Open Folder',
    'welcome.drag_hint':        'or drag a folder onto this window',
    'dialog.help':         "Add some context for this codebase. It'll show in the right panel whenever no file is selected, and persists across sessions. All fields are optional — you can skip and add them later.",
    'dialog.name':         'name',
    'dialog.version':      'version',
    'dialog.stack':        'stack',
    'dialog.description':  'description',
    'dialog.notes':        'notes',
    'dialog.description.ph':'What does this do?',
    'dialog.notes.ph':     'Architecture, conventions, anything you want to remember…',
    'dialog.name.ph':      'My awesome project',
    'dialog.stack.ph':     'React, TypeScript, Postgres…',
    'dialog.skip':         'Skip',
    'dialog.save':         'Save',
    'drop.overlay':        'drop folder to scan',
    'scan.scanning':       'Scanning…',
    'scan.building':       'Building graph…',
    'scan.files':          'files',
    'status.files':        'files',
    'status.edges':        'edges',
    'status.comp':         'comp',
    'status.symbols':      'syms',
    'status.symbols.title':'Symbol graph (codegraph-equivalent layer). Click to build — indexes function/class-level nodes.',
    'status.files.title':  'Total files in graph',
    'status.edges.title':  'Total connections',
    'status.comp.title':   'Connected components',
    'status.state.title':  'Simulation state',
    'status.changed.title':'Last file change',
    'status.backend.title':'Physics backend',
    'status.fps.title':    'Frames per second',
    'status.last_change':  'last change',
    'sim.paused':          'paused',
    'sim.dragging':        'dragging',
    'sim.settled':         'settled',
    'sim.simulating':      'simulating',
    'sim.cooling':         'cooling',
  },
}
let CURRENT_LANG = 'ko'
try {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved === 'en' || saved === 'ko') CURRENT_LANG = saved
} catch {}
function t(key, params) {
  let s = T[CURRENT_LANG]?.[key] ?? T.en[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
  return s
}
function applyI18nToDOM() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18n)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
  document.documentElement.lang = CURRENT_LANG
}
function setLang(lang) {
  if (lang !== 'ko' && lang !== 'en') return
  CURRENT_LANG = lang
  try { localStorage.setItem(LANG_KEY, lang) } catch {}
  applyI18nToDOM()
  // Re-render dynamic panels
  if (typeof refreshTracePanel === 'function') refreshTracePanel()
  if (typeof refreshChanges === 'function' && !document.getElementById('changes')?.classList.contains('hidden')) refreshChanges()
  if (typeof renderInspector === 'function' && state.selectedId && !inspector?.classList.contains('hidden')) renderInspector(state.selectedId)
  // pathLabel: if no folder loaded, show translated label; otherwise leave the path alone
  const pl = document.getElementById('pathLabel')
  if (pl && !state.root) pl.textContent = t('topbar.open_folder.label')
  // Language toggle lives inside the More menu — only update its icon span
  // so we don't clobber the menu item's `<span class="more-label">`.
  const langIcon = document.getElementById('langCurrent')
  if (langIcon) langIcon.textContent = lang === 'ko' ? 'EN' : '한'
}

const MAX_NODES = 300_000
const MAX_EDGES = 1_500_000
const LABEL_POOL = 10          // max simultaneous HTML labels
const PICK_THROTTLE_MS = 32    // hover update budget

// AI agent activity — how long a touched node keeps its pulse halo,
// and what color each operation type tints the pulse to.
const AI_TRACE_TTL_MS = 5500
const AI_TRACE_LOG_CAP = 20
const AI_TRACE_COLORS = {
  node:    [0.45, 0.85, 1.00],  // inspect → cyan
  file:    [0.45, 0.85, 1.00],  // read    → cyan
  deps:    [0.55, 0.75, 1.00],  // traverse → light blue
  users:   [0.55, 0.75, 1.00],
  history: [0.85, 0.75, 0.40],  // history → amber
  focus:   [1.00, 0.85, 0.40],  // ui focus → yellow
  open:    [1.00, 0.85, 0.40],
  write:   [0.30, 1.00, 0.50],  // write/edit/restore → vivid green (AI just modified this file)
  read:    [0.45, 0.85, 1.00],
  blast:   [1.00, 0.35, 0.55],  // blast radius → magenta-red
}

// ═══════════════════════════════════════════════════════════════
//  Environment / palette / utilities
// ═══════════════════════════════════════════════════════════════
const isElectron = !!window.codesynapt
if (window.platform?.isMac) document.body.classList.add('is-mac')

const TYPE_COLORS = {
  js: '#F4C453', jsx: '#7ECFCF', ts: '#5EAAD8', tsx: '#7ECFCF',
  mjs: '#F4C453', cjs: '#F4C453',
  py: '#6BCB77', pyw: '#6BCB77', pyi: '#6BCB77',
  lsp: '#A78BFA', dcl: '#A78BFA', lisp: '#A78BFA', el: '#A78BFA',
  css: '#E879A6', scss: '#E879A6', sass: '#E879A6', less: '#E879A6',
  html: '#F97316', htm: '#F97316',
  vue: '#42b883', svelte: '#FF3E00', astro: '#FF5D01',
  json: '#9CA3AF', yaml: '#9CA3AF', yml: '#9CA3AF', toml: '#9CA3AF',
  xml: '#9CA3AF',
  md: '#E8E8E8', mdx: '#E8E8E8', rst: '#CBD5E1',
  rs: '#DEA584', go: '#00ADD8', java: '#EA2D2E', kt: '#A97BFF',
  rb: '#CC342D', php: '#777BB4', swift: '#FA7343',
  c: '#A8B9CC', cc: '#00599C', cpp: '#00599C', h: '#A8B9CC', hpp: '#00599C',
  cs: '#178600',
  sh: '#89E051', bash: '#89E051', zsh: '#89E051',
  sql: '#E38C00',
  dwg: '#BC8F50', dxf: '#BC8F50',
}
const EDGE_COLORS = {
  import: '#7ECFCF', reexport: '#A78BFA', dynamic: '#F4C453',
  asset: '#F97316', ref: '#94A3B8',
}

function hashColor(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `hsl(${((h % 360) + 360) % 360}, 55%, 65%)`
}
const colorFor = (ext) => TYPE_COLORS[ext] || hashColor(ext || 'unknown')
const basename = (p) => p.split('/').pop()
const radiusFor = (n) => {
  const locR = 0.55 + Math.log1p(n.loc || 1) * 0.22
  const massR = n.mass ? Math.sqrt(Math.max(n.mass - 1, 0)) * 0.45 : 0
  return locR + massR
}

// Convert "#rrggbb" to 3 floats once
const colorBuf = new THREE.Color()
function hexToRGB(hex, out) {
  colorBuf.set(hex)
  out[0] = colorBuf.r; out[1] = colorBuf.g; out[2] = colorBuf.b
}

// ═══════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════
const state = {
  nodes: new Map(),     // id → node
  byIdx: [],            // compact array — order matches GPU buffers
  edges: [],            // {s, t, k}
  symbols: new Map(),   // symbolId → { id, file, name, kind, off, p, shown } — layer-2 function nodes
  symbolCalls: [],      // { s, t } — function-level call edges
  symbolAdj: new Map(), // symbolId → Set(neighbor symbolIds) — for hover focus
  showSymbols: false,   // toggle the 3D function/symbol layer
  adj: new Map(),       // id → Set(neighbor ids)
  hoverId: null,
  selectedId: null,
  paused: false,
  filterText: '',
  searchMode: 'highlight',   // 'highlight' | 'hide'
  searchSyntax: 'plain',     // 'plain' | 'glob' | 'regex'
  matchCount: 0,
  hiddenExts: new Set(),
  root: '',
  focusDepth: 3,        // hops to propagate emphasis when a node is focused
  showAllConnected: false, // when true, ignore focusDepth and reach every connected file
  folderGrouping: false,   // when true, files in the same folder get a weak attraction,
  folderClusterStrength: 0.30,  // 0..0.4 — pull intensity toward folder anchor
  folderClusterSpread:   0.85,  // 0.3..1.0 — anchor radius as fraction of world soft cap
  folderAreaOpacity:     0.06,  // 0..0.4 — folder bubble (area) max opacity (far)

  // User-tunable layout — scale spacing and node size at runtime
  nodeDistanceScale: 1.0,  // 0.3..3.0 — multiplies REPEL and REST
  nodeSizeScale: 1.0,      // 0.3..3.0 — multiplies the rendered point size
  maxWorldRadius: 200,     // 60..600 — world boundary; nodes can't drift beyond ~1.85× this

  // AI agent live trace — id -> { tool, lastAt } for nodes touched by
  // an MCP / CLI client in the last few seconds. Drives the pulse halo.
  aiTrace: new Map(),
  aiTraceLog: [],          // recent ops as { id, tool, ts } — last 20 for the side panel
  aiTrailIds: [],          // ordered list of { id, at } for the trail line, newest first

  // Time-lapse — git-history-driven node visibility filter.
  // fileBornAt: Map<id, epoch_ms>. timelineCutoff: ms epoch — nodes
  // born after this are hidden. null = show all (default).
  fileBornAt: new Map(),
  timelineCutoff: null,
  timelineBounds: null,    // { firstAt, lastAt } once loaded

  // Active set — user-curated list of files that are "really in use"
  // right now. When non-empty, files NOT in this set are dimmed in
  // the graph. Pipelines are named groups (e.g. "production",
  // "test runners") that can be toggled on/off independently;
  // activeFiles is the union of all currently-active pipelines plus
  // any ad-hoc starred files.
  activeFiles: new Set(),          // file ids the user marked "live"
  pipelines: [],                   // [{ id, name, files: string[] }]
  activePipelines: new Set(),      // pipeline ids that are toggled on
  activeSetMode: 'off',            // 'off' | 'dim' | 'hide'

  // Simulation
  sim: {
    alpha: 1, alphaTarget: 0,
    alphaDecay: 0.02, alphaMin: 0.0015,
    velocityDecay: 0.38,
  },

  // Interaction
  draggingNode: null, dragPlane: null, cameraDragging: false,
  lastPickAt: 0, lastMouseX: 0, lastMouseY: 0, mouseMoved: true,
}
// Debug hook — expose state on window so external inspectors (and
// tests) can read it. Cheap; not in any hot path.
if (typeof window !== 'undefined') window.__fg3d = { state, get cam() { return cam }, get scene() { return scene }, get camera() { return camera }, get folderBubbles() { return folderBubbles } }

function reheat(alpha = 0.3) {
  state.sim.alpha = Math.max(state.sim.alpha, alpha)
  state.sim.alphaTarget = 0
}

function rebuildAdjacency() {
  state.adj.clear()
  for (const e of state.edges) {
    if (!state.adj.has(e.s)) state.adj.set(e.s, new Set())
    if (!state.adj.has(e.t)) state.adj.set(e.t, new Set())
    state.adj.get(e.s).add(e.t)
    state.adj.get(e.t).add(e.s)
  }
}

// ─── Connected components ─────────────────────────────────────
// Group nodes by reachability. The biggest component is the "main
// cluster" — usually the bulk of the codebase. Smaller components
// (sub-projects, isolated test sets, orphans) get pulled toward
// the main cluster's centroid so they don't float off into the
// void of the sphere.
//
// componentId: 0 = main, 1+ = secondary. Stored on each node.
function rebuildComponents() {
  const visited = new Set()
  const comps = []
  for (const node of state.byIdx) {
    if (visited.has(node.id)) continue
    const memberIdxs = []
    const stack = [node.id]
    while (stack.length) {
      const id = stack.pop()
      if (visited.has(id)) continue
      visited.add(id)
      const n = state.nodes.get(id)
      if (!n) continue
      memberIdxs.push(n.idx)
      const adj = state.adj.get(id)
      if (adj) for (const nid of adj) if (!visited.has(nid)) stack.push(nid)
    }
    comps.push(memberIdxs)
  }
  // Sort largest first
  comps.sort((a, b) => b.length - a.length)
  // Assign componentId — 0 = main
  for (let ci = 0; ci < comps.length; ci++) {
    for (const idx of comps[ci]) {
      const n = state.byIdx[idx]
      if (n) n.componentId = ci
    }
  }
  state.componentCount = comps.length
  state.mainComponentIdxs = comps[0] || []
}

// Smoothed centroid + bounding radius of the main cluster + per
// sub-component centroids. The sub-centroids let us pull each
// sub-component as a unit, preserving its internal spring structure
// while moving the whole sub-cluster toward the main cluster.
const _mainCentroid = { x: 0, y: 0, z: 0 }
let _mainBoundR = 100
let _mainCentroidLastUpdate = 0
let _frameCounter = 0
const _subCentroids = new Map()  // componentId -> {x,y,z, count}
function refreshMainCentroid(frame) {
  if (!state.mainComponentIdxs || !state.mainComponentIdxs.length) return
  if (frame - _mainCentroidLastUpdate < 30) return
  _mainCentroidLastUpdate = frame
  let mx = 0, my = 0, mz = 0
  let count = 0
  for (const idx of state.mainComponentIdxs) {
    const n = state.byIdx[idx]
    if (!n) continue
    mx += n.p.x; my += n.p.y; mz += n.p.z
    count++
  }
  if (count === 0) return
  _mainCentroid.x = mx / count
  _mainCentroid.y = my / count
  _mainCentroid.z = mz / count
  const radii = []
  for (const idx of state.mainComponentIdxs) {
    const n = state.byIdx[idx]
    if (!n) continue
    const dx = n.p.x - _mainCentroid.x
    const dy = n.p.y - _mainCentroid.y
    const dz = n.p.z - _mainCentroid.z
    radii.push(Math.sqrt(dx*dx + dy*dy + dz*dz))
  }
  radii.sort((a, b) => a - b)
  const p95idx = Math.floor(radii.length * 0.95)
  _mainBoundR = Math.max(50, radii[p95idx] || 100)
  // Per-component centroids — single pass over all nodes accumulates
  // sums per componentId. Only non-main components matter for pull.
  _subCentroids.clear()
  for (const n of state.byIdx) {
    if (n.componentId === 0 || n.componentId === undefined) continue
    let c = _subCentroids.get(n.componentId)
    if (!c) { c = { x: 0, y: 0, z: 0, count: 0 }; _subCentroids.set(n.componentId, c) }
    c.x += n.p.x; c.y += n.p.y; c.z += n.p.z; c.count++
  }
  // Convert sums → means
  for (const c of _subCentroids.values()) {
    if (c.count > 0) { c.x /= c.count; c.y /= c.count; c.z /= c.count }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Three.js scene
// ═══════════════════════════════════════════════════════════════
const canvas = document.getElementById('canvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

// WebGL context can be lost under GPU pressure (driver reset, dGPU/iGPU
// switch, another GPU-heavy app). Without this the render loop would throw
// every frame and freeze the window. Pause rendering on loss, resume on
// restore. preventDefault() is required for the 'restored' event to fire.
let glContextLost = false
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); glContextLost = true }, false)
canvas.addEventListener('webglcontextrestored', () => { glContextLost = false }, false)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#03050C')
// Fog disabled — colors stay vivid at distance instead of fading
// into the background. Perspective (size attenuation) still works.
scene.fog = null

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000)

// ─── View cube — small camera-orientation widget (Blender-style) ──
// Renders a labeled cube in its own canvas, synced with the main
// camera so the cube face you see corresponds to the direction the
// main camera is looking from. Click a face to snap the main view.
const viewCubeCanvas = document.getElementById('viewCubeCanvas')
let viewCubeRenderer = null, viewCubeScene = null, viewCubeCamera = null, viewCubeMesh = null
if (viewCubeCanvas) {
  viewCubeRenderer = new THREE.WebGLRenderer({ canvas: viewCubeCanvas, antialias: true, alpha: true })
  viewCubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  viewCubeRenderer.setSize(viewCubeCanvas.width, viewCubeCanvas.height, false)
  viewCubeRenderer.setClearColor(0x000000, 0)
  viewCubeScene = new THREE.Scene()
  viewCubeCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10)
  viewCubeCamera.position.set(0, 0, 3.4)
  viewCubeCamera.lookAt(0, 0, 0)
  // Build labeled faces — each face is a 1×1 plane mapped to one cube
  // side, with text drawn into a canvas texture. Cube is a group of 6
  // planes (easier text orientation than CubeGeometry+texture array).
  const cubeGroup = new THREE.Group()
  // Glass cube style: nearly-transparent faces (just a light blue tint
  // + border + short single-letter label), with 3 colored axis lines
  // (X=red, Y=green, Z=blue) running through the cube. Reveals
  // orientation via the axis through-lines rather than face colors.
  const FACE_LABELS = [
    { label: 'F', pos: [0, 0,  0.5], rot: [0, 0, 0] },
    { label: 'B', pos: [0, 0, -0.5], rot: [0, Math.PI, 0] },
    { label: 'R', pos: [ 0.5, 0, 0], rot: [0,  Math.PI/2, 0] },
    { label: 'L', pos: [-0.5, 0, 0], rot: [0, -Math.PI/2, 0] },
    { label: 'T', pos: [0,  0.5, 0], rot: [-Math.PI/2, 0, 0] },
    { label: 'B', pos: [0, -0.5, 0], rot: [ Math.PI/2, 0, 0],
      userLabel: 'BOT' },   // distinct snap-target name so it doesn't collide with BACK
  ]
  function makeFaceTexture(label) {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')
    // Transparent background with light-blue tint + border.
    ctx.fillStyle = 'rgba(150, 200, 255, 0.04)'
    ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = 'rgba(150, 200, 255, 0.55)'
    ctx.lineWidth = 3
    ctx.strokeRect(2, 2, 124, 124)
    // Single-letter label, soft white.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.70)'
    ctx.font = 'bold 42px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    return tex
  }
  const planeGeo = new THREE.PlaneGeometry(1, 1)
  const faceData = []
  for (const f of FACE_LABELS) {
    const mat = new THREE.MeshBasicMaterial({
      map: makeFaceTexture(f.label),
      transparent: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(planeGeo, mat)
    mesh.position.set(...f.pos)
    mesh.rotation.set(...f.rot)
    // userLabel overrides for snap-target lookup (BOT vs the 'B'
    // shown on top of BACK and BOTTOM faces).
    mesh.userData.label = f.userLabel || (
      f.label === 'F' ? 'FRONT' :
      f.label === 'R' ? 'RIGHT' :
      f.label === 'L' ? 'LEFT'  :
      f.label === 'T' ? 'TOP'   :
      'BACK'   // any other 'B' (back face)
    )
    cubeGroup.add(mesh)
    faceData.push({ mesh, label: mesh.userData.label })
  }
  // Soft cube edges for definition (subtle)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01)),
    new THREE.LineBasicMaterial({ color: 0x96c8ff, transparent: true, opacity: 0.25 }),
  )
  cubeGroup.add(edges)
  // Three colored axis lines passing through the cube center.
  function makeAxisLine(color, axis) {
    const a = 0.6  // line extends slightly past cube faces
    const points = axis === 'x'
      ? [new THREE.Vector3(-a, 0, 0), new THREE.Vector3(a, 0, 0)]
      : axis === 'y'
      ? [new THREE.Vector3(0, -a, 0), new THREE.Vector3(0, a, 0)]
      : [new THREE.Vector3(0, 0, -a), new THREE.Vector3(0, 0, a)]
    const geo = new THREE.BufferGeometry().setFromPoints(points)
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
    return new THREE.Line(geo, mat)
  }
  cubeGroup.add(makeAxisLine(0xff5050, 'x'))   // X — red
  cubeGroup.add(makeAxisLine(0x60d060, 'y'))   // Y — green
  cubeGroup.add(makeAxisLine(0x5090ff, 'z'))   // Z — blue
  // Small colored caps at +X, +Y, +Z ends with letter labels.
  function makeAxisCap(color, label, position) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
    ctx.beginPath()
    ctx.arc(32, 32, 22, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 26px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 32, 32)
    const tex = new THREE.CanvasTexture(c)
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(0.22, 0.22, 1)
    sprite.position.set(...position)
    return sprite
  }
  cubeGroup.add(makeAxisCap(0xff5050, 'X', [0.65, 0, 0]))
  cubeGroup.add(makeAxisCap(0x60d060, 'Y', [0, 0.65, 0]))
  cubeGroup.add(makeAxisCap(0x5090ff, 'Z', [0, 0, 0.65]))
  viewCubeScene.add(cubeGroup)
  viewCubeMesh = cubeGroup
}

// Sync the view cube's orientation to the main camera. We compute the
// rotation that takes "where main camera looks from" → cube's local
// space, so the cube face presented to the cube's camera is the face
// closest to the main camera's viewing direction.
const _vcUp = new THREE.Vector3(0, 1, 0)
const _vcLook = new THREE.Vector3()
const _vcFrom = new THREE.Vector3()
function updateViewCube() {
  if (!viewCubeMesh) return
  // Main camera position → its direction from origin (since main camera
  // looks at cam.target, which is roughly origin). Use the inverse of
  // the main camera's quaternion as the cube's quaternion → the cube
  // face nearest to the camera looks "forward" to the cube renderer.
  _vcFrom.copy(camera.position).sub(cam.target).normalize()
  // Place the cube's "camera" by orienting the cube such that the
  // outward direction from cube center toward the main camera matches
  // _vcFrom. Simpler: set the cube's quaternion to camera.quaternion
  // inverse so the cube co-rotates with the world.
  viewCubeMesh.quaternion.copy(camera.quaternion).invert()
}
function renderViewCube() {
  if (!viewCubeRenderer) return
  updateViewCube()
  viewCubeRenderer.render(viewCubeScene, viewCubeCamera)
}

// View cube interaction:
//   - drag: rotates main camera (theta/phi)
//   - click (no drag): snaps main camera to that face
if (viewCubeCanvas) {
  const ray = new THREE.Raycaster()
  const FACE_PRE = {
    FRONT: { theta: Math.PI / 2,  phi: Math.PI / 2 },
    BACK:  { theta: -Math.PI / 2, phi: Math.PI / 2 },
    RIGHT: { theta: 0,            phi: Math.PI / 2 },
    LEFT:  { theta: Math.PI,      phi: Math.PI / 2 },
    TOP:   { theta: Math.PI / 2,  phi: 0.0001 },
    BOT:   { theta: Math.PI / 2,  phi: Math.PI - 0.0001 },
  }
  let cubeDragging = false
  let cubeDragMoved = false
  let cubeStartX = 0, cubeStartY = 0
  let cubeLastX = 0, cubeLastY = 0
  const DRAG_THRESHOLD = 3   // px before treating as drag (vs click)

  viewCubeCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    cubeDragging = true
    cubeDragMoved = false
    cubeStartX = cubeLastX = e.clientX
    cubeStartY = cubeLastY = e.clientY
    try { viewCubeCanvas.setPointerCapture(e.pointerId) } catch {}
  })
  viewCubeCanvas.addEventListener('pointermove', (e) => {
    if (!cubeDragging) return
    const totalDx = e.clientX - cubeStartX
    const totalDy = e.clientY - cubeStartY
    if (!cubeDragMoved && Math.abs(totalDx) + Math.abs(totalDy) > DRAG_THRESHOLD) {
      cubeDragMoved = true
    }
    if (cubeDragMoved && cam) {
      cam.theta += (e.clientX - cubeLastX) * 0.005
      cam.phi   -= (e.clientY - cubeLastY) * 0.005
      cam.phi = Math.max(0.001, Math.min(Math.PI - 0.001, cam.phi))
      cubeLastX = e.clientX
      cubeLastY = e.clientY
      markUserInteraction?.()
    }
  })
  function cubePointerEnd(e) {
    if (!cubeDragging) return
    cubeDragging = false
    if (!cubeDragMoved) {
      // Was a click — do face snap.
      const rect = viewCubeCanvas.getBoundingClientRect()
      const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const my = -((e.clientY - rect.top) / rect.height) * 2 + 1
      ray.setFromCamera({ x: mx, y: my }, viewCubeCamera)
      const targets = viewCubeMesh.children.filter((c) => c.userData?.label)
      const hits = ray.intersectObjects(targets, false)
      if (hits.length) {
        const face = hits[0].object.userData.label
        const p = FACE_PRE[face]
        if (p && cam) {
          cam.theta = p.theta
          cam.phi = p.phi
          markUserInteraction?.()
        }
      }
    }
    try { viewCubeCanvas.releasePointerCapture(e.pointerId) } catch {}
  }
  viewCubeCanvas.addEventListener('pointerup', cubePointerEnd)
  viewCubeCanvas.addEventListener('pointercancel', cubePointerEnd)
}

// ─── Starfield background ───────────────────────────────────────
function createStarfield() {
  const count = 3500
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const palettes = [
    [1, 1, 1], [0.85, 0.92, 1], [1, 0.95, 0.82],
    [1, 0.78, 0.58], [0.95, 0.65, 0.55], [0.68, 0.80, 1],
  ]
  for (let i = 0; i < count; i++) {
    const r = 800 + Math.random() * 900
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    pos[i*3]   = r * Math.sin(phi) * Math.cos(theta)
    pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta) * 0.6
    pos[i*3+2] = r * Math.cos(phi)
    const p = palettes[Math.floor(Math.random() * palettes.length)]
    const b = 0.25 + Math.pow(Math.random(), 2.2) * 0.85
    col[i*3] = p[0] * b; col[i*3+1] = p[1] * b; col[i*3+2] = p[2] * b
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.9, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.92, depthWrite: false,
  }))
}
const starfield = createStarfield()
scene.add(starfield)

// ─── Nebula clouds ──────────────────────────────────────────────
function makeGradientTexture(stops) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  for (const [pos, color] of stops) g.addColorStop(pos, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(c)
}
const nebulaTex = makeGradientTexture([
  [0, 'rgba(255,255,255,0.32)'],
  [0.35, 'rgba(255,255,255,0.08)'],
  [1, 'rgba(255,255,255,0)'],
])
function createNebula() {
  const group = new THREE.Group()
  const palette = ['#4a3c8a', '#1c4f6b', '#7a2c5a', '#2c4a8a', '#5a3070']
  for (let i = 0; i < 5; i++) {
    const m = new THREE.SpriteMaterial({
      map: nebulaTex, color: palette[i % palette.length],
      blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.32,
    })
    const sprite = new THREE.Sprite(m)
    const r = 300 + Math.random() * 250
    const theta = Math.random() * Math.PI * 2
    sprite.position.set(r * Math.cos(theta), (Math.random() - 0.5) * 80, r * Math.sin(theta))
    sprite.scale.setScalar(320 + Math.random() * 260)
    group.add(sprite)
  }
  return group
}
const nebula = createNebula()
scene.add(nebula)

// ─── Node points (one Points object for ALL nodes) ──────────────
const glowTexture = makeGradientTexture([
  [0, 'rgba(255,255,255,1)'],
  [0.42, 'rgba(255,255,255,1)'],
  [0.48, 'rgba(255,255,255,0.85)'],
  [0.5, 'rgba(255,255,255,0)'],
  [1, 'rgba(255,255,255,0)'],
])

const nodePositions = new Float32Array(MAX_NODES * 3)
const nodeColors    = new Float32Array(MAX_NODES * 3)
const nodeSizes     = new Float32Array(MAX_NODES)
const nodeAlphas    = new Float32Array(MAX_NODES)

const nodeGeo = new THREE.BufferGeometry()
const nodePosAttr   = new THREE.BufferAttribute(nodePositions, 3); nodePosAttr.setUsage(THREE.DynamicDrawUsage)
const nodeColorAttr = new THREE.BufferAttribute(nodeColors, 3);    nodeColorAttr.setUsage(THREE.DynamicDrawUsage)
const nodeSizeAttr  = new THREE.BufferAttribute(nodeSizes, 1);     nodeSizeAttr.setUsage(THREE.DynamicDrawUsage)
const nodeAlphaAttr = new THREE.BufferAttribute(nodeAlphas, 1);    nodeAlphaAttr.setUsage(THREE.DynamicDrawUsage)
nodeGeo.setAttribute('position', nodePosAttr)
nodeGeo.setAttribute('color', nodeColorAttr)
nodeGeo.setAttribute('size', nodeSizeAttr)
nodeGeo.setAttribute('alpha', nodeAlphaAttr)
nodeGeo.setDrawRange(0, 0)

// Custom shader: per-point size with distance attenuation, per-point alpha, soft glow texture
const nodeVertex = /* glsl */`
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(size * (320.0 / -mv.z), 2.0);
    gl_Position = projectionMatrix * mv;
  }
`
const nodeFragment = /* glsl */`
  uniform sampler2D pointTexture;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(pointTexture, gl_PointCoord);
    if (tex.a < 0.01) discard;
    gl_FragColor = vec4(vColor, vAlpha) * tex;
  }
`
const nodeMat = new THREE.ShaderMaterial({
  uniforms: { pointTexture: { value: glowTexture } },
  vertexShader: nodeVertex, fragmentShader: nodeFragment,
  vertexColors: true, transparent: true,
  blending: THREE.NormalBlending, depthWrite: false,
})
const nodePoints = new THREE.Points(nodeGeo, nodeMat)
nodePoints.frustumCulled = false   // we manage visibility ourselves
scene.add(nodePoints)

// ─── Edges (pre-allocated LineSegments) ─────────────────────────
const edgePositions = new Float32Array(MAX_EDGES * 6)
const edgeColorsBuf = new Float32Array(MAX_EDGES * 6)
const edgeGeo = new THREE.BufferGeometry()
const edgePosAttr   = new THREE.BufferAttribute(edgePositions, 3); edgePosAttr.setUsage(THREE.DynamicDrawUsage)
const edgeColorAttr = new THREE.BufferAttribute(edgeColorsBuf, 3); edgeColorAttr.setUsage(THREE.DynamicDrawUsage)
edgeGeo.setAttribute('position', edgePosAttr)
edgeGeo.setAttribute('color', edgeColorAttr)
edgeGeo.setDrawRange(0, 0)
const edgeMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.55,
})
const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat)
edgeLines.frustumCulled = false
scene.add(edgeLines)

// AI trail line — connects the last N nodes touched by an AI agent,
// drawn as a single THREE.Line with vertex colors fading from old
// (transparent) → new (bright magenta). Lets you see the agent's
// navigation path through the codebase.
const TRAIL_MAX = 32
const trailPositions = new Float32Array(TRAIL_MAX * 3)
const trailColors = new Float32Array(TRAIL_MAX * 3)
const trailGeo = new THREE.BufferGeometry()
const trailPosAttr   = new THREE.BufferAttribute(trailPositions, 3); trailPosAttr.setUsage(THREE.DynamicDrawUsage)
const trailColorAttr = new THREE.BufferAttribute(trailColors,    3); trailColorAttr.setUsage(THREE.DynamicDrawUsage)
trailGeo.setAttribute('position', trailPosAttr)
trailGeo.setAttribute('color', trailColorAttr)
trailGeo.setDrawRange(0, 0)
const trailMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.8, linewidth: 2,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
const trailLine = new THREE.Line(trailGeo, trailMat)
trailLine.frustumCulled = false
scene.add(trailLine)

// ─── Symbol layer (layer-2): functions/methods as points clustered around
// their parent file node, with call edges between them. Same Points +
// LineSegments batching as the file graph. Off by default; toggled from the
// status-bar symbol cell, which fetches /symbol/graph. Positioned each frame
// at parentFile.p + a stable per-symbol offset so functions ride their file.
const MAX_SYMBOLS = 40000
const MAX_SYMBOL_EDGES = 80000
const symPositions = new Float32Array(MAX_SYMBOLS * 3)
const symColors    = new Float32Array(MAX_SYMBOLS * 3)
const symGeo = new THREE.BufferGeometry()
const symPosAttr = new THREE.BufferAttribute(symPositions, 3); symPosAttr.setUsage(THREE.DynamicDrawUsage)
const symColAttr = new THREE.BufferAttribute(symColors, 3);    symColAttr.setUsage(THREE.DynamicDrawUsage)
symGeo.setAttribute('position', symPosAttr)
symGeo.setAttribute('color', symColAttr)
symGeo.setDrawRange(0, 0)
const symMat = new THREE.PointsMaterial({
  size: 3.2, sizeAttenuation: true, vertexColors: true,
  transparent: true, opacity: 0.9, depthWrite: false,   // normal blending → distinct dots, not a glow blob
})
const symPoints = new THREE.Points(symGeo, symMat)
symPoints.frustumCulled = false
symPoints.visible = false
scene.add(symPoints)

const symEdgePositions = new Float32Array(MAX_SYMBOL_EDGES * 6)
const symEdgeColors    = new Float32Array(MAX_SYMBOL_EDGES * 6)
const symEdgeGeo = new THREE.BufferGeometry()
const symEdgePosAttr = new THREE.BufferAttribute(symEdgePositions, 3); symEdgePosAttr.setUsage(THREE.DynamicDrawUsage)
const symEdgeColAttr = new THREE.BufferAttribute(symEdgeColors, 3);    symEdgeColAttr.setUsage(THREE.DynamicDrawUsage)
symEdgeGeo.setAttribute('position', symEdgePosAttr)
symEdgeGeo.setAttribute('color', symEdgeColAttr)
symEdgeGeo.setDrawRange(0, 0)
const symEdgeMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false,
})
const symEdgeLines = new THREE.LineSegments(symEdgeGeo, symEdgeMat)
symEdgeLines.frustumCulled = false
symEdgeLines.visible = false
scene.add(symEdgeLines)

const SYM_KIND_COLOR = {
  function:  new THREE.Color(0x6fe0ff), method: new THREE.Color(0x8affc1),
  class:     new THREE.Color(0xffd479), interface: new THREE.Color(0xc8a2ff),
  type:      new THREE.Color(0xc8a2ff), const: new THREE.Color(0x9aa7b5),
}
const _symDefColor = new THREE.Color(0x9fd0ff)
const _symHiColor  = new THREE.Color(0xffffff)   // hovered/selected symbol point

// Floating tooltip for the hovered function — the dense symbol layer has no
// per-point labels, so this answers "which function is this?".
const symTip = document.createElement('div')
symTip.id='symTip';symTip.style.cssText = 'position:fixed;pointer-events:none;z-index:50;display:none;padding:3px 7px;border-radius:5px;background:rgba(8,12,20,0.92);color:#cfe8ff;font:11px/1.35 ui-monospace,monospace;border:1px solid rgba(120,180,255,0.4);white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis'
document.body.appendChild(symTip)

// ───────────────────────────────────────────────────────────────
// Folder bubbles — translucent colored spheres that wrap each
// top-level folder cluster when grouping is on. Non-interactive
// (not added to the picking path). Color per folder is a
// deterministic hash → HSL hue.
// ───────────────────────────────────────────────────────────────
const folderBubbleGeo = new THREE.SphereGeometry(1, 28, 18)
const folderBubbles = new Map()   // folderName -> THREE.Mesh
const folderBubbleCentroidSmooth = new Map()  // folderName -> {x,y,z} smoothed last-frame centroid (anti-jitter)

// Bubble radius formula. Two regimes:
//   - count ≤ 200:  sqrt growth feels natural for typical folders
//   - count >  200: switches to log growth so a (root) cluster with
//                   thousands of files doesn't engulf the entire scene
// SOFT cap at maxWorld * 0.55 — radii above the cap get progressively
// log-compressed so really big clusters still look bigger than medium
// ones, but never engulf the world.
function folderBubbleRadius(count) {
  const c = Math.max(1, count || 1)
  const small = 14 + Math.sqrt(c) * 4.5
  const large = 80 + Math.log10(c + 1) * 35
  const raw = c < 200 ? small : Math.min(small, large)
  const cap = (state.maxWorldRadius || 200) * 0.55
  if (raw <= cap) return raw
  // Above cap: log-compress so raw=2*cap maps to ~cap*1.28
  return cap + Math.log(1 + (raw - cap) / cap) * cap * 0.4
}
// Curated palette — avoids muddy hash collisions. Hues chosen to be
// visually distinct, slightly desaturated for "aesthetic" rather than
// neon. 10 colors → folders cycle.
const FOLDER_PALETTE = [
  { h: 0.95, s: 0.70, l: 0.65 },  // soft pink
  { h: 0.52, s: 0.55, l: 0.62 },  // teal cyan
  { h: 0.13, s: 0.75, l: 0.62 },  // peach / warm orange
  { h: 0.75, s: 0.50, l: 0.68 },  // lavender purple
  { h: 0.40, s: 0.50, l: 0.55 },  // mint green
  { h: 0.02, s: 0.65, l: 0.62 },  // coral red
  { h: 0.60, s: 0.60, l: 0.65 },  // sky blue
  { h: 0.85, s: 0.55, l: 0.72 },  // light lavender
  { h: 0.08, s: 0.55, l: 0.60 },  // amber
  { h: 0.48, s: 0.50, l: 0.55 },  // sea green
]
function folderHueValue(folderName) {
  let h = 0
  for (let i = 0; i < folderName.length; i++) h = (h * 31 + folderName.charCodeAt(i)) | 0
  return FOLDER_PALETTE[Math.abs(h) % FOLDER_PALETTE.length].h
}
function folderPaletteIndex(folderName) {
  let h = 0
  for (let i = 0; i < folderName.length; i++) h = (h * 31 + folderName.charCodeAt(i)) | 0
  return Math.abs(h) % FOLDER_PALETTE.length
}
function folderHueColor(folderName, lightness) {
  const p = FOLDER_PALETTE[folderPaletteIndex(folderName)]
  const c = new THREE.Color()
  c.setHSL(p.h, p.s, lightness != null ? lightness : p.l)
  return c
}
function ensureFolderBubbles(anchorMap) {
  // Remove bubbles for folders no longer in the map
  for (const [folder, mesh] of folderBubbles) {
    if (!anchorMap.has(folder)) {
      scene.remove(mesh)
      mesh.material.dispose()
      folderBubbles.delete(folder)
      folderBubbleCentroidSmooth.delete(folder)
    }
  }
  // Compute actual cluster centroid per folder — the bubble wraps the
  // CLUSTER, not the anchor. Outer rings get pulled inward slightly by
  // center gravity, so anchor ≠ cluster centroid. Centering on centroid
  // guarantees the bubble always contains its files.
  const centroids = new Map()
  const cCounts = new Map()
  for (const node of state.byIdx) {
    const fkey = anchorMap.has(node.folder) ? node.folder : '(root)'
    if (!anchorMap.has(fkey)) continue
    let c = centroids.get(fkey)
    if (!c) { c = { x: 0, y: 0, z: 0 }; centroids.set(fkey, c) }
    c.x += node.p.x; c.y += node.p.y; c.z += node.p.z
    cCounts.set(fkey, (cCounts.get(fkey) || 0) + 1)
  }
  for (const [fkey, c] of centroids) {
    const n = cCounts.get(fkey) || 1
    c.x /= n; c.y /= n; c.z /= n
  }
  for (const [folder, anchor] of anchorMap) {
    let mesh = folderBubbles.get(folder)
    const radius = folderBubbleRadius(anchor.count || 1)
    if (!mesh) {
      const material = new THREE.MeshBasicMaterial({
        color: folderHueColor(folder),
        transparent: true,
        opacity: 0.20,
        blending: THREE.NormalBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      mesh = new THREE.Mesh(folderBubbleGeo, material)
      mesh.frustumCulled = false
      mesh.userData.folderBubble = true
      mesh.userData.folder = folder
      scene.add(mesh)
      folderBubbles.set(folder, mesh)
    }
    mesh.scale.setScalar(radius)
    // Position at cluster centroid if available, else anchor (initial frame)
    const pos = centroids.get(folder) || anchor
    mesh.position.set(pos.x, pos.y, pos.z)
    mesh.visible = !!state.folderGrouping
  }
}
function hideFolderBubbles() {
  for (const mesh of folderBubbles.values()) mesh.visible = false
}

// Update each bubble's position to its cluster's centroid every frame.
// Also boosts opacity for far-away bubbles so they don't visually fade
// out when zoomed out — apparent on-screen size ≈ radius / distance,
// alpha scales inversely so total "color amount" stays roughly constant.
const _camWorld = new THREE.Vector3()
function updateFolderBubblesToCentroids() {
  if (!state.folderGrouping || folderBubbles.size === 0) return
  const sums = new Map()
  for (const node of state.byIdx) {
    const fkey = folderBubbles.has(node.folder) ? node.folder : '(root)'
    if (!folderBubbles.has(fkey)) continue
    let s = sums.get(fkey)
    if (!s) { s = { x: 0, y: 0, z: 0, n: 0 }; sums.set(fkey, s) }
    s.x += node.p.x; s.y += node.p.y; s.z += node.p.z; s.n++
  }
  camera.getWorldPosition(_camWorld)
  for (const [folder, mesh] of folderBubbles) {
    const s = sums.get(folder)
    if (s && s.n > 0) {
      // Smooth the centroid across frames so a few jittery nodes
      // don't make the whole bubble shake. Lerp factor 0.15 ≈ 200 ms
      // half-life at 60fps — fast enough to follow real movement,
      // slow enough to ignore micro-oscillations.
      const cx = s.x / s.n, cy = s.y / s.n, cz = s.z / s.n
      const prev = folderBubbleCentroidSmooth.get(folder)
      if (prev) {
        prev.x += (cx - prev.x) * 0.15
        prev.y += (cy - prev.y) * 0.15
        prev.z += (cz - prev.z) * 0.15
        mesh.position.set(prev.x, prev.y, prev.z)
      } else {
        folderBubbleCentroidSmooth.set(folder, { x: cx, y: cy, z: cz })
        mesh.position.set(cx, cy, cz)
      }
    }
    const dist = mesh.position.distanceTo(_camWorld)
    const radius = mesh.scale.x || 1
    const apparent = radius / Math.max(dist, 1)        // ~1 close, ~0 far
    // Two-axis compensation: keep RENDERED rgb roughly constant by
    // adjusting BOTH alpha AND color lightness inversely with apparent
    // size. On a black background, rendered = alpha × color, so we
    // can keep the product ~constant by raising color brightness
    // when bubble shrinks on screen.
    //
    //   t = clamp(0, 1, 1 - apparent)   // 0 close, 1 far
    //   alpha     = 0.18 + 0.32 × t      // 0.18 → 0.50
    //   lightness = 0.55 + 0.35 × t      // 0.55 → 0.90 (HSL)
    //
    // alpha 0.18 × color@L=0.55 ≈ (39, 17, 17)   close
    // alpha 0.50 × color@L=0.90 ≈ (130, 116, 116) far  ← much brighter
    const t = Math.max(0, Math.min(1, 1 - apparent))
    // Slider-controlled: state.folderAreaOpacity is the FAR (max) opacity; near
    // is 20% of it so the distance-fade is preserved at any level.
    mesh.material.opacity = (state.folderAreaOpacity ?? 0.06) * (0.2 + 0.8 * t)
    const folderName = mesh.userData.folder || ''
    const p = FOLDER_PALETTE[folderPaletteIndex(folderName)]
    const L = p.l + (0.92 - p.l) * t              // palette L → near 0.92 far
    mesh.material.color.setHSL(p.h, p.s, L)
  }
}

// Folder name labels — one DOM div per cluster, positioned at the
// projected anchor in screen space. Hidden when grouping is off.
const folderLabelPool = new Map()   // folderName -> div
function updateFolderLabels(rect, halfW, halfH, proj) {
  const host = document.getElementById('folderLabels')
  if (!host) return
  if (!state.folderGrouping || folderCentroids.size === 0) {
    for (const el of folderLabelPool.values()) el.style.opacity = '0'
    return
  }
  // Remove labels for folders that no longer exist
  for (const [folder, el] of folderLabelPool) {
    if (!folderCentroids.has(folder)) {
      el.remove()
      folderLabelPool.delete(folder)
    }
  }
  // Position each label at its bubble's center (= cluster centroid)
  const v = new THREE.Vector3()
  for (const [folder, anchor] of folderCentroids) {
    let el = folderLabelPool.get(folder)
    if (!el) {
      el = document.createElement('div')
      el.className = 'folder-label'
      const color = folderHueColor(folder)
      const c = new THREE.Color().copy(color)
      const hsl = { h: 0, s: 0, l: 0 }
      c.getHSL(hsl)
      c.setHSL(hsl.h, 0.6, 0.75)
      el.style.color = '#' + c.getHexString()
      host.appendChild(el)
      folderLabelPool.set(folder, el)
    }
    el.textContent = folder
    const bubble = folderBubbles.get(folder)
    const pos = bubble ? bubble.position : anchor
    v.set(pos.x, pos.y, pos.z).project(camera)
    if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) {
      el.style.opacity = '0'; continue
    }
    el.style.left = (rect.left + v.x * halfW + halfW) + 'px'
    el.style.top  = (rect.top + -v.y * halfH + halfH) + 'px'
    el.style.opacity = '0.9'
  }
}

// ═══════════════════════════════════════════════════════════════
//  Camera
// ═══════════════════════════════════════════════════════════════
const cam = {
  radius: 90, targetRadius: 90,
  theta: Math.PI / 4, phi: Math.PI / 2 - 0.3,
  target: new THREE.Vector3(),
  targetGoal: new THREE.Vector3(),
}

// Trackball rotation: mouse delta interpreted in camera VIEW space.
// Horizontal drag rotates around camera's up axis, vertical around
// its right axis. Result feels "natural" regardless of current view
// (no roll-when-looking-down spherical artifact). After rotation we
// re-derive cam.theta/phi/radius so the rest of the system stays in
// sync.
const _tbOffset = new THREE.Vector3()
const _tbForward = new THREE.Vector3()
const _tbRight = new THREE.Vector3()
const _tbUp = new THREE.Vector3()
const _tbWorldUp = new THREE.Vector3(0, 1, 0)
const _tbQX = new THREE.Quaternion()
const _tbQY = new THREE.Quaternion()
function applyTrackballRotation(dx, dy, sensitivity) {
  const s = sensitivity != null ? sensitivity : 0.005
  // Build offset = position - target. Note: cam.target lags toward
  // cam.targetGoal each frame, so we use cam.target here (current).
  _tbOffset.copy(camera.position).sub(cam.target)
  const r = _tbOffset.length()
  if (r < 0.0001) return
  // Forward = direction camera is looking (target - position).
  _tbForward.copy(_tbOffset).multiplyScalar(-1 / r)
  // Right = forward × worldUp (handles near-pole case via fallback)
  _tbRight.crossVectors(_tbForward, _tbWorldUp)
  if (_tbRight.lengthSq() < 1e-6) {
    // Camera looking straight up/down — pick arbitrary right axis.
    _tbRight.set(1, 0, 0)
  } else {
    _tbRight.normalize()
  }
  // Up = right × forward
  _tbUp.crossVectors(_tbRight, _tbForward).normalize()
  // Rotate offset: dx around up (yaw in view), dy around right (pitch).
  _tbQX.setFromAxisAngle(_tbUp,    -dx * s)
  _tbQY.setFromAxisAngle(_tbRight, -dy * s)
  _tbOffset.applyQuaternion(_tbQX).applyQuaternion(_tbQY)
  // Re-derive spherical state from rotated offset.
  const newR = _tbOffset.length()
  cam.theta = Math.atan2(_tbOffset.x, _tbOffset.z)
  cam.phi = Math.acos(Math.max(-1, Math.min(1, _tbOffset.y / newR)))
  // Clamp phi just shy of poles to keep spherical math stable.
  cam.phi = Math.max(0.001, Math.min(Math.PI - 0.001, cam.phi))
}

// Auto-frame: set camera distance so the cluster body fills the canvas.
//
// Node-radius distribution in force-directed graphs is heavy-tailed:
// 50 % of nodes cluster near origin (hub region), 5 % drift far out
// (orphan halo). Using max-R framing puts the camera so far back the
// dense center looks like a single pixel. Using median-R is too close
// and clips most of the cluster.
//
// Compromise: use P85 — captures the bulk of the visible cloud while
// ignoring the long-tail outliers. Resulting distance puts the dense
// hub region in the middle and the spread halo near the edges.
function frameToFitAll(options = {}) {
  const margin = options.margin || 1.10
  // AutoCAD Z/X "Zoom Extents" semantics: fit the ACTUAL bounding
  // sphere — every node visible, no clipping. Heavy-tailed outliers
  // make this look small, but that's what "show me everything" means.
  if (!state.byIdx || state.byIdx.length === 0) return
  let maxR2 = 0
  for (const node of state.byIdx) {
    const p = node.p
    const r2 = p.x * p.x + p.y * p.y + p.z * p.z
    if (r2 > maxR2) maxR2 = r2
  }
  const fitR = Math.max(50, Math.sqrt(maxR2))
  const vfov = camera.fov * (Math.PI / 180)
  const aspect = camera.aspect || (window.innerWidth / Math.max(1, window.innerHeight))
  const hfov = 2 * Math.atan(aspect * Math.tan(vfov / 2))
  const limitFov = Math.min(vfov, hfov)
  const dist = (fitR * margin) / Math.tan(limitFov / 2)
  cam.targetGoal.set(0, 0, 0)
  cam.targetRadius = Math.min(5500, Math.max(20, dist))
}
function updateCamera() {
  const sinPhi = Math.sin(cam.phi)
  const cosPhi = Math.cos(cam.phi)
  const sinTh  = Math.sin(cam.theta)
  const cosTh  = Math.cos(cam.theta)
  camera.position.set(
    cam.target.x + cam.radius * sinPhi * cosTh,
    cam.target.y + cam.radius * cosPhi,
    cam.target.z + cam.radius * sinPhi * sinTh
  )
  camera.up.set(-cosPhi * cosTh, sinPhi, -cosPhi * sinTh)
  camera.lookAt(cam.target)
}
const IDLE_ROTATE_THRESHOLD_MS = 4000  // start auto-rotating after this idle period
const IDLE_ROTATE_SPEED = 0.06         // rad/sec — slow cinematic spin
let lastUserInteractionAt = performance.now()
function markUserInteraction() { lastUserInteractionAt = performance.now() }
function tickCamera(dt) {
  const k = 1 - Math.exp(-dt * 12)
  cam.radius += (cam.targetRadius - cam.radius) * k
  cam.target.lerp(cam.targetGoal, k)
  // Idle auto-rotate — gentle spin around the focus target when the
  // user hasn't touched anything for a few seconds. Stops the moment
  // they interact, and respects the ❚❚ pause button.
  const idleFor = performance.now() - lastUserInteractionAt
  if (!state.paused
      && idleFor > IDLE_ROTATE_THRESHOLD_MS
      && !state.draggingNode
      && !state.cameraDragging) {
    // Ease in over 1 second after threshold
    const ease = Math.min(1, (idleFor - IDLE_ROTATE_THRESHOLD_MS) / 1000)
    cam.theta += dt * IDLE_ROTATE_SPEED * ease
  }
  updateCamera()
}

// ═══════════════════════════════════════════════════════════════
//  Spatial hash grid — flat Int32Array linked lists, zero alloc.
//
//  Uses a fixed 64³ cell grid with modular wrapping. Wrap-induced
//  false-positives are filtered by the distance check in the
//  physics inner loop, so coexistence in the same bucket without
//  spatial adjacency is harmless. Build is a tight loop over a
//  preallocated Int32Array; query walks linked-list nodes via
//  another preallocated array. No GC, no Map overhead.
// ═══════════════════════════════════════════════════════════════
const GRID_CELL = 11
const GRID_INV = 1 / GRID_CELL
const GRID_SIZE_BITS = 6                       // 64 cells per axis
const GRID_SIZE = 1 << GRID_SIZE_BITS          // 64
const GRID_MASK = GRID_SIZE - 1
const GRID_TOTAL = GRID_SIZE * GRID_SIZE * GRID_SIZE   // 262 144

const cellHead = new Int32Array(GRID_TOTAL)
const nextInCell = new Int32Array(MAX_NODES)

function buildGrid(arr) {
  cellHead.fill(-1)
  const n = arr.length
  for (let i = 0; i < n; i++) {
    const p = arr[i].p
    const cx = ((p.x * GRID_INV) | 0) & GRID_MASK
    const cy = ((p.y * GRID_INV) | 0) & GRID_MASK
    const cz = ((p.z * GRID_INV) | 0) & GRID_MASK
    const cell = (cx << (GRID_SIZE_BITS * 2)) | (cy << GRID_SIZE_BITS) | cz
    nextInCell[i] = cellHead[cell]
    cellHead[cell] = i
  }
}

// ═══════════════════════════════════════════════════════════════
//  Stellar mechanics — CPU implementation (fallback path)
//
//  Three tricks make this work at hundreds-of-thousands of nodes:
//
//   1. Inlined float math. Vector3 method calls (subVectors,
//      normalize, multiplyScalar) are 3-5× slower than direct
//      .x/.y/.z arithmetic in V8's JIT. The hot inner loop uses
//      only local floats — no object allocations, no method
//      dispatch.
//
//   2. Linked-list flat grid. No Map, no array.push, no GC. The
//      grid is two Int32Arrays.
//
//   3. Round-robin for BOTH repulsion and springs. Each tick
//      processes only RR_CHUNK active nodes and SPRING_CHUNK
//      edges. Work per tick is independent of total N and E.
//      Integration still runs on every node — that's a cheap
//      O(N) pass essential for visual smoothness.
//
//  In v0.6+ this path remains as the fallback when WebGPU is
//  unavailable, disabled, or under contention (see backend.js).
// ═══════════════════════════════════════════════════════════════
let rrCursor = 0, springCursor = 0

function stepCPU(dt) {
  const sim = state.sim
  const arr = state.byIdx
  const n = arr.length
  if (n === 0) return
  // While the user is dragging a node, freeze the rest of the graph
  // — no force-sim runs, so unrelated nodes don't drift in response
  // to the dragged node's spring tension. The dragged node's position
  // is updated directly by the pointermove handler.
  if (state.draggingNode) return

  // Disperse animation — when folder grouping was just turned off, lerp
  // every node toward its assigned sphere target with an ease-in-out
  // curve. ~70 frames (~1.2s) gives a smooth dispersal instead of an
  // instant teleport. Slow start prevents the first-frame "snap" that a
  // constant lerp coefficient causes.
  if (state.disperseFrames > 0) {
    const totalFrames = state.disperseTotal || 70
    const progressed = totalFrames - state.disperseFrames
    state.disperseFrames--
    // Ease-in-out cubic for per-frame interpolation amount
    const t = progressed / totalFrames
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const tPrev = (progressed - 1) / totalFrames
    const easedPrev = tPrev < 0.5 ? 4 * tPrev * tPrev * tPrev : 1 - Math.pow(-2 * tPrev + 2, 3) / 2
    // The step fraction is the increment of the eased curve this frame,
    // mapped through remaining-distance lerp factor for numerical stability.
    const stepFrac = Math.min(1, (eased - easedPrev) / Math.max(0.001, 1 - easedPrev))
    for (let i = 0; i < n; i++) {
      const node = arr[i]
      if (!node.target) continue
      node.p.lerp(node.target, stepFrac)
      node.v.x *= 0.6; node.v.y *= 0.6; node.v.z *= 0.6   // damp existing motion
    }
    if (state.disperseFrames === 0) {
      for (let i = 0; i < n; i++) arr[i].target = null
    }
    return  // skip normal physics during dispersal
  }

  sim.alpha += (sim.alphaTarget - sim.alpha) * sim.alphaDecay

  // Settled — just coast residual velocity
  if (sim.alpha < sim.alphaMin && !state.draggingNode) {
    sim.alpha = 0
    // Cold-state outlier check: if any node drifted beyond the
    // soft cap, also enforce the hard clamp in place AND kick the
    // simulation back on so the soft cap can rein it in further.
    const distScaleCold = state.nodeDistanceScale || 1
    const R_SOFT_COLD = (state.maxWorldRadius || 140) * distScaleCold
    const R_HARD_COLD = R_SOFT_COLD * 1.85
    const R_HARD_COLD2 = R_HARD_COLD * R_HARD_COLD
    const R_SOFT_COLD2 = R_SOFT_COLD * R_SOFT_COLD
    let needsReheat = false
    for (let i = 0; i < n; i++) {
      const p = arr[i].p
      const r2 = p.x*p.x + p.y*p.y + p.z*p.z
      if (r2 > R_HARD_COLD2) {
        // Even when cold, slam outliers back onto the hard shell
        const sc = R_HARD_COLD / Math.sqrt(r2)
        p.x *= sc; p.y *= sc; p.z *= sc
        arr[i].v.x = 0; arr[i].v.y = 0; arr[i].v.z = 0
        needsReheat = true
      } else if (r2 > R_SOFT_COLD2) {
        needsReheat = true
      }
    }
    if (needsReheat) reheat(0.3)
    for (let i = 0; i < n; i++) {
      const v = arr[i].v
      if (v.x * v.x + v.y * v.y + v.z * v.z < 0.0002) { v.x = 0; v.y = 0; v.z = 0; continue }
      v.x *= 0.62; v.y *= 0.62; v.z *= 0.62
      const p = arr[i].p
      p.x += v.x * dt * 6; p.y += v.y * dt * 6; p.z += v.z * dt * 6
    }
    return
  }

  const distScale = state.nodeDistanceScale || 1
  const REPEL = 240 * distScale * distScale, SPRING = 0.05, REST = 9 * distScale
  const CENTER = 0.0028, DISK = 0
  const CUT2 = GRID_CELL * GRID_CELL * 2.25
  const VEL_KEEP = 1 - sim.velocityDecay
  const a = sim.alpha

  buildGrid(arr)

  // Round-robin active set — small graphs do everyone every tick.
  const RR_CHUNK = Math.min(n, Math.max(4000, Math.floor(120_000 / Math.max(1, Math.log2(n)))))
  const PAIR_CAP_LOCAL = 32
  const draggingIdx = state.draggingNode ? state.draggingNode.idx : -1

  for (let k = 0; k < RR_CHUNK; k++) {
    const i = (rrCursor + k) % n
    if (i === draggingIdx) continue
    const ni = arr[i]
    const aix = ni.p.x, aiy = ni.p.y, aiz = ni.p.z
    const aim = ni.mass, invMi = 1 / aim
    const cx = ((aix * GRID_INV) | 0) & GRID_MASK
    const cy = ((aiy * GRID_INV) | 0) & GRID_MASK
    const cz = ((aiz * GRID_INV) | 0) & GRID_MASK
    let count = 0

    for (let dx = -1; dx <= 1; dx++) {
      const ncx = (cx + dx) & GRID_MASK
      for (let dy = -1; dy <= 1; dy++) {
        const ncy = (cy + dy) & GRID_MASK
        for (let dz = -1; dz <= 1; dz++) {
          const ncz = (cz + dz) & GRID_MASK
          const cell = (ncx << (GRID_SIZE_BITS * 2)) | (ncy << GRID_SIZE_BITS) | ncz
          let j = cellHead[cell]
          while (j !== -1) {
            if (j === i) { j = nextInCell[j]; continue }
            const nj = arr[j]
            const ex = aix - nj.p.x, ey = aiy - nj.p.y, ez = aiz - nj.p.z
            const d2 = ex*ex + ey*ey + ez*ez
            if (d2 > CUT2 || d2 < 0.0001) { j = nextInCell[j]; continue }
            const safeD2 = d2 < 0.5 ? 0.5 : d2
            const invD = 1 / Math.sqrt(d2)
            // Half-strength because RR causes asymmetric force application.
            // Orphan-involved pairs get a further ×0.4 — orphans have no
            // spring forces holding them in place, so full repel just
            // pushes them outward forever. Weakening repel lets them
            // settle near the main cluster instead of drifting off.
            let f = REPEL * aim * nj.mass / safeD2 * a * 0.5
            // Strong reduction for orphan-involved pairs — orphans
            // shouldn't push other nodes outward, they should just
            // fit into the cluster volume.
            if (aim <= 1.2 || nj.mass <= 1.2) f *= 0.15
            const fx = ex * invD * f, fy = ey * invD * f, fz = ez * invD * f
            ni.v.x += fx * invMi; ni.v.y += fy * invMi; ni.v.z += fz * invMi
            if (j !== draggingIdx) {
              const invMj = 1 / nj.mass
              nj.v.x -= fx * invMj; nj.v.y -= fy * invMj; nj.v.z -= fz * invMj
            }
            if (++count > PAIR_CAP_LOCAL) { dx = 2; dy = 2; dz = 2; break }
            j = nextInCell[j]
          }
        }
      }
    }
  }
  rrCursor = (rrCursor + RR_CHUNK) % n

  // Springs — also round-robined. Graphs are typically ~3× more
  // edges than nodes; sample a similar bounded chunk per tick.
  const edges = state.edges
  const eLen = edges.length
  if (eLen > 0) {
    const SPRING_CHUNK = Math.min(eLen, Math.max(8000, Math.floor(200_000 / Math.max(1, Math.log2(eLen)))))
    const nodeMap = state.nodes
    // Compensate for sub-sampling — scale up so net per-edge force per second stays similar
    const springAlpha = a * Math.min(1, eLen / SPRING_CHUNK)
    for (let k = 0; k < SPRING_CHUNK; k++) {
      const idx = (springCursor + k) % eLen
      const e = edges[idx]
      const na = nodeMap.get(e.s), nb = nodeMap.get(e.t)
      if (!na || !nb) continue
      const ex = nb.p.x - na.p.x, ey = nb.p.y - na.p.y, ez = nb.p.z - na.p.z
      const d2 = ex*ex + ey*ey + ez*ez
      if (d2 < 1e-6) continue
      const d = Math.sqrt(d2)
      const f = SPRING * (d - REST) * springAlpha / d
      const fx = ex * f, fy = ey * f, fz = ez * f
      if (na.idx !== draggingIdx) {
        const inv = 1 / na.mass
        na.v.x += fx * inv; na.v.y += fy * inv; na.v.z += fz * inv
      }
      if (nb.idx !== draggingIdx) {
        const inv = 1 / nb.mass
        nb.v.x -= fx * inv; nb.v.y -= fy * inv; nb.v.z -= fz * inv
      }
    }
    springCursor = (springCursor + SPRING_CHUNK) % eLen
  }

  // Folder grouping — weak attraction pulling files in the same
  // folder toward their shared centroid. Heavy work (centroid
  // computation) is throttled to ~2 Hz; the per-node pull is cheap
  // O(N). Skipped entirely when toggled off.
  if (state.folderGrouping) {
    // Anchor-based clustering: each top-level folder gets assigned a
    // fixed point on the world sphere (deterministic from folder name).
    // Every file in that folder is pulled toward its anchor — so large
    // folders don't just sit at the global center (the failure mode of
    // centroid-based pull where centroid ≈ origin for big groups).
    // Anchors are recomputed only when the set of top-level folders
    // changes (cheap; throttled like centroids were).
    const now = performance.now()
    if (now - folderCentroidLastUpdate > 500) {
      folderCentroidLastUpdate = now
      // Collect counts (to know which folders are big enough to anchor)
      const counts = new Map()
      for (let i = 0; i < n; i++) {
        const f = arr[i].folder
        if (!f) continue
        counts.set(f, (counts.get(f) || 0) + 1)
      }
      // Planetary-system layout — concentric 3D rings. Most-connected
      // folder sits at the center. Ring 1 holds 1 folder, ring 2 holds 2,
      // ring 3 holds 3, … (triangular packing). Within each ring the
      // anchors are distributed on a sphere shell so the layout has true
      // 3D depth (not a flat disk).
      //
      // Singleton folders (1 file) roll into (root) so they don't drift
      // unanchored.
      let rootCount = counts.get('(root)') || 0
      for (const [f, c] of counts) {
        if (c < 2 && f !== '(root)') rootCount += c
      }
      if (rootCount > 0) counts.set('(root)', rootCount)

      // Importance = total mass of files in this folder (incoming +
      // outgoing edges, computed earlier per node). Higher → closer to
      // center.
      const folderMass = new Map()
      for (let i = 0; i < n; i++) {
        const node = arr[i]
        const fkey = (counts.get(node.folder) || 0) >= 2 ? node.folder : '(root)'
        folderMass.set(fkey, (folderMass.get(fkey) || 0) + (node.mass || 1))
      }
      const sortedFolders = [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([f]) => f)
        .sort((a, b) => (folderMass.get(b) || 0) - (folderMass.get(a) || 0))

      // Bubble radius for a folder (used for ring spacing computation here)
      const bubR = (f) => folderBubbleRadius(counts.get(f) || 1)

      // Assign folders to rings: ring L holds L folders (1, 2, 3, 4, …).
      const rings = []
      let placed = 0, li = 0
      while (placed < sortedFolders.length) {
        li++
        rings.push(sortedFolders.slice(placed, placed + li))
        placed += li
      }

      // Cascade ring radii so rings don't overlap each other AND bubbles
      // within a ring don't overlap each other.
      const distScaleLocal = state.nodeDistanceScale || 1
      const spreadFactor = state.folderClusterSpread ?? 0.85
      const GAP = 18 * distScaleLocal
      const ringRadii = []
      let prevOuter = 0
      for (let i = 0; i < rings.length; i++) {
        const folders = rings[i]
        const N = folders.length
        const maxR = Math.max(...folders.map(bubR))
        if (i === 0) { ringRadii.push(0); prevOuter = maxR; continue }
        const minRForRing = N > 1 ? maxR / Math.sin(Math.PI / N) : 0
        const rNeeded = Math.max(prevOuter + maxR + GAP, minRForRing)
        ringRadii.push(rNeeded * spreadFactor + (1 - spreadFactor) * rNeeded)  // spread scales final radius
        prevOuter = rNeeded + maxR
      }

      folderCentroids.clear()
      const phi0 = Math.PI * (3 - Math.sqrt(5))
      rings.forEach((folders, ri) => {
        const R = ringRadii[ri]
        const tilt = ri * 0.731
        if (folders.length === 1) {
          folderCentroids.set(folders[0], { x: 0, y: 0, z: 0, count: counts.get(folders[0]) })
          return
        }
        const N = folders.length
        if (N === 2) {
          folders.forEach((f, k) => {
            const sign = k === 0 ? 1 : -1
            folderCentroids.set(f, {
              x: sign * R * Math.cos(tilt),
              y: sign * R * Math.sin(tilt) * 0.4,
              z: sign * R * Math.sin(tilt),
              count: counts.get(f),
            })
          })
        } else if (N === 3) {
          folders.forEach((f, k) => {
            const a = (k / 3) * 2 * Math.PI + tilt
            folderCentroids.set(f, {
              x: R * Math.cos(a),
              y: R * Math.sin(tilt * 0.5) * (k - 1) * 0.3,
              z: R * Math.sin(a),
              count: counts.get(f),
            })
          })
        } else {
          folders.forEach((f, k) => {
            const y = 1 - (k / Math.max(N - 1, 1)) * 2
            const rxy = Math.sqrt(1 - y * y)
            const th = phi0 * k + tilt
            folderCentroids.set(f, {
              x: Math.cos(th) * rxy * R,
              y: y * R,
              z: Math.sin(th) * rxy * R,
              count: counts.get(f),
            })
          })
        }
      })
      ensureFolderBubbles(folderCentroids)
    }
    const FOLDER_PULL = (state.folderClusterStrength ?? 0.18) * a
    const rootAnchor = folderCentroids.get('(root)')
    for (let i = 0; i < n; i++) {
      if (i === draggingIdx) continue
      const node = arr[i]
      // Singleton folders aren't anchored; pull them toward (root) so
      // they don't drift in no-man's-land.
      const c = folderCentroids.get(node.folder) || rootAnchor
      if (!c) continue
      const v = node.v
      v.x += (c.x - node.p.x) * FOLDER_PULL
      v.y += (c.y - node.p.y) * FOLDER_PULL
      v.z += (c.z - node.p.z) * FOLDER_PULL
      // Outlier clamp: gentle inward nudge for nodes outside their
      // folder's bubble. Soft — strong pull caused oscillation against
      // cross-folder spring forces.
      const dx = node.p.x - c.x, dy = node.p.y - c.y, dz = node.p.z - c.z
      const dr2 = dx*dx + dy*dy + dz*dz
      const bubR = folderBubbleRadius(c.count || 1)
      const bubR2 = bubR * bubR
      if (dr2 > bubR2) {
        const dr = Math.sqrt(dr2)
        const over = (dr - bubR) / bubR
        const k = 0.02 * over   // gentle linear pull
        v.x -= dx * k
        v.y -= dy * k
        v.z -= dz * k
      }
    }
  }

  // Center gravity + galactic-disk flatten + integration — O(N), unavoidable
  const CA = CENTER * a, DA = DISK * a, DT6 = dt * 6
  const R_SOFT = (state.maxWorldRadius || 140) * distScale
  const R_SOFT2 = R_SOFT * R_SOFT
  const R_HARD = R_SOFT * 1.03

  // Pull non-main components toward the main cluster centroid —
  // ONLY when folder grouping is OFF. With grouping on, each folder
  // has its own anchor and the planetary layout owns positioning;
  // adding a "pull toward origin" would fight the anchors.
  _frameCounter = (_frameCounter || 0) + 1
  refreshMainCentroid(_frameCounter)
  const COMP_PULL = 0.08
  const mc = _mainCentroid
  const hasComponents = (state.componentCount || 1) > 1 && !state.folderGrouping

  for (let i = 0; i < n; i++) {
    if (i === draggingIdx) { arr[i].v.x = 0; arr[i].v.y = 0; arr[i].v.z = 0; continue }
    const node = arr[i]
    const p = node.p, v = node.v
    const ca = node.mass <= 1.2 ? CA * 1.5 : CA
    v.x += -p.x * ca
    v.y += -p.y * ca - p.y * DA
    v.z += -p.z * ca
    if (hasComponents && node.componentId !== 0) {
      // Sub-component uniform pull — moves the whole sub-cluster
      // toward main centroid as a unit (preserves internal springs).
      const sc = _subCentroids.get(node.componentId)
      if (sc) {
        v.x += (mc.x - sc.x) * COMP_PULL
        v.y += (mc.y - sc.y) * COMP_PULL
        v.z += (mc.z - sc.z) * COMP_PULL
      }
      // Per-node soft clamp for sub-component nodes.
      const dx = p.x - mc.x, dy = p.y - mc.y, dz = p.z - mc.z
      const dr2 = dx*dx + dy*dy + dz*dz
      const limit = _mainBoundR * 0.70
      if (dr2 > limit * limit) {
        const dr = Math.sqrt(dr2)
        const targetR = limit * (0.50 + Math.random() * 0.40)
        const ratio = targetR / dr
        const tx = mc.x + dx * ratio
        const ty = mc.y + dy * ratio
        const tz = mc.z + dz * ratio
        p.x = (p.x + tx) * 0.5
        p.y = (p.y + ty) * 0.5
        p.z = (p.z + tz) * 0.5
        v.x *= 0.5; v.y *= 0.5; v.z *= 0.5
      }
    } else if (hasComponents && node.componentId === 0) {
      // Main cluster outliers: weakly-connected main nodes drift to
      // periphery under REPEL. Gentle distance-based pull when they
      // drift beyond main bound. alpha-independent so still acts
      // after cooling.
      const dx = p.x - mc.x, dy = p.y - mc.y, dz = p.z - mc.z
      const dr2 = dx*dx + dy*dy + dz*dz
      const limit = _mainBoundR
      if (dr2 > limit * limit) {
        const dr = Math.sqrt(dr2)
        const over = (dr - limit) / limit
        const k = 0.08 * over * (1 + over)
        v.x -= dx * k
        v.y -= dy * k
        v.z -= dz * k
      }
    }
    const r2 = p.x*p.x + p.y*p.y + p.z*p.z
    if (r2 > R_SOFT2) {
      const r = Math.sqrt(r2)
      const over = (r - R_SOFT) / R_SOFT
      // Strong but smooth snap-back. R_SOFT is the desired sphere
      // boundary; we don't want nodes to drift visibly beyond it.
      const k = 0.20 * over * (1 + over * 4) * a
      v.x -= p.x * k
      v.y -= p.y * k
      v.z -= p.z * k
      if (r > R_HARD) {
        const sc = R_HARD / r
        p.x *= sc; p.y *= sc; p.z *= sc
        v.x = 0; v.y = 0; v.z = 0
      }
    }
    v.x *= VEL_KEEP; v.y *= VEL_KEEP; v.z *= VEL_KEEP
    p.x += v.x * DT6; p.y += v.y * DT6; p.z += v.z * DT6
  }
}

// Folder centroid cache for the optional grouping force
const folderCentroids = new Map()
let folderCentroidLastUpdate = 0

// ═══════════════════════════════════════════════════════════════
//  Snapshot ingest (no per-node allocations beyond the JS object)
// ═══════════════════════════════════════════════════════════════
function applySnapshot(files, edges, root) {
  if (root !== undefined && root !== null) {
    state.root = root
    document.getElementById('pathLabel').textContent = root
  }
  const incoming = new Map(files.map((f) => [f.id, f]))

  // Remove stale nodes — compact byIdx by swap-pop
  for (const id of [...state.nodes.keys()]) {
    if (incoming.has(id)) continue
    const n = state.nodes.get(id)
    const lastIdx = state.byIdx.length - 1
    const lastNode = state.byIdx[lastIdx]
    if (lastNode && lastNode !== n) {
      state.byIdx[n.idx] = lastNode
      lastNode.idx = n.idx
    }
    state.byIdx.pop()
    state.nodes.delete(id)
  }

  // Add new + update existing
  for (const f of files) {
    const existing = state.nodes.get(f.id)
    if (existing) {
      existing.ext = f.ext; existing.loc = f.loc; existing.size = f.size
      existing.pkg = f.pkg || null
      // Keep confidence/dynamic fresh on re-snapshot — the new-node branch
      // gets these via the `...f` spread, but updates must refresh them too
      // or the inspector confidence/dynamic badges go stale.
      existing.confidence = f.confidence
      existing.hasDynamicResolution = f.hasDynamicResolution
      existing.dynamicPatterns = f.dynamicPatterns
      existing.hex = colorFor(f.ext)
      hexToRGB(existing.hex, existing.rgb)
    } else {
      if (state.byIdx.length >= MAX_NODES) continue  // overflow guard
      // Initial seed: a small random sphere around origin. Force
      // simulation will spread these out, but if the seed sphere is
      // too tight for thousands of files the early frames look like
      // a packed mush. Scale up the seed radius with already-seeded
      // count so large projects start more "open".
      const seedR = 4 + Math.min(80, files.length / 80)
      const r = 4 + Math.random() * seedR
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const sinPhi = Math.sin(phi)
      const folder = f.id.includes('/') ? f.id.split('/')[0] : '(root)'
      const node = {
        ...f,
        idx: state.byIdx.length,
        hex: colorFor(f.ext),
        rgb: new Float32Array(3),
        folderRgb: new Float32Array(3),
        p: new THREE.Vector3(r * sinPhi * Math.cos(theta), r * Math.cos(phi), r * sinPhi * Math.sin(theta)),
        v: new THREE.Vector3(),
        mass: 1,
        folder,
        pkg: f.pkg || null,
        bornAt: performance.now(),
        emit: 0.45,    // emissive intensity (animated)
        haloA: 0.55,   // halo alpha (animated)
      }
      hexToRGB(node.hex, node.rgb)
      // Folder-tint color — deterministic per folder name (same hash
      // as the bubble color, but darker/desaturated for nodes)
      const fcol = folderHueColor(folder)
      node.folderRgb[0] = fcol.r
      node.folderRgb[1] = fcol.g
      node.folderRgb[2] = fcol.b
      state.nodes.set(f.id, node)
      state.byIdx.push(node)
    }
  }

  state.edges = edges
  rebuildAdjacency()
  rebuildComponents()
  invalidateFocusCache()

  // Mass from degree
  for (const n of state.byIdx) {
    const deg = state.adj.get(n.id)?.size || 0
    n.mass = 1 + Math.sqrt(deg) * 1.6
  }

  updateLegend()
  updateStats()
  document.body.classList.toggle('no-folder', state.byIdx.length === 0 && !state.root)
  applyFilter()
  reheat(0.4)

  // Status bar: graph changed, invalidate cached metrics and stamp
  // the "last change" timestamp (used by the status bar).
  componentCacheStale = true
  lastChangeAt = performance.now()

  // If the previously selected or hovered node no longer exists in
  // the new snapshot (file deleted/renamed), clear those references
  // so we don't keep stale references to a removed node.
  if (state.selectedId && !state.nodes.has(state.selectedId)) {
    state.selectedId = null
    bus.emit('selection:changed', null)
  }
  if (state.hoverId && !state.nodes.has(state.hoverId) && !state.symbols.has(state.hoverId)) {
    state.hoverId = null
  }
  if (state.draggingNode && !state.nodes.has(state.draggingNode.id)) {
    state.draggingNode = null
    state.dragPlane = null
  }

  bus.emit('snapshot:applied', { root })
}

function clearGraph() {
  state.nodes.clear()
  state.byIdx.length = 0
  state.edges = []
  state.adj.clear()
  state.root = ''
  state.selectedId = null
  state.hoverId = null
  for (const lbl of labelPool) lbl.style.opacity = '0'
  document.getElementById('pathLabel').textContent = t('topbar.open_folder.label')
  document.getElementById('inspector').classList.add('hidden')
  document.body.classList.add('no-folder')
  nodeGeo.setDrawRange(0, 0)
  edgeGeo.setDrawRange(0, 0)
  updateStats()
  updateLegend()
  bus.emit('graph:cleared', null)
  bus.emit('selection:changed', null)
  bus.emit('snapshot:applied', { root: '' })
}

// ═══════════════════════════════════════════════════════════════
//  Filter / search / focus
//
//  Two-axis search system:
//   1. searchMode — 'highlight' (default) or 'hide'
//      highlight: matching nodes glow, others dim but remain
//      hide:      non-matching nodes vanish (old behavior)
//   2. searchSyntax — 'plain' (substring), 'glob', or 'regex'
//
//  Each node carries two booleans now:
//   - visible:  whether to render at all (hide mode + ext filter)
//   - matched:  whether the search text matched (drives highlight)
// ═══════════════════════════════════════════════════════════════
function globToRegex(glob) {
  // Convert glob-style pattern to RegExp:
  //   *   → any chars except /
  //   **  → any chars including /
  //   ?   → single char
  //   \X  → literal X (allows escaping glob meta)
  //   [abc] kept as-is
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\' && i + 1 < glob.length) {
      // Escape sequence — emit the next char literally
      const next = glob[i + 1]
      if ('.+^$()|{}\\*?[]'.includes(next)) re += '\\' + next
      else re += next
      i++
    } else if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ }
      else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^$()|{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(re, 'i')
}

function compileSearchPattern(text, syntax) {
  if (!text) return null
  try {
    if (syntax === 'regex') return new RegExp(text, 'i')
    if (syntax === 'glob')  return globToRegex(text)
    // plain — escape regex meta, case-insensitive substring
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped, 'i')
  } catch {
    return null   // invalid regex/glob — treat as no filter
  }
}

function matchesText(n, pattern) {
  if (!pattern) return true
  return pattern.test(n.id)
}
function passesExtFilter(n) {
  return !state.hiddenExts.has(n.ext)
}
function applyFilter() {
  const pattern = compileSearchPattern(state.filterText, state.searchSyntax)
  let matched = 0
  for (const n of state.byIdx) {
    const extOK = passesExtFilter(n)
    const textOK = matchesText(n, pattern)
    n.matched = textOK && extOK && !!pattern
    if (state.searchMode === 'hide') {
      n.visible = extOK && (pattern ? textOK : true)
    } else {
      n.visible = extOK   // highlight mode: only ext filter hides things
    }
    if (n.matched) matched++
  }
  state.matchCount = pattern ? matched : 0
  updateSearchUI()
  bus.emit('filter:changed', null)
}
function updateSearchUI() {
  const el = document.getElementById('searchCount')
  if (!el) return
  if (!state.filterText) {
    el.textContent = ''
    el.classList.remove('has-result', 'no-result')
  } else {
    el.textContent = `${state.matchCount}`
    el.classList.toggle('no-result', state.matchCount === 0)
    el.classList.toggle('has-result', state.matchCount > 0)
  }
}
// ═══════════════════════════════════════════════════════════════
//  Focus propagation
//
//  When a node is hovered or selected, we walk the graph outward
//  from it via BFS. Returns { dists: Map<id,dist>, maxDist } where
//  dist=0 is the focused node, dist=1 are direct neighbors, etc.
//
//  Two modes:
//    Bounded: BFS stops at state.focusDepth. Nodes beyond are
//             "unreached" (heavily dimmed). Default depth = 3.
//    Show all: state.showAllConnected = true. BFS runs unbounded
//             until the entire connected component is mapped. The
//             falloff curve is normalized against the actual max
//             distance found, so deep chains stay informative
//             instead of collapsing to a single brightness.
//
//  Cached on (focus, limit) — render() calls this every frame,
//  and a 300k-node BFS every frame would be expensive. Cache
//  invalidates automatically when hover/select changes, depth
//  changes, or the toggle flips. Also invalidated when the graph
//  itself changes (see invalidateFocusCache).
// ═══════════════════════════════════════════════════════════════
let focusCache = { key: '', dists: null, maxDist: 0 }

function focusDistances() {
  const focus = state.hoverId || state.selectedId
  if (!focus) return null
  const limit = state.showAllConnected ? Infinity : state.focusDepth
  const key = `${focus}|${limit}`
  if (focusCache.key === key && focusCache.dists) return focusCache
  const dists = new Map()
  dists.set(focus, 0)
  let frontier = [focus]
  let maxDist = 0
  for (let d = 1; d <= limit; d++) {
    const next = []
    for (let i = 0; i < frontier.length; i++) {
      const neighbors = state.adj.get(frontier[i])
      if (!neighbors) continue
      for (const id of neighbors) {
        if (dists.has(id)) continue
        dists.set(id, d)
        next.push(id)
      }
    }
    if (next.length === 0) break
    maxDist = d
    frontier = next
  }
  focusCache = { key, dists, maxDist }
  return focusCache
}

function invalidateFocusCache() {
  focusCache.key = ''
  bus.emit('focus:changed', null)
}

// Convert distance to emphasis multiplier in [0,1].
//   distance 0 (the focused node)            → 1.0   (full bright)
//   distance ∈ (0, maxDepth)                 → smooth linear falloff
//   distance ≥ maxDepth or unreached         → 0.10  (heavily faded)
//
// `maxDepth` adapts to the current mode:
//   - bounded mode: state.focusDepth (e.g. 3)
//   - show-all mode: the actual graph max distance found by BFS,
//     so a 12-deep chain falls off gracefully rather than slamming
//     to the floor.
// Floor 0.40 keeps unconnected nodes visible enough to preserve the
// graph silhouette during hover. Lower values (was 0.10) blacked them
// out, which felt like "the rest of the graph disappeared".
function emphasisFor(dist, maxDepth) {
  if (dist === undefined || dist === null) return 0.40
  if (dist === 0) return 1.0
  if (maxDepth <= 0) return 1.0
  if (dist > maxDepth) return 0.40
  const t = dist / (maxDepth + 0.5)
  return Math.max(0.40, 1.0 - t * 0.6)
}

// ═══════════════════════════════════════════════════════════════
//  AI trace — records a node touch (read/inspect/focus/write) and
//  updates the small overlay panel. Visualization (pulse) happens
//  in the render loop via state.aiTrace.
// ═══════════════════════════════════════════════════════════════
function recordTrace(id, tool) {
  if (!id || !state.nodes.has(id)) return
  const now = performance.now()
  state.aiTrace.set(id, { tool, lastAt: now })
  state.aiTraceLog.unshift({ id, tool, ts: Date.now() })
  if (state.aiTraceLog.length > AI_TRACE_LOG_CAP) state.aiTraceLog.length = AI_TRACE_LOG_CAP
  // Trail — add this node to the navigation path. We keep insertion
  // order via state.aiTrailIds; the render loop fills the geometry.
  state.aiTrailIds.unshift({ id, at: now })
  if (state.aiTrailIds.length > TRAIL_MAX) state.aiTrailIds.length = TRAIL_MAX
  refreshTracePanel()
}
function refreshTracePanel() {
  const panel = document.getElementById('aiTracePanel')
  if (!panel) return
  const body = document.getElementById('aiTraceBody')
  if (!body) return
  if (state.aiTraceLog.length === 0) {
    body.innerHTML = `<div class="trace-empty" data-i18n="trace.panel.empty">${t('trace.panel.empty')}</div>`
    panel.classList.remove('active')
    return
  }
  panel.classList.add('active')
  body.innerHTML = state.aiTraceLog.slice(0, 8).map((t) => {
    const d = new Date(t.ts)
    const stamp = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
    const short = t.id.length > 40 ? '…' + t.id.slice(-39) : t.id
    return `<div class="trace-row" data-tool="${escapeAttr(t.tool)}">
      <span class="trace-stamp">${stamp}</span>
      <span class="trace-tool">${escapeHTML(t.tool)}</span>
      <span class="trace-id" title="${escapeAttr(t.id)}">${escapeHTML(short)}</span>
    </div>`
  }).join('')
}

// ═══════════════════════════════════════════════════════════════
//  Label pool — only LABEL_POOL DIVs ever exist, no matter how
//  many nodes the graph has. Each frame we pick which to show.
// ═══════════════════════════════════════════════════════════════
const labelPool = []
for (let i = 0; i < LABEL_POOL; i++) {
  const el = document.createElement('div')
  el.className = 'node-label'
  document.body.appendChild(el)
  labelPool.push(el)
}

function pickLabelTargets(fd) {
  // When focused, label the focused node + its closest neighbors
  // (sorted by graph distance, then by mass within each shell).
  const candidates = []
  if (fd && fd.dists) {
    const ordered = [...fd.dists.entries()].sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1]
      const na = state.nodes.get(a[0]), nb = state.nodes.get(b[0])
      return (nb?.mass || 0) - (na?.mass || 0)
    })
    for (const [id] of ordered) {
      const n = state.nodes.get(id)
      if (n && n.visible !== false) candidates.push(n)
      if (candidates.length >= LABEL_POOL) break
    }
  } else {
    // Show heaviest (most-connected) nodes — top LABEL_POOL by mass
    const sorted = state.byIdx
      .filter((n) => n.visible !== false)
      .sort((a, b) => b.mass - a.mass)
    for (let i = 0; i < Math.min(LABEL_POOL, sorted.length); i++) candidates.push(sorted[i])
  }
  return candidates.slice(0, LABEL_POOL)
}

// ═══════════════════════════════════════════════════════════════
//  CPU picking via NDC projection (much cheaper than raycasting
//  at scale; ~O(n) but only when mouse moved)
// ═══════════════════════════════════════════════════════════════
function pickAtNDC(mx, my) {
  const v = new THREE.Vector3()
  let bestId = null, bestScore = Infinity
  // Pixel-space hit radius (NDC units, depending on canvas size)
  const cw = canvas.clientWidth || window.innerWidth
  const ch = canvas.clientHeight || window.innerHeight
  // NDC spans 2 (-1..1) per axis, so a pixel radius converts with 2/dim, not
  // 1/dim — without the ×2 the hit target was half the intended ~14px.
  const pxRadius = (14 * 2) / Math.min(cw, ch)
  for (let i = 0; i < state.byIdx.length; i++) {
    const n = state.byIdx[i]
    if (n.visible === false) continue
    v.copy(n.p).project(camera)
    if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue
    const dx = v.x - mx, dy = v.y - my
    const d2 = dx*dx + dy*dy
    if (d2 > pxRadius * pxRadius) continue
    // Prefer closer to camera (smaller v.z) and nearer in NDC
    const score = d2 + v.z * 0.001
    if (score < bestScore) { bestScore = score; bestId = n.id }
  }
  // Symbol (function) nodes — pickable when the layer is on. Same NDC test.
  if (state.showSymbols) {
    for (const sym of state.symbols.values()) {
      if (!sym.shown) continue
      v.copy(sym.p).project(camera)
      if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue
      const dx = v.x - mx, dy = v.y - my
      const d2 = dx*dx + dy*dy
      if (d2 > pxRadius * pxRadius) continue
      const score = d2 + v.z * 0.001
      if (score < bestScore) { bestScore = score; bestId = sym.id }
    }
  }
  return bestId
}

// ═══════════════════════════════════════════════════════════════
//  Render loop — writes directly into pre-allocated GPU buffers
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  File tree (left top)
//
//  Builds a hierarchical tree from byIdx file paths, lets the user
//  fold/unfold directories, click files to select them, and click
//  folders to filter the graph to that subtree.
//
//  Performance approach: build the tree data once per snapshot.
//  Render only expanded branches (a "virtual" expansion model —
//  closed folders contribute one row, regardless of contents).
//  For 100k files in 8k folders, the initial collapsed view shows
//  only a few dozen rows; users expand only what they want.
// ═══════════════════════════════════════════════════════════════
const fileTree = {
  // root.children is a Map<string, TreeNode>; nodes are either:
  //   { type: 'dir',  name, path, children: Map, expanded, totalFiles }
  //   { type: 'file', name, path, id, hex, ext }
  root: { type: 'dir', name: '', path: '', children: new Map(), expanded: true, totalFiles: 0 },
  // Path → expanded state, so we preserve folds across rebuilds
  expandedPaths: new Set(['']),
}

function buildFileTree() {
  const root = { type: 'dir', name: '', path: '', children: new Map(), expanded: true, totalFiles: 0 }
  for (const n of state.byIdx) {
    const parts = n.id.split('/')
    let cur = root
    cur.totalFiles++
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]
      let next = cur.children.get(segment)
      if (!next) {
        const dirPath = parts.slice(0, i + 1).join('/')
        next = {
          type: 'dir',
          name: segment,
          path: dirPath,
          children: new Map(),
          expanded: fileTree.expandedPaths.has(dirPath),
          totalFiles: 0,
        }
        cur.children.set(segment, next)
      }
      next.totalFiles++
      cur = next
    }
    const filename = parts[parts.length - 1]
    cur.children.set(filename, {
      type: 'file',
      name: filename,
      path: n.id,
      id: n.id,
      hex: n.hex,
      ext: n.ext,
    })
  }
  fileTree.root = root
}

function sortedChildren(node) {
  // Folders first, then files. Within each group, alphabetical.
  return [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function renderFileTree() {
  const host = document.getElementById('fileTreeBody')
  if (!host) return
  renderFtRoot()
  if (state.byIdx.length === 0) {
    host.innerHTML = '<div class="ctx-empty" style="padding:8px">no folder open</div>'
    return
  }
  const lines = []
  // Skip the synthetic root, render its children
  for (const child of sortedChildren(fileTree.root)) {
    renderTreeNode(child, 0, lines)
  }
  host.innerHTML = lines.join('')
  attachTreeHandlers(host)
}

function renderFtRoot() {
  const el = document.getElementById('ftRoot')
  if (!el) return
  if (!state.root) { el.innerHTML = ''; el.title = ''; return }
  const base = state.root.split(/[\\/]/).filter(Boolean).pop() || state.root
  el.title = state.root
  el.innerHTML = `<span class="ft-root-name">📁 ${escapeHTML(base)}</span><span class="ft-root-path">${escapeHTML(state.root)}</span>`
}

function renderTreeNode(node, depth, lines) {
  const indent = depth * 12
  const active = state.selectedId === node.path
  if (node.type === 'dir') {
    const sym = node.expanded ? '▾' : '▸'
    // Count how many files under this dir are starred — show "★ 3"
    // next to the folder so user can spot partially-marked dirs.
    const starredCount = countStarredUnder(node)
    const starBadge = starredCount > 0
      ? `<span class="ft-stars" title="${starredCount} starred">★${starredCount}</span>`
      : ''
    lines.push(`
      <div class="ft-row ft-folder" data-path="${escapeAttr(node.path)}" data-type="dir"
           style="padding-left:${indent + 6}px">
        <span class="ft-icon expand" data-expand="${escapeAttr(node.path)}">${sym}</span>
        <span class="ft-label">${escapeHTML(node.name)}/</span>
        ${starBadge}
        <span class="ft-count">${node.totalFiles}</span>
      </div>
    `)
    if (node.expanded) {
      for (const child of sortedChildren(node)) {
        renderTreeNode(child, depth + 1, lines)
      }
    }
  } else {
    const color = node.hex || '#888'
    const starred = state.activeFiles.has(node.path)
    lines.push(`
      <div class="ft-row ft-file ${active ? 'active' : ''} ${starred ? 'starred' : ''}"
           data-path="${escapeAttr(node.path)}" data-type="file"
           style="padding-left:${indent + 6}px">
        <span class="ft-star ${starred ? 'on' : ''}" data-star="${escapeAttr(node.path)}"
              title="${starred ? 'Unmark as active' : 'Mark as active'}">${starred ? '★' : '☆'}</span>
        <span class="ft-color" style="background:${color};color:${color}"></span>
        <span class="ft-label">${escapeHTML(node.name)}</span>
      </div>
    `)
  }
}

// Recursive count of starred files anywhere under a dir node
function countStarredUnder(node) {
  if (node.type === 'file') return state.activeFiles.has(node.path) ? 1 : 0
  let n = 0
  for (const c of node.children.values()) n += countStarredUnder(c)
  return n
}

function attachTreeHandlers(host) {
  // Expand/collapse arrows
  host.querySelectorAll('[data-expand]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const path = el.dataset.expand
      toggleDir(path)
    })
  })
  // Folder rows — click body opens/closes too; also focuses the graph
  // on that folder by setting a search filter
  host.querySelectorAll('.ft-folder').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.expand) return  // arrow click already handled
      const path = el.dataset.path
      // Glob meta characters in folder names (rare but possible —
      // e.g. "(legacy)", "[archived]") would be interpreted as glob
      // syntax. Escape them so the filter matches only this folder.
      const safe = path.replace(/[[\]?*()|{}\\]/g, '\\$&')
      state.filterText = safe + '/**'
      state.searchSyntax = 'glob'
      const inp = document.getElementById('search')
      if (inp) inp.value = state.filterText
      try { localStorage.setItem('codesynapt:search_syntax', 'glob') } catch {}
      if (window.syncSearchSyntaxBtn) window.syncSearchSyntaxBtn()
      applyFilter()
    })
  })
  // File rows — select node (star button has its own handler and
  // stops propagation so clicking the star doesn't also select)
  host.querySelectorAll('.ft-file').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.star) return  // star click handled below
      const id = el.dataset.path
      selectNode(id)
    })
  })
  // Star buttons — toggle "active" marking
  host.querySelectorAll('[data-star]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleStarred(el.dataset.star)
    })
  })
}

function toggleDir(path) {
  // Walk to the node and flip expanded. Persist in expandedPaths.
  const parts = path.split('/').filter(Boolean)
  let cur = fileTree.root
  for (const p of parts) {
    cur = cur.children.get(p)
    if (!cur) return
  }
  cur.expanded = !cur.expanded
  if (cur.expanded) fileTree.expandedPaths.add(path)
  else fileTree.expandedPaths.delete(path)
  renderFileTree()
}

function collapseAllTree() {
  // Walk the existing tree turning off expanded — much cheaper than
  // rebuilding from byIdx for large graphs (a rebuild scans every
  // file's path). The expandedPaths set is the source of truth so
  // we clear it too.
  fileTree.expandedPaths.clear()
  function collapseNode(node) {
    if (node.type !== 'dir') return
    node.expanded = false
    for (const child of node.children.values()) collapseNode(child)
  }
  collapseNode(fileTree.root)
  fileTree.root.expanded = true   // root is always logically expanded
  renderFileTree()
}

// Wire tree controls
function setTreeCollapsed(collapsed) {
  const panel = document.getElementById('fileTreePanel')
  panel.classList.toggle('collapsed', collapsed)
  document.body.classList.toggle('tree-collapsed', collapsed)
  const ft = document.getElementById('ftToggle')
  if (ft) ft.textContent = collapsed ? '+' : '−'   // button removed; guard
  const tbtn = document.getElementById('treeToggleBtn')
  if (tbtn) tbtn.classList.toggle('active', collapsed)
  try { localStorage.setItem('codesynapt:tree_collapsed', collapsed ? 'true' : 'false') } catch {}
}
function toggleTree() {
  const collapsed = !document.getElementById('fileTreePanel').classList.contains('collapsed')
  setTreeCollapsed(collapsed)
}
// The ftCollapseAll / ftToggle header buttons were removed (a stray click on the
// hide button left no way to bring the tree back). treeToggleBtn / the 'T'
// shortcut remain as escape hatches.
document.getElementById('treeToggleBtn')?.addEventListener('click', toggleTree)
// Click the "files" header to collapse/expand the tree (accordion).
document.querySelector('.ft-head')?.addEventListener('click', toggleTree)

// Never auto-collapse on load, and clear any state persisted by the old hide
// button so a tree that was hidden that way reappears.
try { localStorage.removeItem('codesynapt:tree_collapsed') } catch {}

// Reveal the canvas (hide the dark loading overlay) once the graph's first
// frame has drawn — covers the brief white an opaque WebGL canvas shows before
// its first render. Double rAF guarantees a real frame painted first. Fallback
// timeout handles the no-folder / no-snapshot case so it never lingers.
;(() => {
  let hidden = false
  const hide = () => {
    if (hidden) return; hidden = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById('canvas-loading')?.classList.add('hidden')
    }))
  }
  bus.on('snapshot:applied', hide)
  setTimeout(hide, 6000)
})()

// Subscribe file tree to relevant events.
bus.on('snapshot:applied', () => {
  buildFileTree()
  renderFileTree()
})
bus.on('selection:changed', () => {
  // Cheap pass — just update "active" class without full rebuild
  const host = document.getElementById('fileTreeBody')
  if (!host) return
  host.querySelectorAll('.ft-file').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === state.selectedId)
  })
})
// Active-set changed — re-render so star icons and folder badges update
bus.on('activeset:changed', () => {
  if (state.byIdx.length > 0) renderFileTree()
})

// (Keyboard shortcuts for T, M, R, S, /, Esc, 1-3 are all handled
// in the unified keydown listener defined later — see the
// "Keyboard shortcuts" block.)

// ═══════════════════════════════════════════════════════════════
//  Active set — user-curated "what's really in use" markings
//
//  Replaces automatic dead-code detection (which doesn't work well
//  for AI-assisted workflows where the conventionally-named "old"
//  file is often the real one). The user explicitly marks files or
//  groups them into named "pipelines"; everything else is dimmed.
//
//  Storage shape per root:
//    { starred: string[], pipelines: [{id,name,files}],
//      activePipelines: string[], mode: 'off'|'dim'|'hide' }
// ═══════════════════════════════════════════════════════════════
const ACTIVESET_KEY_PREFIX = 'codesynapt:active:'

function activeSetKey(root) { return ACTIVESET_KEY_PREFIX + (root || '') }

function loadActiveSet(root) {
  if (!root) return null
  try {
    const raw = localStorage.getItem(activeSetKey(root))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveActiveSet(root) {
  if (!root) return
  try {
    const payload = {
      starred: [...state.activeFiles],
      pipelines: state.pipelines,
      activePipelines: [...state.activePipelines],
      mode: state.activeSetMode,
    }
    localStorage.setItem(activeSetKey(root), JSON.stringify(payload))
  } catch { /* quota / disabled */ }
}

function hydrateActiveSet(root) {
  state.activeFiles = new Set()
  state.pipelines = []
  state.activePipelines = new Set()
  state.activeSetMode = 'off'
  if (!root) return
  const data = loadActiveSet(root)
  if (!data) return
  state.activeFiles = new Set(Array.isArray(data.starred) ? data.starred : [])
  state.pipelines = Array.isArray(data.pipelines) ? data.pipelines : []
  state.activePipelines = new Set(Array.isArray(data.activePipelines) ? data.activePipelines : [])
  state.activeSetMode = data.mode === 'dim' || data.mode === 'hide' ? data.mode : 'off'
}

// Effective live set = union of starred files + files in every
// currently-active pipeline. Returns null if mode is 'off' meaning
// "treat everything as active".
function computeEffectiveActiveSet() {
  if (state.activeSetMode === 'off') return null
  const live = new Set(state.activeFiles)
  for (const pipe of state.pipelines) {
    if (!state.activePipelines.has(pipe.id)) continue
    for (const f of (pipe.files || [])) live.add(f)
  }
  return live
}

function isFileActive(id) {
  if (state.activeSetMode === 'off') return true
  const eff = computeEffectiveActiveSet()
  return eff ? eff.has(id) : true
}

function toggleStarred(id) {
  if (!id || !state.root) return
  if (state.activeFiles.has(id)) state.activeFiles.delete(id)
  else state.activeFiles.add(id)
  // Auto-enable dim mode the first time the user stars something so
  // the marking has a visible effect.
  if (state.activeSetMode === 'off' && state.activeFiles.size > 0) {
    state.activeSetMode = 'dim'
  }
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}

function createPipeline(name) {
  const id = `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  state.pipelines.push({ id, name: name || 'Untitled pipeline', files: [] })
  state.activePipelines.add(id)
  if (state.activeSetMode === 'off') state.activeSetMode = 'dim'
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
  return id
}
function deletePipeline(id) {
  state.pipelines = state.pipelines.filter((p) => p.id !== id)
  state.activePipelines.delete(id)
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}
function renamePipeline(id, name) {
  const p = state.pipelines.find((p) => p.id === id)
  if (!p) return
  p.name = name
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}
function togglePipeline(id) {
  if (state.activePipelines.has(id)) state.activePipelines.delete(id)
  else state.activePipelines.add(id)
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}
function addFileToPipeline(pipeId, fileId) {
  const p = state.pipelines.find((p) => p.id === pipeId)
  if (!p) return
  if (!p.files.includes(fileId)) p.files.push(fileId)
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}
function removeFileFromPipeline(pipeId, fileId) {
  const p = state.pipelines.find((p) => p.id === pipeId)
  if (!p) return
  p.files = p.files.filter((f) => f !== fileId)
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}
function setActiveSetMode(mode) {
  if (mode !== 'off' && mode !== 'dim' && mode !== 'hide') return
  state.activeSetMode = mode
  saveActiveSet(state.root)
  bus.emit('activeset:changed', null)
}

// Hydrate when the user opens a different root (different stored set)
bus.on('snapshot:applied', ({ root }) => {
  if (root && root !== state._lastActiveSetRoot) {
    state._lastActiveSetRoot = root
    hydrateActiveSet(root)
    bus.emit('activeset:changed', null)
  }
})

// ─── Pipelines panel rendering ───────────────────────────────
function renderPipelinesPanel() {
  const panel = document.getElementById('pipelinesPanel')
  const list = document.getElementById('pipelinesList')
  if (!panel || !list) return

  // The panel always shows inside its left-rail tab; an empty state
  // message is rendered when nothing is active.
  const empty = state.pipelines.length === 0 && state.activeFiles.size === 0
  if (!state.root) { list.innerHTML = ''; return }

  // Mode button reflects current mode
  const modeBtn = document.getElementById('ppModeBtn')
  if (modeBtn) {
    const label = { off: '○ off', dim: '◐ dim', hide: '● hide' }[state.activeSetMode]
    modeBtn.textContent = label.split(' ')[0]
    modeBtn.title = `Active set: ${state.activeSetMode} (click to cycle)`
    modeBtn.classList.toggle('active', state.activeSetMode !== 'off')
  }

  if (empty) {
    list.innerHTML = `<div class="pp-empty">No active set yet.<br>★ a file in the tree, or create a pipeline.</div>`
    return
  }

  const starredCount = state.activeFiles.size
  const starredRow = starredCount > 0 ? `
    <div class="pp-item on">
      <span class="pp-toggle" title="Starred files are always active">★</span>
      <span class="pp-name" title="Individually starred files (★ in tree)">starred files</span>
      <span class="pp-count">${starredCount}</span>
    </div>
  ` : ''

  list.innerHTML = starredRow + state.pipelines.map((p) => {
    const on = state.activePipelines.has(p.id)
    return `
      <div class="pp-item ${on ? 'on' : ''}" data-pid="${escapeAttr(p.id)}">
        <span class="pp-toggle" data-toggle="${escapeAttr(p.id)}" title="Toggle">${on ? '✓' : ''}</span>
        <span class="pp-name" contenteditable="true" data-rename="${escapeAttr(p.id)}">${escapeHTML(p.name)}</span>
        <span class="pp-count">${p.files.length}</span>
        <button class="pp-del" data-del="${escapeAttr(p.id)}" title="Delete pipeline">✕</button>
      </div>
    `
  }).join('')

  // Toggle pipelines
  list.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePipeline(el.dataset.toggle)
    })
  })
  // Delete
  list.querySelectorAll('[data-del]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const pid = el.dataset.del
      const p = state.pipelines.find((p) => p.id === pid)
      if (!p) return
      if (confirm(`Delete pipeline "${p.name}"? (Files in it stay; only the grouping is removed.)`)) {
        deletePipeline(pid)
      }
    })
  })
  // Inline rename via contentEditable
  list.querySelectorAll('[data-rename]').forEach((el) => {
    el.addEventListener('blur', () => {
      const newName = el.textContent.trim().slice(0, 60)
      if (newName) renamePipeline(el.dataset.rename, newName)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        el.blur()
      }
    })
  })
}

// Wire the panel buttons (defined in HTML)
document.getElementById('ppAddBtn')?.addEventListener('click', () => {
  if (!state.root) { toast('Open a folder first'); return }
  const name = prompt('Pipeline name:', 'New pipeline')
  if (name && name.trim()) createPipeline(name.trim())
})
document.getElementById('ppModeBtn')?.addEventListener('click', () => {
  const order = ['off', 'dim', 'hide']
  const next = order[(order.indexOf(state.activeSetMode) + 1) % order.length]
  setActiveSetMode(next)
  toast(`Active-set mode: ${next}`)
})

bus.on('activeset:changed', renderPipelinesPanel)
bus.on('snapshot:applied', renderPipelinesPanel)

// ═══════════════════════════════════════════════════════════════
//  Recent files — last 8 files the user selected, persisted per
//  root. Lets you quickly jump back to files you've been looking
//  at without searching again.
// ═══════════════════════════════════════════════════════════════
const RECENT_KEY_PREFIX = 'codesynapt:recent:'
const RECENT_LIMIT = 8

function recentKey(root) { return RECENT_KEY_PREFIX + (root || '') }
function loadRecent(root) {
  if (!root) return []
  try {
    const raw = localStorage.getItem(recentKey(root))
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveRecent(root, list) {
  if (!root) return
  try { localStorage.setItem(recentKey(root), JSON.stringify(list)) } catch {}
}
function pushRecent(id) {
  if (!id || !state.root) return
  const list = loadRecent(state.root).filter((x) => x !== id)
  list.unshift(id)
  if (list.length > RECENT_LIMIT) list.length = RECENT_LIMIT
  saveRecent(state.root, list)
  renderRecentFiles()
}
function clearRecent() {
  if (!state.root) return
  try { localStorage.removeItem(recentKey(state.root)) } catch {}
  renderRecentFiles()
}

function renderRecentFiles() {
  const host = document.getElementById('recentList-files')
  const panel = document.getElementById('recentFiles')
  if (!host || !panel) return
  const list = state.root ? loadRecent(state.root) : []
  // Filter to ones that still exist in the current graph
  const valid = list.filter((id) => state.nodes.has(id))
  if (valid.length === 0) {
    host.innerHTML = `<div class="rf-empty">${t('recent.empty')}</div>`
    return
  }
  host.innerHTML = valid.map((id) => {
    const n = state.nodes.get(id)
    const color = n.hex || '#888'
    const filename = basename(id)
    const isActive = state.selectedId === id
    return `
      <div class="rf-item ${isActive ? 'active' : ''}" data-id="${escapeAttr(id)}" title="${escapeAttr(id)}">
        <span class="rf-dot" style="background:${color};color:${color}"></span>
        <span class="rf-name">${escapeHTML(filename)}</span>
      </div>
    `
  }).join('')
  host.querySelectorAll('.rf-item').forEach((el) => {
    el.addEventListener('click', () => selectNode(el.dataset.id))
  })
}

document.getElementById('recentClearBtn').addEventListener('click', clearRecent)

// Subscribe recent files panel to events.
bus.on('selection:changed', (id) => {
  if (id) pushRecent(id)
  renderRecentFiles()
})
bus.on('snapshot:applied', renderRecentFiles)
function renderFilterBadges() {
  const host = document.getElementById('filterBadges')
  if (!host) return
  const badges = []

  if (state.filterText) {
    const matchInfo = state.matchCount > 0 ? `${state.matchCount} matches` : 'no matches'
    badges.push({
      key: state.searchSyntax,
      label: state.filterText.length > 20 ? state.filterText.slice(0, 20) + '…' : state.filterText,
      title: `Search (${state.searchSyntax}): ${state.filterText} — ${matchInfo}`,
      cls: state.matchCount === 0 && state.filterText ? 'warning' : '',
      clear: () => {
        state.filterText = ''
        document.getElementById('search').value = ''
        applyFilter()
      },
    })
  }

  if (state.hiddenExts.size > 0) {
    const exts = [...state.hiddenExts].slice(0, 3).map((e) => '.' + e).join(', ')
    const more = state.hiddenExts.size > 3 ? ` +${state.hiddenExts.size - 3}` : ''
    badges.push({
      key: 'hidden',
      label: exts + more,
      title: `Hidden extensions: ${[...state.hiddenExts].map((e) => '.' + e).join(', ')}`,
      clear: () => {
        state.hiddenExts.clear()
        updateLegend()
        applyFilter()
      },
    })
  }

  if (state.searchMode === 'hide' && state.filterText) {
    badges.push({
      key: 'mode',
      label: 'hide non-match',
      title: 'Search mode is "hide non-matching" — click ✕ to switch to highlight',
      clear: () => {
        state.searchMode = 'highlight'
        try { localStorage.setItem('codesynapt:search_mode', 'highlight') } catch {}
        if (window.syncSearchModeBtn) window.syncSearchModeBtn()
        applyFilter()
      },
    })
  }

  if (state.folderGrouping) {
    badges.push({
      key: 'layout',
      label: 'folder clustering',
      title: 'Files in the same folder are pulled toward each other',
      clear: () => {
        // Reuse the canonical Settings toggle so the FULL teardown runs:
        // de-cluster animation (disperse targets + frames), hideFolderBubbles(),
        // camera reframe, persistence, and the filter:changed that removes this
        // badge. The ✕ used to only flip the flag + reheat — leaving nodes
        // clustered and the folder bubbles on screen, so it "didn't revert" and
        // you had to turn it off in Settings instead.
        const btn = document.getElementById('folderGroupBtn')
        if (btn && state.folderGrouping) { btn.click(); return }
        // Fallback if the toggle button isn't in the DOM for some reason.
        state.folderGrouping = false
        try { localStorage.setItem('codesynapt:folder_grouping', 'false') } catch {}
        if (btn) btn.classList.remove('active')
        reheat(0.3)
      },
    })
  }

  if (state.showAllConnected) {
    badges.push({
      key: 'focus',
      label: 'show all connected',
      title: 'Ripple ignores depth limit and reaches every connected file',
      clear: () => {
        state.showAllConnected = false
        try { localStorage.setItem('codesynapt:show_all_connected', 'false') } catch {}
        invalidateFocusCache()
        const btn = document.getElementById('showAllBtn')
        if (btn) btn.classList.remove('active')
        const inp = document.getElementById('focusDepthInput')
        if (inp) inp.disabled = false
      },
    })
  }

  if (state.paused) {
    badges.push({
      key: 'sim',
      label: 'paused',
      title: 'Physics simulation paused (Space to resume)',
      clear: () => document.getElementById('pause').click(),
    })
  }

  // Active set badge — shows when curation is on
  if (state.activeSetMode !== 'off') {
    const eff = computeEffectiveActiveSet()
    const liveCount = eff ? eff.size : 0
    badges.push({
      key: 'active',
      label: `${state.activeSetMode === 'hide' ? 'hide' : 'dim'} non-active · ${liveCount}`,
      title: `${liveCount} files marked active. Click ✕ to turn off active-set mode.`,
      clear: () => setActiveSetMode('off'),
    })
  }

  // Render
  host.innerHTML = badges.map((b, i) => `
    <span class="filter-badge ${b.cls || ''}" data-i="${i}" title="${escapeAttr(b.title)}">
      <span class="badge-key">${escapeHTML(b.key)}</span>
      <span>${escapeHTML(b.label)}</span>
      <button data-clear="${i}" title="Clear">✕</button>
    </span>
  `).join('')

  host.querySelectorAll('button[data-clear]').forEach((el) => {
    const i = parseInt(el.dataset.clear, 10)
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      badges[i].clear()
      renderFilterBadges()
    })
  })
}

// Filter badges refresh on every filter change via the event bus.
// Other state changes (folder grouping, show-all) explicitly call
// renderFilterBadges() from their toggle handlers — see below.
bus.on('filter:changed', renderFilterBadges)
bus.on('focus:changed',  renderFilterBadges)
bus.on('snapshot:applied', renderFilterBadges)
bus.on('activeset:changed', renderFilterBadges)
//  last-change time, backend, and FPS. Refreshed twice per second.
//
//  Connected-component count is cached because computing it via
//  union-find is O(N + E) and we don't want to do that twice per
//  second. The cache invalidates whenever the graph mutates.
// ═══════════════════════════════════════════════════════════════
let cachedComponentCount = 0
let componentCacheStale = true

function recomputeComponents() {
  if (state.byIdx.length === 0) { cachedComponentCount = 0; componentCacheStale = false; return }
  const parent = new Map()
  for (const n of state.byIdx) parent.set(n.id, n.id)
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  for (const e of state.edges) {
    const ra = find(e.s), rb = find(e.t)
    if (ra && rb && ra !== rb) parent.set(ra, rb)
  }
  const roots = new Set()
  for (const id of parent.keys()) roots.add(find(id))
  cachedComponentCount = roots.size
  componentCacheStale = false
}

function formatRelativeTime(ms) {
  if (!ms) return '—'
  const ago = performance.now() - ms
  if (ago < 5000) return 'just now'
  if (ago < 60000) return Math.floor(ago / 1000) + 's ago'
  if (ago < 3600000) return Math.floor(ago / 60000) + 'm ago'
  return Math.floor(ago / 3600000) + 'h ago'
}

function updateStatusBar() {
  // Recompute components when:
  //   - the cache is stale AND
  //   - either the graph is small (cheap) or settled (don't compete
  //     for CPU with active physics).
  if (componentCacheStale) {
    const settled = state.sim.alpha < state.sim.alphaMin
    const cheap = state.byIdx.length < 50_000
    if (cheap || settled) recomputeComponents()
  }

  document.getElementById('sb_files').innerHTML =
    `<span class="v">${state.byIdx.length.toLocaleString()}</span> ${t('status.files')}`
  document.getElementById('sb_edges').innerHTML =
    `<span class="v">${state.edges.length.toLocaleString()}</span> ${t('status.edges')}`
  document.getElementById('sb_comps').innerHTML = componentCacheStale
    ? `<span class="v">—</span> ${t('status.comp')}`
    : `<span class="v">${cachedComponentCount.toLocaleString()}</span> ${t('status.comp')}`

  // Symbol-mode cell — built lazily; shows current symbol count if
  // built, or a dash + click hint otherwise.
  const sbSyms = document.getElementById('sb_symbols')
  if (sbSyms) {
    const s = symbolModeState
    if (s.loading) {
      sbSyms.innerHTML = `<span class="v">…</span> ${t('status.symbols')}`
    } else if (s.count != null) {
      sbSyms.innerHTML = `<span class="v">${s.count.toLocaleString()}</span> ${t('status.symbols')}`
    } else {
      sbSyms.innerHTML = `<span class="v">—</span> ${t('status.symbols')}`
    }
  }

  // Sim state
  let stateLabel, stateClass = ''
  if (state.paused) { stateLabel = '⏸ ' + t('sim.paused') }
  else if (state.draggingNode) { stateLabel = '✋ ' + t('sim.dragging') }
  else if (state.sim.alpha < state.sim.alphaMin) { stateLabel = '✓ ' + t('sim.settled'); stateClass = 'good' }
  else if (state.sim.alpha > 0.1) { stateLabel = '⟳ ' + t('sim.simulating'); stateClass = 'accent' }
  else { stateLabel = '⟳ ' + t('sim.cooling') }
  const stateEl = document.getElementById('sb_state')
  stateEl.textContent = stateLabel
  stateEl.className = `status-cell ${stateClass === 'accent' ? '' : stateClass}`

  document.getElementById('sb_changed').innerHTML =
    `${t('status.last_change')}: <span class="v">${formatRelativeTime(lastChangeAt)}</span>`

  // Backend
  const bs = backend.getStatus()
  const beEl = document.getElementById('sb_backend')
  beEl.innerHTML = `${bs.active === 'gpu' ? 'GPU' : 'CPU'}${bs.mode === 'auto' && bs.gpuAvailable ? ' (auto)' : ''}`
  beEl.className = `status-cell ${bs.active === 'gpu' ? 'good' : ''}`

  // FPS
  const fpsEl = document.getElementById('sb_fps')
  const fps = Math.round(fpsEMA)
  fpsEl.innerHTML = `<span class="v">${fps}</span> fps`
  fpsEl.className = `status-cell ${fps < 30 ? 'bad' : fps < 55 ? '' : 'good'}`
}

let lastTime = performance.now()
let labelTimer = 0

// FPS tracking — exponential moving average over recent frames so the
// status bar reading isn't jumpy. Updated every frame, displayed once
// per second.
let fpsEMA = 60
let lastStatusUpdate = 0
let lastChangeAt = 0   // performance.now() of most recent file mutation

let GLOBAL_HEARTBEAT = 0
function render() {
  requestAnimationFrame(render)
  if (glContextLost) return   // GPU context gone — skip work, keep loop alive to resume on restore
  const now = performance.now()
  const dt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now
  labelTimer += dt
  // Subtle scene-wide heartbeat — ~50 BPM (1.2 sec period). Sets the
  // tempo for trace pulses and gives the still graph a feeling of
  // being "alive" rather than static.
  GLOBAL_HEARTBEAT = Math.sin(now / 950 * Math.PI)

  // Frame-time → FPS, smoothed
  if (dt > 0.001) {
    const instFps = 1 / dt
    fpsEMA = fpsEMA * 0.92 + instFps * 0.08
  }
  // Refresh status bar 2× per second
  if (now - lastStatusUpdate > 500) {
    lastStatusUpdate = now
    updateStatusBar()
  }

  tickCamera(dt)
  if (!state.paused) backend.runStep(dt, stepCPU, stepGPU)

  // Background ambience moves only while the simulation is running, so
  // the ❚❚ pause button freezes the whole scene including stars/nebula.
  if (!state.paused) {
    starfield.rotation.y += dt * 0.008
    nebula.rotation.y -= dt * 0.005
  }

  // Throttled picking (only when mouse moved + cool-down)
  if (state.mouseMoved && (now - state.lastPickAt) > PICK_THROTTLE_MS
      && !state.draggingNode && !state.cameraDragging) {
    state.lastPickAt = now
    state.mouseMoved = false
    const rect = canvas.getBoundingClientRect()
    const mx = ((state.lastMouseX - rect.left) / rect.width) * 2 - 1
    const my = -((state.lastMouseY - rect.top) / rect.height) * 2 + 1
    const newHover = pickAtNDC(mx, my)
    if (newHover !== state.hoverId) {
      state.hoverId = newHover
      canvas.style.cursor = newHover ? 'pointer' : 'default'
    }
    // Hovered-function name tooltip (symbol layer only).
    const hs = state.showSymbols && state.hoverId ? state.symbols.get(state.hoverId) : null
    if (hs) {
      const nb = state.symbolAdj.get(state.hoverId)?.size || 0
      symTip.textContent = `${hs.name}${hs.line ? ':' + hs.line : ''}  ·  ${hs.kind} · ${nb} call${nb === 1 ? '' : 's'}`
      symTip.style.left = (state.lastMouseX + 14) + 'px'
      symTip.style.top = (state.lastMouseY + 12) + 'px'
      symTip.style.display = 'block'
    } else if (symTip.style.display !== 'none') {
      symTip.style.display = 'none'
    }
  }

  const fd = focusDistances()
  // In show-all mode, falloff uses the BFS's actual max distance so
  // the curve adapts to the graph's diameter. In bounded mode it
  // uses the user's configured depth.
  const maxDepth = !fd ? state.focusDepth
                 : state.showAllConnected ? Math.max(1, fd.maxDist)
                 : state.focusDepth
  const dists = fd ? fd.dists : null
  const lerpK = 1 - Math.exp(-dt * 9)

  // Compute the effective active set once per frame, not per node.
  // null means "active set is disabled" — every file is live.
  const effectiveActiveSet = computeEffectiveActiveSet()

  // ─── Write node buffers ───
  const n = state.byIdx.length
  for (let i = 0; i < n; i++) {
    const node = state.byIdx[i]
    nodePositions[i*3]   = node.p.x
    nodePositions[i*3+1] = node.p.y
    nodePositions[i*3+2] = node.p.z

    const age = node.bornAt ? Math.min((now - node.bornAt) / 500, 1) : 1
    const grow = age * age * (3 - 2 * age)

    // Time-lapse filter: hide nodes that didn't exist yet at cutoff
    let visible = node.visible !== false
    if (state.timelineCutoff !== null) {
      const bornEpoch = state.fileBornAt.get(node.id)
      if (bornEpoch && bornEpoch > state.timelineCutoff) visible = false
    }

    // Distance-based color emphasis: selected + neighbors brighter,
    // unrelated nodes dimmed to 0.40 floor. Size stays constant
    // (focusPop = 1.0 always) so the graph never thrashes physically.
    let emphasis
    if (!dists) {
      emphasis = 1.0
    } else {
      const d = dists.get(node.id)
      emphasis = emphasisFor(d, maxDepth)
    }

    // Search match boost (highlight mode). When there's an active
    // search and this node matches, push emphasis to full and dim
    // non-matches further. In hide mode non-matches already had
    // visible=false set by applyFilter so no boost is needed.
    if (state.filterText && state.searchMode === 'highlight') {
      if (node.matched) emphasis = Math.max(emphasis, 1.0)
      else emphasis = Math.min(emphasis, 0.30)
    }

    // Active-set dimming. When a curated set is enabled, non-active
    // files get pushed way down so the active subset stands out.
    // effectiveActiveSet was computed once before this loop.
    let activeVisible = visible
    if (effectiveActiveSet && !effectiveActiveSet.has(node.id)) {
      if (state.activeSetMode === 'hide') {
        activeVisible = false
      } else {
        // dim mode
        emphasis = Math.min(emphasis, 0.12)
      }
    } else if (effectiveActiveSet && effectiveActiveSet.has(node.id)) {
      // Active files always at least visible-strength emphasis,
      // overriding focus-ripple darkening from afar.
      emphasis = Math.max(emphasis, 0.85)
    }

    const tEmit = activeVisible ? emphasis : 0.06
    const tAlpha = activeVisible ? Math.max(emphasis, 0.15) : 0.06
    node.emit += (tEmit - node.emit) * lerpK
    node.haloA += (tAlpha - node.haloA) * lerpK

    // AI trace pulse — recently-touched nodes glow + pulse so the user
    // can SEE which files Claude/Cursor/MCP client just read/wrote.
    // Combines (a) a sharp ripple burst right after the trace event
    // and (b) a slower decay tint so the node stays "marked" for a few
    // seconds. Heartbeat synchronizes everything to a global beat.
    let traceBoost = 0
    let traceTint = null
    let rippleSize = 0
    const trace = state.aiTrace.get(node.id)
    if (trace) {
      const age = now - trace.lastAt
      // Writes get a longer TTL — they're more consequential than reads
      // and the user is more likely to want to see *what changed* even
      // a few seconds after the AI moved on.
      const isWrite = trace.tool === 'write'
      const ttl = isWrite ? AI_TRACE_TTL_MS * 2.5 : AI_TRACE_TTL_MS
      if (age > ttl) {
        state.aiTrace.delete(node.id)
      } else {
        const fade = Math.exp(-age / (isWrite ? 3000 : 1500))
        const beat = 0.7 + 0.3 * Math.sin(now / 90 + i * 0.1)
        traceBoost = fade * beat * (isWrite ? 1.3 : 1.0)
        traceTint = AI_TRACE_COLORS[trace.tool] || AI_TRACE_COLORS.read
        // First 700ms after a trace: sharp ripple — node briefly grows
        // 3-4× then settles. Adds the "wow" beat. Writes get a bigger
        // burst (4-5×) to emphasize they're a state-changing event.
        if (age < 700) {
          const t = age / 700
          rippleSize = (1 - t) * (1 - t) * (1 - t) * (isWrite ? 4.5 : 3.0)
        }
      }
    }

    const r = radiusFor(node)
    // Size always stays constant — selection/hover never changes node
    // size, which was perceived as visual "thrashing" on click.
    // The selection signal is carried entirely by edge brightness.
    const focusPop = 1.0
    const searchPop = node.matched ? 1.2 : 1.0
    const starPop = state.activeFiles.has(node.id) ? 1.15 : 1.0
    const tracePop = 1.0 + traceBoost * 1.4 + rippleSize
    let baseSize = r * 3 * (state.nodeSizeScale || 1) * grow * (0.7 + 0.6 * node.emit + GLOBAL_HEARTBEAT * 0.06) * focusPop * searchPop * starPop * tracePop
    // When this node is being traced (read/write/etc), enforce a
    // minimum size so it's visible even from a far camera. 11k-node
    // graphs viewed at ~1700-unit distance otherwise compress traced
    // nodes to a single pixel — invisible.
    if (trace) {
      // Boost increases with traceBoost (peak ~1.0 right after the event)
      // and ripple (the burst in first 700ms).
      const traceMinSize = 30 + traceBoost * 60 + rippleSize * 60
      if (baseSize < traceMinSize) baseSize = traceMinSize
    }
    nodeSizes[i] = baseSize
    nodeAlphas[i] = activeVisible ? Math.min(1, node.haloA + traceBoost * 0.85) : 0

    const boost = 0.55 + 0.5 * node.emit
    // Base node color: extension hue, OR a 60/40 blend with the folder
    // tint when folder grouping is on. This is what makes "same folder"
    // immediately visible — all files in one folder share a hue.
    let baseR = node.rgb[0], baseG = node.rgb[1], baseB = node.rgb[2]
    if (state.folderGrouping && node.folderRgb) {
      const k = 0.6
      baseR = baseR * (1 - k) + node.folderRgb[0] * k
      baseG = baseG * (1 - k) + node.folderRgb[1] * k
      baseB = baseB * (1 - k) + node.folderRgb[2] * k
    }
    // Legacy candidate tint — rusty orange, slow pulse. Renders below
    // the trace tint so an AI touch on a candidate still shows trace
    // color. Pulse is global so all candidates breathe in sync (easier
    // to spot the cluster at a glance).
    if (node.isLegacyCandidate) {
      // GLOBAL_HEARTBEAT is sin(t) ∈ [-1,1]; remap to [0.3,1.0] so the
      // tint never disappears entirely.
      const pulse = 0.65 + 0.35 * GLOBAL_HEARTBEAT
      const k = 0.55 + 0.25 * pulse
      baseR = baseR * (1 - k) + 0.95 * k    // rust orange
      baseG = baseG * (1 - k) + 0.45 * k
      baseB = baseB * (1 - k) + 0.10 * k
    }
    if (traceTint) {
      // Lerp node color toward trace tint by fade amount — stronger
      // when fresh, fully traced color at peak.
      const blend = Math.min(1, traceBoost * 1.2 + rippleSize * 0.3)
      nodeColors[i*3]   = baseR * boost * (1 - blend * 0.6) + traceTint[0] * blend
      nodeColors[i*3+1] = baseG * boost * (1 - blend * 0.6) + traceTint[1] * blend
      nodeColors[i*3+2] = baseB * boost * (1 - blend * 0.6) + traceTint[2] * blend
    } else {
      nodeColors[i*3]   = baseR * boost
      nodeColors[i*3+1] = baseG * boost
      nodeColors[i*3+2] = baseB * boost
    }
  }
  nodePosAttr.needsUpdate = true
  nodeColorAttr.needsUpdate = true
  nodeSizeAttr.needsUpdate = true
  nodeAlphaAttr.needsUpdate = true
  nodePosAttr.clearUpdateRanges(); nodePosAttr.addUpdateRange(0, n * 3)
  nodeColorAttr.clearUpdateRanges(); nodeColorAttr.addUpdateRange(0, n * 3)
  nodeSizeAttr.clearUpdateRanges(); nodeSizeAttr.addUpdateRange(0, n)
  nodeAlphaAttr.clearUpdateRanges(); nodeAlphaAttr.addUpdateRange(0, n)
  nodeGeo.setDrawRange(0, n)

  // ─── Write edge buffers ───
  //
  // Edge brightness uses the MAX distance of its two endpoints
  // (i.e. how "deep" the chain has to be to include this edge).
  // An edge between dist-1 and dist-2 nodes is "the 2nd hop edge"
  // and gets dist-2 emphasis. Edges touching the focused node
  // (dist 0—1) are the brightest. Edges with either endpoint
  // unreached are heavily faded.
  let e = 0
  for (let i = 0; i < state.edges.length; i++) {
    if (e >= MAX_EDGES) break
    const edge = state.edges[i]
    const na = state.nodes.get(edge.s), nb = state.nodes.get(edge.t)
    if (!na || !nb) continue
    if (na.visible === false || nb.visible === false) continue
    edgePositions[e*6]   = na.p.x
    edgePositions[e*6+1] = na.p.y
    edgePositions[e*6+2] = na.p.z
    edgePositions[e*6+3] = nb.p.x
    edgePositions[e*6+4] = nb.p.y
    edgePositions[e*6+5] = nb.p.z
    colorBuf.set(EDGE_COLORS[edge.k] || '#888')
    if (dists) {
      // Direct edge to the selected node? Boost brightness so the
      // user can immediately see "what's connected to this node".
      // Other edges dim to 15 % so they recede into the background.
      const ds = dists.get(edge.s), dt2 = dists.get(edge.t)
      if (ds === 0 || dt2 === 0) {
        colorBuf.multiplyScalar(1.5)
      } else {
        colorBuf.multiplyScalar(0.15)
      }
    }
    edgeColorsBuf[e*6]   = colorBuf.r
    edgeColorsBuf[e*6+1] = colorBuf.g
    edgeColorsBuf[e*6+2] = colorBuf.b
    edgeColorsBuf[e*6+3] = colorBuf.r
    edgeColorsBuf[e*6+4] = colorBuf.g
    edgeColorsBuf[e*6+5] = colorBuf.b
    e++
  }
  edgePosAttr.needsUpdate = true
  edgeColorAttr.needsUpdate = true
  edgePosAttr.clearUpdateRanges(); edgePosAttr.addUpdateRange(0, e * 6)
  edgeColorAttr.clearUpdateRanges(); edgeColorAttr.addUpdateRange(0, e * 6)
  edgeGeo.setDrawRange(0, e * 2)

  // ─── Symbol layer: ride each function on its parent file node ───
  if (state.showSymbols && state.symbols.size) {
    // The hovered/selected symbol, if any — its call edges light up so you
    // see what a function connects to (its synapses). Others recede.
    const hlSym = (state.hoverId && state.symbols.has(state.hoverId)) ? state.hoverId
                : (state.selectedId && state.symbols.has(state.selectedId)) ? state.selectedId
                : null
    const hlNbrs = hlSym ? state.symbolAdj.get(hlSym) : null
    let si = 0
    for (const sym of state.symbols.values()) {
      const fn = state.nodes.get(sym.file)
      if (!fn || fn.visible === false) { sym.shown = false; continue }
      sym.p.copy(fn.p).add(sym.off)
      sym.shown = true
      symPositions[si*3] = sym.p.x; symPositions[si*3+1] = sym.p.y; symPositions[si*3+2] = sym.p.z
      let cr, cg, cb
      if (!hlSym) {
        // Resting: a FAINT cloud (context, not a bright blob) so a hover pops.
        const c = SYM_KIND_COLOR[sym.kind] || _symDefColor; cr = c.r*0.5; cg = c.g*0.5; cb = c.b*0.5
      } else if (sym.id === hlSym) {
        cr = _symHiColor.r; cg = _symHiColor.g; cb = _symHiColor.b           // hovered = white
      } else if (hlNbrs && hlNbrs.has(sym.id)) {
        const c = SYM_KIND_COLOR[sym.kind] || _symDefColor; cr = c.r; cg = c.g; cb = c.b   // its callers/callees = bright
      } else {
        cr = 0.09; cg = 0.11; cb = 0.16                                      // unrelated = dim
      }
      symColors[si*3] = cr; symColors[si*3+1] = cg; symColors[si*3+2] = cb
      si++
      if (si >= MAX_SYMBOLS) break
    }
    symPosAttr.needsUpdate = true; symColAttr.needsUpdate = true
    symPosAttr.clearUpdateRanges(); symPosAttr.addUpdateRange(0, si*3)
    symColAttr.clearUpdateRanges(); symColAttr.addUpdateRange(0, si*3)
    symGeo.setDrawRange(0, si)
    let se = 0
    for (const call of state.symbolCalls) {
      const a = state.symbols.get(call.s), b = state.symbols.get(call.t)
      if (!a || !b || !a.shown || !b.shown) continue
      symEdgePositions[se*6]   = a.p.x; symEdgePositions[se*6+1] = a.p.y; symEdgePositions[se*6+2] = a.p.z
      symEdgePositions[se*6+3] = b.p.x; symEdgePositions[se*6+4] = b.p.y; symEdgePositions[se*6+5] = b.p.z
      let r, g2, b2
      // Resting: type-checker-resolved calls (via:'ts') get a teal tint so the
      // sub-engine enrichment is visible; plain AST-resolved calls stay blue.
      if (!hlSym && call.via === 'ts')                  { r = 0.10; g2 = 0.36; b2 = 0.30 }   // resting: tsc-enriched (teal)
      else if (!hlSym)                                  { r = 0.11; g2 = 0.20; b2 = 0.38 }   // resting: heuristic (faint blue)
      else if (call.s === hlSym || call.t === hlSym)    { r = 0.55; g2 = 0.95; b2 = 1.00 }   // hovered fn's edges: bright
      else                                              { r = 0.03; g2 = 0.04; b2 = 0.08 }   // unrelated: near-invisible
      symEdgeColors[se*6]   = r; symEdgeColors[se*6+1] = g2; symEdgeColors[se*6+2] = b2
      symEdgeColors[se*6+3] = r; symEdgeColors[se*6+4] = g2; symEdgeColors[se*6+5] = b2
      se++
      if (se >= MAX_SYMBOL_EDGES) break
    }
    symEdgePosAttr.needsUpdate = true; symEdgeColAttr.needsUpdate = true
    symEdgePosAttr.clearUpdateRanges(); symEdgePosAttr.addUpdateRange(0, se*6)
    symEdgeColAttr.clearUpdateRanges(); symEdgeColAttr.addUpdateRange(0, se*6)
    symEdgeGeo.setDrawRange(0, se*2)
  }

  // ─── AI navigation trail (a Line through last N traced nodes) ───
  // Pull most-recent first → reverse render order so newest = brightest
  const liveTrail = []
  for (const t of state.aiTrailIds) {
    const age = now - t.at
    if (age > 8000) continue                 // expire after 8s
    const tn = state.nodes.get(t.id)
    if (!tn) continue
    liveTrail.push({ p: tn.p, age })
  }
  let trailCount = 0
  for (let k = liveTrail.length - 1; k >= 0; k--) {  // oldest first
    const tn = liveTrail[k]
    trailPositions[trailCount * 3]     = tn.p.x
    trailPositions[trailCount * 3 + 1] = tn.p.y
    trailPositions[trailCount * 3 + 2] = tn.p.z
    const fade = Math.max(0, 1 - tn.age / 8000)
    // Brighten the newest — color gradient from cyan→magenta as the AI
    // navigates the graph. Combined with the additive blending, fresh
    // segments glow.
    trailColors[trailCount * 3]     = (0.6 + 0.4 * (k / Math.max(1, liveTrail.length - 1))) * fade
    trailColors[trailCount * 3 + 1] = 0.35 * fade
    trailColors[trailCount * 3 + 2] = (0.9 - 0.5 * (k / Math.max(1, liveTrail.length - 1))) * fade
    trailCount++
  }
  trailPosAttr.needsUpdate = true
  trailColorAttr.needsUpdate = true
  trailPosAttr.clearUpdateRanges(); trailPosAttr.addUpdateRange(0, trailCount * 3)
  trailColorAttr.clearUpdateRanges(); trailColorAttr.addUpdateRange(0, trailCount * 3)
  trailGeo.setDrawRange(0, trailCount)

  // ─── Labels (pool of LABEL_POOL DIVs, position chosen targets) ───
  // Labels are positioned in viewport coordinates, but the canvas no
  // longer fills the viewport — it lives in a center column between
  // the left and right rails. So we project to NDC, then map to the
  // canvas's screen rect (not window coords).
  const targets = pickLabelTargets(fd)
  const rect = canvas.getBoundingClientRect()
  const halfW = rect.width / 2, halfH = rect.height / 2
  const proj = new THREE.Vector3()
  for (let i = 0; i < labelPool.length; i++) {
    const el = labelPool[i]
    const t = targets[i]
    if (!t) { el.style.opacity = '0'; continue }
    proj.copy(t.p).project(camera)
    if (proj.z > 1 || proj.x < -1 || proj.x > 1 || proj.y < -1 || proj.y > 1) {
      el.style.opacity = '0'; continue
    }
    el.textContent = basename(t.id)
    el.style.left = (rect.left + proj.x * halfW + halfW) + 'px'
    el.style.top = (rect.top + -proj.y * halfH + halfH) + 'px'
    el.style.opacity = '1'
  }

  // ─── Folder bubbles + labels (recenter bubble to cluster, place labels) ───
  updateFolderBubblesToCentroids()
  updateFolderLabels(rect, halfW, halfH, proj)

  renderer.render(scene, camera)
  renderViewCube()

  // Drive the minimap from the same RAF, throttled internally
  if (window.__drawMinimap) window.__drawMinimap(now)
}

// ═══════════════════════════════════════════════════════════════
//  Resize
// ═══════════════════════════════════════════════════════════════
function resize() {
  const w = canvas.clientWidth || window.innerWidth
  const h = canvas.clientHeight || window.innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
// Re-fit canvas when rails toggle (CSS animates panels in/out but the
// renderer needs to know the new viewport dimensions explicitly).
new ResizeObserver(resize).observe(canvas)
resize(); updateCamera()

// ═══════════════════════════════════════════════════════════════
//  Mouse interaction
// ═══════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster()
let lastX = 0, lastY = 0, downAt = 0, downX = 0, downY = 0
const DRAG_THRESH = 5

// ═══════════════════════════════════════════════════════════════
//  Canvas pointer interaction
//
//  We use Pointer Events with setPointerCapture so the drag survives:
//    - the cursor leaving the window (mouse-up off-screen)
//    - the canvas being resized mid-drag
//    - a snapshot removing the dragged node (we detect that via
//      `state.nodes.has(node.id)` and bail cleanly)
//
//  Click vs drag is disambiguated by a 5px threshold and a 400ms
//  cap. Hover is throttled (rendered every 32ms in render()) so we
//  must NOT trust state.hoverId for clicks — we re-pick at click
//  time to avoid the "stale hover after fast click" bug.
// ═══════════════════════════════════════════════════════════════
let activePointerId = null

function endActiveDrag() {
  if (state.draggingNode) {
    state.draggingNode = null
    state.dragPlane = null
    // No reheat — user said clicking/dragging shouldn't make
    // the whole graph thrash. Settled positions stay put.
  }
  state.cameraDragging = false
  canvas.style.cursor = state.hoverId ? 'pointer' : 'default'
  activePointerId = null
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return                  // only primary button
  if (activePointerId !== null) return        // already dragging
  activePointerId = e.pointerId
  try { canvas.setPointerCapture(e.pointerId) } catch {}
  markUserInteraction()

  downAt = performance.now()
  downX = lastX = e.clientX
  downY = lastY = e.clientY

  if (state.hoverId) {
    const node = state.nodes.get(state.hoverId)
    if (node) {
      state.draggingNode = node
      const camDir = camera.getWorldDirection(new THREE.Vector3()).negate()
      state.dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, node.p)
      node.v.set(0, 0, 0)
      canvas.style.cursor = 'grabbing'
      // No reheat — clicking/dragging shouldn't kick the whole graph
      // into motion. Drag follows the cursor via direct position set,
      // not via force-sim alpha bump.
    } else {
      // Stale hover — node was removed between hover-set and click.
      // Fall through to camera drag.
      state.hoverId = null
      state.cameraDragging = true
    }
  } else {
    state.cameraDragging = true
  }
})

canvas.addEventListener('pointermove', (e) => {
  state.lastMouseX = e.clientX
  state.lastMouseY = e.clientY
  state.mouseMoved = true

  if (state.draggingNode && state.dragPlane) {
    // Guard: snapshot may have removed the node while we were
    // dragging. Detect by checking the node is still mapped.
    if (!state.nodes.has(state.draggingNode.id)) {
      endActiveDrag()
      return
    }
    const rect = canvas.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera({ x: mx, y: my }, camera)
    const hit = new THREE.Vector3()
    if (raycaster.ray.intersectPlane(state.dragPlane, hit)) {
      state.draggingNode.p.copy(hit)
      state.draggingNode.v.set(0, 0, 0)
    }
    // No reheat — alpha accumulating during drag was causing the
    // graph to explode after release. Dragged node moves directly;
    // no force-sim kick needed.
  } else if (state.cameraDragging) {
    cam.theta += (e.clientX - lastX) * 0.005
    cam.phi   -= (e.clientY - lastY) * 0.005
    lastX = e.clientX; lastY = e.clientY
    updateCamera()
  }
})

// pointerup, pointercancel (lost capture, dragged to other monitor)
// and pointerleave-with-buttons-zero all need to release the drag.
function handlePointerEnd(e) {
  if (activePointerId !== null && e.pointerId !== activePointerId) return
  endActiveDrag()
}
canvas.addEventListener('pointerup', handlePointerEnd)
canvas.addEventListener('pointercancel', handlePointerEnd)
// Safety: if the window loses focus while dragging, drop the drag
window.addEventListener('blur', endActiveDrag)

const _zoomViewDir = new THREE.Vector3()
const _zoomPlane = new THREE.Plane()
const _zoomHit = new THREE.Vector3()
const _zoomOrigin = new THREE.Vector3()
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  markUserInteraction()
  const oldR = cam.targetRadius
  // Allow zoom-out up to 3000 so very large projects (auto-tuned
  // maxWorld up to 600) can be viewed in full from a distance.
  // Wheel sensitivity scales with current radius so zooming feels
  // consistent across the whole range.
  const wheelSpeed = 0.12 * (1 + oldR / 1000)
  const newR = Math.max(10, Math.min(5500, oldR + e.deltaY * wheelSpeed))
  if (newR === oldR) return
  if (e.deltaY < 0) {
    // Zoom in: dolly toward cursor (point under cursor stays put on screen)
    const rect = canvas.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera({ x: mx, y: my }, camera)
    camera.getWorldDirection(_zoomViewDir)
    _zoomPlane.setFromNormalAndCoplanarPoint(_zoomViewDir.clone().negate(), cam.targetGoal)
    if (raycaster.ray.intersectPlane(_zoomPlane, _zoomHit)) {
      cam.targetGoal.lerp(_zoomHit, 1 - newR / oldR)
    }
  } else {
    // Zoom out: drift target back toward world origin so you see the whole graph
    cam.targetGoal.lerp(_zoomOrigin, 1 - oldR / newR)
  }
  cam.targetRadius = newR
}, { passive: false })

// Toolbar zoom buttons — proportional step (~15% of current radius)
// per click. No cursor anchor since the button doesn't have one;
// zoom-in just moves toward current target, zoom-out drifts toward
// origin like the wheel.
function zoomStep(direction) {
  markUserInteraction()
  const oldR = cam.targetRadius
  const factor = direction === 'in' ? 0.85 : 1.18
  const newR = Math.max(10, Math.min(5500, oldR * factor))
  if (newR === oldR) return
  if (direction === 'out') {
    cam.targetGoal.lerp(_zoomOrigin, 1 - oldR / newR)
  }
  cam.targetRadius = newR
}
document.getElementById('zoomInBtn')?.addEventListener('click',  () => zoomStep('in'))
document.getElementById('zoomOutBtn')?.addEventListener('click', () => zoomStep('out'))

// ─── Vertical zoom slider ────────────────────────────────────
// Maps slider value 0-1000 to camera distance 5500-10 (log scale).
// Value 1000 = top = closest (small radius). Value 0 = bottom = farthest.
const _zoomMin = 10, _zoomMax = 5500
function zoomSliderFromRadius(r) {
  const clamped = Math.max(_zoomMin, Math.min(_zoomMax, r))
  const t = Math.log(clamped / _zoomMin) / Math.log(_zoomMax / _zoomMin)
  return Math.round(1000 - t * 1000)
}
function zoomRadiusFromSlider(v) {
  const t = (1000 - v) / 1000
  return _zoomMin * Math.pow(_zoomMax / _zoomMin, t)
}
const zoomSliderEl = document.getElementById('zoomSlider')
let _zoomSliderSyncing = false
if (zoomSliderEl) {
  zoomSliderEl.addEventListener('input', () => {
    if (_zoomSliderSyncing) return  // ignore programmatic syncs
    markUserInteraction?.()
    cam.targetRadius = zoomRadiusFromSlider(parseInt(zoomSliderEl.value, 10))
  })
  document.getElementById('zoomSliderIn')?.addEventListener('click', () => zoomStep('in'))
  document.getElementById('zoomSliderOut')?.addEventListener('click', () => zoomStep('out'))
  // Sync slider position to current cam radius — runs from animation
  // loop (cheap). Skips if user is currently dragging the slider.
  function syncZoomSliderToCam() {
    if (document.activeElement === zoomSliderEl) return
    _zoomSliderSyncing = true
    zoomSliderEl.value = zoomSliderFromRadius(cam.targetRadius)
    _zoomSliderSyncing = false
  }
  // Throttle: every ~10 frames
  let _zsFrameCount = 0
  function _zsTick() {
    _zsFrameCount++
    if (_zsFrameCount >= 10) {
      _zsFrameCount = 0
      syncZoomSliderToCam()
    }
    requestAnimationFrame(_zsTick)
  }
  _zsTick()
}

canvas.addEventListener('click', (e) => {
  const dx = e.clientX - downX, dy = e.clientY - downY
  if (Math.sqrt(dx*dx + dy*dy) > DRAG_THRESH) return
  if (performance.now() - downAt > 400) return

  // CRITICAL: re-pick at click time. state.hoverId is throttled to
  // 32ms, so a fast click after a hover-move-then-leave can fire
  // while hoverId still points to the previously hovered node.
  // We re-run picking with the current mouse position to get a
  // fresh result.
  const rect = canvas.getBoundingClientRect()
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1
  const freshHover = pickAtNDC(mx, my)
  selectNode(freshHover)
})

canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect()
  const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1
  const hit = pickAtNDC(mx, my)
  if (hit) openFile(hit)
})

// ═══════════════════════════════════════════════════════════════
//  Keyboard shortcuts
//
//  Avoids overriding browser/OS chords (Ctrl+T, Cmd+W…) and skips
//  shortcut handling when the user is typing into an input field
//  so search-box typing doesn't accidentally pause the sim, etc.
// ═══════════════════════════════════════════════════════════════
function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

window.addEventListener('keydown', (e) => {
  markUserInteraction()
  const typing = isTypingTarget(document.activeElement)
  const settingsOpen = !settingsPanel.classList.contains('hidden')
  const inspectorOpen = !inspector.classList.contains('hidden')
  const dialogOpen = !document.getElementById('projectDialog').classList.contains('hidden')

  // Esc — close whichever panel/selection is active, in priority order
  if (e.key === 'Escape') {
    if (dialogOpen) {
      document.getElementById('projectDialog').classList.add('hidden')
      return
    }
    if (typing) { document.activeElement.blur(); return }
    if (settingsOpen) { settingsPanel.classList.add('hidden'); return }
    if (inspectorOpen) { selectNode(null); return }
    if (state.selectedId) { selectNode(null); return }
    if (state.filterText) {
      state.filterText = ''
      document.getElementById('search').value = ''
      applyFilter()
      return
    }
    return
  }

  if (typing) return  // all other shortcuts skip when typing

  // / — focus search
  if (e.key === '/') {
    e.preventDefault()
    document.getElementById('search').focus()
    return
  }
  // Cmd/Ctrl+F — focus search
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    document.getElementById('search').focus()
    return
  }
  // Cmd/Ctrl+, — open settings (now the left-rail settings tab)
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    openSettings()
    return
  }
  // Space — pause toggle
  if (e.code === 'Space') {
    e.preventDefault()
    pauseBtn.click()
    return
  }
  // R — recenter
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault()
    document.getElementById('recenter').click()
    return
  }
  // F5 — rescan current folder
  if (e.key === 'F5') {
    e.preventDefault()
    refreshFolder()
    return
  }
  // S — toggle stats panel (defined later)
  if (e.key === 's' || e.key === 'S') {
    const sp = document.getElementById('statsPanel')
    if (sp) sp.classList.toggle('hidden')
    return
  }
  // M — toggle the minimap (right sidebar itself is permanent)
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault()
    const btn = document.getElementById('minimapToggle')
    if (btn) btn.click()
    return
  }
  // T — toggle file tree (header button removed; call the toggle directly)
  if (e.key === 't' || e.key === 'T') {
    e.preventDefault()
    toggleTree()
    return
  }
  // 1-3 — restore camera view (Cmd/Ctrl+1-3 saves the current view).
  // saveCustomView / restoreCustomView are hoisted function declarations
  // so they're safe to reference here even though they're defined later.
  if (e.key >= '1' && e.key <= '3') {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      if (typeof saveCustomView === 'function') saveCustomView(e.key)
    } else {
      if (typeof restoreCustomView === 'function') restoreCustomView(e.key)
    }
    return
  }
})

// ═══════════════════════════════════════════════════════════════
//  Inspector
// ═══════════════════════════════════════════════════════════════
const inspector = document.getElementById('inspector')
const inspectorBody = document.getElementById('inspector-body')

async function selectNode(id) {
  if (id && !state.nodes.has(id)) id = null
  state.selectedId = id
  bus.emit('selection:changed', id)
  if (!id) {
    // Inside the right-rail layout the inspector stays visible — reset its
    // body to the empty placeholder so the user sees "no selection".
    inspector.classList.add('hidden')
    if (inspectorBody) {
      inspectorBody.innerHTML = `<div class="rs-empty">${t('inspector.empty')}</div>`
    }
    return
  }
  // Inspector is always visible in the right sidebar — render every time
  // the selection changes.
  renderInspector(id)
  const content = await readFile(id)
  setPreview(id, content)
}

async function openFile(id) {
  if (!id || !state.nodes.has(id)) return
  state.selectedId = id
  bus.emit('selection:changed', id)
  renderInspector(id)
  inspector.classList.remove('hidden')
  const content = await readFile(id)
  setPreview(id, content)
}

function renderInspector(id) {
  const n = state.nodes.get(id)
  if (!n) return
  const outgoing = state.edges.filter((e) => e.s === id).slice(0, 200)
  const incoming = state.edges.filter((e) => e.t === id).slice(0, 200)
  const outCount = state.edges.filter((e) => e.s === id).length
  const inCount  = state.edges.filter((e) => e.t === id).length
  const rowHTML = (e, dir) => {
    const target = dir === 'out' ? e.t : e.s
    const arrow = dir === 'out' ? '→' : '←'
    const color = EDGE_COLORS[e.k] || '#888'
    return `<div class="ins-row" data-target="${escapeAttr(target)}">
      <span class="arrow" style="color:${color}">${arrow}</span>
      <span class="target">${escapeHTML(target)}</span>
      <span class="kind">${e.k}</span>
    </div>`
  }
  const actions = isElectron ? `
    <div class="ins-actions">
      <button class="ins-action" data-action="open">Open</button>
      <button class="ins-action" data-action="reveal">Reveal</button>
    </div>` : ''

  // Connection badge — distinguish "real" connected file from orphan/duplicate
  let badge
  if (inCount === 0 && outCount === 0) {
    badge = `<span class="ins-badge orphan" title="${t('badge.orphan.title')}">${t('badge.orphan.label')}</span>`
  } else if (inCount === 0) {
    badge = `<span class="ins-badge leaf" title="${t('badge.leaf.title')}">${t('badge.leaf.label')}</span>`
  } else {
    badge = `<span class="ins-badge connected" title="${t('badge.connected.title', { n: inCount })}">${t('badge.connected.label', { in: inCount, out: outCount })}</span>`
  }

  // Graph-confidence badge (high/medium/low) + dynamic-resolution marker.
  // Both fields ship in every snapshot (scanner) but were previously unread —
  // surface them so the user sees how trustworthy this file's edges are and
  // when blast radius is only a floor (dynamic imports detected).
  const confBadge = n.confidence
    ? `<span class="ins-badge conf-${n.confidence}" title="${t('badge.conf.title')}">${t('badge.conf.' + n.confidence)}</span>`
    : ''
  const dynPats = Array.isArray(n.dynamicPatterns) ? n.dynamicPatterns : []
  const dynBadge = n.hasDynamicResolution
    ? `<span class="ins-badge dynamic" title="${escapeAttr(t('badge.dynamic.title') + (dynPats.length ? ' — ' + dynPats.join(', ') : ''))}">${t('badge.dynamic.label', { n: dynPats.length })}</span>`
    : ''

  inspectorBody.innerHTML = `
    <div class="ins-name">${escapeHTML(n.id)}</div>
    <div class="ins-sub">.${escapeHTML(n.ext)} · ${n.loc} LOC · ${formatBytes(n.size)} · mass ${n.mass.toFixed(1)}</div>
    <div class="ins-badges">${badge}${confBadge}${dynBadge}</div>
    ${actions}
    ${outgoing.length ? `<div class="ins-section">imports (${outCount})</div>
      ${outgoing.map((e) => rowHTML(e, 'out')).join('')}` : ''}
    ${incoming.length ? `<div class="ins-section">imported by (${inCount})</div>
      ${incoming.map((e) => rowHTML(e, 'in')).join('')}` : ''}
    ${!outgoing.length && !incoming.length ? `
      <div class="ins-sub" style="margin-top:8px;opacity:0.6">no detected connections</div>` : ''}
    <div class="ins-section">history <span class="ins-hint">(max 3, auto)</span></div>
    <div class="ins-history" id="insHistory">loading…</div>
    <div class="ins-section">
      content
      <span class="ins-editor-actions">
        <button class="ins-action-btn" id="previewDiffBtn" data-i18n-title="editor.diff.title">◧ Diff</button>
        <label class="ins-autosave-label" data-i18n-title="editor.autosave.title">
          <input type="checkbox" id="autosaveToggle" checked> <span data-i18n="editor.autosave">auto-save</span>
        </label>
      </span>
    </div>
    <textarea class="ins-editor" id="preview" spellcheck="false" wrap="off">loading…</textarea>
    <div class="ins-save-status" id="saveStatus"></div>
  `
  inspectorBody.querySelectorAll('.ins-row').forEach((el) => {
    el.addEventListener('click', () => {
      const t = el.dataset.target
      if (state.nodes.has(t)) {
        selectNode(t)
      } else {
        toast(`File not in graph: ${basename(t)}`)
      }
    })
  })
  inspectorBody.querySelectorAll('.ins-action').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.action
      if (!isElectron) return
      if (a === 'open') window.codesynapt.openInEditor(id)
      if (a === 'reveal') window.codesynapt.revealInOS(id)
    })
  })
  refreshHistory(id)
}

async function refreshHistory(id) {
  const host = document.getElementById('insHistory')
  if (!host) return
  if (!isElectron) { host.innerHTML = `<div class="ins-sub" style="opacity:0.6">${t('history.electron.required')}</div>`; return }
  if (!state.historyEnabled) { host.innerHTML = `<div class="ins-sub" style="opacity:0.6">${t('history.off')}</div>`; return }
  const versions = await window.codesynapt.listHistory(id)
  if (!versions.length) {
    host.innerHTML = `<div class="ins-sub" style="opacity:0.6">${t('history.none')}</div>`
    return
  }
  host.innerHTML = versions.map((v) => {
    const d = new Date(v.ts)
    const stamp = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
    return `<div class="hist-row" data-ts="${v.ts}">
      <span class="hist-stamp">${stamp}</span>
      <span class="hist-size">${formatBytes(v.size)}</span>
      <button class="hist-btn" data-action="view" data-ts="${v.ts}">${t('history.view')}</button>
      <button class="hist-btn" data-action="restore" data-ts="${v.ts}">${t('history.restore')}</button>
    </div>`
  }).join('')
  host.querySelectorAll('.hist-btn').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const ts = parseInt(el.dataset.ts, 10)
      const action = el.dataset.action
      if (action === 'view') {
        const content = await window.codesynapt.readHistory(id, ts)
        if (content === null) return toast(t('history.snap_not_found'))
        const preview = document.getElementById('preview')
        if (preview) {
          preview.value = content
          // Disable saving when viewing old version — clear dataset.fileId
          // so oninput won't fire saves. Restore button rewrites the disk.
          preview.dataset.fileId = ''
          const status = document.getElementById('saveStatus')
          if (status) { status.textContent = t('history.viewing', { when: new Date(ts).toLocaleString() }); status.className = 'ins-save-status' }
        }
      } else if (action === 'restore') {
        const r = await window.codesynapt.restoreHistory(id, ts)
        if (!r?.ok) return toast(t('history.restore_failed', { err: r?.error || 'unknown' }))
        toast(t('history.restored'))
        setPreview(id, r.content)
        refreshHistory(id)
      }
    })
  })
}

document.getElementById('closeInspector').addEventListener('click', () => selectNode(null))

let saveTimer = null
let saveStatusTimer = null
function setPreview(id, content) {
  if (state.selectedId !== id) return
  const el = document.getElementById('preview')
  if (!el) return
  el.value = content || ''
  el.dataset.fileId = id
  // Remember the on-disk content so the Diff button can compute the
  // delta even after multiple in-memory edits.
  el.dataset.original = content || ''
  el.oninput = (ev) => {
    const fileId = ev.target.dataset.fileId
    if (!fileId) return
    const autosave = document.getElementById('autosaveToggle')?.checked !== false
    if (saveTimer) clearTimeout(saveTimer)
    const status = document.getElementById('saveStatus')
    if (!autosave) {
      if (status) { status.textContent = t('editor.unsaved'); status.className = 'ins-save-status warn' }
      return
    }
    if (status) { status.textContent = t('editor.editing'); status.className = 'ins-save-status' }
    const next = ev.target.value
    saveTimer = setTimeout(async () => {
      if (!isElectron) {
        if (status) { status.textContent = t('editor.save_unavailable'); status.className = 'ins-save-status err' }
        return
      }
      const r = await window.codesynapt.writeFile(fileId, next)
      if (status) {
        if (r?.ok) {
          status.textContent = t('editor.saved'); status.className = 'ins-save-status ok'
          el.dataset.original = next   // synced with disk
        }
        else      { status.textContent = t('editor.error', { err: r?.error || 'unknown' }); status.className = 'ins-save-status err' }
        if (saveStatusTimer) clearTimeout(saveStatusTimer)
        saveStatusTimer = setTimeout(() => {
          if (status && status.textContent !== t('editor.editing')) status.textContent = ''
        }, 1800)
      }
      if (r?.ok) refreshHistory(fileId)
    }, 500)
  }
}

// ─── Diff preview modal ──────────────────────────────────────
// Shows the on-disk version vs the current editor content as a
// line-by-line diff. Uses the same LCS algorithm the main process
// uses for session changes — built in renderer here so the modal
// opens instantly without an IPC roundtrip.
function lineDiff(a, b) {
  const A = (a || '').split(/\r?\n/)
  const B = (b || '').split(/\r?\n/)
  const n = A.length, m = B.length
  // Build LCS DP table — m+1 by n+1
  const dp = Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i][j] = dp[i+1][j+1] + 1
      else dp[i][j] = Math.max(dp[i+1][j], dp[i][j+1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j])      { out.push({ tag: 'eq',  a: i+1, b: j+1, text: A[i] }); i++; j++ }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ tag: 'del', a: i+1, text: A[i] }); i++ }
    else                    { out.push({ tag: 'add', b: j+1, text: B[j] }); j++ }
  }
  while (i < n) { out.push({ tag: 'del', a: i+1, text: A[i] }); i++ }
  while (j < m) { out.push({ tag: 'add', b: j+1, text: B[j] }); j++ }
  return out
}

function openDiffPreview() {
  const el = document.getElementById('preview')
  if (!el || !el.dataset.fileId) return
  const id = el.dataset.fileId
  const orig = el.dataset.original || ''
  const current = el.value
  if (orig === current) return toast(t('editor.diff.no_changes'))

  const diff = lineDiff(orig, current)
  const adds = diff.filter((l) => l.tag === 'add').length
  const dels = diff.filter((l) => l.tag === 'del').length

  // Build modal
  let modal = document.getElementById('diffModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'diffModal'
    modal.className = 'diff-modal hidden'
    document.body.appendChild(modal)
  }
  modal.innerHTML = `
    <div class="diff-modal-inner">
      <div class="diff-modal-head">
        <span class="kicker">${t('editor.diff.title_modal')}</span>
        <span class="diff-modal-id">${escapeHTML(id)}</span>
        <span class="diff-modal-stat"><span class="dm-add">+${adds}</span> <span class="dm-del">−${dels}</span></span>
        <button id="diffModalClose" class="diff-close">✕</button>
      </div>
      <div class="diff-modal-body">
        ${diff.map((ln) => {
          const cls = ln.tag === 'add' ? 'diff-add' : ln.tag === 'del' ? 'diff-del' : 'diff-eq'
          const sign = ln.tag === 'add' ? '+' : ln.tag === 'del' ? '−' : ' '
          const num = ln.tag === 'add' ? `   ${ln.b}` : ln.tag === 'del' ? `${ln.a}   ` : `${ln.a||''} ${ln.b||''}`
          return `<div class="diff-line ${cls}"><span class="diff-num">${num}</span><span class="diff-sign">${sign}</span><span class="diff-text">${escapeHTML(ln.text)}</span></div>`
        }).join('')}
      </div>
      <div class="diff-modal-foot">
        <button id="diffConfirm" class="diff-btn primary">${t('editor.diff.save')}</button>
        <button id="diffCancel" class="diff-btn">${t('editor.diff.cancel')}</button>
        <label class="diff-skip"><input type="checkbox" id="diffSkipNext"> <span>${t('editor.diff.skip_next')}</span></label>
      </div>
    </div>
  `
  modal.classList.remove('hidden')
  // Close handlers
  document.getElementById('diffModalClose').onclick = closeDiffPreview
  document.getElementById('diffCancel').onclick = () => {
    el.value = orig
    closeDiffPreview()
  }
  document.getElementById('diffConfirm').onclick = async () => {
    if (!isElectron) return toast(t('editor.save_unavailable'))
    const r = await window.codesynapt.writeFile(id, current)
    if (r?.ok) {
      el.dataset.original = current
      const status = document.getElementById('saveStatus')
      if (status) { status.textContent = t('editor.saved'); status.className = 'ins-save-status ok' }
      refreshHistory(id)
    } else {
      toast(t('editor.error', { err: r?.error || 'unknown' }))
    }
    if (document.getElementById('diffSkipNext').checked) {
      state.diffSkipSession = true
    }
    closeDiffPreview()
  }
  // ESC closes
  modal.onkeydown = (e) => { if (e.key === 'Escape') closeDiffPreview() }
  modal.tabIndex = -1
  modal.focus()
}
function closeDiffPreview() {
  const modal = document.getElementById('diffModal')
  if (modal) modal.classList.add('hidden')
}

// Inspector toolbar wiring (event delegation since inspector re-renders)
document.getElementById('inspector-body')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'previewDiffBtn') openDiffPreview()
})
// Ctrl/Cmd+S → if not in autosave, show diff preview
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's' && !ev.shiftKey) {
    const focusEl = document.activeElement
    if (focusEl?.id === 'preview') {
      ev.preventDefault()
      openDiffPreview()
    }
  }
})

// ═══════════════════════════════════════════════════════════════
//  Legend / stats / search / controls
// ═══════════════════════════════════════════════════════════════
function updateLegend() {
  const counts = new Map()
  for (const n of state.byIdx) counts.set(n.ext, (counts.get(n.ext) || 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  const container = document.getElementById('legend-items')
  container.innerHTML = sorted.map(([ext, count]) => `
    <div class="legend-item ${state.hiddenExts.has(ext) ? 'dim' : ''}" data-ext="${escapeAttr(ext)}">
      <span class="swatch" style="background:${colorFor(ext)};box-shadow:0 0 6px ${colorFor(ext)}"></span>
      .${escapeHTML(ext)}<span class="count">${count}</span>
    </div>`).join('')
  container.querySelectorAll('.legend-item').forEach((el) => {
    el.addEventListener('click', () => {
      const ext = el.dataset.ext
      state.hiddenExts.has(ext) ? state.hiddenExts.delete(ext) : state.hiddenExts.add(ext)
      updateLegend(); applyFilter()
    })
  })
}

function updateStats() {
  document.getElementById('stat-files').textContent =
    `${state.byIdx.length.toLocaleString()} file${state.byIdx.length !== 1 ? 's' : ''}`
  document.getElementById('stat-edges').textContent =
    `${state.edges.length.toLocaleString()} edge${state.edges.length !== 1 ? 's' : ''}`
}

// ─── Search wiring ──────────────────────────────────────────
const SEARCH_SYNTAX_KEY = 'codesynapt:search_syntax'
const SEARCH_MODE_KEY   = 'codesynapt:search_mode'
try {
  const sx = localStorage.getItem(SEARCH_SYNTAX_KEY)
  if (sx === 'plain' || sx === 'glob' || sx === 'regex') state.searchSyntax = sx
  const sm = localStorage.getItem(SEARCH_MODE_KEY)
  if (sm === 'highlight' || sm === 'hide') state.searchMode = sm
} catch { /* ignore */ }

const searchInput = document.getElementById('search')

// IME composition awareness: while the user is mid-composition
// (Korean/Japanese/Chinese input), don't filter against partial
// characters — wait for the composition to finalize.
let isComposing = false
searchInput.addEventListener('compositionstart', () => { isComposing = true })
searchInput.addEventListener('compositionend', (e) => {
  isComposing = false
  state.filterText = e.target.value
  applyFilter()
})

// Debounce filter application so very fast typing doesn't scan the
// graph on every keystroke. 90ms feels responsive while still
// coalescing bursts.
let filterDebounceTimer = null
searchInput.addEventListener('input', (e) => {
  if (isComposing) return
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer)
  const value = e.target.value
  filterDebounceTimer = setTimeout(() => {
    state.filterText = value
    applyFilter()
  }, 90)
})

const searchSyntaxBtn = document.getElementById('searchSyntaxBtn')
function syncSyntaxBtn() {
  const labels = { plain: 'aA', glob: '*?', regex: '.*' }
  searchSyntaxBtn.textContent = labels[state.searchSyntax]
  searchSyntaxBtn.title = `Syntax: ${state.searchSyntax} (click to cycle)`
  searchInput.placeholder = {
    plain: 'filter files… ( / to focus )',
    glob:  'glob — e.g. *.test.ts, src/**',
    regex: 'regex — e.g. ^src/.*\\.tsx?$',
  }[state.searchSyntax]
}
window.syncSearchSyntaxBtn = syncSyntaxBtn
syncSyntaxBtn()
searchSyntaxBtn.addEventListener('click', () => {
  const order = ['plain', 'glob', 'regex']
  state.searchSyntax = order[(order.indexOf(state.searchSyntax) + 1) % order.length]
  try { localStorage.setItem(SEARCH_SYNTAX_KEY, state.searchSyntax) } catch {}
  syncSyntaxBtn()
  applyFilter()
})

const searchModeBtn = document.getElementById('searchModeBtn')
function syncModeBtn() {
  searchModeBtn.textContent = state.searchMode === 'hide' ? '◑' : '◐'
  searchModeBtn.title = `Mode: ${state.searchMode} (click to toggle)`
  searchModeBtn.classList.toggle('active', state.searchMode === 'hide')
}
window.syncSearchModeBtn = syncModeBtn
syncModeBtn()
searchModeBtn.addEventListener('click', () => {
  state.searchMode = state.searchMode === 'highlight' ? 'hide' : 'highlight'
  try { localStorage.setItem(SEARCH_MODE_KEY, state.searchMode) } catch {}
  syncModeBtn()
  applyFilter()
})

// ═══════════════════════════════════════════════════════════════
//  Stats panel
//
//  Computes high-level structural metrics about the loaded graph:
//   - Total files / edges / extensions
//   - Distribution of incoming vs outgoing connections per file
//   - Top 10 most-connected files (the "hubs")
//   - Count of files with zero connections (orphans)
//   - Number of disconnected components
//
//  Refreshed lazily — only when the panel is open, throttled to
//  once per second so it doesn't dominate the frame budget.
// ═══════════════════════════════════════════════════════════════
const statsPanel = document.getElementById('statsPanel')
const statsBody = document.getElementById('statsBody')
document.getElementById('statsBtn').addEventListener('click', () => {
  statsPanel.classList.toggle('hidden')
  if (!statsPanel.classList.contains('hidden')) {
    // For large graphs, the union-find pass takes >100 ms and blocks
    // the main thread. Show a "loading" placeholder first, then defer
    // the heavy computation by one frame so the panel paints before
    // we freeze.
    if (state.byIdx.length > 30_000) {
      statsBody.innerHTML = '<div class="stats-block" style="opacity:0.6">Computing… (this may take a moment for large graphs)</div>'
      requestAnimationFrame(() => renderStatsPanel())
    } else {
      renderStatsPanel()
    }
  }
})
document.getElementById('closeStats').addEventListener('click', () => {
  statsPanel.classList.add('hidden')
})

let lastStatsRender = 0
function renderStatsPanel() {
  const now = performance.now()
  if (now - lastStatsRender < 1000 && statsBody.innerHTML) return
  lastStatsRender = now
  if (state.byIdx.length === 0) {
    statsBody.innerHTML = '<div class="stats-block">No graph loaded.</div>'
    return
  }

  // Per-node degree
  const incoming = new Map()
  const outgoing = new Map()
  for (const e of state.edges) {
    outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
    incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
  }
  const totalDeg = (id) => (incoming.get(id) || 0) + (outgoing.get(id) || 0)
  const orphans = state.byIdx.filter((n) => totalDeg(n.id) === 0).length

  // Top hubs by total degree
  const ranked = [...state.byIdx]
    .map((n) => ({ n, deg: totalDeg(n.id) }))
    .sort((a, b) => b.deg - a.deg)
    .slice(0, 10)

  // Connected components via union-find for speed
  const parent = new Map()
  state.byIdx.forEach((n) => parent.set(n.id, n.id))
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  for (const e of state.edges) {
    const ra = find(e.s), rb = find(e.t)
    if (ra && rb && ra !== rb) parent.set(ra, rb)
  }
  const components = new Set()
  for (const id of parent.keys()) components.add(find(id))

  // Extension breakdown
  const extCounts = new Map()
  for (const n of state.byIdx) extCounts.set(n.ext, (extCounts.get(n.ext) || 0) + 1)
  const topExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

  const totalFiles = state.byIdx.length
  const avgDeg = totalFiles > 0 ? (state.edges.length * 2 / totalFiles).toFixed(2) : '0'

  statsBody.innerHTML = `
    <div class="stats-block">
      <h4>overview</h4>
      <div class="stat-line"><span>files</span><strong>${totalFiles.toLocaleString()}</strong></div>
      <div class="stat-line"><span>edges</span><strong>${state.edges.length.toLocaleString()}</strong></div>
      <div class="stat-line"><span>avg connections / file</span><strong>${avgDeg}</strong></div>
      <div class="stat-line"><span>components</span><strong>${components.size}</strong></div>
      <div class="stat-line"><span>orphans (0 conn)</span><strong>${orphans}</strong></div>
    </div>
    <div class="stats-block">
      <h4>most connected</h4>
      <ul class="stat-list">
        ${ranked.map(({ n, deg }) => `
          <li data-id="${escapeAttr(n.id)}" title="${escapeAttr(n.id)}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${escapeHTML(basename(n.id))}</span>
            <span class="deg">${deg}</span>
          </li>
        `).join('')}
      </ul>
    </div>
    <div class="stats-block">
      <h4>extensions</h4>
      <ul class="stat-list">
        ${topExts.map(([ext, count]) => `
          <li>
            <span>.${escapeHTML(ext)}</span>
            <span class="deg">${count}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `
  statsBody.querySelectorAll('.stat-list li[data-id]').forEach((el) => {
    el.addEventListener('click', () => selectNode(el.dataset.id))
  })
}

// ─── Export + camera presets ──────────────────────────────────
function download(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 100)
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

document.getElementById('exportPngBtn').addEventListener('click', () => {
  if (state.byIdx.length === 0) { toast('Nothing to export — graph is empty'); return }
  // Force one render with current size, then snapshot canvas to PNG.
  // The just-rendered frame is still in the buffer if we capture
  // immediately. preserveDrawingBuffer would be cleaner but costs
  // sustained perf.
  try {
    renderer.render(scene, camera)
    canvas.toBlob((blob) => {
      if (!blob) { toast('Screenshot failed'); return }
      download(`codesynapt-${timestamp()}.png`, blob, 'image/png')
      toast('Saved screenshot')
    }, 'image/png')
  } catch (err) {
    console.error('PNG export failed:', err)
    toast(`PNG export failed: ${err.message || err}`)
  }
})

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  if (state.byIdx.length === 0) { toast('Nothing to export — graph is empty'); return }
  // Large graphs produce large JSON strings; warn but proceed.
  if (state.byIdx.length > 100_000) {
    toast(`Serializing ${state.byIdx.length.toLocaleString()} nodes — may freeze briefly`)
  }
  try {
    const data = {
      root: state.root,
      exportedAt: new Date().toISOString(),
      nodes: state.byIdx.map((n) => ({
        id: n.id, ext: n.ext, loc: n.loc, size: n.size, mass: n.mass,
      })),
      edges: state.edges.map((e) => ({ source: e.s, target: e.t, kind: e.k })),
    }
    // Defer to next tick so the toast paints before the heavy serialization
    setTimeout(() => {
      try {
        const json = JSON.stringify(data, null, 2)
        download(`codesynapt-${timestamp()}.json`, json, 'application/json')
        toast(`Exported ${data.nodes.length} nodes / ${data.edges.length} edges`)
      } catch (err) {
        console.error('JSON serialize failed:', err)
        toast(`JSON export failed: ${err.message || err}`)
      }
    }, 0)
  } catch (err) {
    console.error('JSON export failed:', err)
    toast(`JSON export failed: ${err.message || err}`)
  }
})

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if (state.edges.length === 0) { toast('No edges to export'); return }
  const lines = ['source,target,kind']
  for (const e of state.edges) {
    const esc = (s) => /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    lines.push(`${esc(e.s)},${esc(e.t)},${esc(e.k)}`)
  }
  download(`codesynapt-edges-${timestamp()}.csv`, lines.join('\n'), 'text/csv')
  toast(`Exported ${state.edges.length} edges as CSV`)
})

const CAMERA_PRESETS = {
  default: { theta: Math.PI / 4, phi: Math.PI / 2 - 0.3, radius: 90 },
  top:     { theta: Math.PI / 4, phi: 0.15,              radius: 110 },
  side:    { theta: 0,           phi: Math.PI / 2,       radius: 95  },
}
document.querySelectorAll('.preset-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = CAMERA_PRESETS[btn.dataset.view]
    if (!preset) return
    cam.theta = preset.theta
    cam.phi = preset.phi
    cam.targetRadius = preset.radius
    cam.target.set(0, 0, 0)
    cam.targetGoal.copy(cam.target)
  })
})

// Custom slots 1-3 — Cmd/Ctrl + 1/2/3 saves, plain 1/2/3 restores
const customViews = {}
try {
  const saved = JSON.parse(localStorage.getItem('codesynapt:custom_views') || '{}')
  Object.assign(customViews, saved)
} catch {}
function saveCustomView(slot) {
  customViews[slot] = {
    theta: cam.theta, phi: cam.phi, radius: cam.targetRadius,
    target: { x: cam.target.x, y: cam.target.y, z: cam.target.z },
  }
  try { localStorage.setItem('codesynapt:custom_views', JSON.stringify(customViews)) } catch {}
  toast(`View saved to slot ${slot}`)
}
function restoreCustomView(slot) {
  const v = customViews[slot]
  if (!v) { toast(`No view saved in slot ${slot}`); return }
  cam.theta = v.theta; cam.phi = v.phi; cam.targetRadius = v.radius
  cam.target.set(v.target.x, v.target.y, v.target.z)
  cam.targetGoal.copy(cam.target)
}
// (Camera-preset shortcuts 1-3 and Ctrl/Cmd+1-3 are handled in the
// unified keydown listener — see the "Keyboard shortcuts" block.)

// ─── AI session changes panel ────────────────────────────────
const changesPanel = document.getElementById('changes')
const changesList  = document.getElementById('changesList')
const expandedChanges = new Set()  // ids whose diff is currently shown

async function openChanges() {
  if (!isElectron) return toast(t('changes.requires_electron'))
  changesPanel.classList.remove('hidden')
  // Close inspector if it's covering the same area
  inspector.classList.add('hidden')
  await refreshChanges()
}
function closeChanges() { changesPanel.classList.add('hidden'); expandedChanges.clear() }
async function refreshChanges() {
  try {
    const items = await window.codesynapt.getChanges()
    if (!items.length) {
      changesList.innerHTML = `<div class="changes-empty">${t('changes.empty')}</div>`
      return
    }
    const rows = []
    for (const c of items) {
      const stamp = new Date(c.lastAt).toISOString().replace('T', ' ').slice(5, 19)
      const locDelta = c.locDelta === 0 ? '±0' : (c.locDelta > 0 ? `+${c.locDelta}` : `${c.locDelta}`)
      const sizeDelta = c.sizeDelta === 0 ? '±0B' : (c.sizeDelta > 0 ? `+${c.sizeDelta}B` : `${c.sizeDelta}B`)
      const shrink = (c.locDelta < 0 || c.sizeDelta < 0) ? 'shrink' : ''
      rows.push(`
        <div class="change-row" data-id="${escapeAttr(c.id)}">
          <span class="change-stamp">${stamp}</span>
          <span class="change-id" title="${escapeAttr(c.id)}">${escapeHTML(c.id)}</span>
          <span class="change-meta ${shrink}">×${c.count} · loc ${locDelta} · ${sizeDelta}</span>
          <button class="change-expand" data-action="toggle" data-id="${escapeAttr(c.id)}" title="Show diff">${expandedChanges.has(c.id) ? '−' : '+'}</button>
        </div>
        ${expandedChanges.has(c.id) ? `<div class="change-diff" data-diff="${escapeAttr(c.id)}">loading diff…</div>` : ''}
      `)
    }
    changesList.innerHTML = rows.join('')
    // Wire up expand buttons
    changesList.querySelectorAll('.change-expand').forEach((el) => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        const id = el.dataset.id
        if (expandedChanges.has(id)) expandedChanges.delete(id)
        else expandedChanges.add(id)
        await refreshChanges()
      })
    })
    // Row click → focus the node in graph
    changesList.querySelectorAll('.change-row').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('change-expand')) return
        const id = el.dataset.id
        const node = state.nodes.get(id)
        if (node) {
          cam.targetGoal.copy(node.p)
          recordTrace(id, 'focus')
        }
      })
    })
    // Load diffs for expanded entries
    for (const id of expandedChanges) {
      const target = changesList.querySelector(`[data-diff="${CSS.escape(id)}"]`)
      if (!target) continue
      try {
        const d = await window.codesynapt.getChangeDiff(id)
        if (!d || d.error) { target.textContent = `error: ${d?.error || 'failed'}`; continue }
        const out = []
        for (const ln of d.lines) {
          const cls = ln.tag === 'add' ? 'diff-add' : ln.tag === 'del' ? 'diff-del' : 'diff-eq'
          out.push(`<span class="${cls}">${escapeHTML(ln.text)}</span>`)
        }
        target.innerHTML = out.join('\n')
      } catch (e) { target.textContent = `error: ${e.message}` }
    }
  } catch (e) {
    changesList.innerHTML = `<div class="changes-empty">error: ${escapeHTML(e.message)}</div>`
  }
}

document.getElementById('changesBtn')?.addEventListener('click', () => {
  if (changesPanel.classList.contains('hidden')) openChanges()
  else closeChanges()
})
document.getElementById('closeChanges')?.addEventListener('click', closeChanges)
// Auto-refresh while panel is open
setInterval(() => {
  if (!changesPanel.classList.contains('hidden')) refreshChanges()
}, 3000)

// ─── Packages panel (monorepo) ───────────────────────────────
const pkgPanel       = document.getElementById('packages')
const pkgMetaEl      = document.getElementById('packagesMeta')
const pkgListEl      = document.getElementById('packagesList')
const pkgDetailEl    = document.getElementById('packageDetail')
const pkgGroupBtn    = document.getElementById('pkgGroupingToggle')
let packagesData = null

async function openPackages() {
  if (!isElectron) return toast(t('changes.requires_electron'))
  pkgPanel.classList.remove('hidden')
  inspector.classList.add('hidden')
  await refreshPackages()
}
function closePackages() {
  pkgPanel.classList.add('hidden')
  pkgDetailEl.classList.add('hidden')
}
async function refreshPackages() {
  try {
    const data = await window.codesynapt.getPackages()
    packagesData = data
    if (!data || !data.packages || data.packages.length === 0) {
      pkgMetaEl.textContent = t('packages.not_monorepo', { kind: data?.kind || 'none' })
      pkgListEl.innerHTML = ''
      return
    }
    pkgMetaEl.textContent = t('packages.meta_summary', {
      kind: data.kind,
      count: data.packages.length,
      crossEdges: data.pkgEdges.length,
    })
    const rows = []
    for (const p of data.packages) {
      rows.push(`
        <div class="pkg-row" data-name="${escapeAttr(p.name)}">
          <div class="pkg-row-main">
            <span class="pkg-icon">📦</span>
            <span class="pkg-name">${escapeHTML(p.name)}</span>
            <span class="pkg-lang">${escapeHTML(p.language)}</span>
          </div>
          <span class="pkg-path" title="${escapeAttr(p.relRoot)}">${escapeHTML(p.relRoot)}</span>
          <span class="pkg-meta">
            ${p.fileCount} files · ${p.loc} loc
            <span class="pkg-edges">→${p.crossPackageImports} / ←${p.crossPackageDependents}</span>
          </span>
        </div>
      `)
    }
    pkgListEl.innerHTML = rows.join('')
    pkgListEl.querySelectorAll('.pkg-row').forEach((el) => {
      el.addEventListener('click', () => openPackageDetail(el.dataset.name))
    })
    updatePkgGroupBtn()
  } catch (e) {
    pkgListEl.innerHTML = `<div class="packages-empty">error: ${escapeHTML(e.message)}</div>`
  }
}

async function openPackageDetail(name) {
  try {
    const d = await window.codesynapt.getPackage(name)
    if (!d || d.error) return toast(`error: ${d?.error || 'failed'}`)
    const out = []
    out.push(`<div class="pkg-detail-head">
      <span class="pkg-detail-name">${escapeHTML(d.name)}</span>
      <span class="pkg-detail-lang">${escapeHTML(d.language)} · ${escapeHTML(d.kind)}</span>
      <button id="pkgDetailClose" class="psw-btn">✕</button>
    </div>`)
    if (d.declared && d.declared.length) {
      out.push(`<div class="pkg-section-title">${t('packages.declared', { n: d.declared.length })}</div>`)
      out.push('<div class="pkg-declared">')
      for (const dep of d.declared.slice(0, 30)) {
        out.push(`<div class="pkg-dep"><span class="pkg-dep-kind">${escapeHTML(dep.kind)}</span> ${escapeHTML(dep.name)}<span class="pkg-dep-spec">@${escapeHTML(dep.spec)}</span></div>`)
      }
      out.push('</div>')
    }
    if (d.outgoingEdges && d.outgoingEdges.length) {
      out.push(`<div class="pkg-section-title">${t('packages.outgoing', { n: d.outgoingEdges.length })}</div>`)
      out.push('<div class="pkg-edges-list">')
      for (const e of d.outgoingEdges.slice(0, 30)) {
        out.push(`<div class="pkg-edge" data-id="${escapeAttr(e.s)}"><span class="pkg-edge-from">${escapeHTML(e.s)}</span> → <span class="pkg-edge-pkg">[${escapeHTML(e.toPkg)}]</span> <span class="pkg-edge-to">${escapeHTML(e.t)}</span></div>`)
      }
      out.push('</div>')
    }
    if (d.incomingEdges && d.incomingEdges.length) {
      out.push(`<div class="pkg-section-title">${t('packages.incoming', { n: d.incomingEdges.length })}</div>`)
      out.push('<div class="pkg-edges-list">')
      for (const e of d.incomingEdges.slice(0, 30)) {
        out.push(`<div class="pkg-edge" data-id="${escapeAttr(e.t)}"><span class="pkg-edge-pkg">[${escapeHTML(e.fromPkg)}]</span> <span class="pkg-edge-from">${escapeHTML(e.s)}</span> → <span class="pkg-edge-to">${escapeHTML(e.t)}</span></div>`)
      }
      out.push('</div>')
    }
    out.push(`<div class="pkg-section-title">${t('packages.top_files', { n: Math.min(d.files.length, 20) })}</div>`)
    out.push('<div class="pkg-files">')
    for (const f of d.files.slice(0, 20)) {
      out.push(`<div class="pkg-file" data-id="${escapeAttr(f.id)}"><span class="pkg-file-mass">m=${f.mass}</span> ${escapeHTML(f.id)}</div>`)
    }
    out.push('</div>')
    pkgDetailEl.innerHTML = out.join('')
    pkgDetailEl.classList.remove('hidden')
    document.getElementById('pkgDetailClose')?.addEventListener('click', () => pkgDetailEl.classList.add('hidden'))
    pkgDetailEl.querySelectorAll('[data-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id
        const node = state.nodes.get(id)
        if (node) {
          cam.targetGoal.copy(node.p)
          recordTrace(id, 'focus')
        }
      })
    })
  } catch (e) { toast(`error: ${e.message}`) }
}

// Toggle: use pkg as the grouping key instead of folder. Works by
// temporarily aliasing node.folder ← node.pkg so the existing folder-
// grouping machinery (centroids, anchors, bubbles, labels) just works.
// The original folder name is preserved on node._folderOrig for the
// inverse swap when grouping is restored.
function applyPackageGrouping(enable) {
  for (const n of state.byIdx) {
    if (enable) {
      if (n._folderOrig === undefined) n._folderOrig = n.folder
      n.folder = n.pkg || '(root)'
    } else {
      if (n._folderOrig !== undefined) { n.folder = n._folderOrig; delete n._folderOrig }
    }
    if (typeof folderHueColor === 'function') {
      const fcol = folderHueColor(n.folder)
      n.folderRgb[0] = fcol.r; n.folderRgb[1] = fcol.g; n.folderRgb[2] = fcol.b
    }
  }
  state.packageGrouping = !!enable
  // Force folder grouping on so the visuals kick in
  if (enable && !state.folderGrouping) {
    state.folderGrouping = true
    bus.emit('folder-grouping:changed', true)
  }
  bus.emit('snapshot:applied', { root: state.root })
}

function updatePkgGroupBtn() {
  if (!pkgGroupBtn) return
  const on = !!state.packageGrouping
  pkgGroupBtn.textContent = on ? t('packages.group_by_package_on') : t('packages.group_by_package')
  pkgGroupBtn.classList.toggle('active', on)
}

pkgGroupBtn?.addEventListener('click', () => {
  applyPackageGrouping(!state.packageGrouping)
  updatePkgGroupBtn()
})

document.getElementById('packagesBtn')?.addEventListener('click', () => {
  if (pkgPanel.classList.contains('hidden')) openPackages()
  else closePackages()
})
document.getElementById('closePackages')?.addEventListener('click', closePackages)

// When monorepo data arrives, hint via toast (only first time per session)
let _monorepoToastShown = false
bus.on('monorepo:updated', (m) => {
  if (_monorepoToastShown) return
  if (!m || !m.packages || !m.packages.length) return
  _monorepoToastShown = true
  toast(t('packages.detected_toast', { kind: m.kind, count: m.packages.length }))
})

// ─── Full AI trace panel (log + stats + sessions + replay) ───
const traceFullPanel = document.getElementById('traceFull')
const traceFullMeta  = document.getElementById('traceFullMeta')
const traceFullBody  = document.getElementById('traceFullBody')
const traceToolSel   = document.getElementById('traceToolFilter')
const traceTabsEl    = document.getElementById('traceTabs')
let traceCurrentTab = 'log'
let traceCurrentToolFilter = ''
let traceCurrentData = null     // last fetched log
let traceCurrentStats = null
let traceReplayTimer = null
let traceReplaying = false

async function openTraceFull() {
  if (!isElectron) return toast(t('changes.requires_electron'))
  traceFullPanel.classList.remove('hidden')
  inspector.classList.add('hidden')
  await refreshTraceFull()
}
function closeTraceFull() {
  stopTraceReplay()
  traceFullPanel.classList.add('hidden')
}

async function refreshTraceFull() {
  try {
    const log = await window.codesynapt.traceLog({ tool: traceCurrentToolFilter || undefined })
    traceCurrentData = log
    const stats = await window.codesynapt.traceStats()
    traceCurrentStats = stats
    const dur = stats.durationMs > 0 ? (stats.durationMs / 1000).toFixed(1) + 's' : '—'
    traceFullMeta.textContent = t('trace.meta', {
      session: stats.sessionId || '—',
      events: stats.eventCount,
      files: stats.fileCount,
      duration: dur,
    })
    // Refresh tool filter options from observed tools
    const tools = new Set(Object.keys(stats.byTool || {}))
    const cur = traceCurrentToolFilter
    traceToolSel.innerHTML = `<option value="">${t('trace.filter.all')}</option>` +
      [...tools].sort().map((tl) => `<option value="${escapeAttr(tl)}" ${tl === cur ? 'selected' : ''}>${escapeHTML(tl)}</option>`).join('')
    renderTraceTab()
  } catch (e) {
    traceFullBody.innerHTML = `<div class="trace-empty">error: ${escapeHTML(e.message)}</div>`
  }
}

function renderTraceTab() {
  if (traceCurrentTab === 'log') renderTraceLog()
  else if (traceCurrentTab === 'stats') renderTraceStats()
  else if (traceCurrentTab === 'sessions') renderTraceSessions()
}

function renderTraceLog() {
  const events = traceCurrentData?.events || []
  if (!events.length) {
    traceFullBody.innerHTML = `<div class="trace-empty">${t('trace.no_events')}</div>`
    return
  }
  // Most recent first
  const rows = []
  for (let i = events.length - 1; i >= 0 && rows.length < 500; i--) {
    const e = events[i]
    const d = new Date(e.ts)
    const stamp = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
    rows.push(`
      <div class="trace-full-row" data-id="${escapeAttr(e.id)}">
        <span class="trace-stamp">${stamp}</span>
        <span class="trace-tool tool-${escapeAttr(e.tool)}">${escapeHTML(e.tool)}</span>
        <span class="trace-id" title="${escapeAttr(e.id)}">${escapeHTML(e.id)}</span>
      </div>
    `)
  }
  traceFullBody.innerHTML = rows.join('')
  traceFullBody.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const node = state.nodes.get(el.dataset.id)
      if (node) cam.targetGoal.copy(node.p)
    })
  })
}

function renderTraceStats() {
  const s = traceCurrentStats
  if (!s || s.eventCount === 0) {
    traceFullBody.innerHTML = `<div class="trace-empty">${t('trace.no_events')}</div>`
    return
  }
  const out = []
  // Tool breakdown bar chart
  const totalTool = Object.values(s.byTool).reduce((a, b) => a + b, 0)
  out.push(`<div class="trace-section-title">${t('trace.stats.by_tool')}</div>`)
  out.push('<div class="trace-stats-list">')
  for (const [tool, n] of Object.entries(s.byTool).sort((a, b) => b[1] - a[1])) {
    const pct = (100 * n / totalTool).toFixed(0)
    out.push(`<div class="trace-stat-row">
      <span class="trace-stat-label tool-${escapeAttr(tool)}">${escapeHTML(tool)}</span>
      <span class="trace-stat-count">${n}</span>
      <div class="trace-stat-bar"><div class="trace-stat-fill" style="width:${pct}%"></div></div>
    </div>`)
  }
  out.push('</div>')

  // Timeline mini-histogram
  if (s.timeline && s.timeline.length) {
    const maxV = Math.max(...s.timeline, 1)
    out.push(`<div class="trace-section-title">${t('trace.stats.timeline')}</div>`)
    out.push('<div class="trace-timeline">')
    for (const v of s.timeline) {
      const h = Math.max(2, (v / maxV) * 48)
      out.push(`<div class="trace-tl-bar" style="height:${h}px" title="${v}"></div>`)
    }
    out.push('</div>')
  }

  // Top files
  out.push(`<div class="trace-section-title">${t('trace.stats.top_files')}</div>`)
  out.push('<div class="trace-top-files">')
  for (const f of s.topFiles) {
    out.push(`<div class="trace-top-file" data-id="${escapeAttr(f.id)}">
      <span class="trace-top-count">×${f.count}</span>
      <span class="trace-id">${escapeHTML(f.id)}</span>
    </div>`)
  }
  out.push('</div>')
  traceFullBody.innerHTML = out.join('')
  traceFullBody.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const node = state.nodes.get(el.dataset.id)
      if (node) cam.targetGoal.copy(node.p)
    })
  })
}

async function renderTraceSessions() {
  traceFullBody.innerHTML = `<div class="trace-empty">${t('trace.loading')}</div>`
  const data = await window.codesynapt.traceSessions()
  if (!data.sessions.length) {
    traceFullBody.innerHTML = `<div class="trace-empty">${t('trace.no_sessions')}</div>`
    return
  }
  const out = []
  for (const s of data.sessions) {
    const stamp = new Date(s.startedAt).toISOString().replace('T', ' ').slice(0, 19)
    const cur = s.isCurrent ? `<span class="trace-session-cur">${t('trace.current')}</span>` : ''
    out.push(`<div class="trace-session-row" data-id="${s.sessionId}">
      <span class="trace-stamp">${stamp}</span>
      <span class="trace-session-meta">${s.eventCount} events · ${(s.size/1024).toFixed(1)}KB</span>
      ${cur}
    </div>`)
  }
  traceFullBody.innerHTML = out.join('')
  traceFullBody.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.id, 10)
      const data = await window.codesynapt.traceSession(id)
      if (!data) return toast(t('trace.session_load_failed'))
      // Render the loaded session's events into the log
      traceCurrentData = { sessionId: id, events: data.events }
      traceCurrentStats = data.stats
      traceCurrentTab = 'log'
      traceTabsEl.querySelectorAll('.trace-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'log'))
      renderTraceLog()
    })
  })
}

// Replay: emit visual pulses for each historical event in real time
// (or compressed time). Uses the existing recordTrace pipeline so the
// 3D pulse + trail look identical to live activity.
function startTraceReplay() {
  if (!traceCurrentData || !traceCurrentData.events.length) return toast(t('trace.no_replay'))
  if (traceReplaying) return stopTraceReplay()
  const events = traceCurrentData.events
  const speed = 30  // x faster than real time
  const startWall = performance.now()
  const startEv = events[0].ts
  let i = 0
  traceReplaying = true
  document.getElementById('traceReplayBtn').textContent = '⏹ Stop'
  function tick() {
    if (!traceReplaying || i >= events.length) return stopTraceReplay()
    const elapsed = (performance.now() - startWall) * speed
    while (i < events.length && events[i].ts - startEv <= elapsed) {
      const e = events[i]
      if (state.nodes.has(e.id)) recordTrace(e.id, e.tool)
      i++
    }
    traceReplayTimer = requestAnimationFrame(tick)
  }
  tick()
}
function stopTraceReplay() {
  if (traceReplayTimer) cancelAnimationFrame(traceReplayTimer)
  traceReplayTimer = null
  traceReplaying = false
  const btn = document.getElementById('traceReplayBtn')
  if (btn) btn.textContent = '▶ Replay'
}

document.getElementById('aiTraceFullBtn')?.addEventListener('click', openTraceFull)
document.getElementById('closeTraceFull')?.addEventListener('click', closeTraceFull)
document.getElementById('traceReplayBtn')?.addEventListener('click', startTraceReplay)
document.getElementById('traceClearBtn')?.addEventListener('click', async () => {
  await window.codesynapt.traceClear()
  state.aiTraceLog.length = 0
  refreshTracePanel()
  await refreshTraceFull()
  toast(t('trace.cleared'))
})
document.getElementById('traceExportBtn')?.addEventListener('click', async () => {
  const r = await window.codesynapt.traceExport()
  if (r.canceled) return
  if (r.error) return toast(`error: ${r.error}`)
  toast(t('trace.exported', { n: r.eventCount, path: r.path }))
})
document.getElementById('traceSessionsBtn')?.addEventListener('click', () => {
  traceCurrentTab = 'sessions'
  traceTabsEl.querySelectorAll('.trace-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'sessions'))
  renderTraceTab()
})
traceTabsEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.trace-tab')
  if (!btn) return
  traceCurrentTab = btn.dataset.tab
  traceTabsEl.querySelectorAll('.trace-tab').forEach((b) => b.classList.toggle('active', b === btn))
  if (traceCurrentTab === 'log' || traceCurrentTab === 'stats') refreshTraceFull()
  else renderTraceTab()
})
traceToolSel?.addEventListener('change', () => {
  traceCurrentToolFilter = traceToolSel.value
  refreshTraceFull()
})
// Auto-refresh when panel is open
setInterval(() => {
  if (!traceFullPanel.classList.contains('hidden') && !traceReplaying) refreshTraceFull()
}, 4000)

// ─── Legacy / migration audit panel ──────────────────────────
const legacyPanel    = document.getElementById('legacy')
const legacyMetaEl   = document.getElementById('legacyMeta')
const legacyListEl   = document.getElementById('legacyList')
const legacyTabsEl   = document.getElementById('legacyTabs')
const legacyConfEl   = document.getElementById('legacyMinConf')
const legacyConfVal  = document.getElementById('legacyMinConfVal')
const legacyHL       = document.getElementById('legacyHighlightBtn')
let legacyData = null
let legacyTab = 'orphan'
let legacyMinConf = 0.5
let legacyHighlight = false
let legacyHighlightIds = new Set()

async function openLegacy() {
  if (!isElectron) return toast(t('changes.requires_electron'))
  legacyPanel.classList.remove('hidden')
  inspector.classList.add('hidden')
  await refreshLegacy()
}
function closeLegacy() { legacyPanel.classList.add('hidden') }

async function refreshLegacy() {
  try {
    legacyListEl.innerHTML = `<div class="legacy-empty">${t('legacy.loading')}</div>`
    legacyData = await window.codesynapt.getLegacy()
    if (!legacyData) {
      legacyListEl.innerHTML = `<div class="legacy-empty">${t('legacy.empty')}</div>`
      return
    }
    const s = legacyData.summary
    legacyMetaEl.textContent = t('legacy.meta_summary', {
      n: s.candidateCount, total: s.totalFiles, loc: s.totalLoc,
    })
    renderLegacyTab()
  } catch (e) {
    legacyListEl.innerHTML = `<div class="legacy-empty">error: ${escapeHTML(e.message)}</div>`
  }
}

function renderLegacyTab() {
  if (!legacyData) return
  const out = []
  const minC = legacyMinConf
  if (legacyTab === 'orphan' || legacyTab === 'path' || legacyTab === 'filename') {
    const key = legacyTab === 'orphan' ? 'orphans'
              : legacyTab === 'path'   ? 'pathPatterns' : 'filenamePatterns'
    const items = (legacyData[key] || []).filter((x) => x.confidence >= minC)
    if (!items.length) {
      legacyListEl.innerHTML = `<div class="legacy-empty">${t('legacy.no_items_for_conf')}</div>`
      return
    }
    for (const x of items) {
      const cls = x.confidence >= 0.85 ? 'high' : x.confidence >= 0.5 ? 'med' : 'low'
      const tag = x.pattern || x.marker || (x.category || '')
      out.push(`
        <div class="legacy-row" data-id="${escapeAttr(x.id)}">
          <span class="legacy-conf-pill conf-${cls}">${x.confidence.toFixed(2)}</span>
          ${tag ? `<span class="legacy-tag">${escapeHTML(tag)}</span>` : ''}
          <span class="legacy-id">${escapeHTML(x.id)}</span>
          <span class="legacy-meta-row">loc ${x.loc} · ${x.size}B</span>
          <div class="legacy-reason">${escapeHTML(x.reason)}</div>
        </div>
      `)
    }
  } else if (legacyTab === 'duplicate') {
    const items = legacyData.duplicates || []
    if (!items.length) {
      legacyListEl.innerHTML = `<div class="legacy-empty">${t('legacy.no_duplicates')}</div>`
      return
    }
    for (const d of items) {
      out.push(`<div class="legacy-dup-group"><div class="legacy-dup-name">${escapeHTML(d.basename)}</div>`)
      for (const f of d.files) {
        const tag = f.isCurrent ? `<span class="legacy-tag dup-current">${t('legacy.dup.current')}</span>`
                  : f.hasLegacyMarker ? `<span class="legacy-tag dup-legacy">${t('legacy.dup.legacy')}</span>` : ''
        out.push(`
          <div class="legacy-row legacy-dup-row" data-id="${escapeAttr(f.id)}">
            ${tag}
            <span class="legacy-id">${escapeHTML(f.id)}</span>
            <span class="legacy-meta-row">m=${f.mass} · loc ${f.loc}</span>
          </div>
        `)
      }
      out.push('</div>')
    }
  }
  legacyListEl.innerHTML = out.join('')
  legacyListEl.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id
      const node = state.nodes.get(id)
      if (node) {
        cam.targetGoal.copy(node.p)
        recordTrace(id, 'focus')
        state.selectedId = id
        bus.emit('selection:changed', id)
      }
    })
  })
}

function computeLegacyHighlightIds() {
  if (!legacyData) return new Set()
  const ids = new Set()
  const minC = legacyMinConf
  for (const x of (legacyData.orphans || []))         if (x.confidence >= minC) ids.add(x.id)
  for (const x of (legacyData.pathPatterns || []))    if (x.confidence >= minC) ids.add(x.id)
  for (const x of (legacyData.filenamePatterns || []))if (x.confidence >= minC) ids.add(x.id)
  for (const d of (legacyData.duplicates || []))
    for (const f of d.files) if (f.hasLegacyMarker) ids.add(f.id)
  return ids
}

function applyLegacyHighlight(on) {
  legacyHighlight = on
  legacyHL.classList.toggle('active', on)
  legacyHL.textContent = on ? t('legacy.highlight_on') : t('legacy.highlight')
  if (on) {
    legacyHighlightIds = computeLegacyHighlightIds()
    // Mark the nodes so the renderer can pick them up (read in stepCPU
    // / draw loop via node.isLegacyCandidate flag).
    for (const n of state.byIdx) n.isLegacyCandidate = legacyHighlightIds.has(n.id)
  } else {
    legacyHighlightIds = new Set()
    for (const n of state.byIdx) n.isLegacyCandidate = false
  }
}

legacyTabsEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.legacy-tab')
  if (!btn) return
  legacyTab = btn.dataset.tab
  legacyTabsEl.querySelectorAll('.legacy-tab').forEach((b) => b.classList.toggle('active', b === btn))
  renderLegacyTab()
})
legacyConfEl?.addEventListener('input', () => {
  legacyMinConf = parseInt(legacyConfEl.value, 10) / 100
  legacyConfVal.textContent = legacyMinConf.toFixed(2)
  renderLegacyTab()
  if (legacyHighlight) applyLegacyHighlight(true)
})
legacyHL?.addEventListener('click', () => applyLegacyHighlight(!legacyHighlight))

document.getElementById('legacyBtn')?.addEventListener('click', () => {
  if (legacyPanel.classList.contains('hidden')) openLegacy()
  else closeLegacy()
})
document.getElementById('closeLegacy')?.addEventListener('click', closeLegacy)

// ─── Codebase tour panel — guided list of entry points + hubs ──
// Surfaces the /tour killer feature (entry points + top hubs with hints).
// The bridge (getTour) existed but had no UI entry point. Clicking a stop
// flies the camera to that node and selects it.
const tourPanel  = document.getElementById('tour')
const tourListEl = document.getElementById('tourList')
async function openTour() {
  if (!isElectron) return toast(t('changes.requires_electron'))
  tourPanel.classList.remove('hidden')
  inspector.classList.add('hidden')
  await refreshTour()
}
function closeTour() { tourPanel.classList.add('hidden') }
async function refreshTour() {
  try {
    tourListEl.innerHTML = `<div class="changes-empty">${t('tour.loading')}</div>`
    const data = await window.codesynapt.getTour()
    const stops = (data && data.stops) || []
    if (!stops.length) {
      tourListEl.innerHTML = `<div class="changes-empty">${t('tour.empty')}</div>`
      return
    }
    tourListEl.innerHTML = stops.map((s, i) => `
      <div class="change-row tour-row" data-id="${escapeAttr(s.id)}">
        <span class="change-stamp">${i + 1} · ${escapeHTML(s.kind || '')}</span>
        <span class="change-id" title="${escapeAttr(s.id)}">${escapeHTML(s.id)}</span>
        <span class="change-meta">${escapeHTML(s.hint || '')}</span>
      </div>`).join('')
    tourListEl.querySelectorAll('.tour-row').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id
        const node = state.nodes.get(id)
        if (!node) return toast('File not in graph: ' + id)
        cam.targetGoal.copy(node.p)
        selectNode(id)
      })
    })
  } catch (e) {
    tourListEl.innerHTML = `<div class="changes-empty">error: ${escapeHTML(e.message)}</div>`
  }
}
document.getElementById('tourBtn')?.addEventListener('click', () => {
  if (tourPanel.classList.contains('hidden')) openTour()
  else closeTour()
})
document.getElementById('closeTour')?.addEventListener('click', closeTour)

// ─── Project switcher (★ pinned + recent) ────────────────────
const pswPanel       = document.getElementById('projectSwitcher')
const pswPinnedList  = document.getElementById('pswPinnedList')
const pswRecentList  = document.getElementById('pswRecentList')
const pswEmpty       = document.getElementById('pswEmpty')
const pswSwitchBtn   = document.getElementById('projectSwitchBtn')
const pswPinBtn      = document.getElementById('pswPinCurrent')
const pswCloseBtn    = document.getElementById('pswClose')

async function refreshProjectSwitcher() {
  if (!isElectron) return
  const data = await window.codesynapt.listProjects()
  const pinned = data.pinned || []
  const recent = (data.recent || []).filter((p) => !pinned.some((x) => x.path === p))
  const current = data.current || ''

  const renderRow = (item, isPinned) => {
    const name = isPinned ? item.name : basename(item)
    const path = isPinned ? item.path : item
    const active = current && current === path
    return `
      <div class="psw-row ${active ? 'active' : ''}" data-path="${escapeAttr(path)}">
        <div class="psw-name">
          <div class="psw-name-row">
            <span class="psw-icon">${isPinned ? '★' : '🕒'}</span>
            <span>${escapeHTML(name)}</span>
          </div>
          <span class="psw-path" title="${escapeAttr(path)}">${escapeHTML(path)}</span>
        </div>
        <button class="psw-pin ${isPinned ? 'pinned' : ''}" data-action="${isPinned ? 'unpin' : 'pin'}" data-path="${escapeAttr(path)}" title="${isPinned ? '★' : '☆'}">${isPinned ? '★' : '☆'}</button>
      </div>
    `
  }
  pswPinnedList.innerHTML = pinned.map((p) => renderRow(p, true)).join('')
  pswRecentList.innerHTML = recent.map((p) => renderRow(p, false)).join('')
  const isEmpty = pinned.length === 0 && recent.length === 0
  pswEmpty.classList.toggle('hidden', !isEmpty)

  // Row click → switch to that folder
  pswPanel.querySelectorAll('.psw-row').forEach((row) => {
    row.addEventListener('click', async (ev) => {
      if (ev.target.classList.contains('psw-pin')) return
      const p = row.dataset.path
      try { await window.codesynapt.loadFolder(p); pswPanel.classList.add('hidden') }
      catch (e) { toast(t('psw.open_failed', { err: e.message || e })) }
    })
  })
  // Pin / unpin
  pswPanel.querySelectorAll('.psw-pin').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const p = btn.dataset.path
      if (btn.dataset.action === 'pin') {
        const name = window.prompt(t('psw.rename.prompt'), basename(p)) || basename(p)
        await window.codesynapt.pinProject(p, name)
      } else {
        if (window.confirm(t('psw.unpin.confirm'))) await window.codesynapt.unpinProject(p)
      }
      refreshProjectSwitcher()
    })
  })
}
function togglePswPanel() {
  if (pswPanel.classList.contains('hidden')) {
    refreshProjectSwitcher()
    pswPanel.classList.remove('hidden')
  } else {
    pswPanel.classList.add('hidden')
  }
}
pswSwitchBtn?.addEventListener('click', togglePswPanel)
pswCloseBtn?.addEventListener('click', () => pswPanel.classList.add('hidden'))
pswPinBtn?.addEventListener('click', async () => {
  if (!state.root) { toast(t('psw.no_current')); return }
  const name = window.prompt(t('psw.rename.prompt'), basename(state.root)) || basename(state.root)
  if (isElectron) await window.codesynapt.pinProject(state.root, name)
  toast(t('psw.pinned'))
  refreshProjectSwitcher()
})
// Click outside closes the popover
document.addEventListener('click', (e) => {
  if (pswPanel.classList.contains('hidden')) return
  if (pswPanel.contains(e.target) || pswSwitchBtn.contains(e.target)) return
  pswPanel.classList.add('hidden')
})

// ─── Language toggle (button lives inside More menu now) ─────
const langToggleBtn = document.getElementById('langToggle')
if (langToggleBtn) {
  const langIcon = document.getElementById('langCurrent')
  if (langIcon) langIcon.textContent = CURRENT_LANG === 'ko' ? 'EN' : '한'
  langToggleBtn.addEventListener('click', () => {
    setLang(CURRENT_LANG === 'ko' ? 'en' : 'ko')
  })
}
applyI18nToDOM()
// pathLabel: initialize to the translated placeholder until a folder loads
;(function initPathLabel() {
  const pl = document.getElementById('pathLabel')
  if (pl && (!state.root || pl.textContent === 'Open Folder…')) {
    pl.textContent = t('topbar.open_folder.label')
  }
})()

// ─── Time-lapse mode (git history replay) ────────────────────
const timelapsePanel = document.getElementById('timelapse')
const tlSlider = document.getElementById('tlSlider')
const tlStamp = document.getElementById('tlStamp')
const tlMeta = document.getElementById('tlMeta')
const tlPlay = document.getElementById('tlPlay')
let tlPlaying = false
let tlPlayRAF = 0
async function openTimelapse() {
  if (!isElectron) return toast(t('timelapse.requires_electron'))
  timelapsePanel.classList.remove('hidden')
  tlStamp.textContent = 'loading git history…'
  tlMeta.textContent = ''
  try {
    const data = await window.codesynapt.getTimeline()
    if (!data || !data.isGit) {
      tlStamp.textContent = '(not a git repo)'
      tlMeta.textContent = data?.error || ''
      return
    }
    state.fileBornAt.clear()
    for (const p of data.points) {
      for (const id of p.addedFiles) {
        if (!state.fileBornAt.has(id)) state.fileBornAt.set(id, p.ts)
      }
    }
    state.timelineBounds = { firstAt: data.firstAt, lastAt: data.lastAt }
    tlSlider.min = 0
    tlSlider.max = data.points.length - 1
    tlSlider.value = data.points.length - 1
    tlMeta.textContent = `${data.commitCount} commits · ${new Date(data.firstAt).toISOString().slice(0,10)} → ${new Date(data.lastAt).toISOString().slice(0,10)}`
    state.timelineCutoff = data.lastAt
    state.timelineData = data
    tlStamp.textContent = `now (${new Date(data.lastAt).toISOString().slice(0,10)})`
  } catch (e) {
    tlStamp.textContent = `(error: ${e.message})`
  }
}
function closeTimelapse() {
  timelapsePanel.classList.add('hidden')
  state.timelineCutoff = null
  tlPlaying = false
}
function applyTimelapseSlider() {
  if (!state.timelineData) return
  const idx = parseInt(tlSlider.value, 10)
  const p = state.timelineData.points[idx]
  if (!p) return
  state.timelineCutoff = p.ts
  tlStamp.textContent = new Date(p.ts).toISOString().slice(0, 10) + ' · ' + p.hash.slice(0, 7) + ' · ' + p.subject.slice(0, 40)
}
document.getElementById('timelapseBtn')?.addEventListener('click', () => {
  if (timelapsePanel.classList.contains('hidden')) openTimelapse()
  else closeTimelapse()
})
document.getElementById('tlClose')?.addEventListener('click', closeTimelapse)
document.getElementById('tlReset')?.addEventListener('click', () => {
  state.timelineCutoff = null
  tlSlider.value = tlSlider.max
  if (state.timelineData) tlStamp.textContent = 'now · all files visible'
})
tlSlider.addEventListener('input', applyTimelapseSlider)
tlPlay.addEventListener('click', () => {
  if (!state.timelineData) return
  if (tlPlaying) { tlPlaying = false; tlPlay.textContent = '▶'; return }
  tlPlaying = true
  tlPlay.textContent = '❚❚'
  const startIdx = parseInt(tlSlider.value, 10) >= state.timelineData.points.length - 1 ? 0 : parseInt(tlSlider.value, 10)
  const total = state.timelineData.points.length - 1
  const startedAt = performance.now()
  const durationMs = 25_000
  const tick = () => {
    if (!tlPlaying) return
    const elapsed = (performance.now() - startedAt) / durationMs
    const idx = Math.min(total, Math.floor(startIdx + (total - startIdx) * elapsed))
    tlSlider.value = idx
    applyTimelapseSlider()
    if (idx >= total) { tlPlaying = false; tlPlay.textContent = '▶'; return }
    tlPlayRAF = requestAnimationFrame(tick)
  }
  tick()
})

// ─── File history toggle ─────────────────────────────────────
const HISTORY_ENABLED_KEY = 'codesynapt:history_enabled'
state.historyEnabled = false
try {
  if (localStorage.getItem(HISTORY_ENABLED_KEY) === 'true') state.historyEnabled = true
} catch {}
const historyToggle = document.getElementById('historyEnabledToggle')
if (historyToggle) {
  historyToggle.checked = state.historyEnabled
  historyToggle.addEventListener('change', () => {
    state.historyEnabled = historyToggle.checked
    try { localStorage.setItem(HISTORY_ENABLED_KEY, state.historyEnabled ? 'true' : 'false') } catch {}
    if (isElectron) window.codesynapt.setHistoryEnabled(state.historyEnabled)
    if (state.selectedId) refreshHistory(state.selectedId)
  })
}
if (isElectron) window.codesynapt.setHistoryEnabled(state.historyEnabled)

// ─── Folder grouping toggle ──────────────────────────────────
const FOLDER_GROUP_KEY = 'codesynapt:folder_grouping'
try {
  if (localStorage.getItem(FOLDER_GROUP_KEY) === 'true') state.folderGrouping = true
} catch {}
const folderGroupBtn = document.getElementById('folderGroupBtn')
folderGroupBtn.classList.toggle('active', state.folderGrouping)
folderGroupBtn.addEventListener('click', () => {
  state.folderGrouping = !state.folderGrouping
  folderGroupBtn.classList.toggle('active', state.folderGrouping)
  if (!state.folderGrouping) {
    // Smooth de-clustering — assign each node a fresh sphere target
    // and animate over ~45 frames (0.75 s). Direct position set would
    // teleport ("snap"); lerping per frame looks like natural motion.
    //
    // Sphere radius scales with file count so 11k files don't pack
    // into a tight 90-unit ball. Baselined at fileCount=100:
    //   100  → 0.45
    //   1000 → 0.65
    //  10000 → 0.85
    //  capped at 0.90 of maxWorld so outer nodes still have headroom.
    hideFolderBubbles()
    const fileCount = state.byIdx.length
    const baseFrac = Math.min(0.90,
      0.45 + Math.max(0, Math.log10(Math.max(100, fileCount) / 100)) * 0.20
    )
    const baseR = (state.maxWorldRadius || 140) * (state.nodeDistanceScale || 1) * baseFrac
    for (const node of state.byIdx) {
      const r = baseR * (0.7 + Math.random() * 0.6)
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const sinPhi = Math.sin(phi)
      if (!node.target) node.target = new THREE.Vector3()
      node.target.set(
        r * sinPhi * Math.cos(theta),
        r * Math.cos(phi),
        r * sinPhi * Math.sin(theta),
      )
    }
    state.disperseTotal = 70
    state.disperseFrames = 70
    reheat(0.5)
  } else {
    reheat(0.4)
  }
  try { localStorage.setItem(FOLDER_GROUP_KEY, state.folderGrouping ? 'true' : 'false') } catch {}
  bus.emit('filter:changed', null)
  // Frame the camera to fit all nodes after the layout settles —
  // 0.8 s after the toggle lets disperse/anchor lerps reach their
  // targets so frameToFitAll sees the final positions.
  setTimeout(() => frameToFitAll(), 800)
})

// ─── Node distance / size sliders ────────────────────────────
const NODE_DIST_KEY = 'codesynapt:node_distance'
const NODE_SIZE_KEY = 'codesynapt:node_size_v2'   // v2: rebased default — old 0.3× is now 1.0×
const MAX_WORLD_KEY = 'codesynapt:max_world_radius'
const FOLDER_STRENGTH_KEY = 'codesynapt:folder_strength'
const FOLDER_SPREAD_KEY   = 'codesynapt:folder_spread'
const FOLDER_OPACITY_KEY  = 'codesynapt:folder_opacity'
try { localStorage.removeItem('codesynapt:node_size') } catch {}
try {
  const d = parseFloat(localStorage.getItem(NODE_DIST_KEY))
  if (!isNaN(d) && d >= 0.3 && d <= 3) state.nodeDistanceScale = d
  const s = parseFloat(localStorage.getItem(NODE_SIZE_KEY))
  if (!isNaN(s) && s >= 0.3 && s <= 3) state.nodeSizeScale = s
  const w = parseFloat(localStorage.getItem(MAX_WORLD_KEY))
  if (!isNaN(w) && w >= 60 && w <= 2000) state.maxWorldRadius = w
  const fs = parseFloat(localStorage.getItem(FOLDER_STRENGTH_KEY))
  if (!isNaN(fs) && fs >= 0 && fs <= 0.4) state.folderClusterStrength = fs
  const fp = parseFloat(localStorage.getItem(FOLDER_SPREAD_KEY))
  if (!isNaN(fp) && fp >= 0.3 && fp <= 1.0) state.folderClusterSpread = fp
  const fo = parseFloat(localStorage.getItem(FOLDER_OPACITY_KEY))
  if (!isNaN(fo) && fo >= 0 && fo <= 0.4) state.folderAreaOpacity = fo
} catch {}

const distSlider         = document.getElementById('nodeDistanceSlider')
const distVal            = document.getElementById('nodeDistanceVal')
const sizeSlider         = document.getElementById('nodeSizeSlider')
const sizeVal            = document.getElementById('nodeSizeVal')
const maxWorldSlider     = document.getElementById('maxWorldSlider')
const maxWorldVal        = document.getElementById('maxWorldVal')
const folderStrengthSlider = document.getElementById('folderStrengthSlider')
const folderStrengthVal    = document.getElementById('folderStrengthVal')
const folderSpreadSlider   = document.getElementById('folderSpreadSlider')
const folderSpreadVal      = document.getElementById('folderSpreadVal')
const folderOpacitySlider  = document.getElementById('folderOpacitySlider')
const folderOpacityVal     = document.getElementById('folderOpacityVal')

function syncSliderUI() {
  distSlider.value = state.nodeDistanceScale
  distVal.textContent = `${state.nodeDistanceScale.toFixed(2)}×`
  sizeSlider.value = state.nodeSizeScale
  sizeVal.textContent = `${state.nodeSizeScale.toFixed(2)}×`
  maxWorldSlider.value = state.maxWorldRadius
  maxWorldVal.textContent = `${state.maxWorldRadius | 0}`
  folderStrengthSlider.value = state.folderClusterStrength
  folderStrengthVal.textContent = state.folderClusterStrength.toFixed(2)
  folderSpreadSlider.value = state.folderClusterSpread
  folderSpreadVal.textContent = state.folderClusterSpread.toFixed(2)
  if (folderOpacitySlider) {
    folderOpacitySlider.value = state.folderAreaOpacity
    folderOpacityVal.textContent = state.folderAreaOpacity.toFixed(2)
  }
}
syncSliderUI()

distSlider.addEventListener('input', () => {
  state.nodeDistanceScale = parseFloat(distSlider.value) || 1
  distVal.textContent = `${state.nodeDistanceScale.toFixed(2)}×`
  reheat(0.5)   // let physics relax into new spacing
  try { localStorage.setItem(NODE_DIST_KEY, String(state.nodeDistanceScale)) } catch {}
})
sizeSlider.addEventListener('input', () => {
  state.nodeSizeScale = parseFloat(sizeSlider.value) || 1
  sizeVal.textContent = `${state.nodeSizeScale.toFixed(2)}×`
  try { localStorage.setItem(NODE_SIZE_KEY, String(state.nodeSizeScale)) } catch {}
})
maxWorldSlider.addEventListener('input', () => {
  state.maxWorldRadius = parseFloat(maxWorldSlider.value) || 140
  maxWorldVal.textContent = `${state.maxWorldRadius | 0}`
  state.maxWorldUserTouched = true   // disable auto-tune for the rest of the session
  reheat(0.5)
  try { localStorage.setItem(MAX_WORLD_KEY, String(state.maxWorldRadius)) } catch {}
  if (scene.fog) scene.fog.density = Math.sqrt(Math.LN2) / (1.5 * state.maxWorldRadius)
})

// Auto-tune maxWorldRadius based on file count when a new folder
// is loaded. Disabled once the user manually moves the slider this
// session. Doesn't write to localStorage — that's reserved for
// explicit user choices.
function autoTuneMaxWorld(fileCount) {
  if (state.maxWorldUserTouched) return
  // Cube-root scaling keeps per-node volume roughly constant — the
  // sphere grows just fast enough that nodes never have to pile up
  // against the world cap. No snap-back triggers, no flying outliers,
  // natural round shape.
  //   100   → 200      (baseline floor)
  //   500   → 320
  //   1000  → 400
  //   5000  → 685
  //   11000 → 900
  //   30000 → 1240
  const target = Math.max(200, Math.min(2000, Math.cbrt(Math.max(100, fileCount)) * 40))
  const rounded = Math.round(target / 10) * 10
  if (Math.abs(state.maxWorldRadius - rounded) < 5) return
  state.maxWorldRadius = rounded
  maxWorldSlider.value = rounded
  maxWorldVal.textContent = `${rounded}`
  try { localStorage.setItem(MAX_WORLD_KEY, String(rounded)) } catch {}
  // Scale fog density with cluster size so colors stay vivid even at
  // the auto-framed camera distance. Targets ~50 % fog at 1.5 × maxWorld
  // distance — consistent depth feel regardless of project size.
  if (scene.fog) {
    scene.fog.density = Math.sqrt(Math.LN2) / (1.5 * rounded)
  }
}
let _autoMaxWorldLastRoot = null
bus.on('snapshot:applied', ({ root }) => {
  if (root && root !== _autoMaxWorldLastRoot) {
    _autoMaxWorldLastRoot = root
    autoTuneMaxWorld(state.byIdx.length)
    // Frame the camera to fit all nodes — delayed so initial physics
    // has time to spread nodes into a stable layout. 1.5 s is enough
    // for force-sim to roughly settle even on large projects.
    setTimeout(() => frameToFitAll(), 1500)
  }
})
folderStrengthSlider.addEventListener('input', () => {
  state.folderClusterStrength = parseFloat(folderStrengthSlider.value) || 0
  folderStrengthVal.textContent = state.folderClusterStrength.toFixed(2)
  if (state.folderGrouping) reheat(0.4)
  try { localStorage.setItem(FOLDER_STRENGTH_KEY, String(state.folderClusterStrength)) } catch {}
})
folderSpreadSlider.addEventListener('input', () => {
  state.folderClusterSpread = parseFloat(folderSpreadSlider.value) || 0.85
  folderSpreadVal.textContent = state.folderClusterSpread.toFixed(2)
  if (state.folderGrouping) {
    folderCentroidLastUpdate = 0   // force anchor recompute on next tick
    reheat(0.4)
  }
  try { localStorage.setItem(FOLDER_SPREAD_KEY, String(state.folderClusterSpread)) } catch {}
})
folderOpacitySlider?.addEventListener('input', () => {
  state.folderAreaOpacity = parseFloat(folderOpacitySlider.value)
  if (isNaN(state.folderAreaOpacity)) state.folderAreaOpacity = 0.06
  folderOpacityVal.textContent = state.folderAreaOpacity.toFixed(2)
  // No reheat needed — opacity is read live in the render loop each frame.
  try { localStorage.setItem(FOLDER_OPACITY_KEY, String(state.folderAreaOpacity)) } catch {}
})
document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
  state.nodeDistanceScale = 1.0
  state.nodeSizeScale = 1.0
  state.maxWorldRadius = 200
  state.folderClusterStrength = 0.30
  state.folderClusterSpread = 0.85
  state.folderAreaOpacity = 0.06
  syncSliderUI()
  if (state.folderGrouping) folderCentroidLastUpdate = 0
  reheat(0.5)
  try {
    localStorage.removeItem(NODE_DIST_KEY)
    localStorage.removeItem(NODE_SIZE_KEY)
    localStorage.removeItem(MAX_WORLD_KEY)
    localStorage.removeItem(FOLDER_STRENGTH_KEY)
    localStorage.removeItem(FOLDER_SPREAD_KEY)
    localStorage.removeItem(FOLDER_OPACITY_KEY)
  } catch {}
})

const pauseBtn = document.getElementById('pause')
let manuallyPaused = false
pauseBtn.addEventListener('click', () => {
  state.paused = !state.paused
  manuallyPaused = state.paused
  pauseBtn.textContent = state.paused ? '▶' : '❚❚'
  pauseBtn.classList.toggle('active', state.paused)
  bus.emit('filter:changed', null)  // "paused" badge shows in filter bar
})

// Auto-pause when the window is genuinely hidden, so the OS can
// reclaim VRAM cleanly for foreground apps (Wan inference, games).
// Resume + reheat softly on return so layout doesn't snap.
//
// Definition of "hidden":
//   - In Electron: only minimize/hide (NOT blur, NOT obscuration).
//     The simulation keeps running when the user clicks into
//     another app or another window happens to be on top.
//   - In the browser fallback: visibilitychange (the best the web
//     platform gives us — tab switch, browser minimize).
//
// Either way, manual user pause is respected: if the user clicked
// the ❚❚ button, we don't auto-resume.
function handleVisibilityChange(visible) {
  if (!visible) {
    state.paused = true
  } else if (!manuallyPaused) {
    state.paused = false
    reheat(0.2)
  }
}
if (isElectron && window.codesynapt.onWindowVisibility) {
  window.codesynapt.onWindowVisibility(({ visible }) => handleVisibilityChange(visible))
} else {
  document.addEventListener('visibilitychange', () => {
    handleVisibilityChange(!document.hidden)
  })
}
document.getElementById('recenter').addEventListener('click', () => {
  cam.theta = Math.PI / 4; cam.phi = Math.PI / 2 - 0.3
  cam.target.set(0, 0, 0)
  cam.targetGoal.copy(cam.target)
  // Fit camera to current node distribution instead of hard-coded 90 —
  // hard-coded distance puts the camera inside the ball for big graphs.
  frameToFitAll()
})

document.getElementById('openFolderBtn').addEventListener('click', pickFolder)
document.getElementById('welcomeOpenBtn').addEventListener('click', pickFolder)

// Refresh — rescan the currently loaded folder
const refreshBtn = document.getElementById('refreshBtn')
let refreshing = false
async function refreshFolder() {
  if (!isElectron || refreshing || !state.root) return
  refreshing = true
  refreshBtn?.classList.add('spinning')
  try {
    await window.codesynapt.loadFolder(state.root)
  } catch (err) {
    console.error('refreshFolder failed:', err)
    toast(`Refresh failed: ${err.message || err}`)
  } finally {
    refreshing = false
    refreshBtn?.classList.remove('spinning')
  }
}
refreshBtn?.addEventListener('click', refreshFolder)
bus.on('snapshot:applied', ({ root }) => {
  if (refreshBtn) refreshBtn.disabled = !root
})

// Re-entrancy guard — prevents the user from spawning multiple OS
// file pickers by rapid-clicking the Open Folder button.
let pickingFolder = false
async function pickFolder() {
  if (pickingFolder) return
  if (!isElectron) return
  pickingFolder = true
  try {
    await window.codesynapt.pickFolder()
  } catch (err) {
    console.error('pickFolder failed:', err)
    toast(`Couldn't open folder: ${err.message || err}`)
  } finally {
    pickingFolder = false
  }
}
async function readFile(id) {
  if (isElectron) {
    const r = await window.codesynapt.readFile(id)
    return r?.content || ''
  } else if (ws && ws.readyState === 1) {
    return new Promise((resolve) => {
      const h = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'file_content' && m.id === id) {
          ws.removeEventListener('message', h)
          resolve(m.content || '')
        }
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ type: 'read_file', id }))
      setTimeout(() => { ws.removeEventListener('message', h); resolve('') }, 3000)
    })
  }
  return ''
}

async function refreshWelcome() {
  if (!isElectron) return
  const s = await window.codesynapt.getState()
  const list = document.getElementById('recentList')
  if (!s.recentFolders || !s.recentFolders.length) { list.innerHTML = ''; return }
  list.innerHTML = `<div class="recent-label">recent</div>` +
    s.recentFolders.map((f) => `<button class="recent-item" data-folder="${escapeAttr(f)}">${escapeHTML(f)}</button>`).join('')
  list.querySelectorAll('.recent-item').forEach((el) => {
    el.addEventListener('click', async () => {
      // Visual cue while loading
      const original = el.style.opacity
      el.style.opacity = '0.5'
      el.disabled = true
      try {
        await window.codesynapt.loadFolder(el.dataset.folder)
      } catch (err) {
        toast(`Couldn't load: ${err.message || err}`)
      } finally {
        el.style.opacity = original
        el.disabled = false
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════════
//  Drag-drop folder
//
//  dragenter/leave fire multiple times as the mouse crosses child
//  element boundaries, so we count depth instead of relying on a
//  single boolean. As a safety net, also reset on drop / blur /
//  dragend in case those events somehow fall out of sync.
// ═══════════════════════════════════════════════════════════════
const dropOverlay = document.getElementById('dropOverlay')
let dragDepth = 0
function hideDropOverlay() {
  dragDepth = 0
  dropOverlay.classList.add('hidden')
}
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  // Only show overlay for actual file drags, not text/link drags
  if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
    dragDepth++
    dropOverlay.classList.remove('hidden')
  }
})
window.addEventListener('dragleave', (e) => {
  e.preventDefault()
  dragDepth--
  if (dragDepth <= 0) hideDropOverlay()
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('dragend', hideDropOverlay)
window.addEventListener('blur', hideDropOverlay)
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  hideDropOverlay()

  if (!isElectron) {
    toast('Drag-drop requires the desktop app — use Open Folder…')
    return
  }

  // Pull the first dropped item that has a usable path. Electron sets
  // `path` on File objects; web browsers don't, which is why this is
  // desktop-only.
  const items = e.dataTransfer?.files
  if (!items || items.length === 0) {
    toast("Couldn't read the dropped item — try Open Folder…")
    return
  }
  const file = items[0]
  // Electron 32+ removed File.path; the real path is only resolvable from the
  // preload via webUtils.getPathForFile (exposed as getPathForFile). Fall back
  // to the legacy file.path for older Electron / non-Electron.
  const fp = (window.codesynapt.getPathForFile && window.codesynapt.getPathForFile(file)) || file.path
  if (!fp) {
    toast("Couldn't read the dropped item — try Open Folder…")
    return
  }

  // Could be a folder OR a file. If it's a file, open its parent dir.
  // We can't tell from the File API which it is — main.cjs decides
  // and reports back. So we just send the path; main.cjs already
  // validates and emits an error if it's not a directory.
  try {
    await window.codesynapt.loadFolder(fp)
  } catch (err) {
    console.error('loadFolder failed:', err)
    toast(`Couldn't open: ${err.message || err}`)
  }
})

// ═══════════════════════════════════════════════════════════════
//  Transport
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  Scan progress + toast helpers
// ═══════════════════════════════════════════════════════════════
const scanToast = document.getElementById('scanToast')
const scanCount = document.getElementById('scanCount')
const scanLabel = scanToast?.querySelector('.scan-label')
const scanLabelDefault = scanLabel?.innerHTML
let scanHideTimer = null
function handleScanProgress({ count, done, phase }) {
  if (scanLabel && phase === 'building' && !done) {
    // Walk finished; heavy edge-resolution runs silently for tens of
    // seconds — show a label so the frozen count doesn't look hung.
    scanLabel.textContent = t('scan.building')
  } else {
    if (scanLabel && scanLabelDefault != null && scanLabel.innerHTML !== scanLabelDefault) {
      // Restore the normal "Scanning… N files" composition (re-creates #scanCount).
      scanLabel.innerHTML = scanLabelDefault
    }
    // Re-resolve in case the label was just restored, swapping the count node.
    const countEl = document.getElementById('scanCount') || scanCount
    countEl.textContent = count.toLocaleString()
  }
  scanToast.classList.remove('hidden')
  if (scanHideTimer) clearTimeout(scanHideTimer)
  if (done) {
    // Brief lingering display after completion, then hide
    scanHideTimer = setTimeout(() => scanToast.classList.add('hidden'), 600)
  }
}

function toast(message) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  document.getElementById('toastHost').appendChild(el)
  setTimeout(() => el.remove(), 3200)
}

let ws = null
if (isElectron) {
  window.codesynapt.onSnapshot((d) => {
    state.monorepo = d.monorepo || null
    state.pkgEdges = d.pkgEdges || []
    applySnapshot(d.files, d.edges, d.root)
    bus.emit('monorepo:updated', state.monorepo)
  })
  window.codesynapt.onFolderLoaded(({ root }) => {
    state.root = root
    document.getElementById('pathLabel').textContent = root
    document.body.classList.remove('no-folder')
  })
  window.codesynapt.onNoFolder(() => { clearGraph(); refreshWelcome() })
  window.codesynapt.onError(({ message }) => { console.error(message); toast(message) })
  if (window.codesynapt.onScanProgress) window.codesynapt.onScanProgress(handleScanProgress)
  if (window.codesynapt.onControl) {
    window.codesynapt.onControl((msg) => {
      const node = state.nodes.get(msg.id)
      if (!node) return
      if (msg.type === 'focus') {
        cam.targetGoal.copy(node.p)
        state.selectedId = msg.id
        bus.emit('selection:changed', msg.id)
        if (!inspector.classList.contains('hidden')) renderInspector(msg.id)
        recordTrace(msg.id, 'focus')
      } else if (msg.type === 'open') {
        cam.targetGoal.copy(node.p)
        openFile(msg.id)
        recordTrace(msg.id, 'open')
      } else if (msg.type === 'trace') {
        recordTrace(msg.id, msg.tool)
      } else if (msg.type === 'blast') {
        // Flash every node in the blast radius
        for (const id of msg.ids) recordTrace(id, 'blast')
        cam.targetGoal.copy(node.p)
      }
    })
  }
  refreshWelcome()
} else {
  function connectWS() {
    ws = new WebSocket(`ws://${location.host}`)
    ws.onclose = () => setTimeout(connectWS, 2000)
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.type === 'snapshot') applySnapshot(m.files, m.edges, m.root)
      else if (m.type === 'scan-progress') handleScanProgress(m)
    }
  }
  connectWS()
  document.body.classList.remove('no-folder')
}

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
const escapeAttr = escapeHTML
function formatBytes(b) {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(2)}MB`
}

// ═══════════════════════════════════════════════════════════════
//  Settings panel — wires up the backend module's status + mode
//  selector. Auto-falls back to CPU if WebGPU isn't available, if
//  the user picks CPU mode, or if the GPU becomes saturated by
//  another app (e.g. Wan 2.2 inference, gaming, training).
// ═══════════════════════════════════════════════════════════════
const settingsPanel = document.getElementById('settings')
// Settings now live in the left rail (its body is relocated there by
// moveSettingsIntoRail). Opening settings = switch the rail to the settings tab
// and expand it. leftSetTab/setLeftRailCollapsed are hoisted declarations below.
function openSettings() {
  try { leftSetTab('settings'); setLeftRailCollapsed(false) } catch {}
}
document.getElementById('settingsBtn').addEventListener('click', openSettings)
document.getElementById('closeSettings')?.addEventListener('click', () => {
  settingsPanel.classList.add('hidden')
})

const radios = document.querySelectorAll('input[name="backend"]')
radios.forEach((r) => r.addEventListener('change', (e) => {
  if (e.target.checked) backend.setMode(e.target.value)
}))

const statusActive = document.getElementById('statusActive')
const statusGpuTime = document.getElementById('statusGpuTime')
const statusReason = document.getElementById('statusReason')

function updateSettingsUI(status) {
  for (const r of radios) r.checked = (r.value === status.mode)
  statusActive.textContent = status.active.toUpperCase()
  statusActive.style.color = status.active === 'gpu' ? 'var(--accent)' : 'var(--fg)'
  statusGpuTime.textContent = status.gpuAvailable && status.gpuTimeMs > 0
    ? `${status.gpuTimeMs.toFixed(1)} ms`
    : '—'
  statusReason.textContent = status.reason
  // Disable GPU-only radio if GPU is not available
  const gpuRadio = document.querySelector('input[name="backend"][value="gpu"]')
  if (gpuRadio) gpuRadio.disabled = !status.gpuAvailable
}

backend.init({ onStatusChange: updateSettingsUI })
backend.subscribe(updateSettingsUI)

// ─── Theme picker ──────────────────────────────────────
const THEME_KEY = 'codesynapt:theme'
const VALID_THEMES = ['observatory', 'minimal', 'terminal', 'maximal', 'carbon', 'mono', 'daylight']

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) theme = 'observatory'
  document.body.setAttribute('data-theme', theme)
  // Mark the active card
  document.querySelectorAll('.theme-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.theme === theme)
  })
  try { localStorage.setItem(THEME_KEY, theme) } catch {}
}

// Hydrate theme on load
let initialTheme = 'observatory'
try {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved && VALID_THEMES.includes(saved)) initialTheme = saved
} catch {}
applyTheme(initialTheme)

// Wire up theme cards
document.querySelectorAll('.theme-card').forEach((card) => {
  card.addEventListener('click', () => {
    applyTheme(card.dataset.theme)
    toast(`Theme: ${card.dataset.theme}`)
  })
})

// ─── Focus-depth controls ────────────────────────────────────
const FOCUS_DEPTH_KEY = 'codesynapt:focus_depth'
const SHOW_ALL_KEY = 'codesynapt:show_all_connected'
const focusDepthInput = document.getElementById('focusDepthInput')
const showAllBtn = document.getElementById('showAllBtn')

// Load saved preferences
try {
  const savedDepth = parseInt(localStorage.getItem(FOCUS_DEPTH_KEY), 10)
  if (Number.isFinite(savedDepth) && savedDepth >= 1 && savedDepth <= 20) {
    state.focusDepth = savedDepth
  }
  const savedAll = localStorage.getItem(SHOW_ALL_KEY)
  if (savedAll === 'true') state.showAllConnected = true
} catch { /* localStorage may be blocked */ }

function syncDepthUI() {
  focusDepthInput.value = String(state.focusDepth)
  focusDepthInput.disabled = state.showAllConnected
  showAllBtn.classList.toggle('active', state.showAllConnected)
}
syncDepthUI()

focusDepthInput.addEventListener('input', (e) => {
  // Accept anything the user types; we clamp on blur for safety
  const v = parseInt(e.target.value, 10)
  if (Number.isFinite(v) && v >= 1 && v <= 20) {
    state.focusDepth = v
    invalidateFocusCache()
    try { localStorage.setItem(FOCUS_DEPTH_KEY, String(v)) } catch { /* ignore */ }
  }
})
focusDepthInput.addEventListener('blur', () => {
  // Clamp invalid input back into range on blur (e.g. user cleared field)
  let v = parseInt(focusDepthInput.value, 10)
  if (!Number.isFinite(v) || v < 1) v = 1
  else if (v > 20) v = 20
  state.focusDepth = v
  focusDepthInput.value = String(v)
  invalidateFocusCache()
  try { localStorage.setItem(FOCUS_DEPTH_KEY, String(v)) } catch { /* ignore */ }
})

showAllBtn.addEventListener('click', () => {
  state.showAllConnected = !state.showAllConnected
  invalidateFocusCache()
  syncDepthUI()
  try {
    localStorage.setItem(SHOW_ALL_KEY, state.showAllConnected ? 'true' : 'false')
  } catch { /* ignore */ }
})

// ═══════════════════════════════════════════════════════════════
//  Right rail — minimap + context panel + project info dialog
//
//  Minimap: a 2D-canvas top-down view of the entire graph. Cheaper
//  than a second Three.js renderer (no extra GL context, no extra
//  GPU uploads of 300k nodes). Rendered at ~20 fps when the graph
//  is active, 2 fps when settled. Clicking on the minimap moves
//  the main camera target to that (x, z) position.
//
//  Context panel: when a node is selected, show its key facts and
//  a shortcut to the inspector. When no node is selected, show
//  project info (set up the first time you open a folder, then
//  persisted per-root in localStorage).
// ═══════════════════════════════════════════════════════════════

// ─── Project info storage ──────────────────────────────────────
const PROJECT_INFO_KEY_PREFIX = 'codesynapt:project:'

function projectKey(root) {
  return PROJECT_INFO_KEY_PREFIX + (root || '')
}
function loadProjectInfo(root) {
  if (!root) return null
  try {
    const raw = localStorage.getItem(projectKey(root))
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}
function saveProjectInfo(root, info) {
  if (!root) return
  try {
    localStorage.setItem(projectKey(root), JSON.stringify({
      ...info,
      updatedAt: new Date().toISOString(),
    }))
  } catch { /* ignore */ }
}
function hasProjectInfo(root) {
  return !!loadProjectInfo(root)
}

// ─── Project info dialog ───────────────────────────────────────
const projectDialog = document.getElementById('projectDialog')
const pi_name = document.getElementById('pi_name')
const pi_version = document.getElementById('pi_version')
const pi_stack = document.getElementById('pi_stack')
const pi_description = document.getElementById('pi_description')
const pi_notes = document.getElementById('pi_notes')

function openProjectDialog(prefill = null) {
  pi_name.value = prefill?.name || ''
  pi_version.value = prefill?.version || ''
  pi_stack.value = prefill?.stack || ''
  pi_description.value = prefill?.description || ''
  pi_notes.value = prefill?.notes || ''
  projectDialog.classList.remove('hidden')
  setTimeout(() => pi_name.focus(), 50)
}
function closeProjectDialog() {
  projectDialog.classList.add('hidden')
}
document.getElementById('dialogClose').addEventListener('click', closeProjectDialog)
document.getElementById('dialogSkip').addEventListener('click', () => {
  if (state.root) saveProjectInfo(state.root, { skipped: true })
  closeProjectDialog()
  renderContextPanel()
})
document.getElementById('dialogSave').addEventListener('click', () => {
  const info = {
    name: pi_name.value.trim(),
    version: pi_version.value.trim(),
    stack: pi_stack.value.trim(),
    description: pi_description.value.trim(),
    notes: pi_notes.value.trim(),
  }
  if (state.root) saveProjectInfo(state.root, info)
  closeProjectDialog()
  renderContextPanel()
  toast('Project info saved')
})
projectDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeProjectDialog()
  // Enter in single-line inputs triggers Save (textarea Enter still
  // inserts newline)
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    e.preventDefault()
    document.getElementById('dialogSave').click()
  }
})
// Backdrop click closes the dialog — but only if the form is empty.
// If the user has entered anything, we keep the dialog open so an
// accidental backdrop click doesn't discard their work. They can
// still explicitly close via the X button, Skip, or Esc.
projectDialog.querySelector('.dialog-backdrop').addEventListener('click', () => {
  const hasContent = [pi_name, pi_version, pi_stack, pi_description, pi_notes]
    .some((el) => el.value.trim() !== '')
  if (!hasContent) {
    closeProjectDialog()
  } else {
    // Subtle feedback: brief shake to show that we noticed the click
    const card = projectDialog.querySelector('.dialog-card')
    if (card) {
      card.classList.remove('shake')
      // Force reflow so the animation re-triggers
      void card.offsetWidth
      card.classList.add('shake')
    }
  }
})

let dialogShownForRoot = ''
function maybeShowFirstSetup(root) {
  if (!root || root === dialogShownForRoot) return
  if (hasProjectInfo(root)) return
  dialogShownForRoot = root
  setTimeout(() => {
    const base = root.split(/[\\/]/).filter(Boolean).pop() || ''
    openProjectDialog({ name: base })
  }, 800)
}

// ─── Context panel ─────────────────────────────────────────────
const ctxBody = document.getElementById('ctxBody')
const ctxKicker = document.getElementById('ctxKicker')
const ctxEditBtn = document.getElementById('ctxEditBtn')

ctxEditBtn.addEventListener('click', () => {
  const existing = loadProjectInfo(state.root)
  openProjectDialog(existing && !existing.skipped ? existing : null)
})

function renderContextPanel() {
  const selNode = state.selectedId ? state.nodes.get(state.selectedId) : null
  if (selNode) {
    ctxKicker.textContent = 'selected file'
    ctxEditBtn.style.display = 'none'
    renderNodeContext(selNode)
  } else {
    ctxKicker.textContent = 'project'
    ctxEditBtn.style.display = state.root ? '' : 'none'
    renderProjectContext()
  }
}

function renderNodeContext(n) {
  let outCount = 0, inCount = 0
  for (let i = 0; i < state.edges.length; i++) {
    const e = state.edges[i]
    if (e.s === n.id) outCount++
    if (e.t === n.id) inCount++
  }
  const filename = basename(n.id)
  const dir = n.id.includes('/') ? n.id.slice(0, n.id.lastIndexOf('/')) : ''
  const starred = state.activeFiles.has(n.id)
  // List pipelines this file is in
  const memberships = state.pipelines.filter((p) => p.files.includes(n.id))

  ctxBody.innerHTML = `
    <div class="ctx-node-title">${escapeHTML(filename)}</div>
    ${dir ? `<div class="ctx-node-path">${escapeHTML(dir)}/</div>` : ''}
    <div class="ctx-row"><span>extension</span><span>.${escapeHTML(n.ext)}</span></div>
    <div class="ctx-row"><span>size</span><span>${formatBytes(n.size)}</span></div>
    <div class="ctx-row"><span>lines</span><span>${n.loc.toLocaleString()}</span></div>
    <div class="ctx-row"><span>mass</span><span>${n.mass.toFixed(2)}</span></div>
    <div class="ctx-row"><span>imports →</span><span>${outCount}</span></div>
    <div class="ctx-row"><span>← imported by</span><span>${inCount}</span></div>

    <div class="ctx-active-block">
      <button id="ctxStarBtn" class="ctx-star-btn ${starred ? 'on' : ''}" type="button">
        ${starred ? '★ Marked as active' : '☆ Mark as active'}
      </button>
      ${memberships.length > 0 ? `
        <div class="ctx-pipe-membership">
          In pipeline${memberships.length > 1 ? 's' : ''}:
          ${memberships.map((p) => `<span class="ctx-pipe-tag">${escapeHTML(p.name)}</span>`).join('')}
        </div>
      ` : ''}
      ${state.pipelines.length > 0 ? `
        <select id="ctxPipeAdd" class="ctx-pipe-select">
          <option value="">Add to pipeline…</option>
          ${state.pipelines.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHTML(p.name)}</option>`).join('')}
        </select>
      ` : ''}
    </div>

    <div class="ctx-actions">
      <button id="ctxOpenInspector">Details</button>
      ${isElectron ? `<button id="ctxOpenInEditor">Open file</button>` : ''}
    </div>
  `
  document.getElementById('ctxStarBtn')?.addEventListener('click', () => {
    if (state.selectedId) toggleStarred(state.selectedId)
  })
  document.getElementById('ctxPipeAdd')?.addEventListener('change', (e) => {
    const pipeId = e.target.value
    if (pipeId && state.selectedId) {
      addFileToPipeline(pipeId, state.selectedId)
      e.target.value = ''
      toast(`Added to ${state.pipelines.find((p) => p.id === pipeId)?.name || 'pipeline'}`)
    }
  })
  document.getElementById('ctxOpenInspector')?.addEventListener('click', () => {
    if (state.selectedId) {
      renderInspector(state.selectedId)
      inspector.classList.remove('hidden')
    }
  })
  document.getElementById('ctxOpenInEditor')?.addEventListener('click', () => {
    if (state.selectedId && isElectron) window.codesynapt.openInEditor(state.selectedId)
  })
}

function renderProjectContext() {
  if (!state.root) {
    ctxBody.innerHTML = `<div class="ctx-empty">No folder open.<br>Drop one onto the window or use ${
      isElectron ? 'Cmd/Ctrl+O' : 'the Open Folder button'
    }.</div>`
    return
  }
  const info = loadProjectInfo(state.root)
  if (!info || info.skipped) {
    const folderName = state.root.split(/[\\/]/).filter(Boolean).pop() || state.root
    ctxBody.innerHTML = `
      <div class="ctx-project-name">${escapeHTML(folderName)}</div>
      <div class="ctx-project-meta">${escapeHTML(state.root)}</div>
      <div class="ctx-row"><span>files</span><span>${state.byIdx.length.toLocaleString()}</span></div>
      <div class="ctx-row"><span>connections</span><span>${state.edges.length.toLocaleString()}</span></div>
      <div class="ctx-empty">
        <div>No project notes yet.</div>
        <button id="ctxAddInfo">Add info</button>
      </div>
    `
    document.getElementById('ctxAddInfo')?.addEventListener('click', () => openProjectDialog({
      name: state.root.split(/[\\/]/).filter(Boolean).pop() || '',
    }))
    return
  }
  const folderName = info.name || (state.root.split(/[\\/]/).filter(Boolean).pop() || state.root)
  const metaPieces = []
  if (info.version) metaPieces.push(`v${info.version}`)
  metaPieces.push(`${state.byIdx.length.toLocaleString()} files · ${state.edges.length.toLocaleString()} edges`)
  ctxBody.innerHTML = `
    <div class="ctx-project-name">${escapeHTML(folderName)}</div>
    <div class="ctx-project-meta">${escapeHTML(metaPieces.join(' · '))}</div>
    ${info.stack ? `
      <div class="ctx-project-section">stack</div>
      <div class="ctx-project-text">${escapeHTML(info.stack)}</div>
    ` : ''}
    ${info.description ? `
      <div class="ctx-project-section">about</div>
      <div class="ctx-project-text">${escapeHTML(info.description)}</div>
    ` : ''}
    ${info.notes ? `
      <div class="ctx-project-section">notes</div>
      <div class="ctx-project-text">${escapeHTML(info.notes)}</div>
    ` : ''}
  `
}

// ─── Minimap rendering ─────────────────────────────────────────
const minimapCanvas = document.getElementById('minimapCanvas')
const minimapCtx = minimapCanvas.getContext('2d')
const minimapDPR = Math.min(window.devicePixelRatio || 1, 2)
minimapCanvas.width = 280 * minimapDPR
minimapCanvas.height = 280 * minimapDPR
minimapCtx.scale(minimapDPR, minimapDPR)

const minimapState = {
  minX: -50, maxX: 50, minZ: -50, maxZ: 50,
  lastRender: 0,
}

function computeMinimapBounds() {
  if (state.byIdx.length === 0) {
    minimapState.minX = -50; minimapState.maxX = 50
    minimapState.minZ = -50; minimapState.maxZ = 50
    return
  }
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity
  for (let i = 0; i < state.byIdx.length; i++) {
    const p = state.byIdx[i].p
    if (p.x < mnX) mnX = p.x
    if (p.x > mxX) mxX = p.x
    if (p.z < mnZ) mnZ = p.z
    if (p.z > mxZ) mxZ = p.z
  }
  const padX = Math.max((mxX - mnX) * 0.06, 5)
  const padZ = Math.max((mxZ - mnZ) * 0.06, 5)
  const rangeX = (mxX - mnX) + padX * 2
  const rangeZ = (mxZ - mnZ) + padZ * 2
  const range = Math.max(rangeX, rangeZ)
  const cx = (mnX + mxX) / 2, cz = (mnZ + mxZ) / 2
  minimapState.minX = cx - range / 2
  minimapState.maxX = cx + range / 2
  minimapState.minZ = cz - range / 2
  minimapState.maxZ = cz + range / 2
}

function worldToMinimap(x, z) {
  const tx = (x - minimapState.minX) / (minimapState.maxX - minimapState.minX)
  const tz = (z - minimapState.minZ) / (minimapState.maxZ - minimapState.minZ)
  return { mx: tx * 280, my: tz * 280 }
}
function minimapToWorld(mx, my) {
  const tx = mx / 280, tz = my / 280
  return {
    x: minimapState.minX + tx * (minimapState.maxX - minimapState.minX),
    z: minimapState.minZ + tz * (minimapState.maxZ - minimapState.minZ),
  }
}

function drawMinimap() {
  const ctx = minimapCtx
  computeMinimapBounds()
  ctx.fillStyle = 'rgba(7, 9, 15, 0.6)'
  ctx.fillRect(0, 0, 280, 280)
  // Subtle grid dots for visual orientation
  ctx.fillStyle = 'rgba(126, 207, 207, 0.05)'
  for (let i = 0; i < 280; i += 24) {
    for (let j = 0; j < 280; j += 24) {
      ctx.fillRect(i, j, 1, 1)
    }
  }

  const fd = focusDistances()
  const maxDepth = !fd ? state.focusDepth
                 : state.showAllConnected ? Math.max(1, fd.maxDist)
                 : state.focusDepth
  const dists = fd ? fd.dists : null

  for (let i = 0; i < state.byIdx.length; i++) {
    const n = state.byIdx[i]
    if (n.visible === false) continue
    const { mx, my } = worldToMinimap(n.p.x, n.p.z)
    if (mx < 0 || mx > 280 || my < 0 || my > 280) continue
    let alpha = 0.7
    if (dists) {
      const d = dists.get(n.id)
      alpha = emphasisFor(d, maxDepth)
    }
    const isSelected = state.selectedId === n.id
    const isHover = state.hoverId === n.id
    const r = isSelected ? 4 : isHover ? 3.5 : 1.7
    ctx.fillStyle = `rgba(${(n.rgb[0] * 255) | 0}, ${(n.rgb[1] * 255) | 0}, ${(n.rgb[2] * 255) | 0}, ${alpha})`
    ctx.beginPath()
    ctx.arc(mx, my, r, 0, Math.PI * 2)
    ctx.fill()
    if (isSelected || isHover) {
      ctx.strokeStyle = isSelected ? 'rgba(126, 207, 207, 0.9)' : 'rgba(255, 255, 255, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(mx, my, r + 2, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Camera target crosshair
  const target = worldToMinimap(cam.target.x, cam.target.z)
  ctx.strokeStyle = 'rgba(126, 207, 207, 0.6)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(target.mx, target.my, 8, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(126, 207, 207, 0.4)'
  ctx.beginPath()
  ctx.moveTo(target.mx - 12, target.my); ctx.lineTo(target.mx - 4, target.my)
  ctx.moveTo(target.mx + 4, target.my);  ctx.lineTo(target.mx + 12, target.my)
  ctx.moveTo(target.mx, target.my - 12); ctx.lineTo(target.mx, target.my - 4)
  ctx.moveTo(target.mx, target.my + 4);  ctx.lineTo(target.mx, target.my + 12)
  ctx.stroke()
}

function maybeDrawMinimap(now) {
  if (document.getElementById('rightRail').classList.contains('collapsed')) return
  const idle = state.sim.alpha < state.sim.alphaMin
  const interval = idle ? 500 : 50
  if (now - minimapState.lastRender < interval) return
  minimapState.lastRender = now
  drawMinimap()
}

// Minimap rendering is throttled internally (2-20 Hz depending
// on sim activity). We piggyback on the main render() loop instead
// of spinning a second requestAnimationFrame, since two RAFs add
// scheduling overhead and would interleave unpredictably. The
// main render loop calls window.__drawMinimap each frame; the
// `maybeDrawMinimap` guard handles throttling and collapsed-state.
window.__drawMinimap = (now) => maybeDrawMinimap(now)

let minimapDragging = false
let minimapPointerId = null

function minimapEventToWorld(e) {
  const rect = minimapCanvas.getBoundingClientRect()
  const mx = ((e.clientX - rect.left) / rect.width) * 280
  const my = ((e.clientY - rect.top) / rect.height) * 280
  return minimapToWorld(mx, my)
}

minimapCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  // Don't try to navigate to a region of empty space if the graph
  // isn't loaded yet.
  if (state.byIdx.length === 0) return
  e.stopPropagation()
  minimapDragging = true
  minimapPointerId = e.pointerId
  try { minimapCanvas.setPointerCapture(e.pointerId) } catch {}
  const { x, z } = minimapEventToWorld(e)
  cam.targetGoal.x = x; cam.targetGoal.z = z
})
minimapCanvas.addEventListener('pointermove', (e) => {
  if (!minimapDragging) return
  if (minimapPointerId !== null && e.pointerId !== minimapPointerId) return
  const { x, z } = minimapEventToWorld(e)
  cam.targetGoal.x = x; cam.targetGoal.z = z
})
function endMinimapDrag(e) {
  if (e && minimapPointerId !== null && e.pointerId !== minimapPointerId) return
  minimapDragging = false
  minimapPointerId = null
}
minimapCanvas.addEventListener('pointerup', endMinimapDrag)
minimapCanvas.addEventListener('pointercancel', endMinimapDrag)
window.addEventListener('blur', () => { minimapDragging = false; minimapPointerId = null })

// ─── Minimap collapse (right sidebar itself is permanent) ──────
const MINIMAP_KEY = 'codesynapt:minimap_collapsed'
const rightRail = document.getElementById('rightRail')
const minimapWrap = document.getElementById('minimapWrap')
const minimapToggleBtn = document.getElementById('minimapToggle')

function setMinimapCollapsed(collapsed) {
  if (!minimapWrap) return
  minimapWrap.classList.toggle('collapsed', collapsed)
  if (minimapToggleBtn) minimapToggleBtn.textContent = collapsed ? '+' : '−'
  try { localStorage.setItem(MINIMAP_KEY, collapsed ? 'true' : 'false') } catch {}
}

let initialMinimapCollapsed = false
try { initialMinimapCollapsed = localStorage.getItem(MINIMAP_KEY) === 'true' } catch {}
setMinimapCollapsed(initialMinimapCollapsed)

if (minimapToggleBtn) {
  minimapToggleBtn.addEventListener('click', () => {
    setMinimapCollapsed(!minimapWrap.classList.contains('collapsed'))
  })
}

// Subscribe context panel and project-info bootstrap to events.
bus.on('selection:changed', renderContextPanel)
bus.on('snapshot:applied', ({ root }) => {
  renderContextPanel()
  if (root && root !== dialogShownForRoot && !hasProjectInfo(root)) {
    maybeShowFirstSetup(root)
  }
})
// When the user closes the folder, dismiss the project-info dialog
// if it's still hanging open from a different root.
bus.on('graph:cleared', () => {
  closeProjectDialog()
  dialogShownForRoot = ''
})

renderContextPanel()

render()

// ═══════════════════════════════════════════════════════════
//  Plugin initialization
//
//  Hand a curated set of helpers to plugin-host so plugins can
//  access app state without reaching into globals directly.
// ═══════════════════════════════════════════════════════════
const pluginHostHelpers = {
  appVersion: '0.11.1',
  getState: () => state,
  getEffectiveActiveSet: () => computeEffectiveActiveSet(),
  readFile: (id) => readFile(id),
  toast: (msg) => toast(msg),
  busOn: (event, handler) => bus.on(event, handler),
  busOff: (event, handler) => bus.off(event, handler),
  createPanel: (manifest, opts) => {
    // Minimal panel implementation — attach to right rail
    const host = document.createElement('div')
    host.className = 'plugin-panel'
    host.dataset.pluginId = manifest.id
    host.dataset.panelId = opts.id
    host.style.cssText = 'background: var(--bg-glass); border: 1px solid var(--border); padding: 12px; margin-top: 10px;'
    const header = document.createElement('div')
    header.className = 'kicker'
    header.textContent = opts.title
    header.style.cssText = 'font-size: 9.5px; letter-spacing: 0.28em; text-transform: uppercase; color: var(--accent); margin-bottom: 10px;'
    host.appendChild(header)
    const body = document.createElement('div')
    host.appendChild(body)

    // Insert into right rail (after context panel)
    const rightRail = document.getElementById('rightRail')
    if (rightRail) rightRail.appendChild(host)

    const render = () => {
      body.innerHTML = ''
      try { opts.render(body) } catch (err) {
        console.error(`[plugin:${manifest.id}] render threw:`, err)
        body.textContent = `Plugin render error: ${err.message}`
      }
    }
    render()
    if (opts.defaultVisible === false) host.style.display = 'none'

    return {
      refresh: render,
      show: () => { host.style.display = '' },
      hide: () => { host.style.display = 'none' },
      dispose: () => host.remove(),
    }
  },
}

// Kick off plugin loading. We do this after the rest of the app is
// initialized so the bus, state, and DOM are ready.
initPlugins(pluginHostHelpers).then(() => {
  // Inject discovered theme plugins into the theme picker
  refreshThemePicker()
})

// Refresh the theme picker grid with any theme-type plugins
function refreshThemePicker() {
  const grid = document.getElementById('themeGrid')
  if (!grid) return
  // Remove existing plugin-added cards
  grid.querySelectorAll('[data-plugin-theme]').forEach((el) => el.remove())
  // Add a card for each discovered theme plugin
  for (const [id, info] of pluginRegistry.themes) {
    const card = document.createElement('button')
    card.className = 'theme-card'
    card.type = 'button'
    card.dataset.theme = id
    card.dataset.pluginTheme = '1'
    card.innerHTML = `
      <span class="theme-swatches">
        <span class="theme-sw" style="background:var(--accent)"></span>
        <span class="theme-sw" style="background:var(--accent-warm)"></span>
        <span class="theme-sw" style="background:var(--accent-pink)"></span>
      </span>
      <span class="theme-name">${escapeHTML(info.manifest.name)}</span>
      <span class="theme-desc">${escapeHTML(info.manifest.description || 'Plugin theme')}</span>
    `
    card.addEventListener('click', () => {
      applyTheme(id)
      toast(`Theme: ${info.manifest.name}`)
    })
    grid.appendChild(card)
  }
  // Add a "manage" button so user knows where plugins live
  let manageBtn = document.getElementById('pluginManageBtn')
  if (!manageBtn) {
    manageBtn = document.createElement('button')
    manageBtn.id = 'pluginManageBtn'
    manageBtn.className = 'export-btn'
    manageBtn.type = 'button'
    manageBtn.style.cssText = 'margin-top: 8px; width: 100%;'
    manageBtn.textContent = 'Open plugin folder…'
    manageBtn.addEventListener('click', () => {
      if (window.codesynapt?.openPluginDir) {
        window.codesynapt.openPluginDir().then((dir) => {
          if (dir) toast(`Plugin folder: ${dir}`)
        })
      }
    })
    grid.parentElement?.insertBefore(manageBtn, grid.nextSibling)
  }
}

// ═══════════════════════════════════════════════════════════════
//  Symbol-mode status cell — clickable in the status bar.
//  Click → builds the symbol graph (codegraph-equivalent layer).
//  Reset whenever the loaded folder changes (snapshot:applied event).
//  (symbolModeState is declared near the top of the module to avoid a TDZ.)
// ═══════════════════════════════════════════════════════════════

// Toggle the 3D symbol (function) layer. First enable fetches /symbol/graph
// and builds state.symbols (each with a stable offset around its parent file)
// + state.symbolCalls; the render loop then draws them as Points + call edges.
async function buildSymbolGraph() {
  const cell = document.getElementById('sb_symbols')
  // The symbol graph is built on demand by the headless/Electron backend
  // (GET /symbol/graph on the control server). The plain web dev server
  // (server.js) is static + WebSocket only and has no such endpoint, so in
  // web mode this control would silently toggle on an empty layer — or, worse,
  // fetch an unrelated project's symbols from whatever cs-serve happens to be
  // on 127.0.0.1:7707. Guard it like every other backend-dependent control
  // (changes / packages / legacy / trace / timelapse) instead of half-running.
  if (!isElectron) {
    toast(t('symbols.requires_electron'))
    return
  }
  state.showSymbols = !state.showSymbols
  symPoints.visible = state.showSymbols
  symEdgeLines.visible = state.showSymbols
  if (cell) cell.classList.toggle('active', state.showSymbols)
  if (!state.showSymbols) return                 // turned off — just hide
  if (symbolModeState.loading) return
  // Already loaded for this project? just show.
  if (state.symbols.size && symbolModeState.lastRoot === state.root) {
    if (cell) cell.title = `${state.symbols.size.toLocaleString()} functions · ${state.symbolCalls.length.toLocaleString()} calls · click to hide`
    return
  }
  symbolModeState.loading = true
  if (cell) cell.classList.add('loading', 'sb-clickable')
  try {
    // Fetch via IPC, NOT a direct fetch(): the renderer runs on the app://
    // scheme, so a fetch to the backend's http://127.0.0.1 is cross-origin and
    // CORS-blocked (the backend reflects only loopback Origins). Main proxies it
    // — works for both the local control-server and a pure-client daemon.
    const j = await window.codesynapt.getSymbols()
    state.symbols.clear()
    for (const s of (j.symbols || [])) {
      // Stable offset on a small sphere shell around the parent file node,
      // so a file's functions cluster on/around it instead of overlapping.
      const off = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      const len = off.length() || 1
      off.multiplyScalar((1.8 + Math.random() * 3.4) / len)
      state.symbols.set(s.id, { id: s.id, file: s.file, name: s.name, kind: s.kind, line: s.line, off, p: new THREE.Vector3(), shown: false })
    }
    state.symbolCalls = j.calls || []
    // Adjacency for hover focus (so hovering a function can highlight only
    // the functions it actually calls / is called by, and fade the rest).
    state.symbolAdj = new Map()
    for (const c of state.symbolCalls) {
      if (!state.symbolAdj.has(c.s)) state.symbolAdj.set(c.s, new Set())
      if (!state.symbolAdj.has(c.t)) state.symbolAdj.set(c.t, new Set())
      state.symbolAdj.get(c.s).add(c.t)
      state.symbolAdj.get(c.t).add(c.s)
    }
    symbolModeState.count = state.symbols.size
    symbolModeState.edges = state.symbolCalls.length
    symbolModeState.lastRoot = state.root
    if (cell) cell.title = `${state.symbols.size.toLocaleString()} functions · ${state.symbolCalls.length.toLocaleString()} calls · click to hide`
  } catch (e) {
    // Surface the failure: a silent catch here is exactly what hid the app://
    // CORS block on the old direct fetch. Toast + console so it's diagnosable.
    if (cell) cell.title = 'symbol layer failed: ' + (e.message || e)
    state.showSymbols = false
    symPoints.visible = false
    symEdgeLines.visible = false
    if (cell) cell.classList.remove('active')
    toast('symbol layer failed: ' + (e.message || e))
    console.error('[symbols] build failed:', e)
  } finally {
    symbolModeState.loading = false
    if (cell) cell.classList.remove('loading')
  }
}

;(function initSymbolCell() {
  const cell = document.getElementById('sb_symbols')
  if (!cell) return
  cell.addEventListener('click', buildSymbolGraph)
  // Reset whenever a new project loads.
  bus.on('snapshot:applied', ({ root }) => {
    if (root && root !== symbolModeState.lastRoot) {
      symbolModeState.lastRoot = root
      symbolModeState.count = null
      symbolModeState.edges = null
    }
  })
})()

// ═══════════════════════════════════════════════════════════════
//  Left sidebar — tab switching
// ═══════════════════════════════════════════════════════════════
const LEFT_TAB_KEY = 'codesynapt:left-tab'
function leftSetTab(name) {
  const rail = document.getElementById('leftRail')
  if (!rail) return
  for (const btn of rail.querySelectorAll('.left-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === name)
  }
  for (const pane of rail.querySelectorAll('.left-tab-pane')) {
    pane.classList.toggle('hidden', pane.dataset.pane !== name)
  }
  try { localStorage.setItem(LEFT_TAB_KEY, name) } catch {}
}
const LEFT_RAIL_ICONS_KEY = 'codesynapt:left_rail_icons'
// Collapse the left rail to its 40px icon strip (pane hidden) or expand it.
function setLeftRailCollapsed(collapsed) {
  document.body.classList.toggle('left-rail-icons', collapsed)
  try { localStorage.setItem(LEFT_RAIL_ICONS_KEY, collapsed ? '1' : '0') } catch {}
}
;(function initLeftTabs() {
  const rail = document.getElementById('leftRail')
  if (!rail) return
  rail.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.left-tab')
    if (!btn) return
    const collapsed = document.body.classList.contains('left-rail-icons')
    if (!collapsed && btn.classList.contains('active')) {
      // Clicking the already-open icon collapses the rail back to icons only.
      setLeftRailCollapsed(true)
    } else {
      // Switching to / opening an icon always expands the pane.
      leftSetTab(btn.dataset.tab)
      setLeftRailCollapsed(false)
    }
  })
  let saved = 'files'
  try { saved = localStorage.getItem(LEFT_TAB_KEY) || 'files' } catch {}
  // Don't restore onto a tab whose button is absent or hidden (e.g. the
  // CS_REGISTRY-only "sessions" tab when registry mode is now off) — that would
  // show an empty pane with no active tab. Fall back to the default.
  const savedBtn = rail.querySelector(`.left-tab[data-tab="${saved}"]`)
  if (!savedBtn || savedBtn.classList.contains('hidden')) saved = 'files'
  leftSetTab(saved)
  // Default to collapsed (icon-only) per the activity-bar design; restore the
  // saved choice so an expand persists across reloads.
  let startCollapsed = true
  try { if (localStorage.getItem(LEFT_RAIL_ICONS_KEY) === '0') startCollapsed = false } catch {}
  setLeftRailCollapsed(startCollapsed)
})()

// ── Relocate the Settings panel into the left rail as an accordion tab ──
// The whole .settings-body node is MOVED (not recreated) so every existing
// control keeps its event wiring. Each section becomes a collapsible accordion
// row (default collapsed; per-section open state persisted).
;(function moveSettingsIntoRail() {
  const host = document.getElementById('settingsPaneHost')
  const panel = document.getElementById('settings')
  const body = panel && panel.querySelector('.settings-body')
  if (!host || !body) return
  host.appendChild(body)
  if (panel) panel.classList.add('hidden')   // old overlay is now empty — keep hidden
  const sections = [...body.querySelectorAll('.settings-section')]
  sections.forEach((title, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'settings-acc'
    title.before(wrap)
    wrap.appendChild(title)
    title.classList.add('settings-acc-title')
    title.style.marginTop = ''                // accordion provides its own spacing
    const cbody = document.createElement('div')
    cbody.className = 'settings-acc-body'
    let n = wrap.nextSibling
    while (n && !(n.nodeType === 1 && n.classList && n.classList.contains('settings-section'))) {
      const next = n.nextSibling
      cbody.appendChild(n)
      n = next
    }
    wrap.appendChild(cbody)
    title.addEventListener('click', () => {
      const open = wrap.classList.toggle('open')
      try { localStorage.setItem('codesynapt:set_acc:' + i, open ? '1' : '0') } catch {}
    })
    let open = false
    try { open = localStorage.getItem('codesynapt:set_acc:' + i) === '1' } catch {}
    wrap.classList.toggle('open', open)
  })
})()

// ═══════════════════════════════════════════════════════════════
//  [④] Multi-session viewer panel (left-rail "sessions" tab)
//
//  Only active in viewer mode (CS_REGISTRY=1). Lists live Claude Code
//  sessions from the registry; clicking "view" attaches the desktop to that
//  session's daemon as a pure client — its graph + trace then arrive through
//  the same snapshot/control:trace channels the local scanner uses (wired in
//  electron/main.cjs). "detach" hands the canvas back to the local scanner.
// ═══════════════════════════════════════════════════════════════
;(function initSessionsPanel() {
  if (!isElectron || !window.codesynapt || !window.codesynapt.viewerEnabled) return
  const tabBtn = document.getElementById('sessionsTab')
  const listEl = document.getElementById('sessionsList')
  const attachedEl = document.getElementById('sessionsAttached')
  const refreshBtn = document.getElementById('spRefresh')
  if (!tabBtn || !listEl) return

  let enabled = false
  let attachedId = null
  let attachedLabel = null

  function paneVisible() {
    const pane = document.querySelector('.left-tab-pane[data-pane="sessions"]')
    return pane && !pane.classList.contains('hidden')
  }

  function renderAttached() {
    if (!attachedEl) return
    if (attachedId == null) { attachedEl.classList.add('hidden'); attachedEl.innerHTML = ''; return }
    attachedEl.classList.remove('hidden')
    attachedEl.innerHTML = `<span class="sp-dot"></span>${escapeHTML(t('sessions.viewing'))}: <b>${escapeHTML(String(attachedLabel || attachedId))}</b>`
  }

  async function refresh() {
    if (!enabled) return
    let data
    try { data = await window.codesynapt.viewerSessions() } catch { return }
    const sessions = (data && data.sessions) || []
    renderAttached()
    if (!sessions.length) {
      listEl.innerHTML = `<div class="sp-empty">${escapeHTML(t('sessions.empty'))}</div>`
      return
    }
    listEl.innerHTML = sessions.map((s) => {
      const isMe = String(s.sessionId) === String(attachedId)
      const dead = !s.daemonAlive
      const cls = 'sp-item' + (isMe ? ' attached' : '') + (dead ? ' dead' : '')
      const label = escapeHTML(s.label || s.projectRoot || s.sessionId)
      const root = escapeHTML(s.projectRoot || '')
      const action = isMe
        ? `<button class="sp-btn sp-detach" data-id="${escapeAttr(s.sessionId)}">${escapeHTML(t('sessions.detach'))}</button>`
        : dead
          ? `<span class="sp-dead">${escapeHTML(t('sessions.dead_daemon'))}</span>`
          : `<button class="sp-btn sp-attach" data-id="${escapeAttr(s.sessionId)}">${escapeHTML(t('sessions.view'))}</button>`
      return `<div class="${cls}" title="${root}">`
        + `<div class="sp-item-main"><div class="sp-label">${label}</div><div class="sp-root">${root}</div></div>`
        + action + `</div>`
    }).join('')
  }

  listEl.addEventListener('click', async (ev) => {
    const aBtn = ev.target.closest('.sp-attach')
    const dBtn = ev.target.closest('.sp-detach')
    if (aBtn) {
      aBtn.disabled = true
      const id = aBtn.dataset.id
      let r
      try { r = await window.codesynapt.viewerAttach(id) } catch (e) { r = { ok: false, error: e.message } }
      if (r && r.ok) { attachedId = r.sessionId; attachedLabel = r.label; toast(`${t('sessions.viewing')}: ${r.label || id}`) }
      else { toast(`${t('sessions.attach_failed')}: ${(r && r.error) || ''}`); aBtn.disabled = false }
      refresh()
    } else if (dBtn) {
      try { await window.codesynapt.viewerDetach() } catch {}
      attachedId = null; attachedLabel = null
      refresh()
    }
  })

  if (refreshBtn) refreshBtn.addEventListener('click', refresh)

  if (window.codesynapt.onViewerStatus) {
    window.codesynapt.onViewerStatus((st) => {
      if (!st) return
      if (st.phase === 'detached') { attachedId = null; attachedLabel = null; refresh() }
      else if (st.phase === 'error') toast('viewer: ' + (st.error || 'error'))
      // 're-bootstrap' is silent — the graph simply refreshes via the snapshot channel.
    })
  }

  window.codesynapt.viewerEnabled().then((on) => {
    enabled = !!on
    if (!enabled) return
    tabBtn.classList.remove('hidden')
    refresh()
    // Poll liveness only while the pane is open (cheap; sessions come/go).
    setInterval(() => { if (paneVisible()) refresh() }, 3000)
  }).catch(() => {})
})()

// ═══════════════════════════════════════════════════════════════
//  Top bar — More popover (⋯ button)
// ═══════════════════════════════════════════════════════════════
;(function initMoreMenu() {
  const btn = document.getElementById('moreBtn')
  const menu = document.getElementById('moreMenu')
  if (!btn || !menu) return
  function position() {
    const r = btn.getBoundingClientRect()
    menu.style.top = (r.bottom + 6) + 'px'
    menu.style.left = (r.right - menu.offsetWidth) + 'px'
  }
  function open() { menu.classList.remove('hidden'); btn.classList.add('active'); position() }
  function close() { menu.classList.add('hidden'); btn.classList.remove('active') }
  function toggle() { menu.classList.contains('hidden') ? open() : close() }
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggle() })
  menu.addEventListener('click', (ev) => {
    if (ev.target.closest('.more-item')) close()
  })
  document.addEventListener('click', (ev) => {
    if (menu.classList.contains('hidden')) return
    if (ev.target.closest('#moreMenu') || ev.target.closest('#moreBtn')) return
    close()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !menu.classList.contains('hidden')) close()
  })
  window.addEventListener('resize', () => {
    if (!menu.classList.contains('hidden')) position()
  })
})()

// Allow plugin themes to be persisted/restored just like built-in ones.
// (VALID_THEMES is checked early — we don't strictly need to add plugin
// theme ids there because applyTheme falls through to the default if
// the theme isn't found in DOM. But for cleanliness:)
const _origApplyTheme = applyTheme
