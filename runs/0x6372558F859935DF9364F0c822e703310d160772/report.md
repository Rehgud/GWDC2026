# Kiln token & energy report — demo-6372558F

- Bundle: `0x6372558F859935DF9364F0c822e703310d160772` · vault `0x6372558F859935DF9364F0c822e703310d160772` · chainId 84532
- Flags: `{"LLM_MODE":"kiln","SCENARIO":"demo","CLOCK":"3","DEADLINE_MARGIN_S":"15","LLM_CALL_CAP":"60"}`
- Sources: kiln.jsonl 12 lines · records/ 23 files · events.jsonl 84 lines · run.json yes · `../eval/nothink.jsonl` 6 lines
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
| F1 | 6516 | 487 | 5 | $0.00048432 | 0 | 793.8 J | 97.4 | 1839 ms | 1960 ms | 1839 ms | 1960 ms |
| F2 | 3654 | 247 | 4 | $0.00026164 | 0 | 402.6 J | 61.8 | 1077 ms | 1204 ms | 1077 ms | 1204 ms |
| F3 | 504 | 219 | 3 | $0.00008748 | 0 | 357.0 J | 73.0 | 1282 ms | 1501 ms | 1282 ms | 1501 ms |
| **total** | 10674 | 953 | 12 | $0.00083344 | 0 | 1553.4 J | 79.4 | 1282 ms | 1960 ms | 1282 ms | 1960 ms |

## 2. By decision flow (one request = F1 → gate → F2 → tx)

