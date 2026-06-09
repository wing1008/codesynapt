# CodeSynapt — Claude Code ↔ App 연동 아키텍처 (정본)

> 이 문서가 정본(canonical)이다. 구현이 여기와 어긋나면 PR에서 잡는다.
> 각 결정에 **WHY(따름관계)**를 붙였다 — "왜 detached?" 같은 닫힌 문을 다시 열지 않기 위해.

## 핵심 모델
앱(데스크톱 뷰어)은 **싱글톤**, Claude Code 세션은 **N개**.
세션마다 앱을 띄우지 않는다. 세션들이 **공유 백엔드(데몬)에 등록**되고, 뷰어가 "활성 세션"을 골라 본다.
`/codesynapt` 진입 = (앱 실행이 아니라) **데몬에 attach-or-spawn**.

## ① 레지스트리 — `~/.codesynapt/` 아래 3종 디렉터리
단일 json 금지(write race). 각 참여자는 **자기 파일만** touch → 락 불필요. 읽기 = 디렉터리 스캔 + TTL 필터.

- `sessions/<sessionId>.json` : `{sessionId, projectRoot, port, pid, label, startedAt, lastSeen}`
- `daemons/<projectHash>.json` : `{port, epoch, pid, startedAt, lastSeen}` — **이 파일이 곧 spawn-lock**
- `viewers/<viewerId>.json` : `{viewerId, attachedProjectHash, lastSeen}`
  - WHY: 뷰어도 refcount 참여자. 파일이 없으면 파일기반 refcount가 뷰어를 못 셈 → "뷰어 붙어있으면 유지" 강제 불가.

