# 3분 데모 대본 (`demo` 시나리오, Base Sepolia 녹화)

심사는 현장 없이 영상, README, 온체인 증빙으로만 한다. 이 문서는 Base Sepolia 녹화 1회를 3분 안의 영상으로 만드는 대본이다. 장면표, 내레이션, 캡션([`demo-captions.srt`](demo-captions.srt)), 촬영 목록, 녹화 런북이 들어 있다.

- 영상 규칙(주최 측 브리핑): 3분 이하, 실제로 돌아가는 모습, 조건이 바뀔 때 무슨 일이 생기는지. Challenge B는 범위 안 1회(허락)와 범위 밖 2회 이상을 보여 줘야 하고, 범위 밖 시도는 매번 멈추고 기록되어야 한다. 조용히 넘어가면 안 된다.
- 녹화 1회 = `demo` 시나리오 1회 = **새 금고** 1개 = 기록 묶음 1개. 대시보드 명령이 금고를 새로 배포하고 세션을 끝(환불)까지 스스로 돌린다(`src/server.ts`: `bootSession` 뒤 `run()`).
- 기준 run은 첫 공개 run `runs/0xA8CEef09a629Cc5c1BB30E82b007Ed1Df8Ee7415/`이다(2026-09-29, 속도 3, Kiln 12회 $0.000844, `AUDIT PASS`). 아래 시각은 이 run의 `events.jsonl`·`kiln.jsonl` 실측값이다. 새 녹화에서는 몇 초씩 달라지므로, 편집은 시각이 아니라 장면표의 "편집 기준 신호"(화면 변화)를 보고 자른다.
- **t0** = 세션 첫 tx(INFERENCE hold `open`)의 intent 시각. 화면에서는 t0+2.4초에 첫 장부 줄 `open ✓ OK`가 뜬다. t0 전 약 50초는 배포 구간이다(준비 tx 11개, 첫 준비 tx 블록이 t0−48초). 편집에서 통째로 뺀다.
- 속도 3: 실제 1초 = 시뮬레이션 3분이라 hold 1시간분이 20초에 준다. 세션은 t0부터 `refund`까지 약 170초다. 1x가 아닌 구간에는 모두 배지(`2x`, `4x`, `8x`, `✂ n초`, `정지 화면`)를 단다.
- 대본 개입(범위 확대 rationale, 실행 로그 주입 한 줄, 탈취 키, 창업자 STOP)은 README §10 표에 전부 공개되어 있다. 영상에서도 해당 장면의 라벨과 캡션에 `대본 개입 / scripted`를 붙인다.

## 1. Challenge B 요구와 장면

| 요구 | 장면 | 화면 증거 |
|---|---|---|
| 범위 안 1회: 허락되고 실행됨 | 3 `RUN` (작업 2·3의 open도 5·8에서 같은 흐름) | 카드 `✓ 10/10 PASS` → `✓ approve` → `✓ APPROVED_ONCHAIN`, 장부 `open ✓ OK`, hold 탱크가 줄고 `settle ✓ OK #1`(t0+39, 장면 4 첫머리) |
| 범위 밖 #1: 목적 밖 충전 | 4 `PUSH #1` | 규칙 10개 통과 → CFO Qwen `✕ deny` → `✕ DENIED_RECORDED`, code `QWEN_DENIED` |
| 범위 밖 #2: 허용 안 된 벤더 | 6 `PUSH #2` | 게이트 칩 `✕ VENDOR_NOT_ALLOWED` 외 2개, `F2 호출 0회` → `✕ DENIED_RECORDED` |
| 범위 밖 #3: 탈취 키로 금고 직접 호출 | 7 `PUSH #3` | 장부 빨간 줄 `open 탈취 키 ✕ DENIED VENDOR_NOT_ALLOWED`, `topUp 탈취 키 ✕ DENIED OVER_MAX_HOLD` |
| 범위 밖 #4: 수수료 포함 예산 초과 (두 번째 Base Sepolia 금고) | 14 `PUSH #4` | Blockscout `Denied`, code `OVER_BUDGET_WITH_FEE`, F2 0회 |
| 창업자 정지 | 9 `STOP` | `SENDING → PAUSED_ON_CHAIN → HALTING → HALTED`, `setPaused`, founder 정산·환불 |
| 멈출 때마다 기록 | 10~13 `EVIDENCE` | Blockscout의 `rec` = 기록 파일 이름의 해시 → 감사 PASS → 1바이트 변조 FAIL |

범위 밖 번호는 녹화에서 일어나는 순서다(범위 확대 sim 45분, 로그 주입 200분, 탈취 키 260분). README "조건이 바뀔 때" 표는 ① 허용 안 된 벤더, ② 목적 밖 충전 순서라 #1·#2가 뒤바뀌어 있다. 영상은 시간 순서를 바꿀 수 없으니, 맞추려면 README 두 행의 순서를 바꾼다(미정).

영상 밖: 벤더 이동(`migrate`), NaN, loss 정체(`plateau`)는 README §10 표와 anvil 테스트(`test/session.test.ts`)로 보여 준다. 기한 경과(`PAST_DEADLINE`)는 공개 체인에서 돌리지 않았다(README §7 2c).

## 2. 장면표 (합계 2:44)