| req_id | action | job | F1 att | F2 att | prompt | completion | reasoning | cost | energy | outcome | code(s) | recHash | tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| demo-6372558F-r1 | inference | 0 | 0 | 0 | 0 | 0 | 0 | $0.00000000 | 0.0 J | APPROVED_ONCHAIN | - | `0x3cc7…1dd5` | [0xc4ab…21a6](https://sepolia.basescan.org/tx/0xc4ab6caa246615e0def4f858cb96bbc98604db9b686dfa82093825018d9821a6) |
| demo-6372558F-r2 | open | 1 | 1 | 1 | 2148 | 160 | 2 | $0.00016708 | 260.8 J | APPROVED_ONCHAIN | - | `0x2ea0…c38c` | [0x47d2…1f16](https://sepolia.basescan.org/tx/0x47d26963fdb534db0cf669c78dda21e1e01a31fe2210b8924cf5b0889d441f16) |
| demo-6372558F-r3 | topUp | 1 | 1 | 1 | 2199 | 161 | 2 | $0.00017148 | 262.4 J | QWEN_DENIED | QWEN_DENIED | `0x08ee…f89c` | [0x51d3…7c19](https://sepolia.basescan.org/tx/0x51d38bd3a6d83cc03f8bf53ea48d05d6cac5d9f53a87788398f859051e1c7c19) |
| demo-6372558F-r4 | open | 2 | 1 | 1 | 2221 | 160 | 2 | $0.00015284 | 260.8 J | APPROVED_ONCHAIN | - | `0x4fa6…71bb` | [0x1634…b2f0](https://sepolia.basescan.org/tx/0x1634b830be0a11e8ce3520058791f92cce35d962656edd97ce62f9dfee73b2f0) |
| demo-6372558F-r5 | topUp | 2 | 1 | 0 | 1378 | 109 | 1 | $0.00010436 | 177.7 J | GATE_DENIED | VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | `0xac84…8c4e` | [0xed76…8b51](https://sepolia.basescan.org/tx/0xed76f33bb663f969c79903973abfa3ff62615c6e356eb3dcb250ed199d7a8b51) |
| demo-6372558F-r6 | open | 3 | 1 | 1 | 2224 | 144 | 2 | $0.00015020 | 234.7 J | APPROVED_ONCHAIN | - | `0x7618…e419` | [0x3ee3…4d43](https://sepolia.basescan.org/tx/0x3ee37661637f7a128539cad72fda7c5c1777e3240514626f707df45b4ade4d43) |

"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record's f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).

## 3. By GPU job: AI cost to govern compute

| job | vendor | requests | Kiln attempts | prompt | completion | LLM cost | energy | settles | GPU net | fee | GPU gross | AI cost / GPU spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B `0x96E2…01dF` | 2 | 5 | 4521 | 390 | $0.00036660 | 635.7 J | 3 | $2.560000 | $0.076799 | $2.636799 | 0.0139% (1 : 7193) |
| 2 | B `0x96E2…01dF` | 2 | 4 | 3768 | 347 | $0.00028652 | 565.6 J | 2 | $2.560000 | $0.076799 | $2.636799 | 0.0109% (1 : 9203) |
| 3 | B `0x96E2…01dF` | 1 | 3 | 2385 | 216 | $0.00018032 | 352.1 J | 0 | $0.000000 | $0.000000 | $0.000000 | - |
| **total** |  |  |  |  |  | $0.00083344 |  |  | $5.120000 | $0.153598 | $5.273598 | 0.0158% (1 : 6328) |

- Job 1: AI cost to govern $2.636799 of compute = $0.00036660.
- Job 2: AI cost to govern $2.636799 of compute = $0.00028652.
- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.

## 4. Session totals and INFERENCE reconciliation

| item | value |
| --- | --- |
| run_id | demo-6372558F |
| Kiln window | 2026-09-29T04:12:35.485Z → 2026-09-29T04:15:16.936Z (161.5 s) |
| calls / attempts | 12 / 12 |
| tokens prompt / completion / reasoning | 10674 / 953 / 12 |
| LLM cost (known) | $0.00083344 |
| cost-unknown attempts (not in the settle) | 0 |
| computed INFERENCE settle = ceil(Σcost × 1e6) | 834 micro-USDC ($0.000834) |
| on-chain INFERENCE `Settled` | 834 micro-USDC on job 0 · tx [0x11e0…f59b](https://sepolia.basescan.org/tx/0x11e0a7354400a0d4b93543b4aeab999578273a1f756d0ed38142615cba04f59b) |
| reconciliation | MATCH |
| INFERENCE hold (inference DECISION) | $0.050000 · computed spend uses 1.67% |
| GPU spend net / fee / gross | $5.120000 / $0.153598 / $5.273598 |
| AI cost / GPU spend | 0.0158% (1 : 6328) |
| energy (completion × 1.63 J) | 1553.4 J = 0.4315 Wh |

## 5. By outcome, and savings

### 5a. Requests by outcome

| outcome | requests | F1 att | F2 att | prompt | completion | cost | energy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVED_ONCHAIN | 4 | 3 | 3 | 6593 | 464 | $0.00047012 | 756.3 J |
| QWEN_DENIED | 1 | 1 | 1 | 2199 | 161 | $0.00017148 | 262.4 J |
| GATE_DENIED | 1 | 1 | 0 | 1378 | 109 | $0.00010436 | 177.7 J |

| layer · deny code(s) | requests |
| --- | --- |
| QWEN_DENIED · QWEN_DENIED | 1 |
| GATE_DENIED · VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | 1 |

### 5b. Gate denied before F2 (the saving)

| F2 calls avoided | mean F2 prompt / completion | prompt saved | completion saved | cost saved | energy saved @1.63 J |
| --- | --- | --- | --- | --- | --- |
| 1 | 913.5 / 61.8 | 913.5 | 61.8 | $0.00006541 | 100.7 J = 0.0280 Wh |

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
| F1 | 487 | 793.8 J | 0.2205 Wh | 1957.7 J | 0.5438 Wh | 5795.3 J | 1.6098 Wh |
| F2 | 247 | 402.6 J | 0.1118 Wh | 992.9 J | 0.2758 Wh | 2939.3 J | 0.8165 Wh |
| F3 | 219 | 357.0 J | 0.0992 Wh | 880.4 J | 0.2445 Wh | 2606.1 J | 0.7239 Wh |
| **total** | 953 | 1553.4 J | 0.4315 Wh | 3831.1 J | 1.0642 Wh | 11340.7 J | 3.1502 Wh |
| saved by gate (est.) | 61.75 | 100.7 J | 0.0280 Wh | 248.2 J | 0.0690 Wh | 734.8 J | 0.2041 Wh |

- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.
- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).
- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.
- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).
- Assumptions: rated power, full load, PUE excluded. Kiln's actual serving configuration is unknown.
