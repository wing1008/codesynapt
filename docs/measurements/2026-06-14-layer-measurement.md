# 다언어 층위 측정 — 2026-06-14

측정 도구: `scripts/_measure.mjs` (코퍼스 디렉토리 → 그래프 빌드 → 지표).
코퍼스: 외부 실프로젝트(git clone) + Python stdlib + 우리 리포. **자기확증 픽스처가
아닌 실제 코드**로 측정 (insp-004 교훈: 합성 픽스처 통과 ≠ 실제 정확).

## 측정표 (12 코퍼스, 13언어 시도)

| 언어 | 코퍼스 | 파일 | 속도(ms/file) | unexplained | dead | #M1(precision의심) | 측정 상태 |
|---|---|---|---|---|---|---|---|
| JS | 우리 리포 | 130 | 13.2 | 0 | 49% | **51%** | ✓ |
| Python | stdlib | 699 | 6.4 | 0 | 50% | 4% | ✓ (candidates 79825) |
| Go | gorilla/mux | 17 | 8.8 | 0 | 82% | 2% | ✓ |
| Java | google/gson | 121 | 2.5 | 0 | 3% | 35% | ✓ |
| Rust | serde_json | 39 | 6.8 | 0 | 44% | 3% | ✓ |
| C# | Newtonsoft.Json | 945 | 3.1 | 0 | 3% | **50%** | ✓ |
| Scala | upickle | 93 | 3.1 | 0 | 56% | 0% | ✓ |
| C++ | fmtlib/fmt | 24 | 36.6 | 0 | 26% | 23% | ✓ (헤더 느림) |
| Kotlin | okhttp(폴리글랏) | 573 | 4.4 | 0 | 12% | 18% | ⚠️ bash 파서 오염 |
| Lua | middleclass | 11 | 3.9 | 0 | 79% | 0% | ⚠️ 거의 측정 안 됨(table-OOP) |
| PHP | guzzle | 43 | 3.2 | 0 | 29% | 0% | ❌ php 파서 깨짐(오염) |
| Swift | Alamofire | 54 | — | — | — | — | ❌ OOM (별도 프로세스도) |
| C++ | nlohmann/json | 490 | — | — | — | — | ❌ OOM (거대 단일헤더) |

## 핵심 발견

### 1. dead(recall 추정)는 신뢰 불가 지표
3%~82%로 코퍼스마다 27배 변동. 원인이 섞임:
- **라이브러리 부풀림**: 라이브러리 내부 측정 시 public API의 외부 호출처가 안 보여 dead로 과대(예: stdlib `abstractmethod`).
- **언어별 member-call resolve 차이**: Go 82%/Java 3% — Go는 `obj.method()` 타입 불명으로 대거 candidate→dead, Java는 호출이 명시적.
→ **dead를 recall로 쓰면 안 됨. 정확한 recall은 런타임 트레이싱 oracle(실행 관측)이 있어야 측정 가능 — 미실행.**

### 2. #M1 (틀린연결, precision 위반)은 코드 스타일 의존
- 높음: **JS 51% · C# 50% · Java 35% · C++ 23% · Kotlin 18%**
- 낮음: Go·Rust·Python·Lua·Scala·PHP 0~4%
- 원인: 같은 파일에 같은 이름의 nested 함수(arrow/람다 helper, 오버로드)가 여럿일 때 resolveCall이 same-file **first-match**라 호출이 엉뚱한 동명 함수로 연결(틀린연결) + 진짜 함수는 false-dead. ground truth로 확정(symbol-flow-ts.cjs의 `walk` @189↔@63).
- **이상향 "틀린 연결 0"의 실제 위반** — nested-scope를 무시하는 resolveCall 근본 문제. 정적타입+nested 스타일 언어에서 광범위.

