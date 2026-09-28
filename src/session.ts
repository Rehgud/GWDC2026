// The orchestrator: one Session runs one session on one freshly deployed vault (one recording = one vault = one bundle).
// It glues chain (Committer), chainread (snapshot), executor (tick/next/windDown), kiln (llm), rules (gate),
// akash (prices), spec, record and report together. All txs go through the Committer; no-tx records
// (SESSION_START, CHAIN_DENIED) go straight to RecordChain.append. The auditor (src/audit.ts) and the
// dashboard (src/server.ts) are built by other agents against record.ts and types.ts, not against this file.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getAddress, keccak256, parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from './abi.ts'
import { Committer, makeWallet, type Intent as TxIntent } from './chain.ts'
import { CHAINS, makePublicClient, snapshot, ReadFailed } from './chainread.ts'
import { toBytes32, TRANSIENT, type Code } from './codes.ts'
import { deploy, preflight, ANVIL_FOUNDER_PK, type DeployOpts } from './deploy.ts'
import {
  newJob, next, tick, planWindDown,
  type Job, type JobEvent, type Action, type Intent as ExecIntent,
} from './executor.ts'
import { llm, costToMicro, llmStats, type LlmCtx, type LlmReq, type LlmResult, type Stub } from './kiln.ts'
import { parseF1, parseVerdict } from './parse.ts'
import { f1Messages, f2Messages, f3Messages, F1_TOOL, F2_TOOL, usd } from './prompts.ts'
import { loadPrices } from './akash.ts'
import { check, gross, maxNet, type GateInput } from './rules.ts'
import { RecordChain, serialize, type Decision, type Override, type KilnCall } from './record.ts'
import { makeSpec, signSpec, parseSpecForGate, type Spec } from './spec.ts'
import { report } from './report.ts'
import type {
  ChainName, ChainSnapshot, Deployment, EventLine, Outcome, PriceBook, StateView, ActionRequest,
  TopupResult, VendorLabel, StopStage,
} from './types.ts'
import type { Intervention, ScenarioDef } from './scenarios.ts'

