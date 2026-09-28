// T9 auditor golden tests (doc G1-G16) on bundles built inside the test with the real building blocks
// (deploy, RecordChain, Committer, makeSpec/signSpec) on a private anvil. No Kiln: KilnCalls are literal fixtures.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeEventLog, encodeAbiParameters, getAddress, keccak256, pad, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from '../src/abi.ts'
import { audit, type AuditResult } from '../src/audit.ts'
import { Committer, makeWallet } from '../src/chain.ts'
import { CHAINS, makePublicClient, snapshot } from '../src/chainread.ts'
import { toBytes32, type Code } from '../src/codes.ts'
import { ANVIL_FOUNDER_PK, deploy, loadAgentKey } from '../src/deploy.ts'
import { RecordChain, serialize, type KilnCall, type RecordType } from '../src/record.ts'
import { check, type GateInput } from '../src/rules.ts'
import { makeSpec, parseSpecForGate, signSpec } from '../src/spec.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const NO_JOB = 2n ** 256n - 1n
const OTHER_VAULT = getAddress('0x000000000000000000000000000000000000dEaD')
const ATTACKER_REC = keccak256(Buffer.from('attacker'))

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => res(port))
    })
  })

// ---- result helpers ----
const has = (r: AuditResult, level: string, check: string, re?: RegExp) =>
  r.findings.some((f) => f.level === level && f.check === check && (!re || re.test(f.msg)))
const show = (r: AuditResult) => r.findings.map((f) => `[${f.level}] ${f.check}: ${f.msg}`).join('\n') + `\n=> ${r.verdict} ${r.reason ?? ''}`

test('import boundary: audit.ts imports only the read side (rules, parse, record, chainread, codes, spec, abi, types, node, viem)', () => {
  const src = readFileSync(new URL('../src/audit.ts', import.meta.url), 'utf8')
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.ok(specs.length > 0)
  const allowed = new Set(['./rules.ts', './parse.ts', './record.ts', './chainread.ts', './codes.ts', './spec.ts', './abi.ts', './types.ts'])
  for (const s of specs) assert.ok(allowed.has(s) || s.startsWith('node:') || s === 'viem' || s.startsWith('viem/'), `forbidden import ${s}`)
  assert.doesNotMatch(src, /(executor|kiln|akash|session|scenarios|server|deploy|\/chain|\/run)\.ts/)
})

