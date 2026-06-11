# Backlog — 곁가지 기록 (메인작업 차단 안 하는 것들)

- [ ] **flaky test (macOS·Node22)**: `headless-features.test.js > GET /trace/sessions lists the on-disk session .jsonl` — sessions.length 0. 이전 테스트들의 trace 쓰기 타이밍에 의존(디스크 가시성 경합). 재실행 pass로 flake 확정 (PR#14, 2026-06-11). deflake = 단언 전 세션파일 존재 폴링 또는 명시적 이벤트 기록 후 조회.
