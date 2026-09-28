# Kiln token & energy report — demo-eF310273

- Bundle: `0xeF31027350Be2c7439C1b0BE022d49421488b72C` · vault `0xeF31027350Be2c7439C1b0BE022d49421488b72C` · chainId 31337
- Flags: `{"LLM_MODE":"kiln","SCENARIO":"demo","CLOCK":"3","DEADLINE_MARGIN_S":"15","LLM_CALL_CAP":"60"}`
- Sources: kiln.jsonl 16 lines · records/ 35 files · events.jsonl 133 lines · run.json yes · `../eval/nothink.jsonl` 6 lines
- LLM mode: 16 kiln / 0 stub attempts · gen_id present on 16/16 HTTP 200 attempts
- Conventions: 1 kiln.jsonl line = 1 HTTP attempt; a call = attempt 1 plus its retries. Cost = Kiln `usage.cost` (USD) summed exactly;
  "unknown" = attempt with no reported cost (cost_known=false: timeout, 429, 5xx); counted, never guessed. Energy = completion tokens × 1.63 J (section 6).
  Latency = nearest-rank p50/p95 over all attempts; "ok" = HTTP 200 attempts only.

## 1. By call type (F1 work_request / F2 cfo_review / F3 receipt_explain)

### 1a. Volume and failures

| flow | calls | attempts | retried calls | failed calls | failed attempts | 429 | no HTTP (timeout/network) | 5xx | truncated (length) | stub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F2 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F3 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **total** | 16 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### 1b. Tokens, cost, energy, latency

| flow | prompt | completion | reasoning | cost (known) | cost-unknown attempts | energy @1.63 J | completion / call | p50 | p95 | p50 ok | p95 ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 8067 | 589 | 7 | $0.00061240 | 0 | 960.1 J | 84.1 | 1618 ms | 1866 ms | 1618 ms | 1866 ms |
| F2 | 5417 | 389 | 6 | $0.00038080 | 0 | 634.1 J | 64.8 | 1120 ms | 1484 ms | 1120 ms | 1484 ms |
| F3 | 520 | 203 | 3 | $0.00008744 | 0 | 330.9 J | 67.7 | 1303 ms | 1357 ms | 1303 ms | 1357 ms |
| **total** | 14004 | 1181 | 16 | $0.00108064 | 0 | 1925.0 J | 73.8 | 1353 ms | 1866 ms | 1353 ms | 1866 ms |

## 2. By decision flow (one request = F1 → gate → F2 → tx)

| req_id | action | job | F1 att | F2 att | prompt | completion | reasoning | cost | energy | outcome | code(s) | recHash | tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| demo-eF310273-r1 | inference | 0 | 0 | 0 | 0 | 0 | 0 | $0.00000000 | 0.0 J | APPROVED_ONCHAIN | - | `0x6291…888f` | `0x25ad…ffcb` |
| demo-eF310273-r2 | open | 1 | 1 | 1 | 1961 | 146 | 2 | $0.00015384 | 238.0 J | APPROVED_ONCHAIN | - | `0x3350…a4a6` | `0x4ba0…2d36` |
| demo-eF310273-r3 | topUp | 1 | 1 | 1 | 2024 | 145 | 2 | $0.00015148 | 236.3 J | APPROVED_ONCHAIN | - | `0xb3e0…51a5` | `0xd439…c30d` |
| demo-eF310273-r4 | topUp | 1 | 1 | 1 | 2092 | 140 | 2 | $0.00015384 | 228.2 J | QWEN_DENIED | QWEN_DENIED | `0x000c…9715` | `0x39b9…fdde` |
| demo-eF310273-r5 | open | 2 | 1 | 1 | 2060 | 147 | 2 | $0.00014332 | 239.6 J | APPROVED_ONCHAIN | - | `0x9ffc…97de` | `0xe5b0…2a11` |
| demo-eF310273-r6 | topUp | 2 | 1 | 0 | 1224 | 91 | 1 | $0.00009276 | 148.3 J | GATE_DENIED | VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | `0x3902…de83` | `0x59ee…4253` |
| demo-eF310273-r7 | open | - | 1 | 1 | 2049 | 165 | 2 | $0.00015524 | 268.9 J | QWEN_DENIED | QWEN_DENIED | `0x9ccc…da37` | `0x08d4…c1ba` |
| demo-eF310273-r8 | open | 3 | 1 | 1 | 2074 | 144 | 2 | $0.00014272 | 234.7 J | APPROVED_ONCHAIN | - | `0xb2ae…086f` | `0x0432…b677` |

"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record's f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).

## 3. By GPU job: AI cost to govern compute

