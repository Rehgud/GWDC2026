import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toBytes32 } from '../src/codes.ts'
import { hashBytes, readChain, verifyChain } from '../src/record.ts'
import { J, analyze, pct, report } from '../src/report.ts'

// Bundle: inference hold, approve (F2 429 -> retry), F2 timeout (cost unknown), re-armed approve, injection gate-deny (no F2),
// Qwen deny, F3 on close, open B, OVER_MAX_HOLD gate-deny (no F2), approve -> chain Denied(PAUSED), windDown with INFERENCE settle.
const FIX = join(import.meta.dirname, 'fixtures', 'report')
const a = analyze(FIX)
const md = report(FIX)
const has = (s: string) => assert.ok(md.includes(s), `report is missing: ${s}`)
const tmp = () => mkdtempSync(join(tmpdir(), 'report-'))
/** Copy of the fixture bundle with text edits applied to its files. */
function bundle(edits: Record<string, (s: string) => string>) {
  const dir = tmp()
  cpSync(FIX, dir, { recursive: true })
  for (const [f, fn] of Object.entries(edits)) writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), 'utf8')))
  return dir
}
const REC = { inf: '0x56d212a395e8250367b8e4b200bd4fc44b3403797d64ae44af92a9db79ca5aae', req3: '0xb24d97b165d96d60ec9fa00a4cbe2e6d52d9438fdb34a5b8158e7fca2c79ebcf', req6: '0xb5250b925ba82f9a9bae58a44427f9fa4a25be45df1e9f090f84fbd8ddc28807' }
const lines = (s: string) => s.trimEnd().split('\n')

test('fixture records are an intact hash chain (regenerate them, do not hand-edit)', () => {
  assert.deepEqual(verifyChain(readChain(join(FIX, 'records'))), [])
})

test('pct: nearest rank with integer math', () => {
  assert.equal(pct(Array.from({ length: 60 }, (_, i) => i + 1), 95), 57) // 0.95 * 60 is 57.000...01 in floats
  assert.equal(pct([3, 1, 2], 50), 2)
  assert.equal(pct([5], 95), 5)
  assert.equal(pct([], 50), null)
})

test('1. by call type: calls, attempts, failures, tokens, cost, latency', () => {
  const { F1, F2, F3, all } = a.flows
  assert.deepEqual([F1.calls, F1.n, F2.calls, F2.n, F3.calls, F3.n], [8, 8, 6, 7, 2, 2])
  assert.deepEqual([F2.retried, F2.failedCalls, F2.failed, F2.r429, F2.timeout, F2.unknown], [1, 1, 2, 1, 1, 2])
  assert.deepEqual([all.prompt, all.completion, all.reasoning, all.pico], [6800, 1210, 15, 882_800_000n]) // $0.0008828
  assert.deepEqual([pct(F1.lat, 50), pct(F1.lat, 95)], [1300, 2400])
  assert.deepEqual([pct(F2.lat, 50), pct(F2.lat, 95), pct(F2.latOk, 50), pct(F2.latOk, 95)], [2200, 10000, 2200, 3000])
  assert.deepEqual([pct(F3.lat, 50), pct(F3.lat, 95)], [900, 1100])
  has('| F2 | 6 | 7 | 1 | 1 | 2 | 1 | 1 | 0 | 0 | 0 |')
  has('| F2 | 3000 | 250 | 5 | $0.00031000 | 2 | 407.5 J | 41.7 | 2200 ms | 10000 ms | 2200 ms | 3000 ms |')
  assert.ok(!md.includes('WARNING: STUB'))
})