| # | 영상 | 길이 | 화면 라벨 | 소스 (t0 기준) · 속도 | 편집 기준 신호 (화면) |
|---|---|---|---|---|---|
| 1 | 0:00–0:12 | 12초 | `CFO Agent · Challenge B: Controls & records` | README 머리글 (촬영 H) + 가로형 흐름도 (촬영 I) · 1x | – |
| 2 | 0:12–0:20 | 8초 | `SCOPE` 창업자가 정한 범위 | `기본 보기` GRANT: t0−1 → t0+3 1x (4초) + 마지막 프레임 `정지 화면` 4초 | 시작: 벤더 A/B/C가 `✓ 허용`(첫 체인 스냅샷, t0 직전), purpose가 보임. 끝: 4초 뒤 `영상 모드`를 누르기 직전. 예산 막대의 `열린 hold $0.05`는 다음 스냅샷(기준 run에서 t0+5초쯤)에야 뜨니 기다리지 않는다 |
| 3 | 0:20–0:36 | 16초 | `RUN` 범위 안 → 허락 | 영상 모드. t0+4 → t0+14 1x (10초), t0+14 → t0+38 `4x` (6초) | 카드 `…-r2 · open · job (신규)`: F1 `B · h100 · $…` → `✓ 10/10 PASS` → `✓ approve` → `✓ APPROVED_ONCHAIN`, 장부 `open ✓ OK`. 4x 구간: 작업 #1 탱크가 40% 선 아래로, 새 카드 `topUp · job #1`(`F1 요청 생성 중…`, t0+31쯤). 끝: 그 카드의 F1 결과가 뜨기 직전 |
| 4 | 0:36–0:54 | 18초 | `PUSH #1` 범위 밖: 목적 밖 충전 → CFO Qwen 거절 → 기록 · `대본 개입` | t0+38 → t0+46 1x (8초), t0+46 → t0+58 `4x` (3초), t0+58 → t0+65 1x (7초) | 장부 첫 `settle ✓ OK #1`(t0+39) → F1 rationale "…pretraining a new 7B base model…" → `✓ 10/10 PASS` → `✕ deny` + 사유 + `명세 purpose` → (`tx 전송·확정 대기…`, 4x) → `✕ DENIED_RECORDED`, code `QWEN_DENIED`, 장부 `recordDecision ✓ OK QWEN_DENIED #1` |
| 5 | 0:54–1:00 | 6초 | `RUN` 작업 2 → 허락 | t0+65 → t0+89 `4x` (6초) | 작업 #1의 마지막 `settle ✓ OK #1`(작업 #1은 `HOLD_EXHAUSTED`, close는 t0+91로 장면 6 첫머리), 카드 `…-r4 · open` → `✓ APPROVED_ONCHAIN`, 작업 #2 RUNNING. 끝: 카드 `topUp · job #2`가 뜸 |
| 6 | 1:00–1:14 | 14초 | `PUSH #2` 범위 밖: 허용 안 된 벤더 → 코드 게이트 거절 (CFO Qwen 0회) → 기록 · `대본 개입` | t0+89 → t0+97 1x (8초), t0+97 → t0+105 `4x` (2초), t0+105 → t0+109 1x (4초) | F1 `0xBADb…BAD0 · h200 · $…` → 칩 `✕ VENDOR_NOT_ALLOWED` `✕ GPU_TYPE_NOT_ALLOWED` `✕ NO_CAPACITY`, `✕ 3건 위반 → 거절`, `F2 호출 0회 (게이트에서 차단)` → `✕ DENIED_RECORDED`, code `VENDOR_NOT_ALLOWED` |
| 7 | 1:14–1:22 | 8초 | `PUSH #3` 범위 밖: 탈취 키 → 컨트랙트 Denied (체인) · `대본 개입` | t0+109 → t0+113 `2x` (2초), t0+113 → t0+119 1x (6초) | 장부 맨 위 빨간 줄 2개: `open 탈취 키 ✕ DENIED VENDOR_NOT_ALLOWED`, `topUp 탈취 키 ✕ DENIED OVER_MAX_HOLD #0`. 예산 막대는 그대로 |
| 8 | 1:22–1:25 | 3초 | `RUN` 작업 3 → 허락 | t0+119 → t0+131 `4x` (3초) | 카드 `…-r6 · open` → `✓ APPROVED_ONCHAIN`(t0+130.4 확정) |
| 9 | 1:25–1:39 | 14초 | `STOP` 창업자 정지 → 정산·환불 · `대본 개입` | t0+131 → t0+137 1x (6초), t0+137 → t0+169 `8x` (4초), t0+169 → t0+173 1x (4초) | 정지 단계 `● SENDING` → `● PAUSED_ON_CHAIN` → `● HALTED`(작업 3 사용량이 0이면 `HALTING`은 같은 순간에 지나가 `✓`로만 보인다), 장부 `setPaused ✓ OK` → (8x) `close #3`, `settle #0`, `close #0` → `refund ✓ OK`(t0+170) |
| 10 | 1:39–1:51 | 12초 | `EVIDENCE` 체인: Blockscout | 촬영 B · 1x | `called recordDecision on AgentBudgetVault` → Logs의 `Denied(uint256 indexed jobId, bytes32 indexed code, bytes32 indexed rec, bool enforced)`, `enforced false` → Topics [2]를 `Hex`에서 `Text`로 = `QWEN_DENIED`, [3] = rec |
| 11 | 1:51–1:59 | 8초 | `EVIDENCE` 기록 파일 | 촬영 C · 1x | 파일 이름 `0000xx-0x<rec>.json` = Topics [3]의 해시, rationale, `gate: []`, `f2_calls: 1`, `QWEN_DENIED`, `f1.rationale by scenario:demo` |
| 12 | 1:59–2:09 | 10초 | `EVIDENCE` 제3자 감사 PASS | 촬영 D · 1x, 출력 전 대기 `✂ 약 18초` | `[PASS] check 1 … anchored up to #21 / 22`(기준 run), `[WARN] … UNRECORDED_ATTEMPT` 2줄, `AUDIT PASS (exit 0)` |
| 13 | 2:09–2:21 | 12초 | `EVIDENCE` 1바이트 변조 → FAIL | 촬영 E · 1x, 출력 전 대기 `✂ 약 17초` | `wc -l`이 `1` → `[FAIL] check 1 (records)` 3줄 → `AUDIT FAIL (exit 1)` |
| 14 | 2:21–2:26 | 5초 | `PUSH #4` 두 번째 금고: 수수료 포함 예산 초과 → 게이트 거절 → 기록 | 촬영 F · 1x | Topics [2] `Text` = `OVER_BUDGET_WITH_FEE`, `enforced false` |
| 15 | 2:26–2:38 | 12초 | `COST` 토큰·비용·에너지 | 촬영 G · 1x (스크롤) | §1b 흐름별 표 → §4 `reconciliation MATCH` → §5b 게이트 절감 → §5c `/no_think` 346 → 66 |
| 16 | 2:38–2:44 | 6초 | `VERIFY` 직접 확인 | 촬영 H · 1x | README "온체인 증빙" 표: 금고 주소, 감사 명령 |