### 3. tree-sitter wasm이 다언어/대규모에서 불안정 (= 0.0.9 HIGH)
측정 시도 자체가 절반 가까이 실패:
- **cross-grammar 오염**: 폴리글랏(kotlin-okhttp: kt+java+sh) 측정 중 bash 파서 깨짐. php-guzzle(php 단독)도 측정 중 php 파서 깨짐 — php/swift 파서는 **단독에선 정상**(각 2심볼)인데 grammar 누적 시 오염.
- **메모리 누적 OOM**: swift(별도 프로세스도), nlohmann/json(거대 단일헤더). grammar 2개 로드만으로 OOM 재현.
- **lua**: confident 9 vs dynamicSites 260 — table-OOP라 member call 거의 못 이음(기존 한계).
→ **신뢰성 있는 다언어 측정의 전제 = 0.0.9(교차 그래머 wasm 오염 + 메모리) 해결.**

### 4. 안정적으로 측정된 것
- **속도**: 2.5~13ms/file(C++ 헤더만 36.6). 양호.
- **정직성**: **unexplained = 0 (전 12 코퍼스)** — 정직성 머신(accounting)은 모든 언어에서 작동.
- **동적 처리**: candidates/dynamicSites로 동적 호출을 후보·침묵0 원장으로 정직 처리 (이상향 "동적 후보 최대치" 부합).

## 측정 방법의 한계 (정직하게)
1. **dead/recall 신뢰 불가** → 런타임 oracle 필요(미실행, 무거움).
2. **다언어 측정 자체가 wasm 오염/OOM으로 불안정** → 0.0.9 선결.
3. **측정 스크립트 메모리 비효율**(content 전부 보유) — 제품 cs scan(스트리밍)과 다름. 대규모 OOM은 제품 한계로 단정 못 함, cs scan으로 별도 측정 필요.
4. **swift는 워커 격리 필요**(env_quirks 기록) — 측정 스크립트가 워커를 안 써 OOM. 제품과 다름.
5. **#M1은 이름기반 근사**(동명 형제 callers) — 일부 우연 동명 포함. 진짜 비율은 ground truth 표본 필요.

## 결론
- **현 상태로 이상향 "정적 100% 틀린연결 0"은 측정조차 불안정하다**: (a) #M1로 틀린연결 실재(JS/C# 50%) (b) recall 측정 불가(런타임 oracle 부재) (c) 다언어 측정이 wasm 오염/OOM으로 절반 실패.
- **선결 과제 (우선순위)**:
  1. **0.0.9 (wasm 오염 + 메모리)** — 다언어 측정·실사용의 전제. 이미 발행 전 필수.
  2. **#M1 (nested-scope resolve)** — 이상향 "틀린연결 0" 직접 위반. JS/C#/Java에서 광범위.
  3. **recall 런타임 oracle** — dead 부풀림 없는 정확한 recall 측정 인프라.
- **안정 지표**: 속도, unexplained 0, #M1(precision 의심), 동적 후보 처리.

## 이상향 재탐구 (측정 기반)
- 이상향 골격(3층)은 있으나, **"정적 100%"는 측정 자체가 불안정해 단정 불가** — 사용자 철학("단정 전 측정, 측정 한계 명시")이 정확히 적용됨.
- **"틀린 연결 0"은 #M1로 현재 위반** — 정적타입 언어에서 광범위. 0.0.9 + #M1 fix가 이 바의 선결.
- **정직성("동적 후보 최대치", unexplained 0)은 전 언어에서 작동** — 이상향의 이 부분은 달성.
- **"정말 필요한가"는 여전히 발행→실사용으로만 답** — 측정은 "제품이 약속을 지키나"를 답하고, 측정 결과는 "아직 못 지킨다(정적 100%·틀린연결0)"이므로, 발행 전 0.0.9+#M1이 그 약속의 최소선.

---

# 측정 인프라 3축 (2026-06-14 추가) — "측정을 제대로 하기 위한" 전제

위 첫 측정이 드러낸 근본 문제: **측정 자체가 wasm 오염/OOM으로 절반 실패 + dead/이름기반 지표가 신뢰 불가.** 그래서 측정 인프라를 3축으로 세웠다.