test('2. by decision flow: outcome, tokens, rec/tx per request', () => {
  const by = Object.fromEntries(a.reqs.map((r) => [r.req_id, r]))
  assert.deepEqual(a.reqs.map((r) => [r.req_id, r.outcome, r.code]), [
    ['req-inf', 'APPROVED_ONCHAIN', ''],
    ['req-1', 'APPROVED_ONCHAIN', ''],
    ['req-2', 'QWEN_NOT_A_JUDGEMENT', 'QWEN_UNAVAILABLE'],
    ['req-3', 'APPROVED_ONCHAIN', ''],
    ['req-4', 'GATE_DENIED', 'VENDOR_NOT_ALLOWED+GPU_TYPE_NOT_ALLOWED'],
    ['req-5', 'QWEN_DENIED', 'QWEN_DENIED'],
    ['req-6', 'APPROVED_ONCHAIN', ''],
    ['req-7', 'GATE_DENIED', 'OVER_MAX_HOLD'],
    ['req-8', 'CHAIN_DENIED', 'PAUSED'],
  ])
  const r1 = by['req-1']
  assert.deepEqual([r1.job, r1.f1, r1.f2, r1.prompt, r1.completion, r1.pico, r1.unknown], ['1', 1, 2, 1000, 150, 122_000_000n, 1])
  assert.deepEqual([by['req-4'].f2, by['req-6'].job], [0, '2']) // open's job comes from the commit's HoldOpened
  assert.match(r1.recHash!, /^0x[0-9a-f]{64}$/)
  assert.match(r1.tx!, /^0x[0-9a-f]{64}$/)
  has(`| req-1 | open | 1 | 1 | 2 | 1000 | 150 | 2 | $0.00012200 + 1 unknown | 244.5 J | APPROVED_ONCHAIN | - | \`${r1.recHash!.slice(0, 6)}…`)
  has(`](https://sepolia.basescan.org/tx/${r1.tx})`)
})

test('3. by GPU job: LLM cost vs settled GPU spend', () => {
  const [j1, j2] = a.jobs
  assert.equal(a.jobs.length, 2) // INFERENCE job 0 is not a GPU job
  assert.deepEqual([j1.id, j1.reqs, j1.n, j1.pico, j1.net, j1.fee, j1.gross], ['1', 5, 11, 532_400_000n, 6_000_000n, 180_000n, 6_180_000n])
  assert.deepEqual([j2.id, j2.reqs, j2.n, j2.pico, j2.gross], ['2', 3, 6, 350_400_000n, 1_339_000n])
  has('- Job 1: AI cost to govern $6.180000 of compute = $0.00053240 + 2 unknown.')
  has('| 1 | A `0x0000…00a1` |')
})

test('4. session totals reconcile with the on-chain INFERENCE settle', () => {
  const s = a.session
  assert.deepEqual([s.computed, s.onchain, s.infJobs, s.infHold], [883n, 883n, ['0'], 50_000n]) // ceil(0.0008828 * 1e6)
  assert.deepEqual([s.gpuNet, s.gpuFee], [7_300_000n, 219_000n])
  has('| reconciliation | MATCH |')
  has('| cost-unknown attempts (not in the settle) | 2 |')
})

test('5. outcomes, gate savings and /no_think comparison', () => {
  assert.deepEqual(a.savings, { avoided: 2, n: 5, prompt: 600, completion: 50, pico: 62_000_000n })
  has('| 2 | 600.0 / 50.0 | 1200.0 | 100.0 | $0.00012400 | 163.0 J = 0.0453 Wh |')
  has('| GATE_DENIED | 2 | 2 | 0 | 800 | 200 | $0.00012000 | 326.0 J |')
  has('| CHAIN_DENIED · PAUSED | 1 |')
  assert.deepEqual([a.nothink.think.n, a.nothink.think.completion, a.nothink.no_think.completion], [3, 1200, 150])
  has('- /no_think cuts completion tokens per call by 87.5% (400.0 → 50.0), energy per call 652.0 J → 81.5 J.')
})

test('6. energy: completion tokens x 1.63 / 4.02 / 11.9 J, in J and Wh', () => {
  assert.deepEqual(J, { rngd: 1.63, rtx: 4.02, upper: 11.9 })
  has('| **total** | 1210 | 1972.3 J | 0.5479 Wh | 4864.2 J | 1.3512 Wh | 14399.0 J | 3.9997 Wh |')
  has('| saved by gate (est.) | 100 | 163.0 J |')
  has('Prefill (prompt) tokens are excluded')
})