**합계 164초 = 2:44** (목표 2:50 이하, 3:00까지 16초 여유). 장면 2~9의 라이브 구간은 t0−1 → t0+173(174초)을 87초로 줄였다. 배포 구간 말고는 자르지 않고 속도만 바꾼다(예외: 장면 2의 정지 화면 4초).

녹화가 기준 run과 다르게 흘러갈 때:
- **A (기대값).** 작업 1의 첫 충전 요청이 곧 범위 확대다. 공개 RPC(`https://sepolia.base.org`, `.env`에 `RPC_URL`이 없으면 이것)에서는 체인 읽기와 tx 확정이 느려서, 첫 충전의 F1이 작업 시작 뒤 약 25~28초(시뮬 약 76~83분)에 시작한다. 그 전에 sim 45분의 rationale 교체가 걸린다. demo run은 25.5초(시뮬 76분)였고, budget run(rationale 교체 없음)도 첫 충전 F1이 27.6초(시뮬 83분)에 시작했다.
- **B (빠른 RPC나 anvil).** 첫 충전이 그대로 승인되고(`topUp ✓ APPROVED_ONCHAIN`), 범위 확대는 약 20초 뒤 다음 충전에 걸린다. 2026-09-29 anvil·stub 리허설이 이 순서였다. 그러면 승인된 충전 4초를 장면 3에 1x로 넣고(범위 안 두 번째 예), 장면 5·8을 `8x`로 줄여 합계를 맞춘다.
- **STOP 때 작업 3에 사용량이 있으면** agent의 `settle`이 `✕ DENIED PAUSED`(빨간 줄)로 하나 더 남는다. 기준 run에서는 작업 3을 연 직후 STOP이 걸려 사용량이 0이었고, 이 줄도 없었다. 탈취 키 공격이 대기 중인 tx를 모두 기다리는 동안 루프가 밀려서 sim 270분 open과 300분 STOP이 이어서 실행되었기 때문이다. 화면에 이 줄이 있을 때만 말한다.

## 3. 장면별 내레이션

한국어 내레이션, 초당 약 6음절. 괄호 속 숫자는 장면 길이다.

| # | 말할 것 |
|---|---|
| 1 (12초) | "AI 에이전트가 GPU를 빌립니다. 결제 기록엔 누가 왜 허락했는지가 없습니다. CFO Agent는 작업별 에스크로로 충전하고, 허락과 거절을 모두 기록합니다." |
| 2 (8초) | "창업자가 정한 범위. 명세는 Llama 8B LoRA 파인튜닝, H100만. 벤더 셋, hold 상한 6달러, 예산 20달러." |
| 3 (16초) | "범위 안의 요청부터. 작업 에이전트가 벤더 B의 H100을 Akash 실제 가격으로 요청합니다. 규칙 10개 통과, CFO Qwen 승인, 체인에 hold가 열립니다. 작업이 도는 동안 사용분과 수수료 3%가 정산됩니다." |
| 4 (18초) | "이제 조건을 바꿉니다. 충전 근거를 대본으로 바꿨습니다. 7B 모델도 처음부터 사전학습하자. 숫자는 멀쩡해서 규칙 10개는 통과합니다. 하지만 CFO Qwen이 서명된 목적과 비교해 거절합니다. 돈은 나가지 않고, 거절 기록의 해시가 체인에 고정됩니다." |
| 5 (6초) | "작업 1은 쓴 만큼 정산됩니다. 두 번째 작업도 같은 검사로 승인됩니다." |
| 6 (14초) | "이번엔 실행 로그에 악성 한 줄을 넣었습니다. 속은 에이전트가 목록에 없는 벤더와 H200을 요청합니다. 코드 게이트가 먼저 막아서 CFO Qwen은 불리지도 않고, 거절은 역시 기록됩니다." |
| 7 (8초) | "훔친 에이전트 키로 백엔드를 건너뛰고 금고를 부릅니다. 컨트랙트가 Denied로 답하고, 돈은 그대로입니다." |
| 8 (3초) | "숫자는 코드, 목적은 Qwen, 강제는 컨트랙트." |
| 9 (14초) | "창업자가 STOP을 보냅니다. 금고가 체인에서 멈추고, 이후 정산은 창업자 키로만 합니다. 작업을 닫고 Kiln 비용을 정산하고 남은 예산을 환불합니다. 멈춤도 기록으로 남습니다." |
| 10 (12초) | "이제 증거입니다. Blockscout에서 거절 tx를 열면 Denied 이벤트가 디코딩되어 있습니다. code를 텍스트로 바꾸면 QWEN_DENIED, rec는 기록 파일의 해시입니다." |
| 11 (8초) | "그 해시가 기록 파일 이름입니다. 요청, 게이트, Qwen의 사유, 대본 개입까지 들어 있습니다." |
| 12 (10초) | "제3자는 이 기록 묶음과 공개 RPC만으로 다시 판정합니다. PASS. 기록 없는 탈취 키 시도는 따로 경고로 나옵니다." |
| 13 (12초) | "기록 한 파일에서 7B를 1B로, 1바이트만 바꿉니다. 해시 체인이 끊겨 FAIL입니다." |
| 14 (5초) | "두 번째 금고: 수수료 포함 예산 초과, 게이트 거절, 기록." |
| 15 (12초) | "모든 Kiln 호출이 흐름별 토큰, 비용, 에너지로 남습니다. Kiln 비용은 체인 정산액과 맞고, /no_think로 출력 토큰을 346에서 66으로 줄였습니다." |
| 16 (6초) | "금고 주소와 tx, 감사 명령은 README에 있습니다. 직접 확인해 보세요." |

