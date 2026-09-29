# Kiln token & energy report — budget-7C813285

- Bundle: `0x7C813285C6f9049e21dc10CF9a1367430Ae8dCcb` · vault `0x7C813285C6f9049e21dc10CF9a1367430Ae8dCcb` · chainId 84532
- Flags: `{"LLM_MODE":"kiln","SCENARIO":"budget","CLOCK":"3","DEADLINE_MARGIN_S":"15","LLM_CALL_CAP":"60"}`
- Sources: kiln.jsonl 4 lines · records/ 12 files · events.jsonl 40 lines · run.json yes · `../eval/nothink.jsonl` 6 lines
- LLM mode: 4 kiln / 0 stub attempts · gen_id present on 4/4 HTTP 200 attempts
- Conventions: 1 kiln.jsonl line = 1 HTTP attempt; a call = attempt 1 plus its retries. Cost = Kiln `usage.cost` (USD) summed exactly;
  "unknown" = attempt with no reported cost (cost_known=false: timeout, 429, 5xx); counted, never guessed. Energy = completion tokens × 1.63 J (section 6).
  Latency = nearest-rank p50/p95 over all attempts; "ok" = HTTP 200 attempts only.

## 1. By call type (F1 work_request / F2 cfo_review / F3 receipt_explain)

### 1a. Volume and failures

| flow | calls | attempts | retried calls | failed calls | failed attempts | 429 | no HTTP (timeout/network) | 5xx | truncated (length) | stub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| F3 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **total** | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### 1b. Tokens, cost, energy, latency

| flow | prompt | completion | reasoning | cost (known) | cost-unknown attempts | energy @1.63 J | completion / call | p50 | p95 | p50 ok | p95 ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 2513 | 205 | 2 | $0.00020124 | 0 | 334.1 J | 102.5 | 1748 ms | 3011 ms | 1748 ms | 3011 ms |
| F2 | 925 | 69 | 1 | $0.00007248 | 0 | 112.5 J | 69.0 | 1285 ms | 1285 ms | 1285 ms | 1285 ms |
| F3 | 174 | 69 | 1 | $0.00002812 | 0 | 112.5 J | 69.0 | 1361 ms | 1361 ms | 1361 ms | 1361 ms |
| **total** | 3612 | 343 | 4 | $0.00030184 | 0 | 559.1 J | 85.8 | 1361 ms | 3011 ms | 1361 ms | 3011 ms |

## 2. By decision flow (one request = F1 → gate → F2 → tx)