test('stub calls are flagged in the header', () => {
  const dir = tmp()
  const line = { ts: 1, flow: 'F1', req_id: 'r', job_id: null, attempt: 1, http: 200, latency_ms: 0, gen_id: 'stub-1', usage: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0 }, cost_known: true, finish_reason: 'tool_calls', llm_mode: 'stub', raw: '{}' }
  writeFileSync(join(dir, 'kiln.jsonl'), JSON.stringify(line) + '\n')
  const out = report(dir)
  assert.match(out, /^# .*\n\n> \*\*WARNING: STUB LLM DATA\.\*\* 1 of 1 kiln\.jsonl attempts/)
  rmSync(dir, { recursive: true })
})

test('missing and partial files render "no data" instead of throwing', () => {
  const empty = tmp()
  const out = report(empty)
  for (const s of ['kiln.jsonl MISSING', 'records/ MISSING', 'run.json MISSING', '_no data (kiln.jsonl missing or empty)_', 'NOT SETTLED']) assert.ok(out.includes(s), s)

  const partial = tmp()
  cpSync(FIX, partial, { recursive: true })
  writeFileSync(join(partial, 'kiln.jsonl'), readFileSync(join(FIX, 'kiln.jsonl'), 'utf8') + '{"flow":"F1","req_')
  mkdirSync(join(partial, 'records'), { recursive: true })
  writeFileSync(join(partial, 'records', '000099-0xdead.json'), '{"schema_version":1,"se')
  const p = analyze(partial)
  assert.deepEqual([p.sources.kiln.bad, p.sources.records.bad, p.flows.all.n], [1, 1, 17])
  assert.ok(report(partial).includes('kiln.jsonl 18 lines (1 malformed, skipped)'))
  rmSync(empty, { recursive: true })
  rmSync(partial, { recursive: true })
})

test('CLI prints the report and writes report.md into the bundle', () => {
  const dir = tmp()
  cpSync(FIX, dir, { recursive: true })
  const stdout = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'report.ts'), dir], { encoding: 'utf8' })
  assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), stdout)
  assert.ok(stdout.includes('| reconciliation | MATCH |'))
  rmSync(dir, { recursive: true })
})

test('approved outcome is fail-closed: Denied event in an OK tx, unconfirmed tx, non-boolean approve', () => {
  const dir = bundle({
    'events.jsonl': (s) => lines(s).flatMap((l) => {
      const e = JSON.parse(l)
      if (e.recHash === REC.req3 && e.ev === 'mined') e.events = [{ name: 'Denied', args: { jobId: '1', code: toBytes32('OVER_HOLD'), enforced: true }, logIndex: 0 }]
      if (e.recHash === REC.req6 && e.ev === 'mined') return [] // sent, never confirmed
      return [JSON.stringify(e)]
    }).join('\n') + '\n',
  })
  const extra = Buffer.from(JSON.stringify({ type: 'DECISION', body: { action: 'topUp', req_id: 'req-x', job_id: '1', gate: { codes: 'NOT_AN_ARRAY' }, f1: {}, verdict: { approve: 'true' } } }))
  writeFileSync(join(dir, 'records', '000099-extra.json'), extra)
  writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + JSON.stringify({ src: 'commit', recHash: hashBytes(extra), txHash: '0x01', status: 'OK', events: 'NOT_AN_ARRAY' }) + '\n')
  const by = Object.fromEntries(analyze(dir).reqs.map((r) => [r.req_id, [r.outcome, r.code]]))
  assert.deepEqual(by['req-3'], ['CHAIN_DENIED', 'OVER_HOLD'])
  assert.deepEqual(by['req-6'], ['TX_ERROR', 'UNCONFIRMED'])
  assert.notEqual(by['req-x'][0], 'APPROVED_ONCHAIN')
  rmSync(dir, { recursive: true })
})