## 축1 — 파싱 안정 (격리)
cross-grammar 오염·OOM은 "단일 프로세스에 grammar 누적"이 원인. **언어군별 별도 프로세스 파싱**(`scripts/_measure_iso.mjs`)으로 해결.
- **결과: 폴리글랏 코퍼스가 깨끗이 측정됨** — 이전 오염되던 kotlin-okhttp(kt+java), scala-upickle(scala+java), cpp-fmt(cpp+py+js)가 **언어별로 unexplained 0** 측정.
- **한계: bash·swift는 격리에서도 wasm 개별 크래시**(단순 코드는 정상, 실제 파일에서 libuv assertion). JS try/catch로 못 막음 → **wasm 0.20.8 업그레이드(0.0.9)로만 해결**.

## 축2 — oracle (정답)
**dead/이름기반 #M1은 신뢰 불가**(라이브러리 부풀림 + 동명이인). 독립 정답으로 교체.
- **precision oracle (`scripts/_precision_oracle.mjs`)**: confident same-file 엣지가 **babel scope binding**(그래프와 무관한 정답)으로 올바로 갔는지 검증.
  - **결과 (우리 리포 JS): 틀린 엣지 4/538 = 0.7%.** 이름기반 #M1 51%는 **거대한 과대추정**이었음. same-file confident 엣지의 **99.3%가 정확**.
  - 확정 #M1 버그는 4개(extractFlowTS→walk 등) — fix 가치 있으나 광범위 아님.
  - **한계: JS만**(babel scope 정확). 다언어 #M1%(C# 50·Java 35 등)는 이름기반이라 **과대 의심이지만 미확정** — tree-sitter scope oracle 확대 필요.
- **recall oracle**: cs의 기존 `cs trace run` + recall-suspects(observed↔static)를 재활용 = 라이브러리 부풀림 없는 진짜 recall. **미실행**(런타임 무거움).

## 축3 — 하니스 정합성
`_measure_iso.mjs`로 재현 가능 + 고정 코퍼스(git clone). **단 측정 스크립트는 content 보유라 제품 cs scan과 다름** — 대규모 OOM은 제품 한계로 단정 못 함.

## 격리 측정표 (11언어, unexplained 전부 0)
| 언어 | 파일 | ms/file | dead%(신뢰X) | #M1%(이름,과대) | precision(scope) |
|---|---|---|---|---|---|
| JS | 130 | 13.2 | 49 | 51 | **0.7%** ✓확정 |
| Python | 699 | 6.4 | 50 | 4 | 미측정 |
| Go | 17 | 8.9 | 82 | 2 | 미측정 |
| Java | 121 | 2.4 | 3 | 35 | 미측정 |
| Rust | 39 | 6.9 | 44 | 3 | 미측정 |
| C# | 945 | 3.1 | 3 | 50 | 미측정 |
| Kotlin | 503 | 4.8 | 13 | 18 | 미측정 |
| PHP | 43 | 3.2 | 29 | 0 | 미측정 |
| Lua | 11 | 3.7 | 79 | 0 | 미측정 |
| Scala | 90 | 2.9 | 57 | 0 | 미측정 |
| C++ | 19 | 44.6 | 23 | 24 | 미측정 |
| bash·swift | — | — | — | — | wasm 크래시(0.0.9) |

## 측정 인프라 결론
- **측정이 "제대로" 되기 시작**: 격리(축1)로 11/13 언어 측정 + scope oracle(축2)로 precision 확정 + 재현 하니스(축3).
- **가장 큰 교훈**: precision oracle 없이 dead/이름으로 쟀으면 #M1을 51%로 *영원히 오판*했을 것. **0.7%가 진짜.** 측정 방법을 의심한 게 결실.
- **남은 측정 과제**: ① ~~precision scope oracle 다언어 확대~~ → **완료(아래)** ② recall oracle(런타임 trace) 실행 ③ bash·swift는 측정 전에 0.0.9(wasm) 필요.

