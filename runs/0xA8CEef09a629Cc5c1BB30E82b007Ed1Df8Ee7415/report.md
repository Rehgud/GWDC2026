# Kiln token & energy report — demo-A8CEef09

- Bundle: `0xA8CEef09a629Cc5c1BB30E82b007Ed1Df8Ee7415` · vault `0xA8CEef09a629Cc5c1BB30E82b007Ed1Df8Ee7415` · chainId 84532
- Flags: `{"LLM_MODE":"kiln","SCENARIO":"demo","CLOCK":"3","DEADLINE_MARGIN_S":"15","LLM_CALL_CAP":"60"}`
- Sources: kiln.jsonl 12 lines · records/ 22 files · events.jsonl 80 lines · run.json yes · `../eval/nothink.jsonl` 6 lines
- LLM mode: 12 kiln / 0 stub attempts · gen_id present on 12/12 HTTP 200 attempts
- Conventions: 1 kiln.jsonl line = 1 HTTP attempt; a call = attempt 1 plus its retries. Cost = Kiln `usage.cost` (USD) summed exactly;
  "unknown" = attempt with no reported cost (cost_known=false: timeout, 429, 5xx); counted, never guessed. Energy = completion tokens × 1.63 J (section 6).
  Latency = nearest-rank p50/p95 over all attempts; "ok" = HTTP 200 attempts only.

## 1. By call type (F1 work_request / F2 cfo_review / F3 receipt_explain)

### 1a. Volume and failures

| flow | calls | attempts | retried calls | failed calls | failed attempts | 429 | no HTTP (timeout/network) | 5xx | truncated (length) | stub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F2 | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F3 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **total** | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### 1b. Tokens, cost, energy, latency

| flow | prompt | completion | reasoning | cost (known) | cost-unknown attempts | energy @1.63 J | completion / call | p50 | p95 | p50 ok | p95 ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 6492 | 511 | 5 | $0.00050088 | 0 | 832.9 J | 102.2 | 1903 ms | 2109 ms | 1903 ms | 2109 ms |
| F2 | 3630 | 251 | 4 | $0.00025288 | 0 | 409.1 J | 62.8 | 1095 ms | 2424 ms | 1095 ms | 2424 ms |
| F3 | 509 | 222 | 3 | $0.00008976 | 0 | 361.9 J | 74.0 | 2404 ms | 3041 ms | 2404 ms | 3041 ms |
| **total** | 10631 | 984 | 12 | $0.00084352 | 0 | 1603.9 J | 82.0 | 1894 ms | 3041 ms | 1894 ms | 3041 ms |

## 2. By decision flow (one request = F1 → gate → F2 → tx)