| job | vendor | requests | Kiln attempts | prompt | completion | LLM cost | energy | settles | GPU net | fee | GPU gross | AI cost / GPU spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B `0x96E2…01dF` | 3 | 7 | 6251 | 496 | $0.00048732 | 808.5 J | 6 | $5.120000 | $0.153597 | $5.273597 | 0.0092% (1 : 10822) |
| 2 | B `0x96E2…01dF` | 2 | 4 | 3457 | 306 | $0.00026484 | 498.8 J | 6 | $5.543936 | $0.166316 | $5.710252 | 0.0046% (1 : 21561) |
| 3 | B `0x96E2…01dF` | 1 | 3 | 2247 | 214 | $0.00017324 | 348.8 J | 1 | $1.283328 | $0.038499 | $1.321827 | 0.0131% (1 : 7630) |
| no job (e.g. denied open) | - | 1 | 2 | 2049 | 165 | $0.00015524 | 268.9 J | 0 | $0.000000 | $0.000000 | $0.000000 | - |
| **total** |  |  |  |  |  | $0.00108064 |  |  | $11.947264 | $0.358412 | $12.305676 | 0.0088% (1 : 11387) |

- Job 1: AI cost to govern $5.273597 of compute = $0.00048732.
- Job 2: AI cost to govern $5.710252 of compute = $0.00026484.
- Job 3: AI cost to govern $1.321827 of compute = $0.00017324.
- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.

## 4. Session totals and INFERENCE reconciliation

| item | value |
| --- | --- |
| run_id | demo-eF310273 |
| Kiln window | 2026-09-28T20:24:57.314Z → 2026-09-28T20:26:49.332Z (112.0 s) |
| calls / attempts | 16 / 16 |
| tokens prompt / completion / reasoning | 14004 / 1181 / 16 |
| LLM cost (known) | $0.00108064 |
| cost-unknown attempts (not in the settle) | 0 |
| computed INFERENCE settle = ceil(Σcost × 1e6) | 1081 micro-USDC ($0.001081) |
| on-chain INFERENCE `Settled` | 1081 micro-USDC on job 0 · tx `0x6c7e…09fe` |
| reconciliation | MATCH |
| INFERENCE hold (inference DECISION) | $0.050000 · computed spend uses 2.16% |
| GPU spend net / fee / gross | $11.947264 / $0.358412 / $12.305676 |
| AI cost / GPU spend | 0.0088% (1 : 11387) |
| energy (completion × 1.63 J) | 1925.0 J = 0.5347 Wh |

## 5. By outcome, and savings

### 5a. Requests by outcome

| outcome | requests | F1 att | F2 att | prompt | completion | cost | energy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVED_ONCHAIN | 5 | 4 | 4 | 8119 | 582 | $0.00059136 | 948.7 J |
| QWEN_DENIED | 2 | 2 | 2 | 4141 | 305 | $0.00030908 | 497.1 J |
| GATE_DENIED | 1 | 1 | 0 | 1224 | 91 | $0.00009276 | 148.3 J |

| layer · deny code(s) | requests |
| --- | --- |
| QWEN_DENIED · QWEN_DENIED | 2 |
| GATE_DENIED · VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | 1 |

### 5b. Gate denied before F2 (the saving)

| F2 calls avoided | mean F2 prompt / completion | prompt saved | completion saved | cost saved | energy saved @1.63 J |
| --- | --- | --- | --- | --- | --- |
| 1 | 902.8 / 64.8 | 902.8 | 64.8 | $0.00006347 | 105.7 J = 0.0294 Wh |

- Estimate: avoided calls × mean over the 6 F2 attempts with usage in this run. The gate is deterministic code: 0 tokens.

### 5c. /no_think on vs off (offline comparison, nothink.jsonl)

| mode | runs | mean prompt | mean completion | mean reasoning | mean cost | energy / call | p50 | p95 | truncated (length) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| think | 3 | 986.0 | 346.0 | 295.0 | $0.00013641 | 564.0 J | 4887 ms | 4890 ms | 0 |
| no_think | 3 | 990.0 | 66.0 | 1.0 | $0.00005928 | 107.6 J | 1378 ms | 1858 ms | 0 |

- /no_think cuts completion tokens per call by 80.9% (346.0 → 66.0), energy per call 564.0 J → 107.6 J.

## 6. Energy estimate (range, stated assumptions)

| scope | completion tokens | RNGD 1.63 J | Wh | RTX Pro 6000 4.02 J | Wh | upper 11.9 J | Wh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 589 | 960.1 J | 0.2667 Wh | 2367.8 J | 0.6577 Wh | 7009.1 J | 1.9470 Wh |
| F2 | 389 | 634.1 J | 0.1761 Wh | 1563.8 J | 0.4344 Wh | 4629.1 J | 1.2859 Wh |
| F3 | 203 | 330.9 J | 0.0919 Wh | 816.1 J | 0.2267 Wh | 2415.7 J | 0.6710 Wh |
| **total** | 1181 | 1925.0 J | 0.5347 Wh | 4747.6 J | 1.3188 Wh | 14053.9 J | 3.9039 Wh |
| saved by gate (est.) | 64.83333333333333 | 105.7 J | 0.0294 Wh | 260.6 J | 0.0724 Wh | 771.5 J | 0.2143 Wh |

- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.
- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).
- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.
- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).
- Assumptions: rated power, full load, PUE excluded. Kiln's actual serving configuration is unknown.
