# 다언어 층위 재측정 — 2026-06-17

전임: [`2026-06-14-layer-measurement.md`](./2026-06-14-layer-measurement.md).
도구: `scripts/_measure.mjs`(지표) + `scripts/_precision_pos.mjs`(위치기반 precision
oracle, 전 언어) + `scripts/_precision_oracle.mjs`(babel-exact, JS 전용).
코퍼스: `scripts/fetch-corpus.mjs`로 12개 OSS repo(corpus-manifest.json 고정 SHA) +
Python stdlib(Python313) + 자체 repo(JS). **자기확증 픽스처 아닌 실제 코드.**

## 측정표 (13 시도)

| 언어 | 코퍼스 | 파일 | ms/file | confident | candidates | dynSites | dead% | unexpl | 이름기반#M1 | **정확 precision(틀린연결)** | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| JS | 자체 repo | 62 | 25.7 | 4643 | 1603 | 516 | 50 | 0 | 52% | **0.2%** (babel 1/538) | ✓ |
| Python | stdlib | 699 | 7.0 | 13892 | 79798 | 4832 | 50 | 0 | 4% | **1.3%** (pos 65/5029) | ✓ |
| Go | gorilla/mux | 17 | 9.4 | 469 | 295 | 62 | 82 | 0 | 2% | **0%** (모호 0) | ✓ |
| Java | google/gson | 121 | 2.5 | 1527 | 4232 | 1010 | 3 | 0 | 35% | **0%** (0/198) | ✓ |
| Rust | serde_json | 39 | 7.0 | 495 | 3758 | 451 | 44 | 0 | 3% | **0%** (0/86) | ✓ |
| C# | Newtonsoft.Json | 945 | 3.3 | 10504 | 45958 | 4531 | 3 | 0 | 50% | **0.4%** (2/562) | ✓ |
| Scala | upickle | 90 | 3.1 | 616 | 7026 | 878 | 57 | 0 | 0% | **0%** (0/61) | ✓ |
| C++ | fmtlib/fmt | 19 | 45.3 | 392 | 1674 | 1285 | 23 | 0 | 25% | **0%** (0/522) | ✓ |
| C++ | nlohmann/json | 292 | 3.9 | 1137 | 8876 | 4695 | 51 | 0 | 0% | **0.3%** (2/654) | ✓ **NEW**(전 OOM) |
| Kotlin | okhttp | 503 | 5.0 | 5145 | 85204 | 10557 | 13 | 0 | 18% | **0.8%** (3/383) | ✓ **NEW**(전 오염) |
| Kotlin | kotlin-wrappers | 14641 | 0.4 | 3707 | 39988 | 10721 | 45 | 0 | 1% | **0%** (0/286) | ✓ |
| PHP | guzzle | 43 | 3.3 | 129 | 28 | 904 | 29 | 0 | 0% | 미측정(파서 flake) | ⚠️ |
| Lua | middleclass | 11 | 4.0 | 9 | 0 | 260 | 79 | 0 | 0% | 0%(거의 측정 안 됨) | ⚠️ |
| Swift | Alamofire | 54 | — | — | — | — | — | — | — | — | ❌ crash |

## 핵심 발견 (2026-06-14 대비 델타)

### 1. ★ 정확 precision(틀린연결) = 전 언어 0~1.3% — "틀린연결 0" 사실상 달성
2026-06-14의 **이름기반 #M1(JS 51%·C# 50%·Java 35%)은 착시였음을 전 언어에서 확정**.
scope oracle(위치기반 + JS babel-exact)로 재측정한 진짜 틀린연결 비율:
- JS 0.2% · Python 1.3% · C# 0.4% · C++(json) 0.3% · Kotlin(okhttp) 0.8% · 나머지 0%.
- 잡힌 위반은 전부 **진짜 nested-scope 충돌**(같은 파일·같은 이름 함수가 test 메서드
  안에 재정의된 케이스: test_abc.py의 `foo`, codesynapt.cjs의 `sleep` 등). 우연 동명 아님.
- 즉 resolveCall의 same-file first-match 한계는 **실재하지만 빈도가 ≤1.3%**. 이상향
  "틀린 연결 0"에 매우 근접(전엔 "JS/C# 50% 위반"으로 잘못 알았던 것이 핵심 정정).

### 2. ★ 측정 신뢰성 대폭 개선 — 13개 중 11개 측정 성공 (전 ~7개)
`--lang` 언어그룹 격리(프로세스당 단일 그래머)가 2026-06-14의 wasm 오염을 대부분 해소:
- **php-guzzle**: 전 "❌ php 파서 깨짐" → 이번 `_measure` 정상(376 심볼). 단 `_precision_pos`
  재실행에선 또 파서 죽음("Cannot read properties of undefined") — **간헐 flake 잔존**.
- **kotlin-okhttp**: 전 "⚠️ bash 파서 오염" → 격리로 정상(503 파일, 7541 심볼).
- **nlohmann/json**: 전 "❌ OOM(거대 단일헤더)" → 이번 정상(292 파일). OOM 해소.
→ 0.0.9 wasm 게이트의 **상당 부분이 언어격리만으로 완화**됨. 다만 근본 ABI 해결은 아님(아래).

### 3. 남은 실패 (= 0.0.9 wasm 게이트 잔여)
- **Swift**: 여전히 네이티브 크래시(별도 프로세스도). 측정 불가.
- **PHP**: 단일언어인데도 같은 입력에서 런마다 성공/실패가 갈림 = **비결정적 wasm flake**.
- **Lua**: confident 9 vs dynamicSites 260 — table-OOP(`obj:method()`)라 member call을 거의
  못 이음. 구조적 한계(파서 안정성과 별개).

### 4. 안정적으로 재확인된 것
- **unexplained = 0 (전 13 시도)** — 정직성 머신(accounting)은 전 언어에서 작동.
- **속도**: 0.4~9.4 ms/file(C++ 헤더만 45). 양호. kotlin-wrappers 14641파일도 0.4ms/file.
- **동적 처리**: candidates/dynamicSites 원장으로 동적 호출을 침묵0으로 정직 처리.

## 변치 않은 한계 (정직하게)
1. **dead ≠ recall**: 3%(C#/Java) ~ 82%(Go)로 27배 변동. 라이브러리 부풀림 + 언어별
   member-call resolve 차이 때문. recall은 **런타임 트레이싱 oracle**(`_recall_oracle.mjs`,
   Python 전용)로만 측정 가능 — 이번 세션 미실행(앱+엔트리 필요). 전회 값(결정가능분 59%
   하한·동적 72%) 유지.
2. **다언어 측정 = 언어격리로 완화됐으나 swift crash·php flake 잔존** → 0.0.9 wasm ABI가
   완전 신뢰의 전제.
3. **이름기반 #M1은 폐기**: 위치/scope oracle이 정본. _measure의 m1Pct 컬럼은 참고용(착시).

## 이상향 거리 (갱신)
- **틀린연결 0**: ✅ 사실상 달성(≤1.3%, 잡힌 건 진짜 nested 충돌). 완전 0은 resolveCall에
  scope 인지 추가 필요(중간 작업, precision/recall 트레이드오프).
- **정적 100%(놓침 0)**: 미측정(런타임 recall oracle 필요). dead로는 결정 불가.
- **다언어 9개 안정 측정**: 11/13 성공. swift·php(flake)·lua가 0.0.9/구조 게이트.