const NO_JOB = 2n ** 256n - 1n
const INFERENCE_HOLD = 50_000n // $0.05 fixed (D2)
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Hex
const CODE_ORDER: Code[] = ['PAUSED', 'PAST_DEADLINE', 'VENDOR_NOT_ALLOWED', 'GPU_TYPE_NOT_ALLOWED', 'NO_CAPACITY', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE', 'OVER_JOB_CAP', 'NAN_DETECTED', 'LOSS_PLATEAU']
const ACTION_ORDER: Record<Action['type'], number> = { CHECKPOINT_SETTLE: 0, REQUEST_TOPUP: 1, TOPUP_TIMEOUT: 1, STOPPED: 2 }

export type SessionOpts = {
  chain: ChainName
  rpcUrls: string[]
  publicRpc: string // PUBLIC rpc written to run.json for the auditor (never a URL with a key)
  deployment: Deployment
  agentPk: Hex
  founderPk: Hex
  runsDir?: string // default 'runs'
  scenario: ScenarioDef
  llm: { mode: 'kiln' | 'stub'; stub?: Stub; cap?: number }
  speed?: number // virtual-clock multiplier (default 1)
  deadlineMarginS?: bigint // default 15n; 0n for the deadline demo
  onEvent?: (line: EventLine) => void
  priceFetch?: typeof fetch // tests pass a fast-failing fetch so loadPrices falls back to the committed snapshot
  priceTimeoutMs?: number
  hardCapMs?: number
}

type Slot = { label: string; job: Job; f3Done: boolean; closing: boolean; demoSettled: boolean }
type Topup = StateView['topups'][number]
const dec = (x: bigint) => x.toString()

export function isRearmable(j: Job): boolean {
  return j.latch === 'denied' && j.denyCode !== null && TRANSIENT.has(j.denyCode) && j.rearms < 1
}

export class Session {
  readonly o: SessionOpts
  readonly dep: Deployment
  readonly dir: string
  readonly scenario: ScenarioDef
  readonly speed: number
  readonly deadlineMarginS: bigint
  readonly client
  readonly committer: Committer
  readonly records: RecordChain
  readonly llmCtx: LlmCtx

  spec!: Spec
  specBytes!: Buffer
  specSig!: Hex
  prices!: PriceBook
  version = 0
  stopStage: StopStage = 'RUNNING'
  topups: Topup[] = []
  ledger: StateView['ledger'] = []
  receipts: StateView['receipts'] = []
  lastSnapshot: ChainSnapshot | null = null

  private started = false
  private windDownP: Promise<void> | null = null
  private ended = false
  private stopping = false
  private reqSeq = 0
  private specGross = 0n
  private slots: Slot[] = []
  private inference: { slot: Slot; jobId: bigint } | null = null
  private inflight = new Set<Promise<unknown>>()
  private execLog: string[] = []
  private injectedLines: string[] = []
  private f1Overrides: { field: string; value: unknown }[] = []
  private pendingOverrides: Override[] = []
  private marketOverrides: Partial<Record<string, { pricePerHour?: bigint; available?: number }>> = {}
  private firedSteps = new Set<number>()
  private kilnCosts: (number | null)[] = []
  private deadlineDemoDone = false
  private realT0 = 0
  private virtT0 = 0

  constructor(o: SessionOpts) {
    this.o = o
    this.dep = o.deployment
    this.scenario = o.scenario
    this.speed = o.speed ?? 1
    this.deadlineMarginS = o.deadlineMarginS ?? 15n
    this.dir = join(o.runsDir ?? 'runs', getAddress(this.dep.vault))
    mkdirSync(this.dir, { recursive: true })
    this.client = makePublicClient(o.chain, o.rpcUrls)
    this.records = new RecordChain(join(this.dir, 'records'), this.runId)
    this.committer = new Committer({
      client: this.client, vault: this.dep.vault, records: this.records, eventsPath: this.eventsPath,
      wallets: { agent: makeWallet(o.chain, o.rpcUrls, o.agentPk), founder: makeWallet(o.chain, o.rpcUrls, o.founderPk) },
    })
    this.llmCtx = { mode: o.llm.mode, stub: o.llm.stub, cap: o.llm.cap, sink: join(this.dir, 'kiln.jsonl') }
  }

  get runId() { return `${this.dep.label}-${this.dep.vault.slice(2, 10)}` }
  private get eventsPath() { return join(this.dir, 'events.jsonl') }
  private get budgetMicro() { return BigInt(this.dep.budget) }
  private get maxHoldMicro() { return BigInt(this.dep.maxHold) }
  private simMinute() { return (Date.now() - this.realT0) * this.speed / 1000 }
  private virtNow() { return this.virtT0 + (Date.now() - this.realT0) * this.speed }
  private bump() { this.version++ }
  private newReqId() { return `${this.runId}-r${++this.reqSeq}` }

  private logEvent(src: EventLine['src'], ev: string, extra: Record<string, unknown> = {}, req_id: string | null = null, job_id: string | null = null) {
    const line: EventLine = { ts: Date.now(), run_id: this.runId, req_id, job_id, src, ev, schema_version: 1, ...extra }
    try { appendFileSync(this.eventsPath, serialize(line).toString('utf8') + '\n') } catch {}
    this.o.onEvent?.(line)
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p as unknown as Promise<unknown>)
    p.finally(() => this.inflight.delete(p as unknown as Promise<unknown>))
    return p
  }

  private async callLlm(req: LlmReq): Promise<LlmResult> {
    const r = await this.track(llm(req, this.llmCtx))
    for (const c of r.calls) this.kilnCosts.push(c.usage?.cost ?? null)
    return r
  }

  private market(label: string) {
    const base = (this.prices.vendors as Record<string, { pricePerHour: bigint; available: number }>)[label]
    if (!base) return { pricePerHour: 0n, available: 0 }
    const ov = this.marketOverrides[label]
    return { pricePerHour: ov?.pricePerHour ?? base.pricePerHour, available: ov?.available ?? base.available }
  }

  private resolveVendor(label: string): Hex {
    if (label === 'A' || label === 'B' || label === 'C') return this.dep.vendors[label as VendorLabel]
    return ZERO_ADDR // unknown label -> gate VENDOR_NOT_ALLOWED (doc)
  }

  // ---- static: deploy a fresh vault for a scenario ----
  static async deployFor(scenario: ScenarioDef, o: {
    chain: ChainName; rpcUrls: string[]; founderPk?: Hex; keysDir?: string; outDir?: string; log?: (s: string) => void; now?: number
  }): Promise<Deployment> {
    const founderPk = o.founderPk ?? (o.chain === 'anvil' ? ANVIL_FOUNDER_PK : undefined)
    if (!founderPk) throw new Error('founderPk required for base-sepolia')
    const client = makePublicClient(o.chain, o.rpcUrls)
    // Wall clock, not the latest block ts: an idle anvil's latest block can be seconds/minutes stale, which would
    // put a short scenario deadline in the past. New blocks are timestamped at wall clock, so this matches the chain.
    const now = o.now ?? Math.floor(Date.now() / 1000)
    const v = scenario.vault
    const dep = await deploy({
      chain: o.chain, rpcUrls: o.rpcUrls, founderPk, label: scenario.name,
      budget: parseUnits(v.budgetUsd, 6), maxHold: parseUnits(v.maxHoldUsd, 6),
      deadline: now + Math.round(v.deadlineHours * 3600), keysDir: o.keysDir, outDir: o.outDir, log: o.log,
    } satisfies DeployOpts)
    const fails = await preflight(dep, client, { relaxDeadline: v.deadlineHours < 2 })
    if (fails.length) throw new Error(`preflight failed: ${fails.join(', ')}`)
    return dep
  }

  // ---- start ----
  async start() {
    if (this.started) throw new Error('already started')
    // One recording = one vault = one bundle. A non-empty bundle means this vault was already recorded (on anvil the
    // deploy address is deterministic and collides across fresh chains): fail loudly instead of concatenating sessions.
    if (this.records.seq !== 0) throw new Error(`bundle ${this.dir} already has ${this.records.seq} records; deploy a fresh vault or clear the bundle`)
    this.started = true
    this.realT0 = Date.now()
    this.virtT0 = Date.now()
    this.prices = (await loadPrices({ fetch: this.o.priceFetch, timeoutMs: this.o.priceTimeoutMs })).book
    const now = Math.floor(Date.now() / 1000)
    this.spec = this.scenario.spec({ vault: this.dep.vault, chainId: this.dep.chainId, now })
    this.specBytes = makeSpec(this.spec)
    this.specSig = await signSpec(this.specBytes, privateKeyToAccount(this.o.founderPk))
    mkdirSync(join(this.dir, 'prices'), { recursive: true })
    writeFileSync(join(this.dir, 'prices', 'akash.json'), serialize({ source: this.prices.source, fetchedAt: this.prices.fetchedAt, gpu: this.prices.gpu, vendors: this.prices.vendors }))
    writeFileSync(join(this.dir, 'spec.json'), this.specBytes)
    writeFileSync(join(this.dir, 'spec.sig'), this.specSig)
    this.writeRunJson(null)
    this.records.append('SESSION_START', {
      vault: this.dep.vault, chainId: this.dep.chainId, deployBlock: this.dep.deployBlock,
      founder: this.dep.founder, agent: this.dep.agent, feeTo: this.dep.feeTo, inferencePayee: this.dep.inferencePayee,
      vendors: this.dep.vendors, spec_raw: this.specBytes.toString('utf8'), spec_sig: this.specSig,
      prices: { source: this.prices.source, snapshotHash: this.prices.snapshotHash, gpu: this.prices.gpu, vendors: this.prices.vendors },
      scenario: this.scenario.name, flags: this.flags(),
    })
    this.bump()
    await this.openInference()
    await this.openVendor(this.scenario.firstVendor ?? 'B', false)
  }

  private flags(): Record<string, string> {
    return {
      LLM_MODE: this.o.llm.mode, SCENARIO: this.scenario.name, CLOCK: String(this.speed),
      DEADLINE_MARGIN_S: this.deadlineMarginS.toString(), LLM_CALL_CAP: String(this.o.llm.cap ?? process.env.LLM_CALL_CAP ?? 60),
    }
  }

  private writeRunJson(lastBlock: number | null) {
    const run = {
      run_id: this.runId, scenario: this.scenario.name, chain: this.o.chain, chainId: this.dep.chainId,
      vault: this.dep.vault, usdc: this.dep.usdc, founder: this.dep.founder, agent: this.dep.agent,
      feeTo: this.dep.feeTo, inferencePayee: this.dep.inferencePayee, vendors: this.dep.vendors,
      deployBlock: this.dep.deployBlock, lastBlock, rpc: this.o.publicRpc, gitSha: gitSha(), flags: this.flags(),
    }
    writeFileSync(join(this.dir, 'run.json'), JSON.stringify(run, null, 2) + '\n')
  }

  private async freshSnapshot(extraVendors: Hex[] = []): Promise<ChainSnapshot | null> {
    const vendors = [...Object.values(this.dep.vendors), this.dep.inferencePayee, ...extraVendors] as Hex[]
    try {
      const s = await snapshot(this.client, this.dep.vault, { vendors })
      this.lastSnapshot = s
      return s
    } catch (e) {
      if (e instanceof ReadFailed) { this.logEvent('watcher', 'read_failed', { err: e.name }); return null }
      throw e
    }
  }

  private async openInference() {
    const req_id = this.newReqId()
    const snap = await this.freshSnapshot()
    if (!snap) throw new Error('inference open: READ_FAILED at start')
    const gi = this.gateInput('inference', snap, { vendor: this.dep.inferencePayee, gpu: '', amount: INFERENCE_HOLD }, [])
    const codes = check(gi)
    if (codes.length) throw new Error(`inference open denied by gate: ${codes[0]}`)
    const slot: Slot = { label: 'INFERENCE', job: newJob(this.dep.inferencePayee, 1n, true), f3Done: true, closing: false, demoSettled: false }
    const body: Decision = {
      action: 'inference', req_id, job_id: null, spec_id: this.spec.spec_id,
      request: { vendorLabel: 'INFERENCE', vendor: this.dep.inferencePayee, gpu: '', amount: dec(INFERENCE_HOLD), rationale: 'session inference hold (D2)' },
      gate: { input: giJson(gi), codes: [] }, f1: [], f2: [], verdict: { approve: true }, reason: 'inference hold',
      tx: { fn: 'open', args: [this.dep.inferencePayee, dec(INFERENCE_HOLD)] }, overrides: [],
    }
    const out = await this.send({ signer: 'agent', fn: 'open', args: [this.dep.inferencePayee, INFERENCE_HOLD], expect: ['HoldOpened'], req_id, job_id: null, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> } })
    if (out.status !== 'OK' || out.jobId === undefined) throw new Error(`inference open failed: ${out.status}`)
    slot.job = next(slot.job, { type: 'HoldOpened', jobId: out.jobId, gross: INFERENCE_HOLD })
    this.inference = { slot, jobId: out.jobId }
    this.bump()
  }

  // ---- the decide pipeline (doc diagram 3) ----
  private async decide(action: 'open' | 'topUp', slot: Slot | null, epoch: number, opts: { extraLog?: string[]; targetLabel?: string } = {}): Promise<{ result: TopupResult; jobId?: bigint; gross?: bigint; code?: Code }> {
    const req_id = this.newReqId()
    const job_id = slot?.job.id?.toString() ?? null
    const view: Topup = { req_id, job_id, action, stage: 'F1', result: null, request: null, gate: CODE_ORDER.map((c) => ({ code: c, pass: true })), qwen: null, code: null, txHash: null, recHash: null }
    this.topups.push(view)
    this.bump()
    const overrides: Override[] = [...this.pendingOverrides]
    this.pendingOverrides = []

    const finishDeny = async (code: Code, f1: KilnCall[], f2: KilnCall[], reqR: Decision['request'] | null, gi: GateInput | null, reason: string): Promise<{ result: TopupResult; code: Code }> => {
      view.stage = 'CHAIN'
      const result: TopupResult = code === 'QWEN_UNAVAILABLE' || code === 'QWEN_UNPARSEABLE' ? 'QWEN_NOT_A_JUDGEMENT' : 'DENIED_RECORDED'
      const body: Decision = {
        action, req_id, job_id, spec_id: this.spec.spec_id,
        request: reqR ?? { vendorLabel: '?', vendor: ZERO_ADDR, gpu: '?', amount: '0', rationale: '' },
        gate: { input: gi ? giJson(gi) : null, codes: gi ? check(gi) : [] }, f1, f2,
        verdict: { approve: false, code }, reason, tx: { fn: 'recordDecision', args: [job_id ?? NO_JOB.toString(), code] }, overrides,
      }
      const out = await this.send({
        signer: 'agent', fn: 'recordDecision', args: [slot?.job.id ?? NO_JOB, toBytes32(code)], expect: ['Denied'],
        req_id, job_id, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> },
        stillValid: () => !this.stopping && (slot === null || slot.job.epoch === epoch),
      })
      view.code = code
      view.result = out.status === 'CANCELLED' ? null : result
      view.recHash = out.status === 'CANCELLED' ? null : (out as { recHash?: Hex }).recHash ?? null
      view.txHash = (out as { txHash?: Hex }).txHash ?? null
      this.bump()
      return { result, code }
    }

    const snap = await this.freshSnapshot([ZERO_ADDR])
    if (!snap) return finishDeny('READ_FAILED', [], [], null, null, 'chain read failed')

    // F1
    const logTail = [...this.execLog.slice(-5), ...this.injectedLines, ...(opts.extraLog ?? [])]
    this.injectedLines = []
    const f1res = await this.callLlm({ flow: 'F1', tools: [F1_TOOL], messages: f1Messages({ action, specRaw: this.specBytes.toString('utf8'), progress: this.progress(slot, action, opts.targetLabel), prices: this.prices, logTail }), req_id, job_id })
    const f1 = f1res.calls as KilnCall[]
    const parsed = parseF1(f1res)
    if (!parsed.ok) return finishDeny(parsed.code, f1, [], null, null, parsed.reason)
    let { vendorLabel, gpu, amount, rationale } = parsed.fields
    for (const ov of this.f1Overrides) {
      const cur: Record<string, unknown> = { vendorLabel, gpu, amount, rationale }
      const from = cur[ov.field]
      if (ov.field === 'vendorLabel') vendorLabel = String(ov.value)
      else if (ov.field === 'gpu') gpu = String(ov.value)
      else if (ov.field === 'rationale') rationale = String(ov.value)
      else if (ov.field === 'amount') amount = BigInt(ov.value as string)
      overrides.push({ field: `f1.${ov.field}`, from: typeof from === 'bigint' ? from.toString() : from, to: typeof ov.value === 'bigint' ? ov.value.toString() : ov.value, by: `scenario:${this.scenario.name}` })
    }
    this.f1Overrides = []
    const vendor = this.resolveVendor(vendorLabel)
    const reqR: Decision['request'] = { vendorLabel, vendor, gpu, amount: dec(amount), rationale }
    view.request = { vendorLabel, gpu, amount: dec(amount), rationale }
    view.stage = 'GATE'
    this.bump()

    // gate
    const gi = this.gateInput(action, snap, { vendor, gpu, amount }, slot?.job.losses ?? [])
    const codes = check(gi)
    view.gate = CODE_ORDER.map((c) => ({ code: c, pass: !codes.includes(c) }))
    if (codes.length) return finishDeny(codes[0], f1, [], reqR, gi, `gate: ${codes.join('+')}`) // NO F2 = the saving

    // F2
    view.stage = 'F2'
    this.bump()
    const f2res = await this.callLlm({ flow: 'F2', tools: [F2_TOOL], messages: f2Messages({ specRaw: this.specBytes.toString('utf8'), summary: this.summary(snap, { vendorLabel, amount }, gi), request: { action, vendorLabel, gpu, amount }, rationale }), req_id, job_id })
    const f2 = f2res.calls as KilnCall[]
    const verdict = parseVerdict(f2res)
    view.qwen = { verdict: verdict.approve ? 'approve' : verdict.code === 'QWEN_DENIED' ? 'deny' : null, reason: verdict.reason }
    if (!verdict.approve) return finishDeny(verdict.code, f1, f2, reqR, gi, verdict.reason)

    // approve -> commit
    view.stage = 'CHAIN'
    this.bump()
    const body: Decision = {
      action, req_id, job_id, spec_id: this.spec.spec_id, request: reqR,
      gate: { input: giJson(gi), codes: [] }, f1, f2, verdict: { approve: true }, reason: verdict.reason,
      tx: action === 'open' ? { fn: 'open', args: [vendor, dec(amount)] } : { fn: 'topUp', args: [job_id!, dec(amount)] }, overrides,
    }
    const stillValid = () => !this.stopping && (action === 'open' ? true : slot !== null && slot.job.epoch === epoch && (slot.job.state === 'RUNNING' || slot.job.state === 'AWAITING_TOPUP'))
    const out = await this.send(
      action === 'open'
        ? { signer: 'agent', fn: 'open', args: [vendor, amount], expect: ['HoldOpened'], req_id, job_id, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> }, stillValid }
        : { signer: 'agent', fn: 'topUp', args: [slot!.job.id!, amount], expect: ['ToppedUp'], req_id, job_id, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> }, stillValid },
    )
    view.recHash = (out as { recHash?: Hex }).recHash ?? null
    view.txHash = (out as { txHash?: Hex }).txHash ?? null

    if (out.status === 'CANCELLED') { view.result = null; this.bump(); return { result: 'DENIED_RECORDED', code: 'TOPUP_TIMEOUT' } }
    if (out.status === 'OK') {
      view.result = 'APPROVED_ONCHAIN'; this.bump()
      const g = (out.events.find((e) => e.name === (action === 'open' ? 'HoldOpened' : 'ToppedUp'))?.args.gross as bigint) ?? gross(amount, false)
      return { result: 'APPROVED_ONCHAIN', jobId: out.jobId, gross: g }
    }
    if (out.status === 'DENIED') {
      this.records.append('CHAIN_DENIED', { req_id, job_id, approval: view.recHash!, code: out.code, txHash: out.txHash })
      view.result = 'APPROVED_BUT_DENIED_ONCHAIN'; view.code = out.code; this.bump()
      return { result: 'APPROVED_BUT_DENIED_ONCHAIN', code: out.code as Code }
    }
    view.result = 'TX_ERROR'; this.bump()
    return { result: 'TX_ERROR' }
  }

  private gateInput(kind: GateInput['kind'], snap: ChainSnapshot, req: { vendor: Hex; gpu: string; amount: bigint }, losses: number[]): GateInput {
    const spec = parseSpecForGate(this.specBytes)
    const label = Object.entries(this.dep.vendors).find(([, a]) => (a as Hex).toLowerCase() === req.vendor.toLowerCase())?.[0] ?? '?'
    return {
      kind,
      chain: {
        block: snap.block, blockTs: snap.blockTs, paused: snap.paused, deadline: snap.deadline, budget: snap.budget,
        committed: snap.committed, maxHold: snap.maxHold, inferencePayee: snap.inferencePayee,
        vendorAllowed: snap.vendorAllowed[req.vendor.toLowerCase()] === true,
      },
      spec, request: { vendor: req.vendor, gpu: req.gpu, amount: req.amount },
      market: kind === 'inference' ? { pricePerHour: 0n, available: 0 } : this.market(label),
      specGross: this.specGross, losses,
    }
  }

  private progress(slot: Slot | null, action: 'open' | 'topUp', targetLabel?: string): Record<string, string | number> {
    const label = slot?.label ?? targetLabel ?? this.scenario.firstVendor ?? 'B'
    const m = this.market(label)
    const held = slot?.job.held ?? 0n, holdSize = slot?.job.holdSize ?? 0n
    const unsettled = slot ? slot.job.accrued - slot.job.settledNet : 0n
    const remainingPct = holdSize > 0n ? Number(((held - gross(unsettled, false)) * 100n) / holdSize) : 100
    return {
      current_vendor: label, action, job_id: slot?.job.id?.toString() ?? 'none yet',
      price_per_hour_usd: usd(m.pricePerHour), hold_usd: usd(holdSize), hold_remaining_pct: remainingPct,
      gpu_minutes_used: slot ? Number(slot.job.runningMs / 1000n) : 0,
      checkpoint_losses: (slot?.job.losses ?? []).map((l) => l.toFixed(2)).join(', ') || 'none',
      target_loss: this.spec.success_metric, max_hold_usd: usd(this.maxHoldMicro), budget_remaining_usd: usd(this.budgetMicro - this.specGross),
    }
  }

  private summary(snap: ChainSnapshot, R: { vendorLabel: string; amount: bigint }, gi: GateInput): Record<string, string | number> {
    return {
      action: gi.kind, vendor: R.vendorLabel, requested_usd: usd(R.amount), gross_with_fee_usd: usd(gross(R.amount, false)),
      budget_remaining_usd: usd(snap.budget - snap.committed), job_cap_usd: usd(gi.spec.job_cap),
      spec_committed_usd: usd(this.specGross), gate: 'PASS (all 10 rules)',
    }
  }

  // ---- opening a vendor job with the D2 one re-propose ----
  private async openVendor(label: string, isMigration: boolean): Promise<Slot | null> {
    const r = await this.decide('open', null, 0, { targetLabel: label, extraLog: isMigration ? ['[exec] migrating: previous vendor capacity is 0'] : [] })
    if (r.result === 'APPROVED_ONCHAIN' && r.jobId !== undefined) return this.newSlot(label, r.jobId, r.gross!)
    const alt = label === 'A' ? 'B' : 'A'
    this.logEvent('scenario', 'reopen', { previous: label, next: alt })
    const r2 = await this.decide('open', null, 0, { targetLabel: alt, extraLog: [`[exec] vendor ${label} was refused (${r.code}); propose a different vendor`] })
    if (r2.result === 'APPROVED_ONCHAIN' && r2.jobId !== undefined) return this.newSlot(alt, r2.jobId, r2.gross!)
    this.logEvent('scenario', 'open_failed_twice', {})
    await this.windDown()
    return null
  }

  private newSlot(label: string, jobId: bigint, g: bigint): Slot {
    const slot: Slot = { label, job: newJob(this.resolveVendor(label), this.market(label).pricePerHour || 1n, false), f3Done: false, closing: false, demoSettled: false }
    this.applyEvent(slot, { type: 'HoldOpened', jobId, gross: g })
    this.applyEvent(slot, { type: 'Start' })
    this.slots.push(slot)
    return slot
  }

  private applyEvent(slot: Slot, ev: JobEvent) {
    slot.job = next(slot.job, ev)
    if (ev.type === 'HoldOpened' || ev.type === 'ToppedUp') this.specGross += ev.gross
    this.bump()
  }

  // ---- the single tx helper: every tx goes through here ----
  private async send(i: TxIntent): Promise<Outcome> {
    const out = await this.committer.commit(i)
    this.ledger.push({
      ts: Date.now(), fn: i.fn, status: out.status,
      code: (out as { code?: string }).code ?? ('reason' in out ? String((out as { reason?: string }).reason) : null),
      txHash: (out as { txHash?: Hex }).txHash ?? null, recHash: (out as { recHash?: Hex }).recHash ?? null, job_id: i.job_id,
    })
    if (this.ledger.length > 50) this.ledger = this.ledger.slice(-50)
    this.bump()
    return out
  }

  // ---- executor loop ----
  private async loopStep() {
    const now = this.virtNow()
    const snap = await this.freshSnapshot()
    if (snap) snap.readAt = now
    await this.runSteps()
    // Deadline demo (DEADLINE_MARGIN_S 0): once wall-clock passes the deadline, an agent settle is Denied(PAST_DEADLINE)
    // on chain. We gate on Date.now (not the possibly-stale blockTs) so the settle's own block carries ts >= deadline.
    if (this.deadlineMarginS === 0n && !this.deadlineDemoDone && this.inference && Date.now() / 1000 >= this.dep.deadline) {
      this.deadlineDemoDone = true
      await this.deadlineDemo()
    }
    for (const slot of this.slots) {
      if (slot.job.state === 'CLOSED' || slot.job.state === 'STOPPED') continue
      const { job, actions } = tick(slot.job, { nowMs: now, snapshot: snap, lossAtSimMinute: (m) => this.scenario.loss(m), deadlineMarginS: this.deadlineMarginS })
      slot.job = job
      this.logCheckpointLoss(slot)
      for (const a of [...actions].sort((x, y) => ACTION_ORDER[x.type] - ACTION_ORDER[y.type])) await this.handleAction(slot, a)
      this.bump()
    }
    for (const slot of this.slots) {
      if (slot.job.state === 'HOLD_EXHAUSTED' && slot.job.latch === 'denied' && !isRearmable(slot.job) && slot.job.pendingNet === 0n && !slot.closing) {
        void this.track(this.closeExhausted(slot))
      }
    }
  }

  private logCheckpointLoss(slot: Slot) {
    const n = slot.job.losses.length
    if (n && this.execLog.filter((l) => l.startsWith(`[ckpt ${slot.label}]`)).length < n) {
      this.execLog.push(`[ckpt ${slot.label}] loss ${slot.job.losses[n - 1].toFixed(3)} at ${Number(slot.job.runningMs / 1000n)} sim-min`)
    }
  }

  private async handleAction(slot: Slot, a: Action) {
    if (a.type === 'CHECKPOINT_SETTLE') void this.track(this.settle(slot, a.amount, slot.job.state === 'HOLD_EXHAUSTED' ? 'exhausted' : slot.job.stopReason ? 'stop' : 'periodic'))
    else if (a.type === 'REQUEST_TOPUP') void this.track(this.runTopup(slot, a.epoch))
    else if (a.type === 'TOPUP_TIMEOUT') await this.recordTimeout(slot)
    else if (a.type === 'STOPPED') await this.onStopped(slot, a.reason)
  }

  private async recordTimeout(slot: Slot) {
    const req_id = this.newReqId()
    const body: Decision = {
      action: 'topUp', req_id, job_id: slot.job.id!.toString(), spec_id: this.spec.spec_id,
      request: { vendorLabel: slot.label, vendor: slot.job.vendor, gpu: 'h100', amount: '0', rationale: 'top-up timed out' },
      gate: { input: null, codes: [] }, f1: [], f2: [], verdict: { approve: false, code: 'TOPUP_TIMEOUT' }, reason: 'top-up flow exceeded 60s',
      tx: { fn: 'recordDecision', args: [slot.job.id!.toString(), 'TOPUP_TIMEOUT'] }, overrides: [],
    }
    await this.send({ signer: 'agent', fn: 'recordDecision', args: [slot.job.id!, toBytes32('TOPUP_TIMEOUT')], expect: ['Denied'], req_id, job_id: body.job_id, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> } })
  }

  private async settle(slot: Slot, amount: bigint, reason: 'periodic' | 'topup' | 'stop' | 'exhausted'): Promise<void> {
    const body = {
      job_id: slot.job.id!.toString(), amount: dec(amount), signer: 'agent', reason,
      accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet), runningMs: dec(slot.job.runningMs), loss: slot.job.losses.at(-1) ?? 'none',
    }
    const out = await this.send({ signer: 'agent', fn: 'settle', args: [slot.job.id!, amount], expect: ['Settled'], req_id: null, job_id: body.job_id, record: { type: 'CHECKPOINT', body } })
    this.applyEvent(slot, out.status === 'OK' ? { type: 'Settled', amount } : { type: 'SettleFailed', amount })
  }

  private async runTopup(slot: Slot, epoch: number): Promise<void> {
    const r = await this.decide('topUp', slot, epoch)
    if (r.result === 'APPROVED_ONCHAIN') this.applyEvent(slot, { type: 'ToppedUp', gross: r.gross! })
    else if (slot.job.latch === 'inflight') this.applyEvent(slot, { type: 'TopupDenied', code: (r.code ?? 'QWEN_UNPARSEABLE') as Code })
  }

  private async closeExhausted(slot: Slot): Promise<void> {
    if (slot.closing || slot.job.state !== 'HOLD_EXHAUSTED') return
    slot.closing = true
    const unsettled = slot.job.accrued - slot.job.settledNet - slot.job.pendingNet
    if (unsettled > 0n) await this.settle(slot, unsettled, 'exhausted')
    const out = await this.send({ signer: 'agent', fn: 'close', args: [slot.job.id!], expect: ['Closed'], req_id: null, job_id: slot.job.id!.toString(), record: { type: 'CLOSE', body: { job_id: slot.job.id!.toString(), signer: 'agent', reason: 'HOLD_EXHAUSTED', accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet) } } })
    if (out.status === 'OK') { this.applyEvent(slot, { type: 'Closed' }); await this.f3(slot) }
    else slot.closing = false
  }

  private async onStopped(slot: Slot, reason: string): Promise<void> {
    if (reason === 'NAN_DETECTED') {
      await Promise.all([...this.inflight]) // wait for the tick's final settle to land
      if (slot.job.state === 'STOPPED') {
        const out = await this.send({ signer: 'agent', fn: 'close', args: [slot.job.id!], expect: ['Closed'], req_id: null, job_id: slot.job.id!.toString(), record: { type: 'CLOSE', body: { job_id: slot.job.id!.toString(), signer: 'agent', reason: 'NAN_DETECTED', accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet) } } })
        if (out.status === 'OK') { this.applyEvent(slot, { type: 'Closed' }); await this.f3(slot) }
      }
      return
    }
    if (this.stopStage === 'RUNNING' || this.stopStage === 'SENDING' || this.stopStage === 'PAUSED_ON_CHAIN') this.stopStage = 'HALTING'
    if (reason === 'PAST_DEADLINE' && !slot.demoSettled) {
      slot.demoSettled = true
      const amt = slot.job.accrued - slot.job.settledNet - slot.job.pendingNet
      if (amt > 0n) // an agent settle after the deadline is Denied(PAST_DEADLINE) on chain: the evidence for this scenario
        await this.send({ signer: 'agent', fn: 'settle', args: [slot.job.id!, amt], expect: ['Settled'], req_id: null, job_id: slot.job.id!.toString(), record: { type: 'CHECKPOINT', body: { job_id: slot.job.id!.toString(), amount: dec(amt), signer: 'agent', reason: 'stop', accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet), runningMs: dec(slot.job.runningMs), loss: slot.job.losses.at(-1) ?? 'none' } } })
    }
    if (this.slots.every((s) => s.job.state === 'STOPPED' || s.job.state === 'CLOSED')) this.stopStage = 'HALTED'
  }

  private async f3(slot: Slot): Promise<void> {
    if (slot.f3Done) return
    slot.f3Done = true
    const net = slot.job.settledNet
    const fee = gross(net, false) - net
    const price = this.market(slot.label).pricePerHour || 1n
    const jobSummary = {
      job_id: slot.job.id!.toString(), vendor: `${slot.label} (${usd(this.market(slot.label).pricePerHour)}/h)`, gpu: 'h100',
      gpu_hours: (Number(net) / Number(price)).toFixed(3), net_paid_usd: usd(net), fee_usd: usd(fee), gross_usd: usd(net + fee),
      ended_by: slot.job.stopReason ?? 'hold exhausted after a top-up decision',
    }
    const res = await this.callLlm({ flow: 'F3', messages: f3Messages({ jobSummary }), req_id: `${this.runId}-f3-${slot.job.id}`, job_id: slot.job.id!.toString() })
    const f3 = res.calls as KilnCall[]
    const text = res.error ? `설명 생성 실패(${res.error})` : (res.content ?? res.toolArgs ?? '설명 생성 실패(EMPTY)').trim()
    this.records.append('RECEIPT', { job_id: slot.job.id!.toString(), f3, text })
    this.receipts.push({
      job_id: slot.job.id!.toString(), vendorLabel: slot.label, provider: String((this.prices.vendors as Record<string, { provider?: string }>)[slot.label]?.provider ?? ''),
      priceSource: this.prices.source, simHours: jobSummary.gpu_hours, amount: usd(net), fee: usd(fee), gross: usd(net + fee), txHashes: [], qwenReason: null, f3: text,
    })
    this.bump()
  }

  // ---- scenario steps ----
  private async runSteps() {
    const sim = this.simMinute()
    for (let idx = 0; idx < this.scenario.interventions.length; idx++) {
      if (this.firedSteps.has(idx)) continue
      const iv = this.scenario.interventions[idx]
      if (iv.atSimMinute !== undefined && sim < iv.atSimMinute) continue
      this.firedSteps.add(idx)
      await this.fireIntervention(iv)
    }
  }

  private async fireIntervention(iv: Intervention) {
    this.logEvent('scenario', iv.kind, { at: iv.atSimMinute ?? null })
    if (iv.kind === 'injectLog') {
      this.injectedLines.push(iv.line)
      this.execLog.push(iv.line)
      this.pendingOverrides.push({ field: 'executor_log', from: null, to: iv.line, by: `scenario:${this.scenario.name}` })
    } else if (iv.kind === 'overrideF1') {
      this.f1Overrides.push({ field: iv.field, value: iv.value }) // recorded as an Override by decide() when applied
    } else if (iv.kind === 'openJob') {
      await this.openVendor(iv.label, false)
    } else if (iv.kind === 'founderStop') {
      await this.action({ type: 'STOP', reason: iv.reason, stateVersion: this.version })
    } else if (iv.kind === 'stolenKey') {
      await this.stolenKeyAttack()
    } else if (iv.kind === 'capacityZero') {
      this.pendingOverrides.push({ field: `market.${iv.from}.available`, from: this.market(iv.from).available, to: 0, by: `scenario:${this.scenario.name}` })
      this.marketOverrides[iv.from] = { ...this.marketOverrides[iv.from], available: 0 }
      await this.migrate(iv.from, iv.to)
    } else if (iv.kind === 'windDown') {
      await this.windDown()
    }
  }

  private async migrate(fromLabel: string, toLabel: string) {
    const slot = this.slots.find((s) => s.label === fromLabel && ['RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED'].includes(s.job.state))
    if (!slot) return
    this.applyEvent(slot, { type: 'Stop', reason: 'MIGRATE' })
    while (this.committer.pending > 0) await sleep(20)
    await Promise.all([...this.inflight])
    const unsettled = slot.job.accrued - slot.job.settledNet - slot.job.pendingNet
    if (unsettled > 0n) await this.settle(slot, unsettled, 'stop')
    const out = await this.send({ signer: 'agent', fn: 'close', args: [slot.job.id!], expect: ['Closed'], req_id: null, job_id: slot.job.id!.toString(), record: { type: 'CLOSE', body: { job_id: slot.job.id!.toString(), signer: 'agent', reason: 'MIGRATE', accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet) } } })
    if (out.status === 'OK') { this.applyEvent(slot, { type: 'Closed' }); await this.f3(slot) }
    await this.send({ signer: 'founder', fn: 'setVendor', args: [this.resolveVendor(fromLabel), false], expect: ['VendorSet'], req_id: null, job_id: null, record: null }) // plain founder tx, NO record
    await this.openVendor(toLabel, true)
  }

  private async deadlineDemo() {
    const jid = this.inference!.jobId
    const out = await this.send({ signer: 'agent', fn: 'settle', args: [jid, 1n], expect: ['Settled'], req_id: null, job_id: jid.toString(), record: { type: 'CHECKPOINT', body: { job_id: jid.toString(), amount: '1', signer: 'agent', reason: 'stop', accrued: '0', settledNet: '0', runningMs: '0', loss: 'none' } } })
    this.logEvent('scenario', 'deadline_demo', { status: out.status, code: (out as { code?: string }).code ?? null })
  }

  private async stolenKeyAttack() {
    while (this.committer.pending > 0) await sleep(20) // idle queue only, so nonces never collide (a collision HALTs REPLACED)
    const attacker = makeWallet(this.o.chain, this.o.rpcUrls, this.o.agentPk)
    const bad = getAddress('0xbad0000000000000000000000000000000000bad') // valid checksum so viem sends it; not allowlisted -> Denied
    const rec = keccak256(Buffer.from('attacker'))
    const attempts: [string, unknown[]][] = [['open', [bad, 1_000_000n, rec]], ['topUp', [0n, this.maxHoldMicro + 1_000_000n, rec]]]
    for (const [fn, args] of attempts) {
      try {
        const hash = await attacker.writeContract({ address: this.dep.vault, abi: vaultAbi, functionName: fn, args, account: attacker.account!, chain: CHAINS[this.o.chain] } as any)
        const r = await this.client.waitForTransactionReceipt({ hash })
        this.logEvent('scenario', 'stolen_key', { fn, txHash: hash, status: r.status, denied: r.logs.length > 0 })
      } catch (e) {
        this.logEvent('scenario', 'stolen_key', { fn, error: (e as Error).name })
      }
    }
  }

  // ---- founder actions (dashboard) ----
  async action(req: ActionRequest): Promise<{ ok: true } | { ok: false; status: 409 | 400; reason: string }> {
    if (req.type === 'STOP') {
      if (this.stopStage !== 'RUNNING') return { ok: false, status: 409, reason: 'STOP already pending' }
      if (req.stateVersion !== this.version) return { ok: false, status: 409, reason: 'stale stateVersion' }
      this.stopping = true
      this.stopStage = 'SENDING'
      this.bump()
      const out = await this.send({ signer: 'founder', fn: 'setPaused', args: [true], expect: ['PausedSet'], req_id: null, job_id: null, record: { type: 'STOP', body: { reason: req.reason, by: 'founder' } } })
      if (out.status === 'OK') { this.stopStage = 'PAUSED_ON_CHAIN'; this.bump() }
      return { ok: true }
    }
    if (!this.canWindDown()) return { ok: false, status: 400, reason: 'not all jobs stopped/exhausted or a tx is pending' }
    await this.windDown()
    return { ok: true }
  }

  private canWindDown(): boolean {
    return this.slots.every((s) =>
      (s.job.state === 'STOPPED' || s.job.state === 'CLOSED' || (s.job.state === 'HOLD_EXHAUSTED' && !isRearmable(s.job))) &&
      this.committer.pendingFor(s.job.id?.toString() ?? '') === 0)
  }

  // ---- windDown: idempotent session end. Concurrent calls dedupe; a second call after completion re-plans and,
  // because every job is CLOSED and refund == 0, sends zero txs. ----
  async windDown(): Promise<void> {
    if (this.windDownP) return this.windDownP
    this.windDownP = this.doWindDown()
    try { await this.windDownP } finally { this.windDownP = null }
  }

  private async doWindDown(): Promise<void> {
    this.stopping = true
    while (this.committer.pending > 0) await sleep(20)
    await Promise.all([...this.inflight])
    for (const slot of this.slots) if (['OPEN', 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED'].includes(slot.job.state)) this.applyEvent(slot, { type: 'Stop', reason: 'END' })
    while (this.committer.pending > 0) await sleep(20)
    await Promise.all([...this.inflight])

    const s1 = await this.freshSnapshot()
    if (!s1) throw new Error('windDown: READ_FAILED')
    const vendorJobs = this.slots.map((s) => s.job)
    for (const it of planWindDown({ jobs: vendorJobs, inference: null, snapshot: s1, deadlineMarginS: this.deadlineMarginS })) if (it.kind !== 'refund') await this.execWind(it)
    for (const slot of this.slots) if (slot.job.state === 'CLOSED' && !slot.f3Done) await this.f3(slot)

    const s2 = await this.freshSnapshot()
    if (!s2) throw new Error('windDown: READ_FAILED (2)')
    const infHold = this.inference ? s2.jobs[Number(this.inference.jobId)]?.held ?? 0n : 0n
    const usageNet = costToMicro(this.kilnCosts).micro
    const capped = usageNet < maxNet(infHold, true) ? usageNet : maxNet(infHold, true)
    for (const it of planWindDown({ jobs: vendorJobs, inference: this.inference ? { jobId: this.inference.jobId, usageNet: capped } : null, snapshot: s2, deadlineMarginS: this.deadlineMarginS })) await this.execWind(it)

    const head = await this.client.getBlockNumber({ cacheTime: 0 })
    this.writeRunJson(Number(head))
    this.ended = true
    this.stopStage = 'HALTED'
    try { writeFileSync(join(this.dir, 'report.md'), report(this.dir)) } catch (e) { this.logEvent('windDown', 'report_failed', { err: (e as Error).message }) }
    this.bump()
  }

  private async execWind(it: ExecIntent): Promise<void> {
    const slot = this.slots.find((s) => s.job.id === (it as { jobId?: bigint }).jobId)
    if (it.kind === 'settle') {
      const body = { job_id: it.jobId.toString(), amount: dec(it.amount), signer: it.signer, reason: 'windDown', accrued: slot ? dec(slot.job.accrued) : '0', settledNet: slot ? dec(slot.job.settledNet) : '0', runningMs: slot ? dec(slot.job.runningMs) : '0', loss: 'none' }
      const out = await this.send({ signer: it.signer, fn: 'settle', args: [it.jobId, it.amount], expect: ['Settled'], req_id: null, job_id: it.jobId.toString(), record: { type: 'CHECKPOINT', body } })
      if (slot) this.applyEvent(slot, out.status === 'OK' ? { type: 'Settled', amount: it.amount } : { type: 'SettleFailed', amount: it.amount })
    } else if (it.kind === 'close') {
      const out = await this.send({ signer: it.signer, fn: 'close', args: [it.jobId], expect: ['Closed'], req_id: null, job_id: it.jobId.toString(), record: { type: 'CLOSE', body: { job_id: it.jobId.toString(), signer: it.signer, reason: 'windDown', accrued: slot ? dec(slot.job.accrued) : '0', settledNet: slot ? dec(slot.job.settledNet) : '0' } } })
      if (out.status === 'OK' && slot && slot.job.state !== 'CLOSED') this.applyEvent(slot, { type: 'Closed' })
    } else if (it.kind === 'refund') {
      const cm = costToMicro(this.kilnCosts)
      await this.send({ signer: 'founder', fn: 'refund', args: [it.amount], expect: ['Refunded'], req_id: null, job_id: null, record: { type: 'SESSION_END', body: { refund: dec(it.amount), inference_usage: dec(cm.micro), kiln_calls: llmStats.calls, kiln_cost_unknown: cm.unknown, jobs: this.slots.map((s) => s.job.id!.toString()) } } })
    }
  }

  // ---- run to completion ----
  async run(): Promise<void> {
    await this.start()
    await this.loop()
    await this.windDown()
  }

  private async loop(): Promise<void> {
    const interval = Math.max(5, Math.round(1000 / this.speed))
    const hardCapMs = this.o.hardCapMs ?? 150_000
    const start = Date.now()
    while (!this.ended && !this.committer.halted) {
      await this.loopStep()
      if (this.isDone()) break
      if (Date.now() - start > hardCapMs) { this.logEvent('scenario', 'hardcap', {}); break }
      await sleep(interval)
    }
    await Promise.all([...this.inflight])
  }

  private isDone(): boolean {
    if (this.deadlineMarginS === 0n && !this.deadlineDemoDone) return false // wait for the deadline-Denied demo
    const end = this.scenario.endAtSimMinute
    if (end !== undefined && this.simMinute() >= end) return true
    const allFired = this.firedSteps.size >= this.scenario.interventions.length
    const opened = this.slots.length > 0
    const terminal = this.slots.every((s) => s.job.state === 'CLOSED' || s.job.state === 'STOPPED')
    return allFired && opened && terminal && this.inflight.size === 0 && this.committer.pending === 0
  }

  // ---- StateView (dashboard) ----
  state(): StateView {
    const s = this.lastSnapshot
    const paid = s ? s.jobs.reduce((a, j) => a + j.paid, 0n) : 0n
    const openHolds = s ? s.jobs.reduce((a, j) => a + j.held, 0n) : 0n
    const budget = s?.budget ?? this.budgetMicro
    const committed = s?.committed ?? 0n
    return {
      version: this.version, run_id: this.runId, scenario: this.scenario.name, vault: this.dep.vault, chainId: this.dep.chainId,
      explorer: this.dep.chainId === 84532 ? 'https://sepolia.basescan.org/tx/' : null,
      asOfBlock: s ? s.block.toString() : '0', blockTs: s ? Number(s.blockTs) : 0, syncAgeMs: s ? Math.max(0, Date.now() - s.readAt) : 0,
      badges: { llm: this.o.llm.mode, price: this.prices?.source ?? '?', scenario: this.scenario.name },
      grant: {
        purpose: this.spec?.purpose ?? '', success_metric: this.spec?.success_metric ?? '', allowed_gpu_types: this.spec?.allowed_gpu_types ?? [],
        job_cap: this.spec ? dec(parseSpecForGate(this.specBytes).job_cap) : '0', deadline: this.spec?.deadline ?? 0,
        budget: dec(budget), paid: dec(paid), fees: '0', inference_paid: dec(this.inference && s ? s.jobs[Number(this.inference.jobId)]?.paid ?? 0n : 0n),
        open_holds: dec(openHolds), refundable: dec(budget - committed), maxHold: dec(s?.maxHold ?? this.maxHoldMicro),
        vendors: (['A', 'B', 'C'] as VendorLabel[]).map((l) => {
          const v = (this.prices?.vendors as Record<string, { provider?: string }>)?.[l] ?? { provider: '' }
          const m = this.prices ? this.market(l) : { pricePerHour: 0n, available: 0 }
          return { label: l, address: this.dep.vendors[l], provider: v.provider ?? '', pricePerHour: dec(m.pricePerHour), available: m.available, allowed: s?.vendorAllowed[this.dep.vendors[l].toLowerCase()] ?? false }
        }),
      },
      jobs: this.slots.map((slot) => this.jobView(slot, false)).concat(this.inference ? [this.jobView(this.inference.slot, true)] : []),
      topups: this.topups,
      stop: this.stopStage,
      ledger: this.ledger,
      receipts: this.receipts,
      health: {
        rpcOk: s !== null, kiln: { mode: this.o.llm.mode, calls: llmStats.calls, lastLatencyMs: null, errors: 0 },
        akash: this.prices?.source ?? '?', pendingTx: this.committer.pending, halted: this.committer.haltReason, ethAgent: '0', ethFounder: '0',
      },
      can: { stop: this.stopStage === 'RUNNING', windDown: this.canWindDown() },
    }
  }

  private jobView(slot: Slot, inference: boolean): StateView['jobs'][number] {
    const j = slot.job
    const unsettled = j.accrued - j.settledNet
    return {
      id: j.id?.toString() ?? '', vendorLabel: slot.label, inference, state: j.state, latch: j.latch, stopReason: j.stopReason,
      held: dec(j.held), holdSize: dec(j.holdSize), accrued: dec(j.accrued), settled: dec(j.settledNet), unsettled: dec(unsettled),
      remainingPct: j.holdSize > 0n ? Number(((j.held - gross(unsettled, false)) * 100n) / j.holdSize) : 100,
      pendingTx: this.committer.pendingFor(j.id?.toString() ?? ''),
    }
  }
}

// ---- helpers ----
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
function gitSha(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
}
/** GateInput with bigints as decimal strings, for the record body (rules.gateInputFromJson round-trips it). */
function giJson(gi: GateInput): unknown {
  return {
    kind: gi.kind,
    chain: { block: gi.chain.block.toString(), blockTs: gi.chain.blockTs.toString(), paused: gi.chain.paused, deadline: gi.chain.deadline.toString(), budget: gi.chain.budget.toString(), committed: gi.chain.committed.toString(), maxHold: gi.chain.maxHold.toString(), inferencePayee: gi.chain.inferencePayee, vendorAllowed: gi.chain.vendorAllowed },
    spec: { allowed_gpu_types: gi.spec.allowed_gpu_types, job_cap: gi.spec.job_cap.toString(), deadline: gi.spec.deadline.toString() },
    request: { vendor: gi.request.vendor, gpu: gi.request.gpu, amount: gi.request.amount.toString() },
    market: { pricePerHour: gi.market.pricePerHour.toString(), available: gi.market.available },
    specGross: gi.specGross.toString(), losses: gi.losses,
  }
}