test('per-request tokens never double count, even when two records share a req_id', () => {
  const dir = bundle({})
  writeFileSync(join(dir, 'records', '000099-dup.json'), JSON.stringify({ type: 'DECISION', body: { action: 'topUp', req_id: 'req-1', job_id: '1', gate: { codes: [] }, f1: [], f2: [], verdict: { approve: false, code: 'READ_FAILED' } } }))
  for (const x of [a, analyze(dir)]) {
    const { F1, F2 } = x.flows
    const t = x.reqs.reduce((n, r) => [n[0] + r.prompt, n[1] + r.completion, n[2] + r.n], [0, 0, 0])
    assert.deepEqual(t, [F1.prompt + F2.prompt, F1.completion + F2.completion, F1.n + F2.n])
  }
  rmSync(dir, { recursive: true })
})

test('INFERENCE reconciliation: MISMATCH, payee fallback, and no MATCH without complete kiln data', () => {
  const settle = (s: string) => s.replace('"amount":"883"', '"amount":"884"')
  const noInfJob = (s: string) => lines(s).filter((l) => !l.includes(REC.inf)).join('\n') + '\n' // inference open's commit lines gone
  const mis = bundle({ 'events.jsonl': (s) => noInfJob(settle(s)) })
  const m = analyze(mis)
  assert.deepEqual([m.session.onchain, m.session.infJobs, m.jobs.map((j) => j.id)], [884n, ['0'], ['1', '2']]) // found via inferencePayee
  assert.ok(report(mis).includes('| reconciliation | MISMATCH (on-chain − computed = 1 micro-USDC) |'))

  const partial = bundle({ 'kiln.jsonl': (s) => s + '{"flow":\n' })
  assert.ok(report(partial).includes('| reconciliation | CANNOT CHECK (kiln.jsonl has 1 malformed lines;'))
  rmSync(join(partial, 'kiln.jsonl'))
  assert.ok(report(partial).includes('| reconciliation | CANNOT CHECK (kiln.jsonl missing) |'))
  for (const d of [mis, partial]) rmSync(d, { recursive: true })
})

test('secret hygiene: RPC URLs and secret-named flags are redacted, no absolute paths', () => {
  const dir = bundle({ 'run.json': (s) => JSON.stringify({ ...JSON.parse(s), flags: { LLM_MODE: 'kiln', RPC_URL: 'https://base-sepolia.g.alchemy.com/v2/sEcReT123', KILN_API_KEY: 'sk-live-XYZ', AGENT: '0x' + 'ab'.repeat(32), CLOCK_MULT: 60 } }) })
  const out = report(dir)
  for (const leak of ['sEcReT123', 'sk-live-XYZ', 'ab'.repeat(32), dir]) assert.ok(!out.includes(leak), leak)
  assert.ok(out.includes('"LLM_MODE":"kiln"') && out.includes('"CLOCK_MULT":60') && out.includes('`nothink.jsonl` 6 lines'))
  rmSync(dir, { recursive: true })
})

test('cost is known only for a finite cost >= 0: usage null or a negative cost is unknown, not $0', () => {
  const dir = tmp()
  const l = (o: object) => JSON.stringify({ flow: 'F1', req_id: 'r', job_id: null, attempt: 1, http: 200, latency_ms: 1, gen_id: 'g', ...o })
  writeFileSync(join(dir, 'kiln.jsonl'), [l({ http: null, usage: null }), l({ usage: { completion_tokens: 5, cost: -0.001 } }), l({ usage: { completion_tokens: 5, cost: 0.0000011 } })].join('\n'))
  const x = analyze(dir)
  assert.deepEqual([x.flows.all.unknown, x.flows.all.pico, x.session.computed], [2, 1_100_000n, 2n]) // ceil(1.1 micro)
  assert.equal(x.flows.all.calls, 3) // same flow/req/job, but each attempt 1 starts a new call
  rmSync(dir, { recursive: true })
})

test('run.json LLM_MODE=stub alone triggers the stub warning', () => {
  const dir = bundle({ 'run.json': (s) => JSON.stringify({ ...JSON.parse(s), flags: { LLM_MODE: 'stub' } }) })
  assert.match(report(dir), /WARNING: STUB LLM DATA\.\*\* run\.json flags LLM_MODE=stub/)
  rmSync(dir, { recursive: true })
})

test('CLI exits 2 on a missing bundle directory', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'report.ts'), join(tmpdir(), 'no-such-bundle-xyz')], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /not a directory/)
})