| req_id | action | job | F1 att | F2 att | prompt | completion | reasoning | cost | energy | outcome | code(s) | recHash | tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| demo-A8CEef09-r1 | inference | 0 | 0 | 0 | 0 | 0 | 0 | $0.00000000 | 0.0 J | APPROVED_ONCHAIN | - | `0x30fc…a7c0` | [0xd93b…302a](https://sepolia.basescan.org/tx/0xd93b8d0a9dc15398506a027ad9a663aada917e7ed5bbb6814657f4d93c71302a) |
| demo-A8CEef09-r2 | open | 1 | 1 | 1 | 2136 | 170 | 2 | $0.00016892 | 277.1 J | APPROVED_ONCHAIN | - | `0x3889…7a66` | [0x2c76…6d45](https://sepolia.basescan.org/tx/0x2c76f052cc04b0da7be300ebf71508f1b1357c41fd5460e7c885f1cb559b6d45) |
| demo-A8CEef09-r3 | topUp | 1 | 1 | 1 | 2182 | 159 | 2 | $0.00016260 | 259.2 J | QWEN_DENIED | QWEN_DENIED | `0x2088…b996` | [0xf784…985f](https://sepolia.basescan.org/tx/0xf7846f6e4ec4f98fa93a2ca863105bd608549ad6d4482ac098db9606acbf985f) |
| demo-A8CEef09-r4 | open | 2 | 1 | 1 | 2204 | 164 | 2 | $0.00016404 | 267.3 J | APPROVED_ONCHAIN | - | `0xa9df…c295` | [0xfbd4…e9d2](https://sepolia.basescan.org/tx/0xfbd425a98be7d39640b1e1e8c178801ec366164c31cbe883536a17c2f91ee9d2) |
| demo-A8CEef09-r5 | topUp | 2 | 1 | 0 | 1369 | 123 | 1 | $0.00010788 | 200.5 J | GATE_DENIED | VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | `0x850a…20ea` | [0x1595…dfce](https://sepolia.basescan.org/tx/0x15952fe0cf849216a42e8cd0b19a3c8833729d04785be102cf0474a21d29dfce) |
| demo-A8CEef09-r6 | open | 3 | 1 | 1 | 2231 | 146 | 2 | $0.00015032 | 238.0 J | APPROVED_ONCHAIN | - | `0xbe41…0915` | [0x9ffd…619d](https://sepolia.basescan.org/tx/0x9ffd48f99ccc30d52170cbf6dacc86707bb3d07e783a33c32afdeee1a8eb619d) |

"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record's f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).

## 3. By GPU job: AI cost to govern compute

| job | vendor | requests | Kiln attempts | prompt | completion | LLM cost | energy | settles | GPU net | fee | GPU gross | AI cost / GPU spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B `0x96E2…01dF` | 2 | 5 | 4492 | 398 | $0.00035964 | 648.7 J | 3 | $2.560000 | $0.076798 | $2.636798 | 0.0136% (1 : 7332) |
| 2 | B `0x96E2…01dF` | 2 | 4 | 3747 | 368 | $0.00030456 | 599.8 J | 2 | $2.560000 | $0.076799 | $2.636799 | 0.0116% (1 : 8658) |
| 3 | B `0x96E2…01dF` | 1 | 3 | 2392 | 218 | $0.00017932 | 355.3 J | 0 | $0.000000 | $0.000000 | $0.000000 | - |
| **total** |  |  |  |  |  | $0.00084352 |  |  | $5.120000 | $0.153597 | $5.273597 | 0.0160% (1 : 6252) |

- Job 1: AI cost to govern $2.636798 of compute = $0.00035964.
- Job 2: AI cost to govern $2.636799 of compute = $0.00030456.
- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.

## 4. Session totals and INFERENCE reconciliation

| item | value |
| --- | --- |
| run_id | demo-A8CEef09 |
| Kiln window | 2026-09-29T01:49:03.329Z → 2026-09-29T01:51:27.420Z (144.1 s) |
| calls / attempts | 12 / 12 |
| tokens prompt / completion / reasoning | 10631 / 984 / 12 |
| LLM cost (known) | $0.00084352 |
| cost-unknown attempts (not in the settle) | 0 |
| computed INFERENCE settle = ceil(Σcost × 1e6) | 844 micro-USDC ($0.000844) |
| on-chain INFERENCE `Settled` | 844 micro-USDC on job 0 · tx [0x6459…7b84](https://sepolia.basescan.org/tx/0x6459c1cd16444d6726bf31b91809b2146efc8fac6efaee8afeba50814a4c7b84) |
| reconciliation | MATCH |
| INFERENCE hold (inference DECISION) | $0.050000 · computed spend uses 1.69% |
| GPU spend net / fee / gross | $5.120000 / $0.153597 / $5.273597 |
| AI cost / GPU spend | 0.0160% (1 : 6252) |
| energy (completion × 1.63 J) | 1603.9 J = 0.4455 Wh |

## 5. By outcome, and savings

### 5a. Requests by outcome

| outcome | requests | F1 att | F2 att | prompt | completion | cost | energy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVED_ONCHAIN | 4 | 3 | 3 | 6571 | 480 | $0.00048328 | 782.4 J |
| QWEN_DENIED | 1 | 1 | 1 | 2182 | 159 | $0.00016260 | 259.2 J |
| GATE_DENIED | 1 | 1 | 0 | 1369 | 123 | $0.00010788 | 200.5 J |

| layer · deny code(s) | requests |
| --- | --- |
| QWEN_DENIED · QWEN_DENIED | 1 |
| GATE_DENIED · VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | 1 |

### 5b. Gate denied before F2 (the saving)

| F2 calls avoided | mean F2 prompt / completion | prompt saved | completion saved | cost saved | energy saved @1.63 J |
| --- | --- | --- | --- | --- | --- |
| 1 | 907.5 / 62.8 | 907.5 | 62.8 | $0.00006322 | 102.3 J = 0.0284 Wh |

- Estimate: avoided calls × mean over the 4 F2 attempts with usage in this run. The gate is deterministic code: 0 tokens.

### 5c. /no_think on vs off (offline comparison, nothink.jsonl)

| mode | runs | mean prompt | mean completion | mean reasoning | mean cost | energy / call | p50 | p95 | truncated (length) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| think | 3 | 986.0 | 346.0 | 295.0 | $0.00013641 | 564.0 J | 4887 ms | 4890 ms | 0 |
| no_think | 3 | 990.0 | 66.0 | 1.0 | $0.00005928 | 107.6 J | 1378 ms | 1858 ms | 0 |

- /no_think cuts completion tokens per call by 80.9% (346.0 → 66.0), energy per call 564.0 J → 107.6 J.

## 6. Energy estimate (range, stated assumptions)

| scope | completion tokens | RNGD 1.63 J | Wh | RTX Pro 6000 4.02 J | Wh | upper 11.9 J | Wh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 511 | 832.9 J | 0.2314 Wh | 2054.2 J | 0.5706 Wh | 6080.9 J | 1.6891 Wh |
| F2 | 251 | 409.1 J | 0.1136 Wh | 1009.0 J | 0.2803 Wh | 2986.9 J | 0.8297 Wh |
| F3 | 222 | 361.9 J | 0.1005 Wh | 892.4 J | 0.2479 Wh | 2641.8 J | 0.7338 Wh |
| **total** | 984 | 1603.9 J | 0.4455 Wh | 3955.7 J | 1.0988 Wh | 11709.6 J | 3.2527 Wh |
| saved by gate (est.) | 62.75 | 102.3 J | 0.0284 Wh | 252.3 J | 0.0701 Wh | 746.7 J | 0.2074 Wh |

- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.
- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).
- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.
- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).
- Assumptions: rated power, full load, PUE excluded. Kiln's actual serving configuration is unknown.
