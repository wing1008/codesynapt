# Backlog — 곁가지 기록 (메인작업 차단 안 하는 것들)

- [x] ~~**flaky test (macOS·Node22)**~~ → 폴링 deflake 적용(PR#19). 원문:: `headless-features.test.js > GET /trace/sessions lists the on-disk session .jsonl` — sessions.length 0. 이전 테스트들의 trace 쓰기 타이밍에 의존(디스크 가시성 경합). 재실행 pass로 flake 확정 (PR#14, 2026-06-11). deflake = 단언 전 세션파일 존재 폴링 또는 명시적 이벤트 기록 후 조회.
- [x] ~~**idle-reap이 진행 중 요청을 죽임**~~ → **수정됨 (PR#17)**: in-flight 카운터 추가, 요청 서빙 중엔 self-exit 안 함.
- [x] ~~**HIGH: cs serve 좀비 축적**~~ → **원인 규명·수정됨 (PR#17)**: ①Windows에서 lease rename이 동시 읽기와 EPERM 충돌 → 리스 갱신 유실+tmp 잔재 ②hb의 단일 try라 touch throw가 reap 체크를 매 틱 스킵(reap 기아). writeAtomic 재시도+폴백, try 분리, tmp 청소(5→0 검증).
- [ ] **trace 패널에 런타임 세션 상세 보기**: PR#17로 타임라인 한 줄("runtime: N edges observed")은 남음. 후속: 클릭 시 관측 엣지 목록/새 동적 엣지로 점프.
- [x] ~~**`cs trace watch`**~~ → 구현(PR#18). 원문:: 장기실행 프로세스(dev server 등)에 inspector(CDP Profiler.start/stop 주기) 붙여 연속 관측 → 주기적 observe POST → 지도가 계속 박동. ws optionalDep 활용.
- [x] ~~**Java/C# `super./base.` 호출 정밀화**~~ → 적용(PR#19). 원문:: Python super()와 동일 메커니즘 적용 가능 (treesitter, classStack.bases 재활용).
- [ ] **표현식 layer / 다언어 확장**: 락된 계획 Phase 4·5.
- [ ] **데스크톱 /health에 epoch 누락 (패리티)**: 헤드리스는 epoch 반환(재부트스트랩 커서), 데스크톱 main.cjs /health는 undefined — 순수클라가 데스크톱 백엔드에 붙을 때 epoch 기반 재부트스트랩이 무력화될 수 있음. (2026-06-11 도그푸딩 C5에서 실증)
- [ ] **HIGH: 교차 그래머 wasm 오염 (web-tree-sitter 0.20.x)**: 같은 프로세스에서 scala 파스 후 lua 트리가 잘림(2번째 top-level 함수·엣지 소실) — 그래머별/공유 Parser 모두 재현. 폴리글랏 리포(해당 그래머 쌍 혼재)에서 오추출 위험. 수정경로=web-tree-sitter+tree-sitter-wasms 쌍 업그레이드(ABI 결합이라 함께). 회귀테스트: misc-langs.test.js it.fails + lua.test.js(단독=정상 증명). (2026-06-11 ① 다언어 바 작업 중 발견)
- [ ] **Lua 베어 호출이 전부 member-call로 오분류** (NAV_TYPES 'variable' — lua AST가 베어 호출도 variable로 감쌈) → zero-silence 원장이 Lua에서 무음 + builtin 거부가 베어에도 적용. 2026-06-05 기존 결함(2차 점검 확인, 회귀 아님). 수정: variable의 자식이 단일 identifier면 bare 취급.
- [ ] (기존 wasm 오염 항목 보강) 트리거 쌍에 **php→lua**도 확인됨 — scala→lua만이 아님 (2차 점검).
- [ ] **장기세션 wasm 힙 추세 미실측**: 라이브맵이 수정마다 심볼 재빌드 — JS 위주 리포는 6회 연속 재빌드 실측 평탄(heap 23→21MB·rss 안정, 2026-06-11). 단 tree-sitter 비중 큰 리포(py/java 대형)의 수일급 데스크톱 세션은 미실측 (tree.delete 호출·swift 워커격리는 있음). 장기 soak 측정 1회 가치.
- [ ] **⑤ 잔여 — 트레이서 미커버 영역** (PR#28 이후): ①Python은 `trace run`만 — `trace watch`(연속) 미지원 ②JVM 에이전트·.NET 프로파일러 트레이서 미구현(각각 별도 대형 공사; Java/C#는 정적바+마킹으로 커버 중) ③언더스코어 시작 파일(`_x.py`)은 스캐너 ignore라 트레이스 시 "no in-repo frames"로 침묵 — 에러 메시지에 힌트 추가 가치. (2026-06-11)
- [ ] **it.fails 단독실행 의미론**: misc-langs의 wasm 오염 expected-fail은 `-t` 필터 단독실행 시 오염원(scala)이 skip돼 통과→fail로 뒤집힘 (2차 점검 실증). 주석 또는 가드 보강.
- [ ] **토스트 문구 다듬기**: 비전문가 가독성 + 이름 3개 이하일 때 '…' 고정 출력 (2차 점검 LOW).
- [x] ~~HIGH: 데스크톱 watcher 간헐 사망~~ → **오진. 진범=유령 데스크톱**: 전날 사용자가 띄운 인스턴스가 taskkill //IM에 침묵 면역(다른 세션/권한, stderr 숨김)인 채 7707 점유 — e2e가 구코드 쌍둥이에게 질의. PowerShell Stop-Process로 제거 후 깨끗한 인스턴스에서 ⑦ 전체 체인 라이브 증명(signature changed 이벤트). 남는 제품 교훈 2건 아래. (2026-06-11)
- [ ] **같은 프로젝트 데스크톱 중복 기동 경고**: 두 데스크톱이 같은 프로젝트를 열면 레지스트리 heartbeat 끼리 thrash + 클라이언트가 구버전 인스턴스로 오라우팅(유령 사건의 본질). 기동 시 레지스트리에 동일 projectHash의 살아있는 desktop 엔트리가 있으면 사용자에게 경고/포커스 이전 제안.
- [ ] **newly-dead 경보 과발화 의심**: 시그니처 프로브 1개 수정에 +102 newly-dead 동반 — enrichment(TS서브엔진/임베딩) 비동기 완료 시점이 accounting 스냅샷 사이에 끼면 도달성이 출렁이는 듯. diff를 enrichment 완료 후로 옮기거나 임계 둘 가치. (2026-06-11 관찰)

## insp-004 (2026-06-12 풀점검) 후속 — Wave 2/3에서 처리
- [ ] **aliased destructure-require 미해결**: `const { orig: local } = require('./mod'); local()` 는 caller 엣지 안 생김 — ESM `import { orig as local }`도 공유하는 기존 한계(rename→source 매핑 부재). Wave1에서 non-alias destructure(#52 핵심 6호출)는 수정됨. 처리경로: 파서가 import 별칭 binding을 {module, exportedName}로 매핑해 resolveCall에 원래 이름 전달.
- [ ] **확정 57건 정본**: `docs/inspections/2026-06-12-insp-004/confirmed.json` (HIGH 21·MED 19·LOW 17). clean.md=재배포 제외 목록(burn-spots/blockers). critic.md=점검 사각 8.
- [ ] **표현식 람다/comprehension 스코프 shadow (#20)**: `lambda x: g(x)` / `[a for a in items]` 에서 inner 바인딩이 outer param을 가리면 g(x)의 x를 param:x로 오판 가능. Wave2에서 다중쓰기/자기참조/증강/기본값/call-of-call은 정직강등 완료. nested-scope shadow는 별도(스코프 스택 필요). 처리경로: lambda/comprehension 진입 시 바인딩 이름을 shadow 집합에 넣어 그 스코프 안 식별자는 param/local 귀속 차단.
