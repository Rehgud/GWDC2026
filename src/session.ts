// The orchestrator: one Session runs one session on one freshly deployed vault (one recording = one vault = one bundle).
// It glues chain (Committer), chainread (snapshot), executor (tick/next/windDown), kiln (llm), rules (gate),
// akash (prices), spec, record and report together. All txs go through the Committer; no-tx records
// (SESSION_START, CHAIN_DENIED) go straight to RecordChain.append. The auditor (src/audit.ts) and the
// dashboard (src/server.ts) are built by other agents against record.ts and types.ts, not against this file.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { formatEther, getAddress, keccak256, parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from './abi.ts'
import { Committer, makeWallet, type Intent as TxIntent } from './chain.ts'
import { CHAINS, decodeVaultLogs, makePublicClient, snapshot } from './chainread.ts'
import { fromBytes32, toBytes32, TRANSIENT, type Code } from './codes.ts'
import { deploy, preflight, ANVIL_FOUNDER_PK, type DeployOpts } from './deploy.ts'
import {
  newJob, next, tick, planWindDown,
  type Job, type JobEvent, type Action, type Intent as ExecIntent,
} from './executor.ts'
import { llm, costToMicro, type LlmCtx, type LlmReq, type LlmResult, type Stub } from './kiln.ts'
import { parseF1, parseVerdict } from './parse.ts'
import { f1Messages, f2Messages, f3Messages, F1_TOOL, F2_TOOL, usd } from './prompts.ts'
import { loadPrices } from './akash.ts'
import { check, gross, type GateInput } from './rules.ts'
import { RecordChain, serialize, type CheckpointBody, type Decision, type Override, type KilnCall } from './record.ts'
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
const STOP_ORDER: StopStage[] = ['RUNNING', 'SENDING', 'PAUSED_ON_CHAIN', 'HALTING', 'HALTED']

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

