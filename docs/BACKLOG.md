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