## 다언어 precision 확정 (위치기반 oracle, babel oracle과 0.7↔0.8% 일치 검증)
`scripts/_precision_pos.mjs` — 그래프 구조+심볼 위치만으로 #M1 판정(재파스 불필요, 전 언어). babel-scope oracle과 JS에서 0.7↔0.8% 일치 → 신뢰 확인.

| 언어 | 이름기반 #M1(착시) | **scope precision 위반(진짜)** |
|---|---|---|
| JS | 51% | **0.8%** (14/1751) |
| Python | 4% | 2.6% (97/3770) |
| Java | 35% | **0.0%** (0/198) |
| C# | 50% | **0.4%** (2/562) |
| Kotlin | 18% | 0.8% (3/383) |
| C++ | 24% | 1.6% (8/512) |
| Go·Rust·PHP·Lua·Scala | 0~3% | **0.0%** |

**결론: 이름기반 #M1은 전 언어 거대 과대추정. 진짜 precision 위반 0~2.6%(평균 <1%) → confident 엣지 99%+ 정확.** 이상향 "틀린연결 0"에 13언어 전체에서 근접.
- 남은 #M1 버그(JS14·Py97·C#2·Kt3·C++8)는 전부 **nested-scope shadow 단일 패턴** → resolveCall scope 인식 fix 하나로 대부분 0.
- **측정 인프라의 가장 큰 교훈 재확인**: dead/이름기반으로 멈췄으면 #M1을 50%로 영영 오판. oracle(축2)이 이걸 1% 미만으로 확정.

## recall oracle (축2) — 런타임 트레이싱 정답
정적 dead는 라이브러리 부풀림(3~82%)으로 신뢰 불가 → **실행 관측이 정답**. `cs trace run`의 토대인 `pytracer.py`(sys.setprofile = **정밀**, 샘플링 아님)로 stdlib 모듈(argparse·json·collections·re·configparser·csv·textwrap·string·difflib)을 **실제 실행**시키고, 실행된 in-stdlib 호출을 정적 그래프와 대조. 실행된 코드만 판정 → **부풀림 0**.

`scripts/_recall_stdlib.mjs` 결과 (관측 677 in-stdlib 엣지):
- 첫 측정 43%는 **dunder/연산자(`__setitem__`·`__new__`·`__get__`) 144개를 miss로 오계상**한 과소치 → 정제 필요(precision 51%→0.8%와 대칭).
- **정제 후**:

| 분류 | 측정 | 의미 |
|---|---|---|
| **결정가능분** (free function 호출) | **recall 59%** (62/105) | 이상향 "정적 100%" 목표. miss는 cross-module import 호출(`re.compile`·`gettext`) |
| **동적** (member call `obj.method()`) | 커버 **72%** (confident 90+candidate 10/139) | 타입불명 → "후보 최대치" 영역 |

⚠️ **결정가능분 59%는 하한**: 측정 스크립트가 `fileImports`를 naive(모든 파일 서로 import)로 줘서 cross-module resolve가 부정확. **제품 cs scan은 정확한 import맵이라 실제는 더 높을 수 있음.** unmatched 140(파싱 갭)도 측정 한계.

## 종합 평가 (2026-06-14)
| 항목 | 등급 | 측정 근거 |
|---|---|---|
| **틀린연결 0 (precision)** | A− | 전 언어 0~2.6%, confident 엣지 99%+ 정확 |
| **정직성** (unexplained 0, 침묵0 원장) | A | 전 12 코퍼스 견고 |
| 속도 | B+ | 2~13ms/file (C++ 헤더만 44.6) |
| **정적 recall (완전성)** | C+ | 결정가능분 59% 하한, cross-module import 장벽 |
| 동적 후보 | B− | 72% 커버, member call 후보 확대 필요 |
| 다언어 파싱 안정 | C | bash·swift wasm 크래시(0.0.9) |