/** topupRealAt: wall-clock start of the in-flight top-up flow (TOPUP_TIMEOUT is real time, see loopStep). */
type Slot = { label: string; job: Job; f3Done: boolean; closing: boolean; topupRealAt: number | null }
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
  private kilnLastMs: number | null = null
  private kilnErrors = 0
  /** Per job id, from decoded Settled events (CHAIN): receipts split net / fee exactly as paid. */
  private settledChain = new Map<string, { net: bigint; fee: bigint }>()
  private feeLog: { block: bigint; fee: bigint }[] = [] // per decoded Settled: the budget bar counts fees mined <= its snapshot
  private jobTxs = new Map<string, Hex[]>()
  private eth = { agent: '?', founder: '?', at: 0 }
  private lastTxBlock = 0n // highest mined block of our own txs: run.json lastBlock is never below it
  private deadlineDemoDone = false
  private rpcOk = false
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
    // One call counter per Session: LLM_CALL_CAP is per session, not per process (the dashboard runs many in one process).
    this.llmCtx = { mode: o.llm.mode, stub: o.llm.stub, cap: o.llm.cap, counter: { calls: 0 }, sink: join(this.dir, 'kiln.jsonl') }
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

  /** inflight holds a twin that never rejects: loop()/windDown wait on it, and a failed flow is logged instead of
   *  becoming an unhandled rejection that kills the process with holds still locked. */
  private track<T>(p: Promise<T>): Promise<T> {
    const q: Promise<unknown> = p.then(() => {}, (e) => this.logEvent('executor', 'flow_error', { err: (e as Error)?.message ?? String(e) }))
      .finally(() => this.inflight.delete(q))
    this.inflight.add(q)
    return p
  }

  private async callLlm(req: LlmReq): Promise<LlmResult> {
    // Fail closed: a wrapper throw (bad config, sink write) is an unavailable Qwen -> deny, never a crash mid-session.
    const r = await this.track(llm(req, this.llmCtx).catch((e): LlmResult => {
      this.logEvent('kiln', 'llm_error', { flow: req.flow, err: (e as Error)?.message ?? String(e) }, req.req_id, req.job_id)
      this.kilnErrors++
      return { calls: [], content: null, toolArgs: null, toolName: null, finishReason: null, error: 'NETWORK' }
    }))
    for (const c of r.calls) {
      this.kilnCosts.push(c.usage?.cost ?? null)
      this.kilnLastMs = c.latency_ms
      if (c.http !== 200) this.kilnErrors++
    }
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
    // Read at fund time (deploy's last tx): the ~11 setup blocks before it must not eat the deadline demo's 12 s.
    const v = scenario.vault
    const secs = Math.round(v.deadlineHours * 3600)
    const dep = await deploy({
      chain: o.chain, rpcUrls: o.rpcUrls, founderPk, label: scenario.name,
      budget: parseUnits(v.budgetUsd, 6), maxHold: parseUnits(v.maxHoldUsd, 6),
      deadline: o.now !== undefined ? o.now + secs : () => Math.floor(Date.now() / 1000) + secs, keysDir: o.keysDir, outDir: o.outDir, log: o.log,
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
    const { book, bytes: priceBytes } = await loadPrices({ fetch: this.o.priceFetch, timeoutMs: this.o.priceTimeoutMs })
    this.prices = book
    const now = Math.floor(Date.now() / 1000)
    this.spec = this.scenario.spec({ vault: this.dep.vault, chainId: this.dep.chainId, now })
    this.specBytes = makeSpec(this.spec)
    this.specSig = await signSpec(this.specBytes, privateKeyToAccount(this.o.founderPk))
    mkdirSync(join(this.dir, 'prices'), { recursive: true })
    writeFileSync(join(this.dir, 'prices', 'akash.json'), priceBytes) // keccak == prices.snapshotHash (auditor check 2)
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
    // The scenario clock starts when the first job starts, not before the opening F1/F2: live Kiln latency there
    // (seconds = hours of sim time at speed 60) would otherwise fire every early intervention, or endAtSimMinute,
    // before the job has run a single tick.
    this.realT0 = this.virtT0 = Date.now()
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
      setupTxs: this.dep.setupTxs, // fund / setVendor / setMaxHold carry no rec: matched 1:1 by tx hash (criterion 1)
    }
    writeFileSync(join(this.dir, 'run.json'), JSON.stringify(run, null, 2) + '\n')
  }

  /** One full read per block (doc: the watcher reads once per block N). While the head is still the snapshot's block the
   *  state is the same, so it is reused with a new readAt: ~13 eth_calls per block instead of per loop step (40 req/s at
   *  speed 3, ~700 at speed 60: enough for a public or free-tier RPC to rate-limit a recording into READ_FAILED). */
  private async freshSnapshot(): Promise<ChainSnapshot | null> {
    const vendors = [...Object.values(this.dep.vendors), this.dep.inferencePayee] as Hex[]
    try {
      const last = this.lastSnapshot
      const s = last && this.rpcOk && (await this.client.getBlockNumber({ cacheTime: 0 })) === last.block
        ? { ...last, readAt: Date.now() }
        : await snapshot(this.client, this.dep.vault, { vendors })
      this.lastSnapshot = s
      this.rpcOk = true
      this.refreshEth()
      return s
    } catch (e) { // snapshot() already retried once (ReadFailed); a failed head read is the same READ_FAILED
      this.rpcOk = false
      this.logEvent('watcher', 'read_failed', { err: (e as Error)?.name ?? 'Error' })
      return null
    }
  }

  /** Gas balances for the dashboard health line, at most every 10 s, off the loop's critical path. */
  private refreshEth() {
    if (Date.now() - this.eth.at < 10_000) return
    this.eth.at = Date.now()
    void Promise.all([this.client.getBalance({ address: this.dep.agent }), this.client.getBalance({ address: this.dep.founder })])
      .then(([a, f]) => { this.eth = { agent: formatEther(a), founder: formatEther(f), at: this.eth.at } }, () => {})
  }

  private async openInference() {
    const req_id = this.newReqId()
    const snap = await this.freshSnapshot()
    if (!snap) throw new Error('inference open: READ_FAILED at start')
    const gi = this.gateInput('inference', snap, { vendor: this.dep.inferencePayee, gpu: '', amount: INFERENCE_HOLD }, [])
    const codes = check(gi)
    if (codes.length) throw new Error(`inference open denied by gate: ${codes[0]}`)
    const slot: Slot = { label: 'INFERENCE', job: newJob(this.dep.inferencePayee, 1n, true), f3Done: true, closing: false, topupRealAt: null }
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
  private async decide(action: 'open' | 'topUp', slot: Slot | null, epoch: number, opts: { extraLog?: string[]; targetLabel?: string } = {}): Promise<{ result: TopupResult; jobId?: bigint; gross?: bigint; code?: Code; label?: string }> {
    const req_id = this.newReqId()
    const job_id = slot?.job.id?.toString() ?? null
    const view: Topup = { req_id, job_id, action, stage: 'F1', result: null, request: null, gate: CODE_ORDER.map((c) => ({ code: c, pass: true })), qwen: null, code: null, txHash: null, recHash: null }
    this.topups.push(view)
    this.bump()
    let overrides: Override[] = []
    /** The card's terminal state. A card a TOPUP_TIMEOUT already closed (recordTimeout) keeps that result. A CANCELLED
     *  flow (epoch changed: STOP, timeout, NaN, END) sent nothing and wrote no record: stage DONE, code CANCELLED. */
    const at = (stage: Topup['stage']) => { if (view.stage !== 'DONE') { view.stage = stage; this.bump() } }
    const done = (result: TopupResult | null, out: Outcome, code: string | null = null) => {
      if (view.stage === 'DONE') return
      const cancelled = out.status === 'CANCELLED'
      Object.assign(view, {
        stage: 'DONE', result: cancelled ? null : result, code: cancelled ? 'CANCELLED' : code,
        txHash: (out as { txHash?: Hex }).txHash ?? null, recHash: cancelled ? null : (out as { recHash?: Hex }).recHash ?? null,
      })
      this.bump()
    }

    const finishDeny = async (code: Code, f1: KilnCall[], f2: KilnCall[], reqR: Decision['request'] | null, gi: GateInput | null, reason: string): Promise<{ result: TopupResult; code: Code }> => {
      at('CHAIN')
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
      done(out.status === 'OK' ? result : 'TX_ERROR', out, code) // the deny is only DENIED_RECORDED once its anchor landed
      return { result, code }
    }

    const snap = await this.freshSnapshot()
    if (!snap) return finishDeny('READ_FAILED', [], [], null, null, 'chain read failed')

    // F1
    // Scripted inputs are taken when the request STARTS, together with their Overrides: an intervention that fires
    // while this F1 is in flight belongs to the next request, and a poisoned line reaches exactly one F1 (the one whose
    // DECISION records it), never every later prompt through the log tail.
    const logTail = [...this.execLog.slice(-5), ...this.injectedLines, ...(opts.extraLog ?? [])]
    const f1Overrides = this.f1Overrides
    overrides = this.pendingOverrides
    this.injectedLines = []
    this.f1Overrides = []
    this.pendingOverrides = []
    const f1res = await this.callLlm({ flow: 'F1', tools: [F1_TOOL], messages: f1Messages({ action, specRaw: this.specBytes.toString('utf8'), progress: this.progress(slot, action, opts.targetLabel), prices: this.prices, logTail }), req_id, job_id })
    const f1 = f1res.calls as KilnCall[]
    const parsed = parseF1(f1res)
    if (!parsed.ok) return finishDeny(parsed.code, f1, [], null, null, parsed.reason)
    let { vendorLabel, gpu, amount, rationale } = parsed.fields
    for (const ov of f1Overrides) {
      const cur: Record<string, unknown> = { vendorLabel, gpu, amount, rationale }
      const from = cur[ov.field]
      if (ov.field === 'vendorLabel') vendorLabel = String(ov.value)
      else if (ov.field === 'gpu') gpu = String(ov.value)
      else if (ov.field === 'rationale') rationale = String(ov.value)
      else if (ov.field === 'amount') amount = BigInt(ov.value as string)
      overrides.push({ field: `f1.${ov.field}`, from: typeof from === 'bigint' ? from.toString() : from, to: typeof ov.value === 'bigint' ? ov.value.toString() : ov.value, by: `scenario:${this.scenario.name}` })
    }
    // A topUp can only pay the job's own vendor: any other label (even an allowlisted one) resolves to no vendor, so the
    // gate answers VENDOR_NOT_ALLOWED and no DECISION ever names a vendor its tx does not pay.
    const vendor = action === 'topUp' && slot && vendorLabel !== slot.label ? ZERO_ADDR : this.resolveVendor(vendorLabel)
    const reqR: Decision['request'] = { vendorLabel, vendor, gpu, amount: dec(amount), rationale }
    view.request = { vendorLabel, gpu, amount: dec(amount), rationale }
    at('GATE')

    // gate
    const gi = this.gateInput(action, snap, { vendor, gpu, amount }, slot?.job.losses ?? [])
    const codes = check(gi)
    view.gate = CODE_ORDER.map((c) => ({ code: c, pass: !codes.includes(c) }))
    if (codes.length) return finishDeny(codes[0], f1, [], reqR, gi, `gate: ${codes.join('+')}`) // NO F2 = the saving

    // F2
    at('F2')
    const f2res = await this.callLlm({ flow: 'F2', tools: [F2_TOOL], messages: f2Messages({ specRaw: this.specBytes.toString('utf8'), summary: this.summary(snap, { vendorLabel, amount }, gi), request: { action, vendorLabel, gpu, amount }, rationale }), req_id, job_id })
    const f2 = f2res.calls as KilnCall[]
    const verdict = parseVerdict(f2res)
    view.qwen = { verdict: verdict.approve ? 'approve' : verdict.code === 'QWEN_DENIED' ? 'deny' : null, reason: verdict.reason }
    if (!verdict.approve) return finishDeny(verdict.code, f1, f2, reqR, gi, verdict.reason)

    // approve -> commit
    at('CHAIN')
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
    if (out.status === 'CANCELLED') { done(null, out); return { result: 'DENIED_RECORDED', code: 'TOPUP_TIMEOUT' } }
    if (out.status === 'OK') {
      done('APPROVED_ONCHAIN', out)
      const g = (out.events.find((e) => e.name === (action === 'open' ? 'HoldOpened' : 'ToppedUp'))?.args.gross as bigint) ?? gross(amount, false)
      return { result: 'APPROVED_ONCHAIN', jobId: out.jobId, gross: g, label: vendorLabel }
    }
    if (out.status === 'DENIED') {
      this.records.append('CHAIN_DENIED', { req_id, job_id, approval: out.recHash, code: out.code, txHash: out.txHash })
      done('APPROVED_BUT_DENIED_ONCHAIN', out, out.code)
      return { result: 'APPROVED_BUT_DENIED_ONCHAIN', code: out.code as Code }
    }
    done('TX_ERROR', out, out.status === 'HALT' ? out.reason : out.status)
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
    if (this.stopping) return null // every open would be CANCELLED anyway; skip the F1 calls
    const r = await this.decide('open', null, 0, { targetLabel: label, extraLog: isMigration ? ['[exec] migrating: previous vendor capacity is 0'] : [] })
    // The slot takes the APPROVED label (F1 may name another vendor than targeted): its address and price are what the chain job pays.
    if (r.result === 'APPROVED_ONCHAIN' && r.jobId !== undefined) return this.newSlot(r.label!, r.jobId, r.gross!)
    if (this.stopping) return null // the first open was CANCELLED by a STOP / windDown: no re-propose
    const alt = label === 'A' ? 'B' : 'A'
    this.logEvent('scenario', 'reopen', { previous: label, next: alt })
    const r2 = await this.decide('open', null, 0, { targetLabel: alt, extraLog: [`[exec] vendor ${label} was refused (${r.code}); propose a different vendor`] })
    if (r2.result === 'APPROVED_ONCHAIN' && r2.jobId !== undefined) return this.newSlot(r2.label!, r2.jobId, r2.gross!)
    this.logEvent('scenario', 'open_failed_twice', {})
    await this.windDown()
    return null
  }

  private newSlot(label: string, jobId: bigint, g: bigint): Slot {
    const slot: Slot = { label, job: newJob(this.resolveVendor(label), this.market(label).pricePerHour || 1n, false), f3Done: false, closing: false, topupRealAt: null }
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
    // recordDecision lines show the code the backend decided (QWEN_DENIED, VENDOR_NOT_ALLOWED, ...), anchored by that tx
    const decided = i.fn === 'recordDecision' ? fromBytes32(i.args[1] as Hex) : null
    this.pushLedger({
      ts: Date.now(), fn: i.fn, status: out.status,
      code: (out as { code?: string }).code ?? ('reason' in out ? String((out as { reason?: string }).reason) : decided),
      txHash: (out as { txHash?: Hex }).txHash ?? null, recHash: (out as { recHash?: Hex }).recHash ?? null, job_id: i.job_id, signer: i.signer,
    })
    if ('block' in out && out.block > this.lastTxBlock) this.lastTxBlock = out.block
    const txHash = (out as { txHash?: Hex }).txHash
    const jid = i.job_id ?? (out.status === 'OK' && out.jobId !== undefined ? out.jobId.toString() : null)
    if (txHash && jid !== null) this.jobTxs.set(jid, [...(this.jobTxs.get(jid) ?? []), txHash])
    if (out.status === 'OK') for (const e of out.events) {
      if (e.name !== 'Settled') continue
      const k = String(e.args.jobId), p = this.settledChain.get(k) ?? { net: 0n, fee: 0n }
      this.settledChain.set(k, { net: p.net + (e.args.amount as bigint), fee: p.fee + (e.args.fee as bigint) })
      this.feeLog.push({ block: out.block, fee: e.args.fee as bigint })
    }
    this.bump()
    return out
  }

  private pushLedger(line: StateView['ledger'][number]) {
    this.ledger.push(line)
    if (this.ledger.length > 50) this.ledger = this.ledger.slice(-50)
  }

  // ---- executor loop ----
  private async loopStep() {
    const now = this.virtNow()
    const read = await this.freshSnapshot()
    // tick() judges staleness on the virtual clock; lastSnapshot keeps the real readAt for the dashboard's sync age.
    const snap = read && { ...read, readAt: now }
    await this.runSteps()
    // Deadline demo (DEADLINE_MARGIN_S 0): once wall-clock passes the deadline, an agent settle is Denied(PAST_DEADLINE)
    // on chain. We gate on Date.now (not the possibly-stale blockTs) so the settle's own block carries ts >= deadline.
    if (this.deadlineMarginS === 0n && !this.deadlineDemoDone && this.inference && !this.stopping && Date.now() / 1000 >= this.dep.deadline) {
      await this.deadlineDemo()
    }
    for (const slot of this.slots) {
      if (slot.job.state === 'CLOSED' || slot.job.state === 'STOPPED') continue
      // TOPUP_TIMEOUT is a real-time budget (60 s for F1 + F2 + tx, D4) but tick() runs on the virtual clock, where 60 s
      // is 1 real second at speed 60: rebase the in-flight flow's start so tick() measures its real elapsed time.
      if (slot.job.latch === 'inflight' && slot.job.topupAtMs !== null && slot.topupRealAt !== null) slot.job = { ...slot.job, topupAtMs: now - (Date.now() - slot.topupRealAt) }
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
    if (a.type === 'CHECKPOINT_SETTLE') void this.track(this.settle(slot, a.amount, slot.job.state === 'HOLD_EXHAUSTED' ? 'exhausted' : slot.job.stopReason ? 'stop' : 'periodic', { reserved: true }))
    else if (a.type === 'REQUEST_TOPUP') { slot.topupRealAt = Date.now(); void this.track(this.runTopup(slot, a.epoch)) }
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
    const out = await this.send({ signer: 'agent', fn: 'recordDecision', args: [slot.job.id!, toBytes32('TOPUP_TIMEOUT')], expect: ['Denied'], req_id, job_id: body.job_id, record: { type: 'DECISION', body: body as unknown as Record<string, unknown> } })
    // The timed-out flow's card ends here (its own late answer is CANCELLED and must not overwrite this).
    const card = this.topups.findLast((t) => t.job_id === body.job_id && t.action === 'topUp' && t.stage !== 'DONE')
    if (card) Object.assign(card, { stage: 'DONE', result: out.status === 'OK' ? 'DENIED_RECORDED' : 'TX_ERROR', code: 'TOPUP_TIMEOUT', txHash: (out as { txHash?: Hex }).txHash ?? null, recHash: (out as { recHash?: Hex }).recHash ?? null })
  }

  /** Every vendor settle goes through here. A tick's CHECKPOINT_SETTLE is already counted in pendingNet (`reserved`);
   *  any other caller reserves it now and is refused unless the amount is unsettled AND unreserved. So no span is ever
   *  paid twice, and a Denied/HALT outcome is always a legal SettleFailed. Returns true when Settled. */
  private async settle(slot: Slot, amount: bigint, reason: CheckpointBody['reason'], o: { reserved?: boolean; signer?: 'agent' | 'founder' } = {}): Promise<boolean> {
    const j = slot.job
    if (!o.reserved) {
      if (amount <= 0n || amount > j.accrued - j.settledNet - j.pendingNet) return false
      slot.job = { ...j, pendingNet: j.pendingNet + amount }
    }
    const signer = o.signer ?? 'agent'
    const body: CheckpointBody = {
      job_id: j.id!.toString(), amount: dec(amount), signer, reason,
      accrued: dec(j.accrued), settledNet: dec(j.settledNet), runningMs: dec(j.runningMs), loss: j.losses.at(-1) ?? 'none',
    }
    const out = await this.send({ signer, fn: 'settle', args: [j.id!, amount], expect: ['Settled'], req_id: null, job_id: body.job_id, record: { type: 'CHECKPOINT', body } })
    this.applyEvent(slot, out.status === 'OK' ? { type: 'Settled', amount } : { type: 'SettleFailed', amount })
    return out.status === 'OK'
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
    if (unsettled > 0n && !(await this.settle(slot, unsettled, 'exhausted'))) { slot.closing = false; return } // never close over unpaid usage
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
    this.advanceStop('HALTING')
    // PAUSED: the agent still asks to be paid the usage it owes up to the stop. The paused contract answers
    // Denied(PAUSED, enforced) with its CHECKPOINT record: success criterion 2's STOP evidence (doc diagram 4, order B).
    // Through settle(), so a landed settle (vault unpaused by hand) is booked; windDown's founder settle pays the delta.
    // PAST_DEADLINE: no agent settle. With the default margin the executor stops 15 s BEFORE the chain deadline, so it
    // would simply land; windDown's founder settle pays the delta instead (executor.stop).
    const due = slot.job.accrued - slot.job.settledNet - slot.job.pendingNet
    if (reason === 'PAUSED' && due > 0n) await this.settle(slot, due, 'stop')
    if (this.slots.every((s) => s.job.state === 'STOPPED' || s.job.state === 'CLOSED')) this.advanceStop('HALTED')
  }

  /** The STOP banner only moves forward: a slow setPaused receipt must not pull HALTED back to PAUSED_ON_CHAIN. */
  private advanceStop(to: StopStage) {
    if (STOP_ORDER.indexOf(to) > STOP_ORDER.indexOf(this.stopStage)) { this.stopStage = to; this.bump() }
  }

  private async f3(slot: Slot): Promise<void> {
    if (slot.f3Done) return
    slot.f3Done = true
    const id = slot.job.id!.toString()
    // CHAIN numbers: the decoded Settled events of this job (the fee is floored per settle, so not gross(Σnet) - Σnet)
    const { net, fee } = this.settledChain.get(id) ?? { net: 0n, fee: 0n }
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
      job_id: id, vendorLabel: slot.label, provider: String((this.prices.vendors as Record<string, { provider?: string }>)[slot.label]?.provider ?? ''),
      priceSource: this.prices.source, simHours: jobSummary.gpu_hours, amount: dec(net), fee: dec(fee), gross: dec(net + fee),
      txHashes: this.jobTxs.get(id) ?? [], qwenReason: this.topups.findLast((t) => t.job_id === id && t.qwen)?.qwen?.reason ?? null, f3: text,
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
    if (!slot || this.stopping) return // after STOP / during windDown there is nothing to migrate to
    this.applyEvent(slot, { type: 'Stop', reason: 'MIGRATE' })
    await this.drain()
    const unsettled = slot.job.accrued - slot.job.settledNet - slot.job.pendingNet
    if (unsettled > 0n && !(await this.settle(slot, unsettled, 'stop'))) return // windDown's founder settle + close picks it up
    const out = await this.send({ signer: 'agent', fn: 'close', args: [slot.job.id!], expect: ['Closed'], req_id: null, job_id: slot.job.id!.toString(), record: { type: 'CLOSE', body: { job_id: slot.job.id!.toString(), signer: 'agent', reason: 'MIGRATE', accrued: dec(slot.job.accrued), settledNet: dec(slot.job.settledNet) } } })
    if (out.status === 'OK') { this.applyEvent(slot, { type: 'Closed' }); await this.f3(slot) }
    await this.send({ signer: 'founder', fn: 'setVendor', args: [this.resolveVendor(fromLabel), false], expect: ['VendorSet'], req_id: null, job_id: null, record: null }) // plain founder tx, NO record
    await this.openVendor(toLabel, true)
  }

  /** settle(INFERENCE, 0): after the deadline the contract answers Denied(PAST_DEADLINE), the evidence. If the chain clock
   *  still lags the wall clock it lands and pays nothing (never a unit the usage didn't accrue); retried next step. */
  private async deadlineDemo() {
    const jid = this.inference!.jobId
    const out = await this.send({ signer: 'agent', fn: 'settle', args: [jid, 0n], expect: ['Settled'], req_id: null, job_id: jid.toString(), record: { type: 'CHECKPOINT', body: { job_id: jid.toString(), amount: '0', signer: 'agent', reason: 'stop', accrued: '0', settledNet: '0', runningMs: '0', loss: 'none' } } })
    this.deadlineDemoDone = out.status !== 'OK'
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
        const denied = decodeVaultLogs(r, this.dep.vault).find((e) => e.name === 'Denied')
        const code = denied ? fromBytes32(denied.args.code as Hex) : null
        this.logEvent('scenario', 'stolen_key', { fn, txHash: hash, status: r.status, code })
        // Evidence feed: the attacker's tx, no record (its rec names none)
        this.pushLedger({ ts: Date.now(), fn, status: denied ? 'DENIED' : r.status === 'success' ? 'OK' : 'REVERTED', code, txHash: hash, recHash: null, job_id: fn === 'topUp' ? String(args[0]) : null, signer: 'attacker' })
      } catch (e) {
        this.logEvent('scenario', 'stolen_key', { fn, error: (e as Error).name })
        this.pushLedger({ ts: Date.now(), fn, status: 'ERROR', code: (e as Error).name, txHash: null, recHash: null, job_id: null, signer: 'attacker' })
      }
      this.bump()
    }
  }

  // ---- founder actions (dashboard) ----
  async action(req: ActionRequest): Promise<{ ok: true } | { ok: false; status: 409 | 400; reason: string }> {
    if (req.type === 'STOP') {
      // No stateVersion check for STOP: the version bumps on every loop step, so a dashboard click would always be
      // stale, and STOP only ever makes things safer. A second STOP, or one once windDown has begun, is refused:
      // a pause landing between windDown's plan and its agent-signed txs would get them Denied mid-session-end.
      if (this.stopStage !== 'RUNNING' || this.stopping) return { ok: false, status: 409, reason: 'STOP already pending or the session is winding down' }
      this.stopping = true
      this.stopStage = 'SENDING'
      this.bump()
      const out = await this.send({ signer: 'founder', fn: 'setPaused', args: [true], expect: ['PausedSet'], req_id: null, job_id: null, record: { type: 'STOP', body: { reason: req.reason, by: 'founder' } } })
      if (out.status === 'OK') this.advanceStop('PAUSED_ON_CHAIN')
      return { ok: true }
    }
    if (!this.canWindDown()) return { ok: false, status: 400, reason: 'not all jobs stopped/exhausted or a tx is pending' }
    await this.windDown()
    return { ok: true }
  }

  /** False before any vendor job exists (nothing to wind down yet) and once the session ended (SESSION_END is sent once). */
  private canWindDown(): boolean {
    return this.slots.length > 0 && !this.ended && this.slots.every((s) =>
      (s.job.state === 'STOPPED' || s.job.state === 'CLOSED' || (s.job.state === 'HOLD_EXHAUSTED' && !isRearmable(s.job))) &&
      this.committer.pendingFor(s.job.id?.toString() ?? '') === 0)
  }

  // ---- windDown: idempotent session end. Concurrent calls dedupe; a call after completion sends zero txs (the plan
  // would only be another refund(0) + SESSION_END). A windDown that threw did not end the session: it re-plans. ----
  async windDown(): Promise<void> {
    if (this.ended) return
    if (this.windDownP) return this.windDownP
    this.windDownP = this.doWindDown()
    try { await this.windDownP } finally { this.windDownP = null }
  }

  private async drain() {
    while (this.committer.pending > 0) await sleep(20)
    await Promise.all([...this.inflight])
  }

  private throwHalted(): never {
    throw new Error(`windDown: committer HALTED (${this.committer.haltReason}); nothing can be sent from this process`)
  }

  private async doWindDown(): Promise<void> {
    if (this.committer.halted) this.throwHalted()
    this.stopping = true
    await this.drain()
    for (const slot of this.slots) if (['OPEN', 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED'].includes(slot.job.state)) this.applyEvent(slot, { type: 'Stop', reason: 'END' })
    await this.drain()

    await this.windJobs(false) // vendor jobs: settle(delta) + close
    for (const slot of this.slots) if (slot.job.state === 'CLOSED' && !slot.f3Done) await this.f3(slot)
    for (const it of await this.windJobs(true)) { // INFERENCE after every F3 (its usage includes them), then the refund
      // The refund anchors SESSION_END: the session only ends once it landed (a later windDown() is then a no-op).
      if (!(await this.execWind(it))) { if (this.committer.halted) this.throwHalted(); throw new Error('windDown: refund not confirmed; run windDown again') }
    }

    // Uncached head read AFTER the final refund receipt; never below our own last mined tx (a lagging fallback RPC)
    const head = await this.client.getBlockNumber({ cacheTime: 0 })
    this.writeRunJson(Number(head > this.lastTxBlock ? head : this.lastTxBlock))
    this.ended = true
    this.advanceStop('HALTED')
    try { writeFileSync(join(this.dir, 'report.md'), report(this.dir)) } catch (e) { this.logEvent('windDown', 'report_failed', { err: (e as Error).message }) }
    this.bump()
  }

  /** Plan on a fresh snapshot with the LIVE job objects and execute, until only the refund is left (returned). A settle or
   *  close the contract Denied (a pause or the deadline landing after the plan) is re-planned, founder-signed, next pass;
   *  a job whose settle failed is not closed that pass (no close over unpaid usage). The refund is only ever computed
   *  after every job is closed on chain, so it never over-asks (OverBudget -> HALT with SESSION_END unanchored). */
  private async windJobs(withInference: boolean): Promise<ExecIntent[]> {
    for (let pass = 0; pass < 3; pass++) {
      if (this.committer.halted) this.throwHalted()
      const s = await this.freshSnapshot()
      if (!s) throw new Error('windDown: READ_FAILED')
      const inference = withInference && this.inference ? { jobId: this.inference.jobId, usageNet: this.inferenceUsage(s) } : null
      const plan = planWindDown({ jobs: this.slots.map((x) => x.job), inference, snapshot: s, deadlineMarginS: this.deadlineMarginS })
      const work = plan.filter((it) => it.kind !== 'refund')
      if (!work.length) return plan
      const failed = new Set<bigint>()
      for (const it of work) {
        if (it.kind === 'refund' || (it.kind === 'close' && failed.has(it.jobId))) continue
        if (!(await this.execWind(it)) && it.kind === 'settle') failed.add(it.jobId)
      }
    }
    throw new Error('windDown: a settle/close was still refused after 3 passes; nothing refunded (run windDown again)')
  }

  /** Kiln usage to reimburse, capped at what the fee-exempt INFERENCE hold ever held (paid + held). */
  private inferenceUsage(s: ChainSnapshot): bigint {
    const c = s.jobs[Number(this.inference!.jobId)]
    const usage = costToMicro(this.kilnCosts).micro, cap = c ? c.paid + c.held : 0n
    return usage < cap ? usage : cap
  }

  /** One windDown intent. Returns true when it landed. */
  private async execWind(it: ExecIntent): Promise<boolean> {
    const slot = this.slots.find((s) => s.job.id === (it as { jobId?: bigint }).jobId)
    if (it.kind === 'settle') {
      if (slot) return this.settle(slot, it.amount, 'windDown', { signer: it.signer })
      const body: CheckpointBody = { job_id: it.jobId.toString(), amount: dec(it.amount), signer: it.signer, reason: 'windDown', accrued: '0', settledNet: '0', runningMs: '0', loss: 'none' }
      return (await this.send({ signer: it.signer, fn: 'settle', args: [it.jobId, it.amount], expect: ['Settled'], req_id: null, job_id: body.job_id, record: { type: 'CHECKPOINT', body } })).status === 'OK'
    }
    if (it.kind === 'close') {
      const out = await this.send({ signer: it.signer, fn: 'close', args: [it.jobId], expect: ['Closed'], req_id: null, job_id: it.jobId.toString(), record: { type: 'CLOSE', body: { job_id: it.jobId.toString(), signer: it.signer, reason: 'windDown', accrued: slot ? dec(slot.job.accrued) : '0', settledNet: slot ? dec(slot.job.settledNet) : '0' } } })
      const closed = slot ?? (this.inference?.jobId === it.jobId ? this.inference.slot : undefined)
      if (out.status === 'OK' && closed && closed.job.state !== 'CLOSED') {
        if (closed.job.state === 'OPEN') this.applyEvent(closed, { type: 'Stop', reason: 'END' }) // the INFERENCE hold never runs
        this.applyEvent(closed, { type: 'Closed' })
      }
      return out.status === 'OK'
    }
    const cm = costToMicro(this.kilnCosts)
    // kiln_calls counts THIS session's attempts (kilnCosts has one entry per attempt), not the process-wide llmStats.
    const out = await this.send({ signer: 'founder', fn: 'refund', args: [it.amount], expect: ['Refunded'], req_id: null, job_id: null, record: { type: 'SESSION_END', body: { refund: dec(it.amount), inference_usage: dec(cm.micro), kiln_calls: this.kilnCosts.length, kiln_cost_unknown: cm.unknown, jobs: this.slots.map((s) => s.job.id!.toString()) } } })
    return out.status === 'OK'
  }

  // ---- run to completion ----
  async run(): Promise<void> {
    await this.start()
    await this.loop()
    await this.windDown()
  }

  private async loop(): Promise<void> {
    const interval = Math.max(5, Math.round(1000 / this.speed))
    const hardCapMs = this.hardCapMs
    const start = Date.now()
    while (!this.ended && !this.windDownP && !this.committer.halted) {
      await this.loopStep()
      if (this.isDone()) break
      if (Date.now() - start > hardCapMs) { this.logEvent('scenario', 'hardcap', {}); break }
      await sleep(interval)
    }
    await Promise.all([...this.inflight])
  }

  /** Default: the scenario's last scripted minute in real time (it scales with 1/speed) plus 2 minutes of slack. */
  private get hardCapMs(): number {
    const horizon = Math.max(this.scenario.endAtSimMinute ?? 0, ...this.scenario.interventions.map((i) => i.atSimMinute))
    return this.o.hardCapMs ?? horizon * 1000 / this.speed + 120_000
  }

  private isDone(): boolean {
    if (this.deadlineMarginS === 0n && !this.deadlineDemoDone && !this.stopping) return false // wait for the deadline-Denied demo
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
    // The budget bar's five parts come from ONE snapshot, so they always add up to its budget (committed = Σheld + Σpaid
    // on chain). Only the vendor net/fee split uses decoded Settled fees, those mined at or before the snapshot block: a
    // receipt newer than the snapshot would otherwise count as paid while the snapshot still holds it (sum > budget).
    const infId = this.inference ? Number(this.inference.jobId) : -1
    let vendorPaid = 0n, inferencePaid = 0n, openHolds = 0n
    for (const [i, j] of (s?.jobs ?? []).entries()) {
      openHolds += j.held
      if (i === infId) inferencePaid += j.paid; else vendorPaid += j.paid
    }
    const fees = s ? this.feeLog.reduce((a, f) => (f.block <= s.block ? a + f.fee : a), 0n) : 0n // INFERENCE is fee-exempt
    const paidNet = vendorPaid - fees
    const budget = s?.budget ?? this.budgetMicro
    const committed = s?.committed ?? 0n
    const specDl = this.spec?.deadline ?? 0
    return {
      version: this.version, run_id: this.runId, scenario: this.scenario.name, vault: this.dep.vault, chainId: this.dep.chainId,
      explorer: this.dep.chainId === 84532 ? 'https://sepolia.basescan.org/tx/' : null,
      asOfBlock: s ? s.block.toString() : '0', blockTs: s ? Number(s.blockTs) : 0, syncAgeMs: s ? Math.max(0, Date.now() - s.readAt) : 0,
      badges: { llm: this.o.llm.mode, price: this.prices?.source ?? '?', scenario: this.scenario.name },
      grant: {
        purpose: this.spec?.purpose ?? '', success_metric: this.spec?.success_metric ?? '', allowed_gpu_types: this.spec?.allowed_gpu_types ?? [],
        // the binding deadline: min(signed spec, vault) (R3-13)
        job_cap: this.spec ? dec(parseSpecForGate(this.specBytes).job_cap) : '0', deadline: s && Number(s.deadline) < specDl ? Number(s.deadline) : specDl,
        budget: dec(budget), paid: dec(paidNet), fees: dec(fees), inference_paid: dec(inferencePaid),
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
        rpcOk: this.rpcOk, kiln: { mode: this.o.llm.mode, calls: this.kilnCosts.length, lastLatencyMs: this.kilnLastMs, errors: this.kilnErrors },
        akash: this.prices?.source ?? '?', pendingTx: this.committer.pending, halted: this.committer.haltReason, ethAgent: this.eth.agent, ethFounder: this.eth.founder,
      },
      can: { stop: this.stopStage === 'RUNNING' && !this.stopping, windDown: this.canWindDown() },
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