- 장면 4의 7B 문장은 `src/scenarios.ts`의 `SCOPE_CREEP_RATIONALE`이다. 장면 6의 주입 줄은 `INJECTION_LINE`이다.
- 장면 6의 "Qwen 0회"는 CFO Qwen(F2)만 센다. 속은 요청을 쓴 작업 에이전트(F1)도 Qwen3-32B라서 Kiln 호출은 1회 있다(기준 run `r5`: F1 1, F2 0). 그래서 "Qwen 0회"가 아니라 "CFO Qwen 0회"라고 말한다.
- 음절 수는 영어 약어를 읽는 소리로 셌다(`CFO` 3, `GPU` 3, `H100` 4). 장면 4(약 107음절), 8(약 18음절), 10(약 68음절)은 장면 길이에 거의 꽉 찬다.
- 장면 15의 346 → 66은 `runs/eval/nothink.jsonl`의 켬/끔 비교(각 3회, 오프라인)다. `report.md` §5c에 그대로 나온다.
- 장면 9의 STOP은 대본(sim 300분, `founderStop`, 사유 `MANUAL`)이다. 사람이 버튼을 누르지 않는다(§7 본 녹화 6).

## 4. 화면 (`?video=1`, 1280×720)

2026-09-29 anvil·stub 리허설에서 1280×720 스크린샷으로 확인했다.

- 영상 모드는 한 화면에 스크롤 없이 들어간다. 위에서부터:
  - 머리줄: `CFO Agent`, run id, 금고 주소(줄임), sync, 배지 `LLM KILN`(초록), `PRICE LIVE`, `SCENARIO demo`, `pending tx n`, `기본 보기` 버튼. 둘째 줄은 STOP 버튼 3개, `정산·환불`, 정지 단계.
  - 예산 줄: 예산 $20.00과 막대(지급, 수수료 3%, 추론비(Kiln), 열린 hold, 환불 가능).
  - 최신 충전 카드 1장: `1 F1 요청` → `2 GATE 10규칙` → `3 F2 판정` → `4 CHAIN 결과`. 진행 중인 단계에 파란 테두리.
  - 왼쪽 아래 작업 표(작업, 상태, hold 탱크와 40% 충전선). INFERENCE 행은 맨 위에 고정되고, 닫힌 작업 행은 숨는다(CSS는 "닫히지 않은 행이 있으면"인데 INFERENCE 행이 늘 그 조건을 채운다). 작업 #1이 `HOLD_EXHAUSTED`인 채 작업 #2가 열린 동안(기준 run t0+78 → t0+91)은 행이 3개라 표 아래 빈 곳이 없다.
  - 오른쪽 아래 EVIDENCE: 장부 최신 6줄(시각, fn, 상태, code, job, tx). 최신 줄이 맨 위.
- 영상 모드에서 숨는 것: 서명된 명세와 벤더 표(그래서 장면 2는 `기본 보기`로 찍는다), 영수증, latch·금액 열, rec 열, 이전 카드들. 1280×720 `기본 보기`에서는 GRANT 구역(purpose, 허용 GPU, job cap, 기한, maxHold, 예산, 벤더 A/B/C와 Akash 가격, `✓ 허용`)이 첫 화면에 다 들어간다.
- 세션 시작 직후 몇 초 동안 벤더가 `✕ 차단`, 가격이 `$0`으로 보인다. 첫 체인 스냅샷과 가격을 읽기 전이라서다. 이 구간은 쓰지 않는다.
- `recordDecision` 줄은 `✓ OK`에 code(`QWEN_DENIED`, `VENDOR_NOT_ALLOWED`)가 붙어 나온다. tx 자체는 성공했고, 그 안의 `Denied(enforced=false)` 이벤트가 거절 기록을 체인에 고정한다. 빨간 `✕ DENIED` 줄은 컨트랙트가 직접 거절한 tx다(탈취 키, 또는 정지 뒤 agent `settle`).
- 거절 카드는 `4 CHAIN 결과`에서 12~19초 기다린다(기준 run: 범위 확대 19초, 로그 주입 12초). 모든 tx가 대기열 하나(Committer)를 차례로 지나고 각 tx가 영수증을 기다리기 때문이다(Base Sepolia에서 tx 하나에 2~13초). 이 대기를 4x로 줄인다. F1·F2 자체는 1~2.5초다(기준 run p50/p95).
- 장부와 카드의 tx 링크는 Basescan으로 간다. 소스 검증은 Blockscout·Sourcify에 했고(두 금고 모두 Sourcify `exact_match`) Basescan은 이 금고의 로그를 디코딩해 보여 주지 않으므로, 디코딩된 이벤트는 Blockscout에서 연다(§8 명령 (1)이 링크를 만든다).

## 5. 편집 규칙

- 캡션: [`demo-captions.srt`](demo-captions.srt) 32개 cue, 위 줄 영어, 아래 줄 한국어, 장면표 시각에 맞췄다. tx 해시나 비용처럼 run마다 달라지는 값은 넣지 않았다. 편집에서 장면 길이가 바뀌면 그 장면의 cue를 같이 옮긴다.
- 화면 라벨(`RUN`, `PUSH #1 · 대본 개입`처럼 장면표 라벨 열의 앞부분만)과 속도 배지는 대시보드 장면(3~9)에서 EVIDENCE 제목 줄의 오른쪽 빈 곳에 둔다. 영상 모드에서 그 줄은 `EVIDENCE` 뒤가 늘 비어 있다. 작업 표 아래는 쓰지 않는다: 행이 3개인 동안(장면 5) 비지 않고, 맨 아래 2줄 캡션과 겹친다. 장면 2와 10~16은 캡션과 겹치지 않는 위쪽 빈 곳에 둔다. 머리줄(금고 주소, `LLM KILN` 배지)과 카드는 가리지 않는다. 캡션은 맨 아래 가운데에 두고, 오래된 장부 줄 한두 개는 가려도 된다.
- 1x가 아닌 구간에는 모두 배지를 단다. `2x`·`4x`·`8x`는 속도 변경, `✂ 18초`는 화면 변화 없는 대기를 잘라낸 곳, `정지 화면`은 한 프레임을 멈춘 곳이다.
- `대본 개입 / scripted`: 장면 4, 6, 7, 9의 라벨과 캡션에 붙인다.
- 터미널 장면(11~13)은 `clear` 뒤에 실행해서 출력이 화면 위쪽에 오게 한다. 캡션이 맨 아래를 가린다.

## 6. 촬영 목록