`projectHash = sha256(canonicalRoot)`.
`canonicalRoot = realpath + (win32: 구분자 \ 정규화 + 드라이브 대소문자 통일 + 경로 소문자 폴딩)`.
WHY: 같은 프로젝트가 다른 경로로 보이면(`C:\` vs `c:\`, 심링크, trailing slash, `/` vs `\`) 데몬이 2개 → "프로젝트당 1개" 동일성 기준.

## ② 백엔드 = projectRoot당 공유 **detached 데몬** (`cs serve`)
- MCP·뷰어는 **순수 클라이언트**.
  - WHY: "프로젝트당 공유"는 in-process와 양립 불가 — 주인 세션이 나가면 백엔드 증발 → 타 세션 고아. **공유 자원은 주인이 없어야 한다(detached가 唯一解).** ②를 합의한 순간 in-process는 죽었다.
- attach = `daemons/<projectHash>.json`에서 `(port, epoch)` 수령 → 없으면 spawn 경합.
- **spawn 경합 = `O_CREAT|O_EXCL` on `daemons/<projectHash>.json` 원자 생성.**
  - 승자: lastSeen 즉시 기록 → 빈 포트 bind → port 기록.
  - 패자: 파일 폴링(승자가 port 쓸 때까지) 후 attach.
  - stale(TTL 만료) 파일은 깨고 재spawn.
  - WHY: 포트bind는 랜덤포트라 직렬화 못 함 → 진짜 lock은 O_EXCL. lastSeen을 **port 쓰기 전에** 찍어야 spawn-중-크래시 미완성 엔트리도 TTL 회수됨(패자 무한폴링 방지).
- 모든 `cs_*` 요청에 **sessionId 동봉**.
- **격리**: 트레이스·세션뷰·trace clear는 sessionId 칸막이 (타 세션 영향 X).
- **전파**: 공유 구조 데이터(L1 파일그래프·L2 심볼그래프·deps/blast/safety) 변경은 전 세션 전파.
- **쓰기는 공유된 현실** — 격리 안 함(A가 고친 파일은 B도 봐야 맞음).

## 수명 = heartbeat-lease 단일 메커니즘
- **refcount = lease 생존 참여자 수** (별도 +1/-1 카운터 금지 — kill -9/터미널닫기에서 반드시 깨짐).
- 참여자 = MCP 세션 ∪ 연결된 뷰어. 둘 다 N초마다 자기 파일 lastSeen 갱신.
- 살아있음 = lastSeen이 TTL 이내. pid/포트ping은 **백업일 뿐**(pid 재사용 위험 → 단독 신뢰 금지).
- **유휴 MCP 세션도 백그라운드 타이머로 heartbeat** (안 하면 살아있는데 오살).
- 뷰어는 **현재 붙은 데몬에 귀속** — 프로젝트 전환 = old detach + new attach(유령 뷰어 방지).
- 데몬 refcount(self-exit 판단) = projectHash 일치하는 fresh `sessions` + `viewers`. **0이면 데몬 self-exit.**

## ③ 실시간 = `(epoch, seq)` 커서 델타 폴링
- **seq 전역 단조**: trace append + graph invalidate 모두 +1.
- 응답: **트레이스는 sessionId 필터, 그래프는 전체 전송** (한 커서, 필터된 페이로드).
  - WHY: 트레이스=격리 / 그래프=공유의 비대칭. per-session seq면 graph seq와 desync → "그래프 갱신됐는데 커서 안 움직임" 버그.
- **콜드 attach = bootstrap**: 풀 상태 fetch(`/graph`·`/symbol`) + 현재 seq 수령 → 이후 델타.
  - WHY: 그래프는 *상태*라 `since=0` 무의미; 트레이스는 *로그*라 since 델타 가능 → snapshot+delta 표준.
- **epoch = 데몬 인스턴스 id.** 데몬 재시작 시 seq 리셋 → 클라가 `(epoch, seq)` 저장, epoch 불일치면 **re-bootstrap**.
  - WHY: detached라 재생성이 실재 → 옛 커서가 콜드 데몬에 무한대기 거는 것 방지. ★의 직접 따름정리.
- **heartbeat 합승**(폴링이 곧 heartbeat). **TTL = 폴링주기 × 3.** janitor 동일 tick.
- 페이로드는 **transport 불변** → 추후 WS 푸시 승급 시 데이터 계약 안 바뀜(폴링은 임시방편이 아니라 같은 계약의 한 transport).

## ④ 쓰기
- **last-write-wins** (MVP, 충돌 감지 안 함 — 공유 FS의 현실이라 어떤 구조든 동일).
- 완화 = **contentHash `If-Match` 선조건 → 412 시 AI가 다시 읽고 재시도**(자동 머지 X). (contentHash는 이미 노출됨.)
- 프로세스 모델 = ②의 detached 데몬 (in-process 폐기).

## 구현 원칙 / 순서
- 기존 단일 포트락(`~/.codesynapt/port`)이 MCP·CLI·`cs serve`에 박혀 있음 → **flag 뒤에서 점진 교체, 옛 경로 살려둠.** 한 번에 갈아엎지 말 것(렌더러 취약성 전례).
  - 전환기 공존 시 새 데몬은 별도 포트레인지 or 레지스트리 우선순위 명시(옛↔새 포트 충돌 방지).
- attach-중-스캔은 기존 `initialScanComplete`/`scanPhase` 게이트 재사용(ready까지 대기) — 새 작업 아님.
- 파일 갱신 = temp+rename 원자, 리더는 parse 실패 시 그 tick 무시, stale 파일은 발견자(데몬 tick/다음 클라)가 삭제.
- 순서: **① 레지스트리+lease(자족적·테스트 쉬움) → ② 데몬 lifecycle → ③ 커서 프로토콜 → ④ 뷰어(제일 위험, 마지막).**

## 미해결 / 코드단계 디테일 (합의 아님, 튜닝/엣지)
- UNC 경로(`\\server\share`)는 드라이브문자 정규화 안 먹음 → canonical에서 별도 케이스.
- win32 경로 소문자 폴딩은 드문 case-sensitive 볼륨에서 과합치 가능(실용상 수용).
- 숫자 튜닝: 폴링주기, TTL 배수, 포트레인지.