describe('auditor on anvil', { skip: ANVIL ? false : 'anvil binary not found ($HOME/.foundry/bin/anvil or PATH): skipping auditor golden tests' }, () => {
  let anvil: ChildProcess
  let url: string
  let client: PublicClient
  let root: string
  let good: string // G1 golden bundle
  let bad: string // G11/G13/G14 + check-4 violations
  let goodRes: AuditResult

  /** Builds one bundle: runs/<vault>/ with run.json, spec.json/.sig, prices/, records/, events.jsonl. */
  async function build(variant: 'good' | 'bad'): Promise<string> {
    const now = Number((await client.getBlock()).timestamp)
    const dep = await deploy({
      chain: 'anvil', rpcUrls: [url], founderPk: ANVIL_FOUNDER_PK, budget: 20_000_000n, maxHold: 6_000_000n,
      deadline: now + 36 * 3600, label: variant, outDir: join(root, 'deployments'), keysDir: join(root, 'keys'),
    })
    const dir = join(root, 'runs', dep.vault)
    mkdirSync(join(dir, 'prices'), { recursive: true })
    const runId = `${variant}-${dep.vault.slice(2, 10)}`
    const agentPk = loadAgentKey(dep.vault, join(root, 'keys'))
    const records = new RecordChain(join(dir, 'records'), runId)
    const c = new Committer({
      client, vault: dep.vault, records, eventsPath: join(dir, 'events.jsonl'),
      wallets: { agent: makeWallet('anvil', [url], agentPk), founder: makeWallet('anvil', [url], ANVIL_FOUNDER_PK) },
    })
    const attacker = makeWallet('anvil', [url], agentPk) // stolen agent key, bypassing the backend and the records
    const attack = async (functionName: string, args: unknown[]) => {
      const hash = await attacker.writeContract({ address: dep.vault, abi: vaultAbi, functionName, args, account: attacker.account!, chain: CHAINS.anvil } as any)
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
    }
    const mode: KilnCall['llm_mode'] = variant === 'bad' ? 'stub' : 'kiln'

    // spec (G13: the bad bundle carries a correctly signed spec for ANOTHER vault)
    const specBytes = makeSpec({
      spec_id: `spec-${runId}`, vault: variant === 'bad' ? OTHER_VAULT : dep.vault, chain_id: dep.chainId, issued_at: new Date(now * 1000).toISOString(),
      purpose: 'fine-tune a 7B model on the eval set', success_metric: 'eval loss < 1.0', allowed_gpu_types: ['h100'], job_cap_usd: '12', deadline: dep.deadline,
    })
    const specSig = await signSpec(specBytes, privateKeyToAccount(ANVIL_FOUNDER_PK))
    writeFileSync(join(dir, 'spec.json'), specBytes)
    writeFileSync(join(dir, 'spec.sig'), specSig)
    // bad: the anchored price snapshot says vendor A has no capacity (a DECISION below claims otherwise)
    const prices = { source: 'SNAPSHOT:test', snapshotHash: keccak256(Buffer.from('prices')), gpu: 'h100', vendors: Object.fromEntries((['A', 'B', 'C'] as const).map((l) => [l, { provider: `p${l}`, hostUri: `https://${l}`, pricePerHour: '2500000', available: variant === 'bad' && l === 'A' ? 0 : 3 }])) }
    writeFileSync(join(dir, 'prices', 'akash.json'), serialize(prices))
    records.append('SESSION_START', {
      vault: dep.vault, chainId: dep.chainId, deployBlock: dep.deployBlock, founder: dep.founder, agent: dep.agent, feeTo: dep.feeTo,
      inferencePayee: dep.inferencePayee, vendors: dep.vendors, spec_raw: specBytes.toString('utf8'), spec_sig: specSig, prices, scenario: variant, flags: { LLM_MODE: mode },
    })

    // ---- helpers following the orchestrator's record schemas ----
    let reqN = 0
    const gate = async (kind: GateInput['kind'], vendor: Hex, amount: bigint, specGross: bigint, losses: number[] = []): Promise<GateInput> => {
      const s = await snapshot(client, dep.vault, { vendors: [vendor] })
      return {
        kind,
        chain: { block: s.block, blockTs: s.blockTs, paused: s.paused, deadline: s.deadline, budget: s.budget, committed: s.committed, maxHold: s.maxHold, inferencePayee: s.inferencePayee, vendorAllowed: s.vendorAllowed[vendor.toLowerCase()] === true },
        spec: parseSpecForGate(specBytes), request: { vendor, gpu: kind === 'inference' ? '' : 'h100', amount },
        market: kind === 'inference' ? { pricePerHour: 0n, available: 0 } : { pricePerHour: 2_500_000n, available: 3 }, specGross, losses,
      }
    }
    const kc = (flow: KilnCall['flow'], raw: string): KilnCall => ({
      flow, attempt: 1, http: 200, latency_ms: 900, gen_id: `${mode === 'stub' ? 'stub-' : 'gen-'}${flow}-${reqN}`,
      usage: { prompt_tokens: 400, completion_tokens: 40, reasoning_tokens: 0, cost: 0.00014 }, raw, finish_reason: 'stop', cost_known: true, llm_mode: mode,
    })
    const F1 = (amount: string) => kc('F1', JSON.stringify({ vendor_label: 'B', gpu: 'h100', amount_usd: amount, rationale: 'eval run needs more time' }))
    const APPROVE = () => kc('F2', '{"verdict":"approve","reason":"fits the purpose"}')
    const DENY = () => kc('F2', '{"verdict":"deny","reason":"outside the purpose"}')
    const decision = (gi: GateInput, o: { codes?: Code[]; verdict: { approve: true } | { approve: false; code: Code }; f1?: KilnCall[]; f2?: KilnCall[]; job_id?: string | null; fn: string; label?: string }) => ({
      action: gi.kind, req_id: `${runId}-r${++reqN}`, job_id: o.job_id ?? null, spec_id: `spec-${runId}`,
      request: { vendorLabel: o.label ?? 'B', vendor: gi.request.vendor, gpu: gi.request.gpu, amount: gi.request.amount.toString(), rationale: 'r' },
      gate: { input: JSON.parse(serialize(gi).toString('utf8')), codes: o.codes ?? check(gi) }, f1: o.f1 ?? [], f2: o.f2 ?? [],
      verdict: o.verdict, reason: 'test', tx: { fn: o.fn, args: [] }, overrides: [],
    })
    const send = async (signer: 'agent' | 'founder', fn: string, args: unknown[], expect: string, record: { type: RecordType; body: Record<string, unknown> } | null, status = 'OK') => {
      const out = await c.commit({ signer, fn, args, expect: [expect], record, req_id: null, job_id: null })
      assert.equal(out.status, status, `${fn}: ${JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
      return out as Extract<typeof out, { txHash: Hex }> & { jobId?: bigint }
    }
    const ckpt = (job: bigint, amount: bigint, signer: 'agent' | 'founder') => ({ type: 'CHECKPOINT' as const, body: { job_id: job.toString(), amount: amount.toString(), signer, reason: 'periodic', accrued: amount.toString(), settledNet: '0', runningMs: '1000', loss: 1.5 } })
    const close = (job: bigint, signer: 'agent' | 'founder') => ({ type: 'CLOSE' as const, body: { job_id: job.toString(), signer, reason: 'test', accrued: '0', settledNet: '0' } })
    const B = dep.vendors.B, INF = dep.inferencePayee

    // inference hold (D2: gate record only) + vendor B open
    const gInf = await gate('inference', INF, 50_000n, 0n)
    const inf = (await send('agent', 'open', [INF, 50_000n], 'HoldOpened', { type: 'DECISION', body: decision(gInf, { verdict: { approve: true }, fn: 'open', label: 'INFERENCE' }) })).jobId!
    const gB = await gate('open', B, 2_000_000n, 0n)
    const jobB = (await send('agent', 'open', [B, 2_000_000n], 'HoldOpened', { type: 'DECISION', body: decision(gB, { verdict: { approve: true }, f1: [F1('2')], f2: [APPROVE()], fn: 'open' }) })).jobId!

    if (variant === 'bad') {
      await attack('open', [dep.vendors.A, 1_000_000n, ATTACKER_REC]) // G11: a real hold with no record
      const g = await gate('topUp', B, 1_000_000n, 2_060_000n, [2, 1.5])
      // check 4a: codes that rules.check does not produce
      await send('agent', 'recordDecision', [jobB, toBytes32('GPU_TYPE_NOT_ALLOWED')], 'Denied', { type: 'DECISION', body: decision(g, { codes: ['GPU_TYPE_NOT_ALLOWED'], verdict: { approve: false, code: 'GPU_TYPE_NOT_ALLOWED' }, fn: 'recordDecision', job_id: jobB.toString() }) })
      // check 4b: a chain field that disagrees with the replay (codes recomputed so only the chain comparison fails)
      const g2: GateInput = { ...g, chain: { ...g.chain, committed: g.chain.committed - 1n } }
      await send('agent', 'recordDecision', [jobB, toBytes32('QWEN_DENIED')], 'Denied', { type: 'DECISION', body: decision(g2, { verdict: { approve: false, code: 'QWEN_DENIED' }, f1: [F1('1')], f2: [DENY()], fn: 'recordDecision', job_id: jobB.toString() }) })
      const approved = (gi: GateInput, fn: string, o: { label?: string; job_id?: string } = {}) => decision(gi, { verdict: { approve: true }, f1: [F1('1')], f2: [APPROVE()], fn, ...o })
      const C = dep.vendors.C
      // check 3: a spend whose DECISION carries no gate input (check 4 would have nothing to re-run)
      const gN = await gate('open', C, 1_000_000n, 5_000_000n)
      await send('agent', 'open', [C, 1_000_000n], 'HoldOpened', { type: 'DECISION', body: { ...approved(gN, 'open', { label: 'C' }), gate: { input: null, codes: [] } } })
      // check 3: a gate "read" dated at the spend's own block (anvil automines the open into the next block)
      const gF = await gate('open', C, 1_000_000n, 5_000_000n)
      await send('agent', 'open', [C, 1_000_000n], 'HoldOpened', { type: 'DECISION', body: approved({ ...gF, chain: { ...gF.chain, block: gF.chain.block + 1n } }, 'open', { label: 'C' }) })
      // check 3: verdict approve although the recorded F2 answer denies; and a spend the gate itself denied
      const gQ = await gate('open', C, 1_000_000n, 5_000_000n)
      await send('agent', 'open', [C, 1_000_000n], 'HoldOpened', { type: 'DECISION', body: decision(gQ, { verdict: { approve: true }, f1: [F1('1')], f2: [DENY()], fn: 'open', label: 'C' }) })
      const gG = await gate('open', C, 1_000_000n, 5_000_000n)
      await send('agent', 'open', [C, 1_000_000n], 'HoldOpened', { type: 'DECISION', body: approved({ ...gG, request: { ...gG.request, gpu: 'a100' } }, 'open', { label: 'C' }) })
      // check 4: market available 3 for A, but SESSION_START.prices says 0 (hides NO_CAPACITY)
      const gA = await gate('open', dep.vendors.A, 1_000_000n, 9_000_000n)
      await send('agent', 'open', [dep.vendors.A, 1_000_000n], 'HoldOpened', { type: 'DECISION', body: approved(gA, 'open', { label: 'A' }) })
      // check 4: specGross 0 although gated vendor spends already reserved more (hides OVER_JOB_CAP)
      const gS = await gate('topUp', B, 1_000_000n, 0n)
      await send('agent', 'topUp', [jobB, 1_000_000n], 'ToppedUp', { type: 'DECISION', body: approved(gS, 'topUp', { job_id: jobB.toString() }) })
    } else {
      await attack('open', [dep.vendors.A, 7_000_000n, ATTACKER_REC]) // G5: stolen key -> Denied(OVER_MAX_HOLD), no record
      await send('agent', 'settle', [jobB, 1_000_033n], 'Settled', ckpt(jobB, 1_000_033n, 'agent')) // G7 split settle 1 (fee 30_000)
      // G12: approval read while unpaused, founder STOP lands first, the contract answers Denied(PAUSED)
      const gT = await gate('topUp', B, 1_000_000n, 2_060_000n, [2, 1.5])
      await send('founder', 'setPaused', [true], 'PausedSet', { type: 'STOP', body: { reason: 'MANUAL', by: 'founder' } })
      const den = await send('agent', 'topUp', [jobB, 1_000_000n], 'ToppedUp', { type: 'DECISION', body: decision(gT, { verdict: { approve: true }, f1: [F1('1')], f2: [APPROVE()], fn: 'topUp', job_id: jobB.toString() }) }, 'DENIED')
      records.append('CHAIN_DENIED', { req_id: `${runId}-r${reqN}`, job_id: jobB.toString(), approval: den.recHash, code: (den as { code?: string }).code, txHash: den.txHash })
      await send('founder', 'setPaused', [false], 'PausedSet', { type: 'STOP', body: { reason: 'RESUME', by: 'founder' } })
      await send('agent', 'settle', [jobB, 33n], 'Settled', ckpt(jobB, 33n, 'agent')) // G8 settle after unpause; G7 split settle 2 (fee 0, the sum would floor to 1 more)
      // Qwen deny -> recordDecision, then the stolen key replays that rec (G6)
      const gD = await gate('topUp', B, 1_000_000n, 2_060_000n, [2, 1.5, 1.2])
      const deny = await send('agent', 'recordDecision', [jobB, toBytes32('QWEN_DENIED')], 'Denied', { type: 'DECISION', body: decision(gD, { verdict: { approve: false, code: 'QWEN_DENIED' }, f1: [F1('1')], f2: [DENY()], fn: 'recordDecision', job_id: jobB.toString() }) })
      await attack('recordDecision', [NO_JOB, toBytes32('QWEN_DENIED'), deny.recHash])
      // G15: founder de-allowlists B BEFORE the founder settle pays it
      await send('founder', 'setVendor', [B, false], 'VendorSet', null)
      await send('founder', 'settle', [jobB, 100n], 'Settled', ckpt(jobB, 100n, 'founder'))
      await send('agent', 'close', [jobB], 'Closed', close(jobB, 'agent'))
      await send('agent', 'settle', [inf, 1_234n], 'Settled', ckpt(inf, 1_234n, 'agent')) // inference: fee 0
      await send('agent', 'close', [inf], 'Closed', close(inf, 'agent'))
    }
    const r = (fn: string) => client.readContract({ address: dep.vault, abi: vaultAbi, functionName: fn } as any) as Promise<bigint>
    const refund = (await r('budget')) - (await r('committed'))
    await send('founder', 'refund', [refund], 'Refunded', { type: 'SESSION_END', body: { refund: refund.toString(), inference_usage: '1234', kiln_calls: 6, kiln_cost_unknown: 0, jobs: [inf.toString(), jobB.toString()] } })

    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      run_id: runId, scenario: variant, chain: 'anvil', chainId: dep.chainId, vault: dep.vault, usdc: dep.usdc, founder: dep.founder, agent: dep.agent,
      feeTo: dep.feeTo, inferencePayee: dep.inferencePayee, vendors: dep.vendors, deployBlock: dep.deployBlock,
      lastBlock: Number(await client.getBlockNumber({ cacheTime: 0 })), rpc: url, gitSha: 'test', flags: { LLM_MODE: mode },
    }, null, 2) + '\n')
    return dir
  }

  /** A mutated copy of the golden bundle. */
  let copies = 0
  const variant = (mutate: (dir: string) => void, from = good) => {
    const d = join(root, 'copies', String(copies++))
    cpSync(from, d, { recursive: true })
    mutate(d)
    return d
  }
  const recFiles = (d: string) => readdirSync(join(d, 'records')).sort().map((f) => join(d, 'records', f))
  const flipByte = (file: string, at: (b: Buffer) => number) => {
    const b = readFileSync(file)
    const i = at(b)
    b[i] = b[i] === 0x31 ? 0x32 : 0x31
    writeFileSync(file, b)
  }
  const run = (d: string, o: { submission?: boolean; rpc?: string } = {}) => audit(d, { rpc: url, ...o })

  before(async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    anvil = spawn(ANVIL!, ['--port', String(port)], { stdio: 'ignore' })
    client = makePublicClient('anvil', [url])
    for (let t = 0; ; t++) {
      try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)) }
    }
    root = mkdtempSync(join(tmpdir(), 'audit-'))
    good = await build('good')
    bad = await build('bad')
    goodRes = await run(good)
  })

  after(() => {
    anvil?.kill()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('G1 golden bundle PASS; G5 stolen key -> UNRECORDED_ATTEMPT WARN (exit 0); G6 DUPLICATE_REC_REF; G12 CHAIN_OVERRIDE INFO', () => {
    const r = goodRes
    assert.equal(r.verdict, 'PASS', show(r))
    assert.equal(r.exitCode, 0)
    for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', 'receipts']) assert.ok(has(r, 'PASS', id), `check ${id} PASS\n${show(r)}`)
    assert.ok(has(r, 'WARN', '8', /UNRECORDED_ATTEMPT.*sender 0x[0-9a-fA-F]{40} code OVER_MAX_HOLD/), show(r))
    assert.ok(has(r, 'WARN', '8', /DUPLICATE_REC_REF/), show(r))
    assert.ok(has(r, 'INFO', '8', /CHAIN_OVERRIDE.*Denied\(PAUSED\)/), show(r))
    assert.equal(r.attacks.length, 2) // listed apart from the backend's 1:1 ledger
    assert.ok(has(r, 'PASS', '1', /anchored up to #(\d+) \/ (\d+)/))
  })

  test('G7 split settles use the per-settle floor; G8 settle after unpause PASS; G15 founder settle to a de-allowlisted vendor PASS', () => {
    // settles 1_000_033 (fee 30_000) + 33 (fee 0): an aggregate floor would expect 30_001 and fail check 6
    assert.ok(has(goodRes, 'PASS', '6'))
    assert.ok(has(goodRes, 'PASS', '7'))
    assert.ok(has(goodRes, 'PASS', '5', /4 settles/), show(goodRes))
  })

  test('--submission: a kiln bundle passes, a stub bundle FAILs (G14); without the flag stub calls are not judged', async () => {
    const ok = await run(good, { submission: true })
    assert.ok(has(ok, 'PASS', 'submission'), show(ok))
    const r = await run(bad, { submission: true })
    assert.ok(has(r, 'FAIL', 'submission', /stub Kiln calls in \d+ record/), show(r)) // found in the calls, not only the LLM_MODE flag
    assert.ok(!(await run(bad)).findings.some((f) => f.check === 'submission'))
  })

  test('G11 HoldOpened without a record -> UNGATED_SPEND; G13 spec for another vault -> FAIL check 2; check 4 catches wrong codes and a chain field off the replay', async () => {
    const r = await run(bad)
    assert.equal(r.verdict, 'FAIL')
    assert.equal(r.exitCode, 1)
    assert.ok(has(r, 'FAIL', '3', /UNGATED_SPEND: HoldOpened/), show(r))
    assert.ok(has(r, 'FAIL', '2', /spec is for vault 0x000000000000000000000000000000000000dEaD/), show(r))
    assert.ok(has(r, 'FAIL', '4', /rules\.check = \[\], record says \["GPU_TYPE_NOT_ALLOWED"\]/), show(r))
    assert.ok(has(r, 'FAIL', '4', /committed recorded \d+, replay \d+/), show(r))
    assert.ok(has(r, 'PASS', '1'), show(r)) // the record chain itself is intact
  })

  test('forged gate inputs FAIL: null gate.input on a spend, a read not before the spend, market off the price snapshot, specGross under the replay', async () => {
    const r = await run(bad)
    assert.ok(has(r, 'FAIL', '3', /HoldOpened.*gate\.input is null/), show(r))
    assert.ok(has(r, 'FAIL', '3', /HoldOpened.*gate read at block (\d+), not before the spend/), show(r))
    assert.ok(has(r, 'FAIL', '3', /HoldOpened.*last F2 raw does not parse to approve/), show(r))
    assert.ok(has(r, 'FAIL', '3', /HoldOpened.*gate\.codes \["GPU_TYPE_NOT_ALLOWED"\] not \[\]/), show(r))
    assert.ok(has(r, 'FAIL', '4', /market available 3 is neither SESSION_START\.prices A nor a recorded override/), show(r))
    assert.ok(has(r, 'FAIL', '4', /specGross 0 < \d+ gross already reserved/), show(r))
  })

  test('a truncated bundle (records and lastBlock cut after a settle) FAILs: the vault did more than the replay shows', async () => {
    const d = variant((d) => {
      const lines = readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const at = lines.findIndex((l) => l.src === 'commit' && l.ev === 'mined' && l.fn === 'settle')
      const cut = lines[at]
      writeFileSync(join(d, 'events.jsonl'), lines.slice(0, at + 1).map((l) => JSON.stringify(l) + '\n').join(''))
      const files = recFiles(d)
      const keep = files.findIndex((f) => f.includes(cut.recHash))
      assert.ok(keep > 0 && keep < files.length - 1)
      for (const f of files.slice(keep + 1)) unlinkSync(f)
      const p = join(d, 'run.json')
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), lastBlock: Number(cut.block) }))
    })
    const r = await run(d)
    assert.equal(r.exitCode, 1, show(r))
    assert.deepEqual([...new Set(r.findings.filter((f) => f.level === 'FAIL').map((f) => f.check))], ['bundle'], show(r)) // chain, tail and rules all look fine
    assert.ok(has(r, 'FAIL', 'bundle', /outside the audited range/), show(r))
    // a run.json deployBlock moved past the anchored SESSION_START.deployBlock (would skip early events)
    const late = await run(variant((d) => { const p = join(d, 'run.json'); const j = JSON.parse(readFileSync(p, 'utf8')); j.deployBlock += 3; writeFileSync(p, JSON.stringify(j)) }))
    assert.ok(has(late, 'FAIL', '2', /from block \d+, run\.json says .* from block \d+/), show(late))
  })

  test('a stolen-key Denied that front-runs the rec of a backend settle leaves the settle gated (WARN only)', async () => {
    const lines = readFileSync(join(good, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const settleRec = lines.find((l) => l.src === 'commit' && l.ev === 'mined' && l.fn === 'settle').recHash as Hex
    const frontRun = {
      ...client,
      getLogs: async (p: any) => (await client.getLogs(p)).map((l) => (l.topics[3] === ATTACKER_REC ? { ...l, topics: [l.topics[0], l.topics[1], l.topics[2], settleRec] as any } : l)),
    } as PublicClient
    const r = await audit(good, { client: frontRun })
    assert.equal(r.verdict, 'PASS', show(r))
    assert.ok(has(r, 'WARN', '8', /DUPLICATE_REC_REF/), show(r))
  })

  test('a vault that does not enforce its rules (same events, lax contract) FAILs checks 5, 6 and 7', async () => {
    // Simulated with rewritten logs: the auditor must judge the events itself, not trust the contract.
    const vendorA = pad(JSON.parse(readFileSync(join(good, 'run.json'), 'utf8')).vendors.A.toLowerCase() as Hex)
    let settles = 0
    const lax = {
      ...client,
      getLogs: async (p: any) => (await client.getLogs(p)).map((l) => {
        const d = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as any }) as { eventName: string; args: any }
        const uints = (...v: bigint[]) => encodeAbiParameters(v.map(() => ({ type: 'uint256' })), v)
        if (d.eventName === 'Funded') return { ...l, data: uints(d.args.amount, d.args.budget, 1n) } // deadline long past
        if (d.eventName === 'PausedSet' && !d.args.paused) return { ...l, data: encodeAbiParameters([{ type: 'bool' }], [true]) } // the unpause never happened
        const i = d.eventName === 'Settled' ? settles++ : -1
        if (i === 0) return { ...l, data: uints(d.args.amount, d.args.fee + 1n) } // the 1_000_033 settle: fee off the floor
        if (i === 3) return { ...l, topics: [l.topics[0], l.topics[1], vendorA, l.topics[3]] as any } // the inference settle: not job.vendor
        return l
      }),
    } as PublicClient
    const r = await audit(good, { client: lax })
    assert.equal(r.exitCode, 1, show(r))
    assert.ok(has(r, 'FAIL', '6', /fee 30001 != floor\(1000033\*300\/10000\) = 30000/), show(r))
    assert.ok(has(r, 'FAIL', '5', /pays 0x[0-9a-fA-F]{40}, job \d+ vendor is/), show(r))
    assert.ok(has(r, 'FAIL', '7', /agent spend at \d+ >= deadline 1/), show(r))
    assert.ok(has(r, 'FAIL', '7', /Settled.*agent spend while paused/), show(r))
  })

  test('a malformed bundle FAILs (exit 1) instead of crashing the auditor', async () => {
    const nul = await run(variant((d) => writeFileSync(recFiles(d)[3], 'null')))
    assert.equal(nul.exitCode, 1, show(nul))
    assert.ok(has(nul, 'FAIL', '1', /not a JSON record object/), show(nul))
    const body = await run(variant((d) => { const f = recFiles(d)[2]; writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), body: null })) }))
    assert.equal(body.exitCode, 1, show(body))
    const runJson = await run(variant((d) => { const p = join(d, 'run.json'); const j = JSON.parse(readFileSync(p, 'utf8')); delete j.deployBlock; writeFileSync(p, JSON.stringify(j)) }))
    assert.equal(runJson.exitCode, 1, show(runJson))
    assert.ok(has(runJson, 'FAIL', 'bundle', /deployBlock/), show(runJson))
  })

  test('G2 one byte of a record -> FAIL check 1', async () => {
    const d = variant((d) => flipByte(recFiles(d)[3], (b) => b.indexOf('"t":') + 4))
    const r = await run(d)
    assert.equal(r.exitCode, 1)
    assert.ok(has(r, 'FAIL', '1', /content hash/), show(r))
  })

  test('G3 one byte of the spec -> FAIL check 2', async () => {
    const r = await run(variant((d) => flipByte(join(d, 'spec.json'), (b) => b.indexOf('"job_cap_usd":"') + 15)))
    assert.equal(r.exitCode, 1)
    assert.ok(has(r, 'FAIL', '2', /spec_raw != spec.json/), show(r))
    assert.ok(has(r, 'FAIL', '2', /spec signed by 0x[0-9a-fA-F]{40}, vault.founder\(\)/), show(r))
  })

  test('G4 a deleted middle record -> FAIL check 1', async () => {
    const r = await run(variant((d) => unlinkSync(recFiles(d)[6])))
    assert.equal(r.exitCode, 1)
    assert.ok(has(r, 'FAIL', '1', /seq \d+, expected \d+|prev/), show(r))
  })

  test('G10 last record tampered or deleted -> UNANCHORED_TAIL', async () => {
    const tampered = await run(variant((d) => flipByte(recFiles(d).at(-1)!, (b) => b.indexOf('"t":') + 4)))
    assert.ok(has(tampered, 'FAIL', '1', /UNANCHORED_TAIL/), show(tampered))
    const deleted = await run(variant((d) => unlinkSync(recFiles(d).at(-1)!)))
    assert.ok(has(deleted, 'FAIL', '1', /UNANCHORED_TAIL/), show(deleted))
    assert.ok(has(deleted, 'FAIL', '1', /Refunded.*names no record/), show(deleted))
    // a record appended after the last anchor (e.g. a RECEIPT) is unanchored too
    const appended = await run(variant((d) => { new RecordChain(join(d, 'records'), 'x').append('RECEIPT', { job_id: '1', f3: [], text: 'late' }) }))
    assert.ok(has(appended, 'FAIL', '1', /UNANCHORED_TAIL/), show(appended))
  })

  test('G9 head < lastBlock, an unreachable RPC or a chainId mismatch -> CANNOT_VERIFY (exit 2)', async () => {
    const head = await client.getBlockNumber({ cacheTime: 0 })
    const edit = (d: string, f: (j: any) => void) => { const p = join(d, 'run.json'); const j = JSON.parse(readFileSync(p, 'utf8')); f(j); writeFileSync(p, JSON.stringify(j)) }
    const ahead = await run(variant((d) => edit(d, (j) => { j.lastBlock = Number(head) + 1000 })))
    assert.equal(ahead.exitCode, 2, show(ahead))
    assert.match(ahead.reason!, /head \d+ < run.json lastBlock/)
    const dead = await run(good, { rpc: `http://127.0.0.1:${await freePort()}` })
    assert.equal(dead.verdict, 'CANNOT_VERIFY', show(dead))
    assert.match(dead.reason!, /RPC unreachable/)
    const wrong = await audit(good, { client: { ...client, getChainId: async () => 84532 } as PublicClient }) // an RPC for another chain
    assert.equal(wrong.exitCode, 2, show(wrong))
    assert.match(wrong.reason!, /chainId 84532 != run.json chainId 31337/)
  })

  test('G16 an autocrlf checkout of the whole bundle still PASSes (records carry no LF); a record that picked up CRLF FAILs with the hint', async () => {
    const lf2crlf = (p: string) => writeFileSync(p, readFileSync(p, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1')
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]))
    const whole = await run(variant((d) => all(d).forEach(lf2crlf)))
    assert.equal(whole.verdict, 'PASS', show(whole))
    const r = await run(variant((d) => appendFileSync(recFiles(d)[4], '\r\n')))
    assert.equal(r.exitCode, 1)
    assert.ok(has(r, 'FAIL', '1', /CRLF.*autocrlf/), show(r))
  })

  test('a backend tx hash in events.jsonl with no receipt -> FAIL', async () => {
    const r = await run(variant((d) => appendFileSync(join(d, 'events.jsonl'), JSON.stringify({ ts: 0, run_id: 'x', req_id: null, job_id: null, src: 'commit', ev: 'mined', schema_version: 1, fn: 'settle', txHash: keccak256(Buffer.from('never')) }) + '\n')))
    assert.ok(has(r, 'FAIL', 'receipts', /no receipt/), show(r))
  })

  test('CLI: one line per check, exit codes 0 / 1 / 2, --json', async () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('../src/audit.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' })
    const ok = cli(good)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /^\[PASS\] check 1 \(records\): /m)
    assert.match(ok.stdout, /^\[WARN\] check 8 \(denials\): UNRECORDED_ATTEMPT/m)
    assert.match(ok.stdout, /^AUDIT PASS \(exit 0\)/m)
    const j = JSON.parse(cli(good, '--json').stdout)
    assert.equal(j.verdict, 'PASS')
    assert.equal(cli(bad).status, 1)
    const dead = cli(good, '--rpc', `http://127.0.0.1:${await freePort()}`)
    assert.equal(dead.status, 2)
    assert.match(dead.stdout, /AUDIT CANNOT_VERIFY \(exit 2\): RPC unreachable/)
    assert.doesNotMatch(dead.stdout + dead.stderr, /127\.0\.0\.1/) // the RPC URL is never echoed
  })
})