| 촬영 | 무엇 | 언제 | 창 | 장면 |
|---|---|---|---|---|
| A. 본 녹화 | 대시보드를 이어서 한 번에: `기본 보기` GRANT → `영상 모드` → `refund ✓ OK` 뒤 5초 | 녹화 당일, 명령 실행부터 | 브라우저 뷰포트 1280×720 | 2~9 |
| B. Blockscout: 범위 밖 #1 tx | Logs 탭, 디코딩된 `Denied`, Topics [2] `Hex` → `Text` | A 직후 | 같은 브라우저 1280×720 | 10 |
| C. 터미널: 기록 파일 | §8 명령 (2) | A 직후 | 터미널 1280×720, 글꼴 16pt 이상 | 11 |
| D. 터미널: 감사 PASS | §8 명령 (3) | C 다음 | 같은 터미널 | 12 |
| E. 터미널: 1바이트 변조 FAIL | §8 명령 (4) | D 다음 | 같은 터미널 | 13 |
| F. Blockscout: budget run tx | `0x205f73a2…` Logs, Topics [2] `Text` | 언제든 (고정 URL) | 브라우저 1280×720 | 14 |
| G. report.md | `runs/<vault>/report.md` Markdown 미리보기, §1b → §4 → §5b → §5c | A 뒤 | 편집기 1280×720 | 15 |
| H. README | 머리글, "온체인 증빙" 표 | 언제든 | 브라우저(GitHub)나 편집기 미리보기 1280×720 | 1, 16 |
| I. 가로형 흐름도 | `diagrams/cfo-agent-escrow-topup-lr.png`(1950×631)를 화면 폭에 맞춰. 가로형은 1280 폭에서 글자가 약 12px이다. README §4의 세로형 PNG(1950×3112)는 720 높이에 맞추면 글자가 약 8px라 읽히지 않는다 | 언제든 | 이미지 뷰어 1280×720 | 1 |

## 7. 녹화 런북

### T-60 사전 점검

1. Foundry와 테스트. Foundry는 `~/.foundry/bin`에 있고 새 셸의 PATH에는 없다.
   ```sh
   export PATH="$HOME/.foundry/bin:$PATH"
   forge --version && cast --version
   forge test && npm test      # 2026-09-29: forge test 38 pass, npm test 282 pass, 0 fail, 0 skipped (약 104초)
   ```
   `npm test`의 skipped가 0보다 크면 anvil을 못 찾은 것이다(PATH 확인).
2. founder ETH가 0.0021 이상인지 본다. 주소는 공개값이라 키가 필요 없다.
   ```sh
   cast balance 0x87e3866c97b7aE307b9d030581111D076AAaDB58 --ether --rpc-url https://sepolia.base.org
   ```
   배포는 새 agent에게 가스 0.0015 ETH(바닥값 0.0005 × 3)를 보내고 준비 tx 11개를 보낸다. preflight는 배포 뒤 founder와 agent가 각각 0.0005 ETH 이상이어야 통과하고, preflight 실패는 배포 tx를 다 보낸 뒤에야 난다. 금고 하나에 약 0.0015 ETH라서 2026-09-29 잔액 0.00696 ETH면 새 금고 4개까지 된다. 0.0021 미만이면 새 금고를 만들기 전에 faucet으로 충전한다.
3. `.env`는 열지 않고, 값이 있는지만 본다(값은 출력하지 않는다).
   ```sh
   node --env-file=.env -e 'for (const k of ["FOUNDER_PK", "KILN_API_KEY", "RPC_URL"]) console.log(k, process.env[k] ? "set" : "MISSING")'
   ```
   `FOUNDER_PK`, `KILN_API_KEY`는 `set`이어야 한다. `RPC_URL`이 `MISSING`이면 공개 RPC `https://sepolia.base.org`를 쓴다(기준 run 두 개도 이것). `.env`에 `LLM_MODE`가 없으므로 명령 앞에 `LLM_MODE=kiln`을 꼭 붙인다. 셸 값이 `--env-file`보다 우선한다.
4. Kiln. `LLM_MODE=kiln npm run smoke:kiln`이 예열이다(Kiln 5회: F1, F2, 주입 F1 2회, F3. 모두 HTTP 200, 지연 10초 미만, 파싱 성공을 눈으로 본다). `.env`에 `LLM_MODE`가 없어서 앞에 붙이지 않으면 호출 없이 `LLM_MODE must be "kiln" or "stub"`으로 끝난다. 이 스크립트는 추적 중인 `test/fixtures/kiln/*.json`을 새 응답으로 덮어쓰고 `runs/eval/kiln.jsonl`에 줄을 더하므로, 끝나면 `git checkout -- test/fixtures/kiln runs/eval/kiln.jsonl`로 되돌린다. 공유 키(60 RPM)이므로 팀에 "HH:MM~HH:MM Kiln 사용 중지"를 공지한다. 본 녹화는 약 4분이고, 증거 촬영에는 Kiln을 쓰지 않는다. `LLM_MODE=kiln npm run eval:f2`(25회)는 프롬프트를 바꾼 경우에만 다시 돌린다(마지막 PASS는 README §9).
5. `npm run check-secrets` PASS, `git check-ignore .env keys/`가 두 줄을 출력한다.
6. 화면: 알림 끄기(집중 모드). `.env`, `keys/`, 셸 기록이 보이는 터미널은 닫는다. 감사용 터미널은 새 창으로 열고 글꼴을 16pt 이상으로 한다.
7. 가격: 녹화 때 배지가 `PRICE LIVE`인지 본다. `PRICE SNAPSHOT:<사유>`면 커밋된 `prices/akash-snapshot.json` 가격을 쓴 것이다. 녹화는 계속하고 README에 적는다. 오늘 LIVE 가격은 A $2.04, B $2.56, C $3.16이었다(녹화 시점에 다를 수 있다).
8. (선택) 새 clone에서 기존 번들 재현: `git -c core.autocrlf=true clone` → `npm ci` → `npm run audit -- runs/0xA8CEef09a629Cc5c1BB30E82b007Ed1Df8Ee7415 --submission`이 PASS.

### T-5

