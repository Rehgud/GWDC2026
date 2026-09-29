# Kiln token & energy report — demo-4E8E2db8

- Bundle: `0x4E8E2db83acdcb1E2941aE9E7d76aDE04356507C` · vault `0x4E8E2db83acdcb1E2941aE9E7d76aDE04356507C` · chainId 84532
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
| F1 | 6486 | 499 | 5 | $0.00052284 | 0 | 813.4 J | 99.8 | 1908 ms | 2272 ms | 1908 ms | 2272 ms |
| F2 | 3646 | 250 | 4 | $0.00028292 | 0 | 407.5 J | 62.5 | 1130 ms | 1187 ms | 1130 ms | 1187 ms |
| F3 | 504 | 207 | 3 | $0.00009224 | 0 | 337.4 J | 69.0 | 1376 ms | 1387 ms | 1376 ms | 1387 ms |
| **total** | 10636 | 956 | 12 | $0.00089800 | 0 | 1558.3 J | 79.7 | 1376 ms | 2272 ms | 1376 ms | 2272 ms |

## 2. By decision flow (one request = F1 → gate → F2 → tx)

| req_id | action | job | F1 att | F2 att | prompt | completion | reasoning | cost | energy | outcome | code(s) | recHash | tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| demo-4E8E2db8-r1 | inference | 0 | 0 | 0 | 0 | 0 | 0 | $0.00000000 | 0.0 J | APPROVED_ONCHAIN | - | `0xa269…5e7e` | [0x3c96…d446](https://sepolia.basescan.org/tx/0x3c9649ac6f2a9730903dd4476d29f2be934cb144de25c67a7b5ebccfd3cad446) |
| demo-4E8E2db8-r2 | open | 1 | 1 | 1 | 2149 | 176 | 2 | $0.00017264 | 286.9 J | APPROVED_ONCHAIN | - | `0x7809…754e` | [0x1c77…3023](https://sepolia.basescan.org/tx/0x1c774293a2ddf0adb44d2409d3a96618d04ab4d653dcd30db33076587a2f3023) |
| demo-4E8E2db8-r3 | topUp | 1 | 1 | 1 | 2188 | 161 | 2 | $0.00021960 | 262.4 J | QWEN_DENIED | QWEN_DENIED | `0xa47b…88b7` | [0x39b7…5e0f](https://sepolia.basescan.org/tx/0x39b721d7d574a973b19b10d2e83ca4642ef7cb6ac6e2fa1fa90694d0803d5e0f) |
| demo-4E8E2db8-r4 | open | 2 | 1 | 1 | 2199 | 149 | 2 | $0.00015004 | 242.9 J | APPROVED_ONCHAIN | - | `0x04bb…4e8a` | [0x4d69…f777](https://sepolia.basescan.org/tx/0x4d6939f4e0747a5fe0e0f2ff69f57e3a0d18ed14e95a03e2c9a0845abe6af777) |
| demo-4E8E2db8-r5 | topUp | 2 | 1 | 0 | 1372 | 109 | 1 | $0.00011172 | 177.7 J | GATE_DENIED | VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | `0xe327…4d4f` | [0x0b39…767c](https://sepolia.basescan.org/tx/0x0b39f95c1091ee461875e9f0945ae1f9c9042b21b212c2ce94adf2953802767c) |
| demo-4E8E2db8-r6 | open | 3 | 1 | 1 | 2224 | 154 | 2 | $0.00015176 | 251.0 J | APPROVED_ONCHAIN | - | `0xd374…dbe5` | [0xb9da…7936](https://sepolia.basescan.org/tx/0xb9daa1166912dc1c90fd06016840b3b11817dacae8d2217f1e7afe433a3e7936) |

"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record's f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).

## 3. By GPU job: AI cost to govern compute

| job | vendor | requests | Kiln attempts | prompt | completion | LLM cost | energy | settles | GPU net | fee | GPU gross | AI cost / GPU spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B `0x96E2…01dF` | 2 | 5 | 4511 | 406 | $0.00042528 | 661.8 J | 3 | $2.560000 | $0.076799 | $2.636799 | 0.0161% (1 : 6200) |
| 2 | B `0x96E2…01dF` | 2 | 4 | 3740 | 322 | $0.00029028 | 524.9 J | 2 | $2.560000 | $0.076799 | $2.636799 | 0.0110% (1 : 9084) |
| 3 | B `0x96E2…01dF` | 1 | 3 | 2385 | 228 | $0.00018244 | 371.6 J | 0 | $0.000000 | $0.000000 | $0.000000 | - |
| **total** |  |  |  |  |  | $0.00089800 |  |  | $5.120000 | $0.153598 | $5.273598 | 0.0170% (1 : 5873) |

- Job 1: AI cost to govern $2.636799 of compute = $0.00042528.
- Job 2: AI cost to govern $2.636799 of compute = $0.00029028.
- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.

## 4. Session totals and INFERENCE reconciliation

| item | value |
| --- | --- |
| run_id | demo-4E8E2db8 |
| Kiln window | 2026-09-29T16:37:31.542Z → 2026-09-29T16:40:12.893Z (161.4 s) |
| calls / attempts | 12 / 12 |
| tokens prompt / completion / reasoning | 10636 / 956 / 12 |
| LLM cost (known) | $0.00089800 |
| cost-unknown attempts (not in the settle) | 0 |
| computed INFERENCE settle = ceil(Σcost × 1e6) | 899 micro-USDC ($0.000899) |
| on-chain INFERENCE `Settled` | 899 micro-USDC on job 0 · tx [0x3293…86cc](https://sepolia.basescan.org/tx/0x32937f0d57124d648af422f72a8387cf667d4ff33a3a1899a4a01577f94586cc) |
| reconciliation | MATCH |
| INFERENCE hold (inference DECISION) | $0.050000 · computed spend uses 1.80% |
| GPU spend net / fee / gross | $5.120000 / $0.153598 / $5.273598 |
| AI cost / GPU spend | 0.0170% (1 : 5873) |
| energy (completion × 1.63 J) | 1558.3 J = 0.4329 Wh |

## 5. By outcome, and savings

### 5a. Requests by outcome

| outcome | requests | F1 att | F2 att | prompt | completion | cost | energy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVED_ONCHAIN | 4 | 3 | 3 | 6572 | 479 | $0.00047444 | 780.8 J |
| QWEN_DENIED | 1 | 1 | 1 | 2188 | 161 | $0.00021960 | 262.4 J |
| GATE_DENIED | 1 | 1 | 0 | 1372 | 109 | $0.00011172 | 177.7 J |

| layer · deny code(s) | requests |
| --- | --- |
| QWEN_DENIED · QWEN_DENIED | 1 |
| GATE_DENIED · VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED+NO_CAPACITY | 1 |

### 5b. Gate denied before F2 (the saving)

| F2 calls avoided | mean F2 prompt / completion | prompt saved | completion saved | cost saved | energy saved @1.63 J |
| --- | --- | --- | --- | --- | --- |
| 1 | 911.5 / 62.5 | 911.5 | 62.5 | $0.00007073 | 101.9 J = 0.0283 Wh |

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
| F1 | 499 | 813.4 J | 0.2259 Wh | 2006.0 J | 0.5572 Wh | 5938.1 J | 1.6495 Wh |
| F2 | 250 | 407.5 J | 0.1132 Wh | 1005.0 J | 0.2792 Wh | 2975.0 J | 0.8264 Wh |
| F3 | 207 | 337.4 J | 0.0937 Wh | 832.1 J | 0.2311 Wh | 2463.3 J | 0.6843 Wh |
| **total** | 956 | 1558.3 J | 0.4329 Wh | 3843.1 J | 1.0675 Wh | 11376.4 J | 3.1601 Wh |
| saved by gate (est.) | 62.5 | 101.9 J | 0.0283 Wh | 251.2 J | 0.0698 Wh | 743.8 J | 0.2066 Wh |

- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.
- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).
- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.
- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).
- Assumptions: rated power, full load, PUE excluded. Kiln's actual serving configuration is unknown.
