# Backlog — 곁가지 기록 (메인작업 차단 안 하는 것들)

- [ ] **flaky test (macOS·Node22)**: `headless-features.test.js > GET /trace/sessions lists the on-disk session .jsonl` — sessions.length 0. 이전 테스트들의 trace 쓰기 타이밍에 의존(디스크 가시성 경합). 재실행 pass로 flake 확정 (PR#14, 2026-06-11). deflake = 단언 전 세션파일 존재 폴링 또는 명시적 이벤트 기록 후 조회.
- [ ] **idle-reap이 진행 중 요청을 죽임**: 긴 /symbol/summary 빌드(대형 리포 첫 호출) 중에도 세션리스 없으면 데몬 self-exit → 클라이언트 빈 응답. in-flight HTTP 요청을 리스로 카운트하거나 reap 전 drain 필요. (2026-06-11 Hmapp 측정 중 재현)
- [ ] **HIGH: cs serve 좀비 축적 — idle-reap 미작동 사례**: 측정 세션들이 띄운 serve 데몬 17개가 수 시간 생존(세션리스 없음에도 self-exit 안 함) → 포트 7707-7716 고갈 → 데스크톱 "control API disabled" + CLI가 낡은 코드 데몬으로 오라우팅. pkill -f가 Windows에서 안 죽는 것도 한 원인(하니스), 그러나 reap 자체가 안 돈 의심. 재현·원인 조사 필요 (heartbeat가 살아있는 조건? MCP 세션 리스 잔존?). 사용자 실영향: 포트 고갈·구버전 응답. (2026-06-11 발견)