1. 포트 8787이 비어 있다: `lsof -nP -iTCP:8787 -sTCP:LISTEN`의 출력이 없다.
2. founder에게 대기 중인 tx가 없다: `cast nonce 0x87e3866c97b7aE307b9d030581111D076AAaDB58 --block pending --rpc-url https://sepolia.base.org`와 `--block latest`가 같다.
3. Kiln 예열(마지막 smoke가 10분이 넘었으면 `LLM_MODE=kiln npm run smoke:kiln` 한 번, 뒤에 fixture 되돌리기), 팀 Kiln 중지 확인.
4. 감사용 터미널은 repo에서 `clear`. 브라우저에는 Blockscout 탭(`https://base-sepolia.blockscout.com`)을 준비한다.
5. 판단 규칙: 빨간 표시가 15분 안에 회복되지 않으면 그때까지 가장 좋은 take를 쓴다.

### 본 녹화 (촬영 A)

1. 대시보드 터미널(화면 밖)에서 실행한다.
   ```sh
   LLM_MODE=kiln npm run dashboard -- --scenario demo --chain base-sepolia
   ```
   출력 순서: `dashboard    http://127.0.0.1:8787/` → `deploying a fresh vault for scenario "demo" on base-sepolia (<RPC URL>) ...` → 준비 tx 해시 11개 → `vault 0x… agent 0x… deployBlock N`. 개인 키는 찍히지 않지만 RPC URL은 찍힌다. `RPC_URL`에 API 키가 든 URL을 넣었다면 이 터미널은 화면에 넣지 않는다. 서버는 배포 전에 먼저 뜨고, 배포는 약 50초 걸린다.
2. `dashboard …` 줄이 뜨면 브라우저를 연다. 뷰포트는 1280×720이어야 한다. Chrome이면 깨끗한 프로필 창 예:
   ```sh
   open -na "Google Chrome" --args --user-data-dir=/tmp/cfo-rec --no-first-run --no-default-browser-check --window-size=1280,800 --app="http://127.0.0.1:8787/?video=1"
   ```
   창 크기에는 제목 줄이 들어가므로, DevTools 콘솔에서 `innerWidth + "x" + innerHeight`가 `1280x720`이 되게 높이를 맞춘다. 1920×1080 전체 화면도 된다. 영상 모드 CSS가 같은 배치를 1.5배로 키운다.
3. 화면 녹화를 시작한다(뷰포트 1280×720 영역). 세션이 시작되기 전까지는 `서버에 연결하는 중…` 배너가 보인다.
4. 머리줄에 run id가 뜨면 `기본 보기`를 누른다. 벤더 A/B/C가 `✓ 허용`으로 바뀌고 purpose가 보이면(첫 체인 스냅샷, t0 직전) 장면 2다. 4초 세고 `영상 모드`를 누른다. 예산 막대의 `열린 hold $0.05`는 다음 스냅샷(기준 run에서 t0+5초쯤)에야 뜨니 기다리지 않는다. 첫 카드의 F1 결과(t0+7초쯤)는 그 뒤에 온다. 늦게 눌러도 끝난 RUN 카드가 t0+27초까지 화면에 남는다.
5. 배지를 확인한다: `LLM KILN`(초록). `LLM STUB`이면 바로 중단한다(제출 감사에서 FAIL).
6. 그 뒤로는 아무것도 누르지 않는다. 모든 장면이 대본(sim 45·170·200·260·270·300분)으로 돈다. STOP을 일찍 누르면 작업 3이 취소되고, 탈취 키 tx가 이미 멈춘 금고를 두드려 `VENDOR_NOT_ALLOWED`·`OVER_MAX_HOLD` 대신 `PAUSED`로 거절된다(컨트랙트는 `PAUSED`를 먼저 검사한다).
7. 끝: 정지 단계 `HALTED`, 장부 맨 위 `refund ✓ OK`, 터미널 `session finished; the dashboard stays up (Ctrl+C to exit)`. 5초 더 찍고 멈춘다. 명령 실행부터 약 3분 50초 걸린다. `runs/<vault>/report.md`는 자동으로 생긴다.

### 증거 촬영 (촬영 B~G, 본 녹화 직후)

1. 화면 밖에서 먼저 감사 PASS를 확인한다: `npm run audit -- runs/<vault> --submission`.
2. 새 금고가 Blockscout에서 소스 검증되었는지 본다.
   ```sh
   curl -s https://base-sepolia.blockscout.com/api/v2/smart-contracts/<vault> | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j={};try{j=JSON.parse(s)}catch{};console.log("verified:",j.is_verified===true,j.is_verified_via_eth_bytecode_db?"(bytecode DB 자동 매칭)":"")})'
   ```
   budget 금고는 Blockscout가 바이트코드 DB(verifier alliance)로 검증했다(세션 끝 약 37초 뒤. 같은 금고의 Sourcify `exact_match`는 세션 중인 01:58:01Z에 먼저 생겼는데, 누가 올렸는지는 레포에 없다). demo 금고는 직접 검증했다. 그래서 새 금고의 자동 검증은 보장되지 않는다. `verified: false`면 몇 분 뒤 다시 본다. 검증이 없어도 Topics의 `Hex` → `Text` 전환은 되지만, 위쪽의 `Denied(…)` 디코딩 표는 안 나온다. 끝내 `false`면 장면 10 내레이션의 "디코딩되어 있습니다"와 cue 22의 "decoded"를 빼고 Topics만 보여 준다.
3. 촬영 B: §8 명령 (1)이 찍은 `recordDecision QWEN_DENIED` 줄의 URL(`…/tx/<hash>?tab=logs`)을 연다. 머리 `called recordDecision on AgentBudgetVault` → Logs의 `Denied(…)` 표(`jobId`, `code`, `rec`, `enforced false`) → 아래 Topics로 스크롤 → [2]의 `Hex`를 `Text`로 바꾸면 `QWEN_DENIED` → [3]이 rec. 기준 run의 같은 화면: `https://base-sepolia.blockscout.com/tx/0xf7846f6e4ec4f98fa93a2ca863105bd608549ad6d4482ac098db9606acbf985f?tab=logs`.
4. 촬영 C·D·E: §8 명령 (2), (3), (4).
5. 촬영 F: `https://base-sepolia.blockscout.com/tx/0x205f73a223356b6da60a736ef471b1990e7c0617c65ae6dfaba4f1069dda066a?tab=logs` → Topics [2] `Text` → `OVER_BUDGET_WITH_FEE`, `enforced false`. 이 거절의 기록은 `runs/0x7C813285C6f9049e21dc10CF9a1367430Ae8dCcb/records/000006-0x34c7c01e….json`이다(F1 1회, F2 0회, 대본 개입 없음). 예산 $5.29에서 INFERENCE $0.05와 작업 1 gross $2.6368을 약정하면 $2.6032가 남는데, net $2.56 충전은 수수료를 더하면 $2.6368이라 넘는다.
6. 촬영 G: `runs/<vault>/report.md`를 편집기 Markdown 미리보기로 열고 §1b → §4 → §5b → §5c로 스크롤한다.