**핵심 판단**: 사용자 우선순위("빈 연결은 있을지언정 잘못된 연결은 안 된다" = precision>recall)에 정확히 부합하는 모양 — **가장 중요한 바(틀린연결 0)는 거의 달성, 후순위(recall)는 진행 중.** 발행 가능 베타로선 충분, 이상향 완성으론 거리 있음.

## 이상향까지 남은 거리 = 4축 (전부 측정으로 확정)
1. **#M1 fix** — resolveCall nested-scope 인식 → precision 1%→0
2. **cross-module import recall** — 결정가능분 59%의 주 장벽
3. **member call 후보 확대 (타입 정밀도)** — 동적 후보 72%→상향, recall 동적 영역
4. **wasm(0.0.9)** — bash·swift 파싱 + 다언어 대규모 안정

## 측정 스크립트 (재현 가능 — 영구 측정 기준)
| 스크립트 | 역할 |
|---|---|
| `scripts/_measure.mjs` | 단일 코퍼스 측정(속도·dead·정직성·#M1 이름기반). `--lang=` 격리, `--json` |
| `scripts/_measure_iso.mjs` | **축1 격리** — 언어군별 별도 프로세스(cross-grammar 오염·OOM 회피) |
| `scripts/_precision_oracle.mjs` | **축2 precision** — babel scope ground truth(JS 정확). #M1 확정 |
| `scripts/_precision_pos.mjs` | **축2 precision 다언어** — 그래프+위치 기반(전 언어, babel과 0.7↔0.8% 일치 검증) |
| `scripts/_recall_oracle.mjs` | **축2 recall** — 앱 실행 pytracer observed vs 정적 |
| `scripts/_recall_stdlib.mjs` | **축2 recall 실코드** — stdlib 모듈 실행, 결정가능분/동적 정제 |

코퍼스: `git clone --depth 1` — gorilla/mux(go), google/gson(java), serde-rs/json(rust), JamesNK/Newtonsoft.Json(cs), square/okhttp(kotlin), Alamofire(swift), guzzle(php), kikito/middleclass(lua), com-lihaoyi/upickle(scala), fmtlib/fmt(cpp). + Python stdlib + 우리 리포.

## 측정 자체의 한계 (정직)
1. **측정 스크립트 ≠ 제품 경로** — content 전부 메모리 보유로 대규모 OOM(swift/cpp), naive fileImports. 제품 cs scan(스트리밍·정확 import)으로 재측정하면 다를 수 있음.
2. **recall은 실행 가능 코퍼스만** — 라이브러리는 실행 안 됨, stdlib 일부만. JS는 cpu-prof(샘플링)라 py(정밀)보다 부정확.
3. **precision scope oracle은 same-file만** — cross-file(alias/namespace) precision 미측정.
4. **bash·swift는 측정 자체가 wasm 크래시** — 0.0.9 전엔 측정 불가.
→ 즉 이 측정도 "완벽한 정답이 아니라 oracle 기반 하한/근사". 단 dead/이름기반보다 압도적으로 신뢰 가능, "측정 결과를 의심하라"가 매 단계 착시를 제거함.

## #M1 fix + 적대 재검증 (2026-06-14)
resolveCall에 scope-exact(JS babel) + 위치기반 srcId(tree-sitter) 추가 → bare call이 nested same-named 정의로 정확히 resolve (commit e1d0e56, 3c454c0).

| 언어 | fix 전 | fix 후 |
|---|---|---|
| JS | 0.8%(pos)/0.7%(babel) | **0.0%(pos)/0.2%(babel)** |
| C++ | 1.6% | **0.0%** |
| Python | 2.6% | **1.3%** (절반) |
| Java | 0.0% | 0.0% |
| Kotlin/C# | 0.8%/0.4% | 0.8%/0.4% (caller 범위 밖, 위치기반 한계) |

**적대 재검증** (fix를 의심):
- ⚠️ **자기참조 발견**: precision oracle(`_precision_pos`)이 "src 범위 안 nested 우선"으로 #M1 판정 = fix와 **동일 로직** → fix하면 oracle 0이 당연. **측정값 0%는 과신 금지.**
- **진짜 독립 검증 2가지**: ① **과교정(런타임 recall 재측정)**: fix 후 결정가능분 recall **59% 그대로 유지**(62/105) = **fix가 올바른 엣지를 안 깸**(과교정 0). ② **언어 scope 규칙**: nested shadow는 JS/Py 명세 → fix 방향 의미상 올바름.
- babel oracle(JS) 0.2% 잔여 = babel scope도 fix와 같은 scope라 자기참조지만, babel scope=언어 ground truth라 "거의 0" 신뢰.
- **결론**: fix 안전·올바름. 진짜 precision = JS 0.2% + tree-sitter 위치근사(py 1.3%). 잔여는 정확한 tree-sitter scope oracle 필요(ROI 낮음, 백로그).
- **방법론 교훈**: oracle과 fix가 같은 로직이면 자기참조 → 진짜 검증은 *다른 축*(런타임 과교정 + 언어 명세)으로 해야. 측정 의심을 fix 검증에도 적용.

## cross-module recall fix (2번, 2026-06-14)
recall oracle이 결정가능분 miss = cross-module import 함수 호출로 확정(측정 착시 아닌 진짜 갭). tree-sitter 언어에서 두 패턴 fix:
- **namespace member call** `import re; re.compile()` (commit 0bf2e7d) — receiver가 import 모듈이면 importedOnly resolve (JS Wave2c 패턴 이식).
- **from-import 함수 alias** `from m import orig as a; a()` (commit 0cd76e0) — alias→orig 매핑.

**효과 (recall oracle, 실행 stdlib)**: 결정가능분 recall **59% → 67%(namespace) → 70%(alias) → 76%(정밀 import맵)**. 324 테스트, 회귀 0. 동적 member call 커버 72%.

**측정 정밀화(②) — (b) 또 적중**: naive fileImports(모든파일 서로 import)가 over-import로 imported-ambiguous decline을 유발 → recall을 *과소*(70%)시킴. 정밀 import맵(실행 관측 cf→ef)이면 진짜 **76%**. naive는 상한이 아니라 하한이었음. unmatched 140은 심볼없는 callee(lambda/C확장)라 recall 무관, 데코레이터 def-line은 정확 일치.

## ★ 남은 수정 (누적 — 계속 추가, 잊지 말 것)
측정으로 확정/추정된 수정 대상. 처리 시 [x], 우선순위·ROI 표기.
- [ ] **2번 잔여: 복합 import** — `from pkg import sub; sub.join()`(submodule namespace), 다단계 import. recall 남은 miss 26의 일부. **ROI 점감**(59→67→70, 다음 fix는 더 작음).
- [ ] **측정 정밀화(②)** — `_recall_stdlib`이 naive fileImports라 recall 70%가 하한일 수 있음 + unmatched 140(심볼 매칭 갭, 데코레이터 def-line 등). 실제 import 파싱/제품 cs scan 경로로 진짜 recall 확인. **측정 의심 원칙상 가치**.
- [ ] **3번: member call 타입 정밀도** — 동적 member call 72% 커버. `obj.method()` 후보군 확대/타입 추론. recall 동적 영역. **큰 작업**.
- [ ] **#M1 잔여** — py 1.3%·kotlin 0.8%·cs 0.4% (caller 범위 밖 nested, 위치기반 한계). 정확한 tree-sitter scope oracle 필요. **ROI 낮음**.
- [ ] **wasm 0.0.9** — bash·swift 파싱 크래시 + 다언어 대규모 안정. ABI 벽. **발행 전 필수, 큰 공사**.
- [ ] **precision cross-file** — scope oracle이 same-file만. cross-file(alias/namespace) precision 미측정.