| req_id | action | job | F1 att | F2 att | prompt | completion | reasoning | cost | energy | outcome | code(s) | recHash | tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| budget-7C813285-r1 | inference | 0 | 0 | 0 | 0 | 0 | 0 | $0.00000000 | 0.0 J | APPROVED_ONCHAIN | - | `0x05a1…bf9e` | [0x1463…695c](https://sepolia.basescan.org/tx/0x14633436c74aad6dfb573878818c8c71ffc2f3a81867fb34d4b0a1fd83af695c) |
| budget-7C813285-r2 | open | 1 | 1 | 1 | 2154 | 178 | 2 | $0.00017268 | 290.1 J | APPROVED_ONCHAIN | - | `0xdc13…21be` | [0xbb9a…9de8](https://sepolia.basescan.org/tx/0xbb9a6da64f6d46233569da46d2647ba6296ca1a8b0aaaf5d9071b54af0de9de8) |
| budget-7C813285-r3 | topUp | 1 | 1 | 0 | 1284 | 96 | 1 | $0.00010104 | 156.5 J | GATE_DENIED | OVER_BUDGET_WITH_FEE | `0x34c7…6f9c` | [0x205f…066a](https://sepolia.basescan.org/tx/0x205f73a223356b6da60a736ef471b1990e7c0617c65ae6dfaba4f1069dda066a) |

"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record's f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).

## 3. By GPU job: AI cost to govern compute

| job | vendor | requests | Kiln attempts | prompt | completion | LLM cost | energy | settles | GPU net | fee | GPU gross | AI cost / GPU spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B `0x96E2…01dF` | 2 | 4 | 3612 | 343 | $0.00030184 | 559.1 J | 3 | $2.560000 | $0.076799 | $2.636799 | 0.0114% (1 : 8736) |
| **total** |  |  |  |  |  | $0.00030184 |  |  | $2.560000 | $0.076799 | $2.636799 | 0.0114% (1 : 8736) |

- Job 1: AI cost to govern $2.636799 of compute = $0.00030184.
- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.

## 4. Session totals and INFERENCE reconciliation

| item | value |
| --- | --- |
| run_id | budget-7C813285 |
| Kiln window | 2026-09-29T01:57:48.322Z → 2026-09-29T01:59:02.540Z (74.2 s) |
| calls / attempts | 4 / 4 |
| tokens prompt / completion / reasoning | 3612 / 343 / 4 |
| LLM cost (known) | $0.00030184 |
| cost-unknown attempts (not in the settle) | 0 |
| computed INFERENCE settle = ceil(Σcost × 1e6) | 302 micro-USDC ($0.000302) |
| on-chain INFERENCE `Settled` | 302 micro-USDC on job 0 · tx [0x281e…14c2](https://sepolia.basescan.org/tx/0x281e8e11d543ab6020af2a891840afd03b2663d4836d6740fb7efa2f984014c2) |
| reconciliation | MATCH |
| INFERENCE hold (inference DECISION) | $0.050000 · computed spend uses 0.60% |
| GPU spend net / fee / gross | $2.560000 / $0.076799 / $2.636799 |
| AI cost / GPU spend | 0.0114% (1 : 8736) |
| energy (completion × 1.63 J) | 559.1 J = 0.1553 Wh |

## 5. By outcome, and savings

### 5a. Requests by outcome

| outcome | requests | F1 att | F2 att | prompt | completion | cost | energy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVED_ONCHAIN | 2 | 1 | 1 | 2154 | 178 | $0.00017268 | 290.1 J |
| GATE_DENIED | 1 | 1 | 0 | 1284 | 96 | $0.00010104 | 156.5 J |

| layer · deny code(s) | requests |
| --- | --- |
| GATE_DENIED · OVER_BUDGET_WITH_FEE | 1 |

### 5b. Gate denied before F2 (the saving)

| F2 calls avoided | mean F2 prompt / completion | prompt saved | completion saved | cost saved | energy saved @1.63 J |
| --- | --- | --- | --- | --- | --- |
| 1 | 925.0 / 69.0 | 925.0 | 69.0 | $0.00007248 | 112.5 J = 0.0312 Wh |

- Estimate: avoided calls × mean over the 1 F2 attempts with usage in this run. The gate is deterministic code: 0 tokens.

### 5c. /no_think on vs off (offline comparison, nothink.jsonl)

| mode | runs | mean prompt | mean completion | mean reasoning | mean cost | energy / call | p50 | p95 | truncated (length) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| think | 3 | 986.0 | 346.0 | 295.0 | $0.00013641 | 564.0 J | 4887 ms | 4890 ms | 0 |
| no_think | 3 | 990.0 | 66.0 | 1.0 | $0.00005928 | 107.6 J | 1378 ms | 1858 ms | 0 |

- /no_think cuts completion tokens per call by 80.9% (346.0 → 66.0), energy per call 564.0 J → 107.6 J.

## 6. Energy estimate (range, stated assumptions)

| scope | completion tokens | RNGD 1.63 J | Wh | RTX Pro 6000 4.02 J | Wh | upper 11.9 J | Wh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 205 | 334.1 J | 0.0928 Wh | 824.1 J | 0.2289 Wh | 2439.5 J | 0.6776 Wh |
| F2 | 69 | 112.5 J | 0.0312 Wh | 277.4 J | 0.0770 Wh | 821.1 J | 0.2281 Wh |
| F3 | 69 | 112.5 J | 0.0312 Wh | 277.4 J | 0.0770 Wh | 821.1 J | 0.2281 Wh |
| **total** | 343 | 559.1 J | 0.1553 Wh | 1378.9 J | 0.3830 Wh | 4081.7 J | 1.1338 Wh |
| saved by gate (est.) | 69 | 112.5 J | 0.0312 Wh | 277.4 J | 0.0770 Wh | 821.1 J | 0.2281 Wh |

- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.
- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).
- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.
- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).
- Assumptions: rated power, full load, PUE excluded. Kiln's actual serving configuration is unknown.