### 이상 시

| 감지 신호 | 자동 동작 | 사람 조치 | 녹화 중이면 |
|---|---|---|---|
| Kiln 429·타임아웃 (카드 `— QWEN_NOT_A_JUDGEMENT`, `기본 보기` health 줄의 errors 증가) | fail-closed 거절, 일시 코드는 job당 1회 재시도. 세션은 스스로 끝난다 | 팀 Kiln 사용 확인 | 그 take는 버리고 새 금고로 다시. **stub으로 바꾸지 않는다** |
| RPC 오류, `STALE` 배너 | 사용량 누적 정지, 버튼 비활성 | RPC 확인 | 10초 넘게 계속되면 take 폐기 |
| ETH 부족 | 기동 거부(preflight `founderEth`·`agentEth`) | faucet으로 충전 | take 폐기 |
| `HALTED · <사유>` 빨간 배너 (`UNCONFIRMED`, `REPLACED`, `SEND_FAILED:…`, `PRESEND_REVERT:…`, 예상 밖 `REVERTED`·`UNEXPECTED`) | Committer 정지(재서명·새 nonce·수수료 인상 없음) | Blockscout에서 tx 확인, `events.jsonl`에서 `req_id` 역추적 → 아래 HALT 절차 | take 폐기 |
| 백엔드 크래시 (터미널 종료) | 복구 없음(금고 1개 = 세션 1개) | 아래 HALT 절차 | take 폐기 |
| Akash 실패 | `SNAPSHOT:<사유>` 가격 사용 | 배지 확인 | 계속 |
| 비밀 유출 의심 | pre-commit 실패 | Kiln 키 폐기·재발급. agent 키면 HALT 절차 → 새 금고 | 중단 |

**HALT 절차.** take가 HALT되거나 백엔드가 죽으면 hold가 잠긴 채 남는다. `scripts/wind-down.ts`가 백엔드 없이 founder 키만으로 정리한다(체인 상태와 `records/`를 읽고, 기록 체인을 이어 붙인다).

```sh
# 0) 녹화를 멈추고 대시보드를 Ctrl+C (HALT된 Committer는 더 보내지 않지만, 보내는 쪽은 하나만 둔다)
# 1) 계획만 본다
npm run wind-down -- runs/<vault> --chain base-sepolia --dry-run
# 2) 실행: setPaused(true) → 열린 job 전부 close → refund. 기록(STOP, CLOSE, SESSION_END)을 이어 붙이고 run.json lastBlock을 고친다
npm run wind-down -- runs/<vault> --chain base-sepolia
#    마지막 CHECKPOINT의 settle이 체인에 안 들어갔으면 --pay-last-checkpoint를 붙인다(출력의 "UNPAID USAGE" 줄 참고)
# 3) founder ETH가 0.0021 이상인지 보고, 새 금고로 다시 녹화한다(대시보드 명령이 새 금고를 배포한다)
```

- 버린 take의 번들(`runs/<vault>/`)은 제출물이 아니다. 커밋하지 않는다.
- 머리줄에 run id가 뜨기 전(배포·preflight)에 실패했다면 `run.json`이 없어서 정리할 것도 없다. MockUSDC는 금고마다 새로 찍으므로 잃는 것은 ETH뿐이다. 바로 새 take를 한다.
- 대시보드 `정산·환불` 버튼은 백엔드가 살아 있을 때의 탈출구다(STOP 뒤, 모든 작업이 STOPPED나 HOLD_EXHAUSTED이고 대기 tx가 0일 때 활성). 백엔드 없이 도는 탈출구는 위 `npm run wind-down`이다.

### 녹화 뒤

1. 감사 PASS를 확인한다(증거 촬영 1).
2. README에 영상 속 금고를 넣는다: "온체인 증빙" 표, §8 표(아래 §9 생성 명령), §9 녹화 세션 수치(`report.md`의 흐름별·결정별·작업별 표). 기존 0xA8CE run을 함께 둘지는 정해야 한다.
3. 새 clone(`git -c core.autocrlf=true clone`)에서 커밋한 새 번들 감사 PASS를 다시 확인한다.
4. 새 번들(`runs/<vault>/`, `deployments/84532-<vault>.json`) 커밋은 사람이 정한다. `keys/`는 커밋하지 않는다(gitignore).

## 8. 증거 장면 명령 (촬영 B~E)

```sh
v=runs/<vault>        # 대시보드 머리줄과 터미널에 찍힌 새 금고 주소

# (1) Blockscout 링크: 체인에 Denied가 남은 tx 전부 (백엔드 recordDecision + 탈취 키)
node -e '
const fs = require("fs"), d = process.argv[1]
const txt = (h) => Buffer.from(String(h).slice(2), "hex").toString().replace(/\0+$/, "")
for (const e of fs.readFileSync(d + "/events.jsonl", "utf8").trim().split("\n").map(JSON.parse)) {
  const den = e.src === "commit" && e.ev === "mined" && (e.events || []).find((x) => x.name === "Denied")
  if (den) console.log(e.fn, txt(den.args.code), "https://base-sepolia.blockscout.com/tx/" + e.txHash + "?tab=logs")
  if (e.src === "scenario" && e.ev === "stolen_key" && e.txHash) console.log("탈취 키 " + e.fn, e.code, "https://base-sepolia.blockscout.com/tx/" + e.txHash + "?tab=logs")
}' $v

# (2) 기록 파일 (장면 11). 파일 이름의 해시 = Blockscout Topics [3]의 rec
f=$(grep -l '"QWEN_DENIED"' $v/records/*.json | head -1); basename "$f"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), b = r.body
console.log(JSON.stringify({ seq: r.seq, type: r.type, req_id: b.req_id, rationale: b.request.rationale, gate: b.gate.codes, f2_calls: b.f2.length, verdict: b.verdict, reason: b.reason, override: b.overrides.map((o) => o.field + " by " + o.by) }, null, 2))' "$f"

# (3) 감사 PASS (장면 12). 공개 RPC로 이벤트를 재생해서 약 18초 걸린다
npm run audit -- $v --submission

# (4) 사본의 기록 1바이트 변조 → FAIL (장면 13, 약 17초)
rm -rf /tmp/tampered && cp -R $v /tmp/tampered
f=$(grep -l "new 7B" /tmp/tampered/records/*.json | head -1)     # 범위 확대 DECISION 기록
perl -pi -e 's/new 7B/new 1B/' "$f"                               # 한 줄짜리 JSON에서 첫 번째만 바뀐다: 1바이트
cmp -l "$f" "$v/records/$(basename "$f")" | wc -l                 # 1
npm run audit -- /tmp/tampered

# (5) 토큰·에너지 표 (장면 15). 세션 끝에 runs/<vault>/report.md로 자동 생성된다. 다시 만들려면:
npm run report -- $v
```

기준 run(0xA8CE) 번들로 2026-09-29에 다시 돌린 결과. (1)은 `recordDecision QWEN_DENIED`, `recordDecision VENDOR_NOT_ALLOWED`, `탈취 키 open VENDOR_NOT_ALLOWED`, `탈취 키 topUp OVER_MAX_HOLD` 네 줄을 찍었다. (2)는 `000005-0x2088d9e4….json`, `override: ["f1.rationale by scenario:demo"]`. (3)과 (4)의 핵심 줄:

```
(3) [PASS] bundle: vault 0xA8CEef09a629Cc5c1BB30E82b007Ed1Df8Ee7415 chain 84532, blocks 47439104..47439209, 2 tx(s) outside the backend
    [PASS] check 1 (records): 22 records, hashes and prev chain intact, anchored up to #21 / 22
    [PASS] check 2 ~ 7 …
    [WARN] check 8 (denials): UNRECORDED_ATTEMPT: Denied (block 47439179, tx 0x049951c5..) sender 0xaca4e630… code VENDOR_NOT_ALLOWED rec 0x97154a62..
    [WARN] check 8 (denials): UNRECORDED_ATTEMPT: Denied (block 47439180, tx 0xe3d03cee..) sender 0xaca4e630… code OVER_MAX_HOLD rec 0x97154a62..
    [WARN] check 8 (denials): DUPLICATE_REC_REF: rec 0x97154a62.. on 2 events: …
    [PASS] check 8 (denials): 4 Denied events, 2 with a record
    [PASS] receipts: 18 backend tx receipts present
    [PASS] submission: no stub Kiln calls in any record
    AUDIT PASS (exit 0) (0 FAIL, 3 WARN, 0 INFO)

(4) [FAIL] check 1 (records): 000005-0x2088d9e4….json: content hash 0xabe1db02… != file name
    [FAIL] check 1 (records): 000006-0x3ed230c1….json: prev 0x2088d9e4…, expected 0xabe1db02…
    [FAIL] check 1 (records): Denied (block 47439153, tx 0xf7846f6e..) from backend carries rec 0x2088d9e4.. that names no record
    AUDIT FAIL (exit 1) (3 FAIL, 3 WARN, 0 INFO)
```

WARN 3건은 설계대로다. 기록 없이 금고를 직접 부른 탈취 키 tx 2건(`UNRECORDED_ATTEMPT`)과, 두 tx가 같은 rec를 쓴 `DUPLICATE_REC_REF` 1건이다.

## 9. README §8 표 생성

준비 tx, 백엔드 tx와 기록 파일, 탈취 키 tx를 순서대로 한 줄씩 찍는다.

```sh
node -e '
const fs = require("fs"), d = process.argv[1], run = JSON.parse(fs.readFileSync(d + "/run.json"))
const recs = Object.fromEntries(fs.readdirSync(d + "/records").map((f) => [f.slice(7, 73), f]))
const tx = (h) => run.chainId === 84532 ? `[${h.slice(0, 10)}…](https://sepolia.basescan.org/tx/${h})` : "`" + h.slice(0, 10) + "…`"
const SETUP = ["MockUSDC deploy", "mint", "AgentBudgetVault deploy", "setVendor A", "setVendor B", "setVendor C", "setVendor INFERENCE", "setMaxHold", "agent gas", "approve", "fund"]
const rows = run.setupTxs.map((h, i) => [SETUP[i] ?? "setup", "founder", tx(h), "deployments/" + run.chainId + "-" + run.vault + ".json", "OK"])
let signer = "-"
for (const e of fs.readFileSync(d + "/events.jsonl", "utf8").trim().split("\n").map(JSON.parse)) {
  if (e.src === "commit" && e.ev === "intent") signer = e.signer
  if (e.src === "commit" && e.ev === "mined") rows.push([e.fn, signer, tx(e.txHash), recs[e.recHash] ? "records/" + recs[e.recHash] : "(기록 없음: tx 해시로 매칭)", e.status + (e.code ? " " + e.code : "")])
  if (e.src === "scenario" && e.ev === "stolen_key") rows.push([e.fn + " (공격)", "탈취된 agent 키", e.txHash ? tx(e.txHash) : "-", "(기록 없음: 감사자 UNRECORDED_ATTEMPT)", e.code ? "Denied " + e.code : e.error ?? "?"])
}
console.log("| # | 함수 | 서명자 | tx | 기록 파일 | 결과 |\n|---|---|---|---|---|---|")
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.join(" | ")} |`))
' runs/<vault>
```

## 10. 역추적

Blockscout tx → Logs의 Topics [3] `rec` → `ls runs/<vault>/records/*<recHash>*` → 기록의 `req_id` → `grep <req_id> runs/<vault>/events.jsonl`.
