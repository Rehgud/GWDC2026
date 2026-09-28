// session.ts — one session = one vault = one bundle. Orchestrates the whole E2E flow:
//
//   SESSION_START -> INFERENCE open (D2: chain rules + record, no gate, no F2)
//   -> F1 work_request -> freeze(R) -> gate.check (10 rules) -> F2 cfo_review (only after PASS)
//      -> open(R.vendor, R.amount, rec)       (initial / migration: one re-proposal, then windDown)
//   -> executor ticks (60x): checkpoint settle every 30 sim-min, edge top-up trigger at 40%
//      -> F1 -> gate -> F2 -> topUp(R.jobId, R.amount, rec) | recordDecision(jobId, code)
//   -> STOP / deadline / NaN / hold exhausted after a final deny / completion
//   -> windDown: per vendor job delta settle -> close (F3 receipt) -> INFERENCE settle(cost)
//      -> close -> refund(budget - committed) anchored by SESSION_END.
//
// Every write goes through commit(); every result through classify(); every "now" in a rule is
// the snapshot's block time. Scenario interventions are recorded as overrides.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toHex, type Chain, type Hex, type PublicClient } from 'viem';
import { vaultAbi } from './abi.ts';
import { marketFor, type PriceEntry, type PriceTable } from './akash.ts';
import { ChainWatcher, ReadFailedError } from './chain.ts';
import { NO_JOB, type DenyCode } from './codes.ts';
import { Committer, HaltError, type CommitOutcome, type Sender } from './commit.ts';
import type { ChainCfg, Deployment } from './config.ts';
import { JobExecutor, JobMeter, type ChainTickView, type TickAction } from './executor.ts';
import { costToMicro, type LlmClient, type StubResponder } from './kiln.ts';
import { f1FromRaw, verdictFromRaw } from './parse.ts';
import { f1Messages, f2Messages, f3Messages, type VendorOption } from './prompts.ts';
import {
  hashBytes,
  serialize,
  type Bodies,
  type ChainSnapshot,
  type Checkpoint,
  type LlmEvidence,
  type Override,
  type RecordDraft,
  type RecordKind,
  type SessionEndReason,
  type TxIntent,
} from './record.ts';
import {
  chainRules,
  check,
  formatUsd,
  gross,
  isAddress,
  isFeeExempt,
  realSeconds,
  sameAddress,
  specGross,
  toDec,
  type ChainRuleInput,
  type ChainView,
  type GateInput,
  type GateRequest,
  type LossWire,
  type MarketView,
} from './rules.ts';
import { parseSpec, specJobCap, type WorkSpec } from './spec.ts';

// ------------------------------------------------------------------------------ types
export type SessionConfig = {
  runId: string;
  clockMult: number;
  triggerTenths: bigint;
  deadlineMarginS: number;
  inferenceHold: bigint;
  tickMs: number;
  topupTimeoutMs: number;
  gitSha: string;
  model: string;
  llmCallCap: number;
};

export type AttackKind = 'vendor' | 'maxHold' | 'budget' | 'replay';
export type AttackResult = { kind: AttackKind; txHash: Hex | null; outcome: string; code: string | null };

export type ScenarioApi = {
  injectLog(line: string, by: `scenario:${string}`): void;
  setCapacity(label: string, capacity: number, by: `scenario:${string}`): void;
  founderStop(reason: string): Promise<void>;
  attack(kind: AttackKind, opts?: { vendor?: Hex; amount?: bigint }): Promise<AttackResult>;
  requestMigration(): void;
  lastRequest(): F1Summary | null;
};

export type Scenario = {
  name: string;
  lossAt: (idx: number) => number;
  /** COMPLETED after this many checkpoints (or earlier when targetLoss is reached) */
  maxCheckpoints: number;
  targetLoss?: number;
  onCheckpoint?: (idx: number, api: ScenarioApi) => Promise<void> | void;
  stub: StubResponder;
  /** windDown tries the agent first so the chain shows Denied(PAUSED / PAST_DEADLINE) */
  denyDemo?: boolean;
};

export type F1Summary = { vendorLabel: string; vendor: Hex | null; gpu: string; amount: string; reason: string };

export type SessionDeps = {
  chainCfg: ChainCfg;
  dep: Deployment;
  /** bundle dir: runs/<vault> (spec.json + spec.sig already signed there) */
  dir: string;
  pc: PublicClient;
  chain: Chain;
  agent: Sender;
  founder: Sender;
  llm: LlmClient;
  prices: PriceTable;
  scenario: Scenario;
  cfg: SessionConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

type TaskJob = { jobId: bigint; label: string; vendor: Hex; gpu: string; exec: JobExecutor; closed: boolean; receipt: Promise<void> | null; qwenReasons: string[]; topUps: number; txs: Hex[] };

type Decision = {
  decision: 'APPROVE' | 'DENY' | 'CANCELLED';
  code: DenyCode | null;
  outcome: CommitOutcome | null;
  request: F1Summary | null;
};

export type DashboardState = ReturnType<Session['state']>;

// ------------------------------------------------------------------------------ session
export class Session {
  readonly d: SessionDeps;
  readonly spec: WorkSpec;
  readonly specText: string;
  committer!: Committer;
  watcher!: ChainWatcher;

  private vendors: (PriceEntry & { capOverride: number | null })[];
  private inferenceJob: bigint | null = null;
  private inferenceClosed = false;
  private tasks: TaskJob[] = [];
  private current: TaskJob | null = null;
  private taskLosses: LossWire[] = [];
  private nextCkptIdx = 0;
  private progressLog: string[] = [];
  private overrides: Override[] = [];
  private epoch = 0;
  private reqSeq = 0;
  private flows = new Set<Promise<void>>();
  private migrationRequested = false;
  private endReason: SessionEndReason | null = null;
  private ending: Promise<void> | null = null;
  private lastUsageLog = 0;
  // observability for the dashboard / metrics
  private ui = {
    lastRequest: null as null | Record<string, unknown>,
    denied: [] as Record<string, unknown>[],
    txs: [] as Record<string, unknown>[],
    receipts: [] as Record<string, unknown>[],
    attacks: [] as AttackResult[],
    f2SavedByGate: 0,
    stopState: 'NONE' as 'NONE' | 'SENDING' | 'PAUSED_ON_CHAIN' | 'HALTING' | 'HALTED',
    stateVersion: 0,
    halt: null as string | null,
  };

  private constructor(d: SessionDeps, specBytes: Uint8Array) {
    this.d = d;
    this.spec = parseSpec(specBytes);
    this.specText = new TextDecoder().decode(specBytes);
    this.vendors = d.prices.entries.map((e) => ({ ...e, capOverride: null }));
  }

  // -------------------------------------------------------------- setup
  static async create(d: SessionDeps): Promise<Session> {
    const specPath = join(d.dir, 'spec.json');
    if (!existsSync(specPath) || !existsSync(join(d.dir, 'spec.sig'))) throw new Error(`${d.dir}/spec.json + spec.sig missing: run npm run sign-spec`);
    const { readFileSync } = await import('node:fs');
    const specBytes = new Uint8Array(readFileSync(specPath));
    const s = new Session(d, specBytes);
    mkdirSync(join(d.dir, 'prices'), { recursive: true });
    writeFileSync(join(d.dir, 'prices', `${d.prices.hash}.json`), d.prices.bytes);
    s.committer = await Committer.open({
      dir: d.dir,
      vault: d.dep.vault,
      pc: d.pc,
      chain: d.chain,
      senders: { agent: d.agent, founder: d.founder },
      onEvent: (ev) => s.event('commit', ev),
    });
    const watchAddrs = [...d.prices.entries.map((e) => e.address), d.dep.inferencePayee];
    s.watcher = new ChainWatcher(d.pc, d.dep.vault, watchAddrs, { now: () => s.now() });
    s.writeRunJson({});
    return s;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }
  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
  private log(line: string): void {
    this.d.log?.(line);
  }

  private event(src: string, data: Record<string, unknown>): void {
    const line = { ts: new Date(this.now()).toISOString(), run_id: this.d.cfg.runId, src, schema_version: 1, ...data };
    appendFileSync(join(this.d.dir, 'events.jsonl'), JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
    this.ui.stateVersion++;
  }

  private writeRunJson(extra: Record<string, unknown>): void {
    const d = this.d;
    const run = {
      schema_version: 1,
      run_id: d.cfg.runId,
      chain_id: d.chainCfg.id,
      vault: d.dep.vault,
      deploy_block: d.dep.deployBlock,
      git_sha: d.cfg.gitSha,
      scenario: d.scenario.name,
      flags: { LLM_MODE: d.llm.mode, KILN_MODEL: d.cfg.model, CLOCK_MULT: d.cfg.clockMult, TOPUP_TRIGGER: Number(d.cfg.triggerTenths) / 10, DEADLINE_MARGIN_S: d.cfg.deadlineMarginS, LLM_CALL_CAP: d.cfg.llmCallCap, PRICE_SOURCE: d.prices.source },
      roles: { founder: d.dep.founder, agent: d.dep.agent, fee_to: d.dep.feeTo, inference_payee: d.dep.inferencePayee, usdc: d.dep.usdc },
      rpc_hosts: d.chainCfg.rpcUrls.map((u) => {
        try {
          return new URL(u).host; // host only: provider URLs can embed API keys in the path
        } catch {
          return 'invalid';
        }
      }),
      ...extra,
    };
    writeFileSync(join(d.dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  }

  private header<K extends RecordKind>(kind: K, jobId: bigint | null, tx: TxIntent | null, reqId: string | null = null) {
    return {
      kind,
      run_id: this.d.cfg.runId,
      chain_id: this.d.chainCfg.id,
      vault: this.d.dep.vault,
      spec_id: this.spec.spec_id,
      req_id: reqId,
      job_id: jobId === null ? null : jobId.toString(),
      at: new Date(this.now()).toISOString(),
      tx,
    };
  }

  private commit(draft: RecordDraft): Promise<CommitOutcome> {
    return this.committer.commit(draft).then((o) => {
      if (o.status === 'MINED') {
        const r = o.result;
        this.ui.txs.push({ fn: draft.tx?.fn, from: draft.tx?.from, tx: o.txHash, block: o.block.toString(), result: r.kind, code: r.kind === 'DENIED' ? r.code : null, rec: o.rec.hash, kind: draft.kind });
        if (r.kind === 'DENIED' || draft.tx?.fn === 'recordDecision') {
          this.ui.denied.push({ layer: r.kind === 'DENIED' ? 'CONTRACT' : 'GATE/CFO', code: r.kind === 'DENIED' ? r.code : draft.tx?.args[1], tx: o.txHash, job: draft.job_id });
        }
      }
      return o;
    });
  }

  // -------------------------------------------------------------- views
  private vendorOptions(): VendorOption[] {
    return this.vendors.map((v) => ({ label: v.label, gpu: v.gpu, priceMicroPerHour: v.price, capacity: v.capOverride ?? v.capacity }));
  }

  private resolveVendor(label: string): Hex | null {
    const l = label.trim().replace(/^vendor\s+/i, '');
    const byLabel = this.vendors.find((v) => v.label.toLowerCase() === l.toLowerCase() || v.host_uri === l);
    if (byLabel) return byLabel.address;
    return isAddress(l) ? (l as Hex) : null;
  }

  private labelOf(addr: Hex): string {
    return this.vendors.find((v) => sameAddress(v.address, addr))?.label ?? addr;
  }

  private marketView(vendor: Hex | null, gpu: string): MarketView | null {
    const m = marketFor(this.d.prices, vendor, gpu);
    if (!m) return null;
    const v = this.vendors.find((x) => sameAddress(x.address, m.address))!;
    return { vendor: m.address, gpu: m.gpu, price: m.price.toString(), capacity: v.capOverride ?? m.capacity };
  }

  private async chainView(snap: ChainSnapshot, vendor: Hex | null, jobId: bigint | null): Promise<ChainView> {
    let allowed = false;
    if (vendor) {
      const key = vendor.toLowerCase();
      if (snap.vendorAllowed[key] === undefined) {
        // unknown address (e.g. an injected 0xBAD...): read it at the SAME block N
        snap.vendorAllowed[key] = (await this.d.pc.readContract({ address: this.d.dep.vault, abi: vaultAbi, functionName: 'vendorAllowed', args: [vendor], blockNumber: BigInt(snap.blockNumber) })) as boolean;
      }
      allowed = snap.vendorAllowed[key]!;
    }
    const job = jobId === null ? null : (snap.jobs.find((j) => j.id === jobId.toString()) ?? null);
    return {
      blockNumber: snap.blockNumber,
      blockTimestamp: snap.blockTimestamp,
      paused: snap.paused,
      deadline: snap.deadline,
      budget: snap.budget,
      committed: snap.committed,
      maxHold: snap.maxHold,
      feeBps: snap.feeBps,
      inferencePayee: this.d.dep.inferencePayee,
      vendorAllowed: allowed,
      job,
    };
  }

  private specGrossAt(snap: ChainSnapshot): bigint {
    const ids = new Set(this.tasks.map((t) => t.jobId.toString()));
    return specGross(snap.jobs.filter((j) => ids.has(j.id)).map((j) => ({ held: BigInt(j.held), paid: BigInt(j.paid), closed: j.closed })));
  }

  private async snapshot(): Promise<ChainSnapshot> {
    for (const t of this.tasks) this.watcher.trackJob(t.jobId);
    if (this.inferenceJob !== null) this.watcher.trackJob(this.inferenceJob);
    return this.watcher.fresh();
  }

  // -------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    const d = this.d;
    const signer = d.dep.founder;
    await this.commit({
      ...this.header('SESSION_START', null, null),
      body: {
        spec: { file: 'spec.json', hash: hashBytes(new TextEncoder().encode(this.specText)), sig: (await import('node:fs')).readFileSync(join(d.dir, 'spec.sig'), 'utf8').trim() as Hex, signer },
        roles: { founder: d.dep.founder, agent: d.dep.agent, fee_to: d.dep.feeTo, inference_payee: d.dep.inferencePayee, usdc: d.dep.usdc },
        vendors: d.prices.entries.map((e) => ({ label: e.label, address: e.address, host_uri: e.host_uri, gpu: e.gpu, price: e.price.toString(), capacity: e.capacity })),
        prices: { source: d.prices.source, file: `prices/${d.prices.hash}.json`, hash: d.prices.hash, fetched_at: d.prices.fetched_at },
        config: {
          llm_mode: d.llm.mode,
          model: d.cfg.model,
          clock_mult: d.cfg.clockMult,
          topup_trigger_bps: Number(d.cfg.triggerTenths) * 1000,
          deadline_margin_s: d.cfg.deadlineMarginS,
          llm_call_cap: d.cfg.llmCallCap,
          inference_hold: d.cfg.inferenceHold.toString(),
          scenario: d.scenario.name,
          git_sha: d.cfg.gitSha,
        },
        deploy_block: d.dep.deployBlock,
      } satisfies Bodies['SESSION_START'],
    });
    this.event('session', { ev: 'start', scenario: d.scenario.name, price_source: d.prices.source });
  }

  /** Full run: start -> inference -> job -> loop -> windDown. Resolves with the end reason. */
  async run(): Promise<SessionEndReason> {
    try {
      await this.start();
      if (!(await this.openInference())) return await this.windDown('INITIAL_OPEN_FAILED');
      if (!(await this.openVendorJob('start', []))) return await this.windDown('INITIAL_OPEN_FAILED');
      while (!this.endReason) {
        await this.sleep(this.d.cfg.tickMs);
        await this.tickOnce();
      }
      await this.ending;
      return this.endReason!;
    } catch (e) {
      this.ui.halt = (e as Error).message;
      this.event('session', { ev: 'halt', error: (e as Error).message });
      throw e;
    }
  }

  // -------------------------------------------------------------- INFERENCE (D2)
  private async openInference(): Promise<boolean> {
    let snap: ChainSnapshot;
    try {
      snap = await this.snapshot();
    } catch {
      return false;
    }
    const inf = this.d.dep.inferencePayee;
    const request: GateRequest = { kind: 'open', vendor: inf, vendorLabel: 'INFERENCE', gpu: '', amount: this.d.cfg.inferenceHold.toString(), jobId: null };
    const ruleInput: ChainRuleInput = { v: 1, request, chain: await this.chainView(snap, inf, null) };
    const ruleResult = chainRules(ruleInput);
    const code = (ruleResult[0] ?? null) as DenyCode | null;
    const tx: TxIntent = code ? { fn: 'recordDecision', from: 'agent', args: [NO_JOB.toString(), code] } : { fn: 'open', from: 'agent', args: [inf, request.amount] };
    const o = await this.commit({
      ...this.header('INFERENCE_OPEN', null, tx),
      body: { snapshot: snap, ruleInput, ruleResult, decision: code ? 'DENY' : 'APPROVE', code } satisfies Bodies['INFERENCE_OPEN'],
    });
    if (o.status === 'MINED' && o.result.kind === 'OK' && o.result.jobId !== null && !code) {
      this.inferenceJob = o.result.jobId;
      this.watcher.trackJob(o.result.jobId);
      this.event('session', { ev: 'inference_open', job_id: o.result.jobId });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- F1 -> gate -> F2 -> commit
  private async decide(p: { kind: 'open' | 'topUp'; trigger: Bodies['REQUEST']['trigger']; attempt: number; exclude: string[]; job: TaskJob | null; epoch: number; t0: number }): Promise<Decision> {
    const reqId = `req-${String(++this.reqSeq).padStart(4, '0')}`;
    const jobId = p.job ? p.job.jobId : null;
    const denyTx = (code: DenyCode): TxIntent => ({ fn: 'recordDecision', from: 'agent', args: [(jobId ?? NO_JOB).toString(), code] });
    const overrides = this.overrides.splice(0);
    const body: Bodies['REQUEST'] = { trigger: p.trigger, attempt: p.attempt, snapshot: null, f1: null, request: null, gateInput: null, gateInputHash: null, gateResult: null, f2: null, verdict: null, decision: 'DENY', code: null, overrides };
    const finish = async (code: DenyCode | null, tx: TxIntent | null, request: F1Summary | null): Promise<Decision> => {
      body.decision = code ? 'DENY' : 'APPROVE';
      body.code = code;
      this.ui.lastRequest = { req_id: reqId, trigger: p.trigger, kind: p.kind, request, gate: body.gateResult, f2: body.verdict, decision: body.decision, code, f2_called: body.f2 !== null };
      const o = await this.commit({ ...this.header('REQUEST', jobId, tx, reqId), body });
      this.event('request', { req_id: reqId, job_id: jobId, trigger: p.trigger, decision: body.decision, code, gate: body.gateResult, f2: body.verdict?.verdict ?? null });
      return { decision: body.decision, code, outcome: o, request };
    };
    const timedOut = () => this.now() - p.t0 > this.d.cfg.topupTimeoutMs;

    // [1] snapshot at block N (fail-closed)
    let snap: ChainSnapshot;
    try {
      snap = await this.snapshot();
    } catch (e) {
      if (!(e instanceof ReadFailedError)) throw e;
      return finish('READ_FAILED', null, null); // local record, anchored by the next tx
    }
    body.snapshot = snap;

    // [3] F1 work_request
    const cur = p.job;
    const secondsToDeadline = BigInt(snap.deadline) - BigInt(snap.blockTimestamp);
    const f1 = await this.d.llm.call(
      'F1',
      f1Messages({
        specText: this.specText,
        trigger: p.trigger,
        progressLog: this.progressLog,
        chain: { budget: BigInt(snap.budget), committed: BigInt(snap.committed), maxHold: BigInt(snap.maxHold), secondsToDeadline, simHoursToDeadline: (Number(secondsToDeadline) * this.d.cfg.clockMult) / 3600, paused: snap.paused },
        vendors: this.vendorOptions(),
        current: cur ? { vendorLabel: cur.label, gpu: cur.gpu, holdGross: cur.exec.meter.holdSize, remainingGross: cur.exec.meter.remaining() } : null,
        exclude: p.exclude,
      }),
    );
    body.f1 = f1;
    if (f1.code) return finish(f1.code, denyTx(f1.code), null);
    const parsed = f1FromRaw(f1.raw, f1.attempts.at(-1)?.finish_reason ?? null);
    if (!parsed.ok) return finish('QWEN_UNPARSEABLE', denyTx('QWEN_UNPARSEABLE'), null);
    const req = parsed.value;
    const vendor = this.resolveVendor(req.vendor);
    const summary: F1Summary = { vendorLabel: req.vendor, vendor, gpu: req.gpu, amount: req.amount, reason: req.reason };
    body.request = { vendor: req.vendor, gpu: req.gpu, amount: req.amount, reason: req.reason };

    // [4] R = freeze(request); gate
    const R: GateRequest = Object.freeze({ kind: p.kind, vendor, vendorLabel: req.vendor, gpu: req.gpu, amount: toDec(req.amountMicro), jobId: jobId === null ? null : jobId.toString() });
    const gateInput: GateInput = {
      v: 1,
      request: R,
      chain: await this.chainView(snap, vendor, jobId),
      spec: { spec_id: this.spec.spec_id, allowed_gpu_types: this.spec.allowed_gpu_types, job_cap: specJobCap(this.spec).toString(), deadline: String(this.spec.deadline) },
      ledger: { spec_gross: this.specGrossAt(snap).toString() },
      market: this.marketView(vendor, req.gpu),
      progress: { losses: [...this.taskLosses] },
      clockMult: this.d.cfg.clockMult,
    };
    body.gateInput = gateInput;
    body.gateInputHash = hashBytes(serialize(R));
    const codes = check(gateInput);
    body.gateResult = codes;
    const txArgs: TxIntent = p.kind === 'open' ? { fn: 'open', from: 'agent', args: [R.vendor ?? '', R.amount] } : { fn: 'topUp', from: 'agent', args: [R.jobId!, R.amount] };
    if (codes.length) {
      this.ui.f2SavedByGate++;
      return finish(codes[0]!, denyTx(codes[0]!), summary);
    }

    // [5] F2 cfo_review, only after a gate PASS
    const g = gross(req.amountMicro, BigInt(snap.feeBps), isFeeExempt(vendor, this.d.dep.inferencePayee));
    const m = gateInput.market!;
    const lossNums = this.taskLosses.filter((x): x is number => typeof x === 'number');
    const last = lossNums.at(-1) ?? null;
    const base = lossNums.at(-4) ?? lossNums[0] ?? null;
    const f2 = await this.d.llm.call(
      'F2',
      f2Messages({
        specText: this.specText,
        kind: p.kind,
        request: { vendorLabel: this.labelOf(vendor!), gpu: req.gpu, amountNet: req.amountMicro, amountGross: g },
        summary: {
          specSpentGross: BigInt(gateInput.ledger.spec_gross),
          jobCapGross: specJobCap(this.spec),
          budgetLeftGross: BigInt(snap.budget) - BigInt(snap.committed),
          checkpoints: this.taskLosses.length,
          lastLoss: last,
          lossImprovementPct: last !== null && base !== null && base > 0 ? ((base - last) / base) * 100 : null,
          simHoursSoFar: this.tasks.reduce((s, t) => s + Number(t.exec.meter.simMs) / 3_600_000, 0),
          simHoursRequested: Number(realSeconds(req.amountMicro, BigInt(m.price), 1)) / 3600,
          gateResult: 'PASS',
        },
        rationale: req.reason,
      }),
    );
    body.f2 = f2;
    if (f2.code) return finish(f2.code, denyTx(f2.code), summary);
    const verdict = verdictFromRaw(f2.raw, f2.attempts.at(-1)?.finish_reason ?? null);
    if (!verdict.ok) {
      body.verdict = verdict.code === 'QWEN_DENIED' ? { verdict: 'deny', reason: verdict.reason } : null;
      if (cur && verdict.code === 'QWEN_DENIED') cur.qwenReasons.push(verdict.reason);
      return finish(verdict.code, denyTx(verdict.code), summary);
    }
    body.verdict = { verdict: 'approve', reason: verdict.reason };
    if (cur) cur.qwenReasons.push(verdict.reason);

    // [6] epoch / state guard: a STOP or NaN that landed meanwhile cancels (no record, no tx)
    if (p.kind === 'topUp') {
      if (timedOut()) return finish('TOPUP_TIMEOUT', denyTx('TOPUP_TIMEOUT'), summary);
      const ph = cur?.exec.state.phase;
      if (p.epoch !== this.epoch || this.endReason || (ph !== 'RUNNING' && ph !== 'AWAITING_TOPUP')) {
        this.event('request', { req_id: reqId, job_id: jobId, ev: 'CANCELLED', phase: ph });
        return { decision: 'CANCELLED', code: null, outcome: null, request: summary };
      }
    }
    // [7..9] commit the approved tx (args from R only)
    return finish(null, txArgs, summary);
  }

  private async openVendorJob(trigger: 'start' | 'migration', exclude: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await this.decide({ kind: 'open', trigger: attempt === 0 ? trigger : 'repropose', attempt, exclude, job: null, epoch: this.epoch, t0: this.now() });
      const o = d.outcome;
      if (d.decision === 'APPROVE' && o?.status === 'MINED' && o.result.kind === 'OK' && o.result.jobId !== null && o.result.event.name === 'HoldOpened') {
        const ev = o.result.event;
        const vendor = ev.vendor;
        const pe = this.d.prices.entries.find((e) => sameAddress(e.address, vendor))!;
        const meter = new JobMeter(pe.price, BigInt((await this.snapshotLite()).feeBps), false);
        const exec = new JobExecutor(ev.jobId, pe.label, meter, {
          clockMult: this.d.cfg.clockMult,
          triggerTenths: this.d.cfg.triggerTenths,
          deadlineMarginS: this.d.cfg.deadlineMarginS,
          lossAt: this.d.scenario.lossAt,
          firstCheckpointIdx: this.nextCkptIdx,
        });
        exec.opened(ev.gross, this.now());
        const t: TaskJob = { jobId: ev.jobId, label: pe.label, vendor, gpu: pe.gpu, exec, closed: false, receipt: null, qwenReasons: [], topUps: 0, txs: [o.txHash] };
        this.tasks.push(t);
        this.current = t;
        this.watcher.trackJob(ev.jobId);
        this.progressLog.push(`[job ${ev.jobId}] opened on vendor ${pe.label} (${pe.gpu} $${formatUsd(pe.price)}/h), hold $${formatUsd(ev.gross)} gross`);
        this.event('job', { ev: 'opened', job_id: ev.jobId, vendor: pe.label, gross: ev.gross });
        return true;
      }
      if (d.request?.vendorLabel) exclude = [...exclude, d.request.vendorLabel];
    }
    return false;
  }

  private async snapshotLite(): Promise<ChainSnapshot> {
    return this.watcher.state().snapshot ?? (await this.snapshot());
  }

  // -------------------------------------------------------------- tick loop
  private tickView(): ChainTickView | null {
    const st = this.watcher.state();
    if (!st.snapshot || st.fetchedAt === null) return null;
    return { paused: st.snapshot.paused, deadline: BigInt(st.snapshot.deadline), blockTimestamp: BigInt(st.snapshot.blockTimestamp), fetchedAtMs: st.fetchedAt, stale: this.watcher.stale() };
  }

  async tickOnce(): Promise<void> {
    if (this.endReason) return;
    await this.watcher.tick();
    const t = this.current;
    if (!t || t.closed) return;
    const view = this.tickView();
    if (!view) return;
    const now = this.now();
    const actions = t.exec.tick(now, view);
    if (now - this.lastUsageLog >= 1000) {
      this.lastUsageLog = now;
      this.event('usage', { job_id: t.jobId, accrued_net: t.exec.meter.accruedNet(), settled_net: t.exec.meter.settledNet, sim_ms: t.exec.meter.simMs, phase: t.exec.state.phase, latch: t.exec.state.latch });
    }
    for (const a of actions) await this.handle(t, a);
  }

  private async handle(t: TaskJob, a: TickAction): Promise<void> {
    switch (a.kind) {
      case 'checkpoint':
        return this.onCheckpoint(t, a);
      case 'trigger':
        this.startTopUp(t);
        return;
      case 'exhausted':
        this.event('job', { ev: a.awaiting ? 'AWAITING_TOPUP' : 'HOLD_EXHAUSTED', job_id: t.jobId });
        if (!a.awaiting) await this.endAfterExhaustion(t);
        return;
      case 'stop':
        this.event('job', { ev: 'stop', job_id: t.jobId, reason: a.reason });
        if (a.reason === 'NAN') {
          await this.finishJob(t, 'agent', 'NaN loss: checkpoint -> settle -> close');
          void this.windDown('NAN');
        } else {
          this.ui.stopState = 'HALTED';
          void this.windDown(a.reason === 'PAUSED' ? 'STOP' : 'DEADLINE');
        }
        return;
      case 'stale':
        return;
      case 'log':
        this.progressLog.push(a.line);
        return;
    }
  }

  private checkpointOf(a: TickAction & { kind: 'checkpoint' }, t: TaskJob): Checkpoint {
    return { idx: a.idx, loss: a.loss, accrued_net: t.exec.meter.accruedNet().toString(), sim_seconds: a.simSeconds.toString() };
  }

  private async onCheckpoint(t: TaskJob, a: TickAction & { kind: 'checkpoint' }): Promise<void> {
    this.nextCkptIdx = a.idx + 1;
    this.taskLosses.push(a.loss);
    this.progressLog.push(`[ckpt ${a.idx}] job ${t.jobId} vendor ${t.label} sim=${(Number(a.simSeconds) / 60).toFixed(0)}min loss=${a.loss}`);
    await this.settleJob(t, 'agent', 'checkpoint', this.checkpointOf(a, t));
    // scenario interventions happen at checkpoints (recorded as overrides on the next request)
    await this.d.scenario.onCheckpoint?.(a.idx, this.api());
    if (this.endReason) return;
    if (t.exec.state.phase === 'RUNNING' && t.exec.state.latch === 'denied') {
      const { canRearm } = await import('./executor.ts');
      if (canRearm(t.exec.state)) t.exec.apply({ type: 'REARM' });
    }
    const cap = this.vendors.find((v) => v.label === t.label);
    if (this.migrationRequested || (cap && (cap.capOverride ?? cap.capacity) <= 0)) {
      this.migrationRequested = false;
      await this.migrate(t);
      return;
    }
    const done = a.idx + 1 >= this.d.scenario.maxCheckpoints || (typeof a.loss === 'number' && this.d.scenario.targetLoss !== undefined && a.loss < this.d.scenario.targetLoss);
    if (done && typeof a.loss === 'number') {
      await this.finishJob(t, 'agent', 'success metric reached');
      void this.windDown('COMPLETED');
    }
  }

  /** settle the job's unsettled usage (skip when zero: a CHECKPOINT record keeps the loss) */
  private async settleJob(t: TaskJob, by: 'agent' | 'founder', reason: Bodies['SETTLE']['reason'], ckpt: Checkpoint | null): Promise<boolean> {
    const net = t.exec.meter.unsettled();
    if (net <= 0n) {
      if (ckpt) await this.commit({ ...this.header('CHECKPOINT', t.jobId, null), body: { checkpoint: ckpt, note: 'no usage since the last settle' } });
      return true;
    }
    const o = await this.commit({
      ...this.header('SETTLE', t.jobId, { fn: 'settle', from: by, args: [t.jobId.toString(), net.toString()] }),
      body: { by, vendor: t.vendor, net: net.toString(), accrued_net: t.exec.meter.accruedNet().toString(), settled_before: t.exec.meter.settledNet.toString(), reason, sim_seconds: (t.exec.meter.simMs / 1000n).toString(), checkpoint: ckpt, snapshot: null },
    });
    if (o.status === 'MINED' && o.result.kind === 'OK' && o.result.event.name === 'Settled') {
      t.exec.meter.onSettled(o.result.event.net, o.result.event.fee);
      t.txs.push(o.txHash);
      return true;
    }
    return false; // Denied (paused/deadline/vendor) or ALREADY_CLOSED: caller decides
  }

  private async closeJob(t: TaskJob, by: 'agent' | 'founder', reason: string): Promise<boolean> {
    if (t.closed) return true;
    const o = await this.commit({
      ...this.header('CLOSE', t.jobId, { fn: 'close', from: by, args: [t.jobId.toString()] }),
      body: { by, reason, unsettled_net: t.exec.meter.unsettled().toString(), snapshot: null },
    });
    if (o.status === 'ALREADY_CLOSED' || (o.status === 'MINED' && o.result.kind === 'OK')) {
      t.closed = true;
      if (t.exec.state.phase !== 'CLOSED') t.exec.apply({ type: 'CLOSED' });
      if (o.status === 'MINED') {
        t.txs.push(o.txHash);
        t.receipt = this.explain(t, o.rec.hash, reason); // F3, async; never blocks the close
      }
      this.event('job', { ev: 'closed', job_id: t.jobId, by });
      return true;
    }
    return false;
  }

  /** checkpoint -> settle -> close, agent first and founder if the chain Denies the agent */
  private async finishJob(t: TaskJob, prefer: 'agent' | 'founder', reason: string): Promise<void> {
    if (t.closed) return;
    const ph = t.exec.state.phase;
    if (ph !== 'STOPPED' && ph !== 'CLOSED') t.exec.apply({ type: 'STOP', reason: 'MANUAL' });
    const ck = t.exec.forceCheckpoint();
    this.taskLosses.push(ck.loss);
    this.nextCkptIdx = ck.idx + 1;
    const ckpt = this.checkpointOf(ck, t);
    let by = prefer;
    if (!(await this.settleJob(t, by, 'halt', ckpt)) && by === 'agent') {
      by = 'founder';
      await this.settleJob(t, by, 'wind_down', null);
    }
    if (!(await this.closeJob(t, by, reason)) && by === 'agent') await this.closeJob(t, 'founder', reason);
  }

  private async endAfterExhaustion(t: TaskJob): Promise<void> {
    const code = t.exec.state.deniedCode;
    await this.finishJob(t, 'agent', `hold exhausted after ${code ?? 'no top-up'}`);
    void this.windDown(code === 'QWEN_DENIED' || code === 'QWEN_UNPARSEABLE' || code === 'QWEN_UNAVAILABLE' ? 'QWEN_FINAL_DENY' : 'TOPUP_DENIED');
  }

  // -------------------------------------------------------------- top-up flow (async, epoch-guarded)
  private startTopUp(t: TaskJob): void {
    const epoch = this.epoch;
    const t0 = this.now();
    const flow = (async () => {
      const d = await this.decide({ kind: 'topUp', trigger: t.exec.state.rearmed > 0 ? 'rearm' : 'topup', attempt: t.exec.state.rearmed, exclude: [], job: t, epoch, t0 });
      if (d.decision === 'CANCELLED' || t.exec.state.phase === 'CLOSED') return;
      const o = d.outcome;
      if (d.decision === 'APPROVE' && o?.status === 'MINED' && o.result.kind === 'OK' && o.result.event.name === 'ToppedUp') {
        t.exec.meter.onToppedUp(o.result.event.gross);
        t.topUps++;
        t.txs.push(o.txHash);
        const v = this.tickView();
        const resumeOk = !!v && !v.paused && JobExecutor.chainNow(v, this.now()) < v.deadline - BigInt(this.d.cfg.deadlineMarginS);
        t.exec.apply({ type: 'TOPPED_UP', resumeOk });
        this.progressLog.push(`[job ${t.jobId}] top-up approved: +$${formatUsd(o.result.event.gross)} gross`);
        return;
      }
      const code: DenyCode = d.code ?? (o?.status === 'MINED' && o.result.kind === 'DENIED' ? (o.result.code as DenyCode) : 'QWEN_UNAVAILABLE');
      if (t.exec.state.latch === 'inflight') t.exec.apply({ type: 'TOPUP_DENIED', code });
      this.progressLog.push(`[job ${t.jobId}] top-up denied: ${code}`);
      if (t.exec.state.phase === 'HOLD_EXHAUSTED' && !this.endReason) await this.endAfterExhaustion(t);
    })().catch((e) => {
      this.ui.halt = (e as Error).message;
      this.event('flow', { ev: 'error', error: (e as Error).message });
      if (e instanceof HaltError) this.endReason = 'WIND_DOWN';
    });
    this.flows.add(flow);
    void flow.finally(() => this.flows.delete(flow));
  }

  // -------------------------------------------------------------- migration
  private async migrate(t: TaskJob): Promise<void> {
    this.epoch++;
    await this.finishJob(t, 'agent', 'migration: vendor capacity 0');
    await this.commit({ ...this.header('ADMIN', null, { fn: 'setVendor', from: 'founder', args: [t.vendor, false] }), body: { reason: `migration: disable vendor ${t.label}`, overrides: this.overrides.splice(0) } });
    this.current = null;
    if (!(await this.openVendorJob('migration', [t.label]))) void this.windDown('MIGRATION_OPEN_FAILED');
  }

  // -------------------------------------------------------------- F3 receipt (never blocks close)
  private async explain(t: TaskJob, closeRec: Hex, reason: string): Promise<void> {
    const m = t.exec.meter;
    const fee = m.paid - m.settledNet;
    let text: string;
    let f3: LlmEvidence | null = null;
    try {
      f3 = await this.d.llm.call('F3', f3Messages({ specPurpose: this.spec.purpose, vendorLabel: t.label, gpu: t.gpu, simHours: Number(m.simMs) / 3_600_000, netPaid: m.settledNet, fee, topUps: t.topUps, closeReason: reason, qwenReasons: t.qwenReasons }));
      text = f3.code || !f3.raw ? `설명 생성 실패(${f3.code ?? 'EMPTY'})` : f3.raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 600);
    } catch (e) {
      text = `설명 생성 실패(${(e as Error).name})`;
    }
    const pe = this.d.prices.entries.find((e) => e.label === t.label)!;
    const receipt = {
      job_id: t.jobId.toString(),
      vendor_label: t.label,
      vendor: t.vendor,
      price_source: this.d.prices.source,
      price_hash: this.d.prices.hash,
      sim_seconds: (m.simMs / 1000n).toString(),
      net: m.settledNet.toString(),
      fee: fee.toString(),
      spec_gross: m.paid.toString(),
      tx_hashes: [...t.txs],
      qwen_reason: t.qwenReasons.at(-1) ?? null,
    };
    void pe;
    await this.commit({ ...this.header('RECEIPT', t.jobId, null), body: { close_ref: closeRec, f3, text, receipt } });
    this.ui.receipts.push({ ...receipt, text });
  }

  // -------------------------------------------------------------- scenario API
  api(): ScenarioApi {
    return {
      injectLog: (line, by) => {
        this.progressLog.push(line);
        this.overrides.push({ field: 'executor_log', from: null, to: line, by });
        this.event('scenario', { ev: 'inject_log', line, by });
      },
      setCapacity: (label, capacity, by) => {
        const v = this.vendors.find((x) => x.label === label)!;
        this.overrides.push({ field: `akash.capacity.${label}`, from: v.capOverride ?? v.capacity, to: capacity, by, actual: v.capacity });
        v.capOverride = capacity;
        this.event('scenario', { ev: 'capacity', label, capacity, actual: v.capacity, by });
      },
      founderStop: (reason) => this.founderStop(reason),
      attack: (kind, opts) => this.attack(kind, opts),
      requestMigration: () => {
        this.migrationRequested = true;
      },
      lastRequest: () => (this.ui.lastRequest?.request as F1Summary | undefined) ?? null,
    };
  }

  /** Dashboard STOP / scenario STOP: founder setPaused(true, rec) through the same queue. */
  async founderStop(reason: string): Promise<void> {
    this.ui.stopState = 'SENDING';
    const snap = this.watcher.state().snapshot;
    const o = await this.commit({ ...this.header('PAUSE', null, { fn: 'setPaused', from: 'founder', args: [true] }), body: { reason, snapshot: snap } });
    if (o.status === 'MINED' && o.result.kind === 'OK') this.ui.stopState = 'PAUSED_ON_CHAIN';
    this.event('stop', { reason, tx: o.status === 'MINED' ? o.txHash : null });
    await this.watcher.fresh().catch(() => {});
    this.ui.stopState = 'HALTING';
  }

  /**
   * Stolen agent key: raw txs signed with the agent key that bypass the gate, Qwen and the
   * record chain (like `cast send`). Sent inside the commit queue so nonces never race.
   */
  private async attack(kind: AttackKind, opts: { vendor?: Hex; amount?: bigint } = {}): Promise<AttackResult> {
    const { encodeFunctionData } = await import('viem');
    const { classify } = await import('./chain.ts');
    const rec = keccak256(toHex(`attacker:${kind}:${this.now()}`));
    const bad = opts.vendor ?? ('0xBAd0000000000000000000000000000000000Bad' as Hex);
    const snap = await this.snapshot().catch(() => null);
    const cur = this.current;
    let fn: 'open' | 'topUp' = 'open';
    let args: unknown[];
    if (kind === 'vendor' || kind === 'replay') args = [bad, opts.amount ?? 2_560_000n, rec];
    else if (kind === 'maxHold') args = [this.d.prices.entries[0]!.address, BigInt(snap?.maxHold ?? '6000000') + 1n, rec];
    else {
      const free = snap ? BigInt(snap.budget) - BigInt(snap.committed) : 0n;
      const amount = free < BigInt(snap?.maxHold ?? '0') ? free : BigInt(snap?.maxHold ?? '0');
      if (cur && !cur.closed) {
        fn = 'topUp';
        args = [cur.jobId, amount, rec];
      } else args = [this.d.prices.entries[0]!.address, amount, rec];
    }
    // never let a demo attack succeed: an attacker tx that would pay out is not sent (it would be
    // a real UNGATED_SPEND). The vault must answer it with Denied (NO_JOB / false).
    const sim = await this.d.pc
      .simulateContract({ address: this.d.dep.vault, abi: vaultAbi, functionName: fn, args: args as never, account: this.d.agent.account })
      .then((r) => r.result as unknown)
      .catch((e: Error) => `revert:${e.message.split(/\r?\n/)[0]}`);
    const wouldSucceed = fn === 'open' ? typeof sim === 'bigint' && sim !== NO_JOB : sim === true;
    if (wouldSucceed || typeof sim === 'string') {
      const skipped: AttackResult = { kind, txHash: null, outcome: wouldSucceed ? 'SKIPPED_WOULD_SUCCEED' : 'SKIPPED_REVERT', code: null };
      this.event('attack', { kind, fn, skipped: skipped.outcome, sim: String(sim) });
      return skipped;
    }
    const res = await this.committer.exclusive(async () => {
      const hash = await this.d.agent.wallet.sendTransaction({ account: this.d.agent.account, chain: this.d.chain, to: this.d.dep.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: fn, args: args as never }), gas: 200_000n });
      const r = await this.d.pc.waitForTransactionReceipt({ hash, pollingInterval: 500 });
      return { hash, c: classify(r, this.d.dep.vault, fn, rec) };
    });
    const out: AttackResult = { kind, txHash: res.hash, outcome: res.c.kind, code: res.c.kind === 'DENIED' ? res.c.code : null };
    this.ui.attacks.push(out);
    this.ui.denied.push({ layer: 'CONTRACT (stolen key)', code: out.code, tx: res.hash, job: null });
    this.event('attack', { kind, fn, tx: res.hash, outcome: out.outcome, code: out.code });
    return out;
  }

  // -------------------------------------------------------------- windDown (idempotent)
  /** Session end, exactly once: every vendor job settled+closed, INFERENCE settled+closed, refund. */
  windDown(reason: SessionEndReason): Promise<SessionEndReason> {
    if (!this.ending) {
      this.endReason ??= reason;
      this.epoch++;
      this.ending = this.doWindDown(this.endReason).catch((e) => {
        this.ui.halt = (e as Error).message;
        this.event('session', { ev: 'winddown_error', error: (e as Error).message });
        throw e;
      });
    }
    return this.ending.then(() => this.endReason!);
  }

  private async doWindDown(reason: SessionEndReason): Promise<void> {
    this.event('session', { ev: 'wind_down', reason });
    await Promise.allSettled([...this.flows]);
    await this.committer.drain();
    const snap = await this.snapshot();
    const ts = BigInt(snap.blockTimestamp);
    const blocked = snap.paused || ts + 5n >= BigInt(snap.deadline);
    // after STOP / deadline the agent is Denied (D3); the founder path always works. The deny demo
    // tries the agent first so the chain itself records Denied(PAUSED / PAST_DEADLINE).
    const by: 'agent' | 'founder' = blocked && !this.d.scenario.denyDemo ? 'founder' : 'agent';
    for (const t of this.tasks) {
      if (t.closed) continue;
      if (t.exec.state.phase !== 'STOPPED' && t.exec.state.phase !== 'CLOSED') t.exec.apply({ type: 'STOP', reason: 'MANUAL' });
      // delta_net = ledger usage up to the executor halt - chain Settled sum
      if (!(await this.settleJob(t, by, 'wind_down', null)) && by === 'agent') await this.settleJob(t, 'founder', 'wind_down', null);
      if (!(await this.closeJob(t, by, `session end: ${reason}`)) && by === 'agent') await this.closeJob(t, 'founder', `session end: ${reason}`);
    }
    await Promise.allSettled(this.tasks.map((t) => t.receipt ?? Promise.resolve()));
    // INFERENCE: settle accumulated Kiln cost (fee-exempt), then close — once, at session end
    if (this.inferenceJob !== null && !this.inferenceClosed) {
      const cost = this.d.llm.costMicro();
      const infBy: 'agent' | 'founder' = blocked ? 'founder' : 'agent';
      if (cost > 0n) {
        const o = await this.commit({
          ...this.header('SETTLE', this.inferenceJob, { fn: 'settle', from: infBy, args: [this.inferenceJob.toString(), cost.toString()] }),
          body: { by: infBy, vendor: this.d.dep.inferencePayee, net: cost.toString(), accrued_net: cost.toString(), settled_before: '0', reason: 'wind_down', sim_seconds: '0', checkpoint: null, snapshot: null },
        });
        if (!(o.status === 'MINED' && o.result.kind === 'OK') && infBy === 'agent') {
          await this.commit({
            ...this.header('SETTLE', this.inferenceJob, { fn: 'settle', from: 'founder', args: [this.inferenceJob.toString(), cost.toString()] }),
            body: { by: 'founder', vendor: this.d.dep.inferencePayee, net: cost.toString(), accrued_net: cost.toString(), settled_before: '0', reason: 'wind_down', sim_seconds: '0', checkpoint: null, snapshot: null },
          });
        }
      }
      const c = await this.commit({ ...this.header('CLOSE', this.inferenceJob, { fn: 'close', from: infBy, args: [this.inferenceJob.toString()] }), body: { by: infBy, reason: 'session end: INFERENCE', unsettled_net: '0', snapshot: null } });
      if (!(c.status === 'ALREADY_CLOSED' || (c.status === 'MINED' && c.result.kind === 'OK'))) {
        await this.commit({ ...this.header('CLOSE', this.inferenceJob, { fn: 'close', from: 'founder', args: [this.inferenceJob.toString()] }), body: { by: 'founder', reason: 'session end: INFERENCE', unsettled_net: '0', snapshot: null } });
      }
      this.inferenceClosed = true;
    }
    // refund(budget - committed) anchored by SESSION_END (the last record)
    const end = await this.snapshot();
    const refund = BigInt(end.budget) - BigInt(end.committed);
    const all = this.tasks.map((t) => t.exec.meter);
    const o = await this.commit({
      ...this.header('SESSION_END', null, { fn: 'refund', from: 'founder', args: [refund.toString()] }),
      body: {
        reason,
        refund: refund.toString(),
        snapshot: end,
        totals: {
          vendor_net: all.reduce((s, m) => s + m.settledNet, 0n).toString(),
          fees: all.reduce((s, m) => s + (m.paid - m.settledNet), 0n).toString(),
          inference: this.d.llm.costMicro().toString(),
          llm_calls: this.d.llm.callCount(),
        },
      },
    });
    const lastBlock = o.status === 'MINED' ? o.block.toString() : end.blockNumber;
    const unknownCost = costToMicro([]).unknown;
    void unknownCost;
    this.writeRunJson({ last_block: lastBlock, end_reason: reason, ended_at: new Date(this.now()).toISOString() });
    this.event('session', { ev: 'end', reason, refund, last_block: lastBlock });
    this.ui.stopState = this.ui.stopState === 'NONE' ? 'NONE' : 'HALTED';
  }

  // -------------------------------------------------------------- dashboard state
  state() {
    const st = this.watcher?.state();
    const s = st?.snapshot;
    const cur = this.current;
    return {
      run_id: this.d.cfg.runId,
      vault: this.d.dep.vault,
      chain_id: this.d.chainCfg.id,
      scenario: this.d.scenario.name,
      badges: { LLM: this.d.llm.mode.toUpperCase(), PRICE: this.d.prices.source, SCENARIO: this.d.scenario.name },
      asOfBlock: s?.blockNumber ?? null,
      syncAgoMs: st?.fetchedAt ? this.now() - st.fetchedAt : null,
      stale: this.watcher ? this.watcher.stale() : true,
      chain: s ? { budget: s.budget, committed: s.committed, paused: s.paused, deadline: s.deadline, blockTimestamp: s.blockTimestamp, maxHold: s.maxHold } : null,
      spec: { spec_id: this.spec.spec_id, purpose: this.spec.purpose, job_cap_usd: this.spec.job_cap_usd, allowed_gpu_types: this.spec.allowed_gpu_types },
      vendors: this.vendors.map((v) => ({ label: v.label, price: v.price.toString(), capacity: v.capOverride ?? v.capacity, host: v.host_uri })),
      inference: { jobId: this.inferenceJob?.toString() ?? null, costMicro: this.d.llm.costMicro().toString(), calls: this.d.llm.callCount(), cap: this.d.cfg.llmCallCap },
      jobs: this.tasks.map((t) => ({
        jobId: t.jobId.toString(),
        vendor: t.label,
        phase: t.exec.state.phase,
        latch: t.exec.state.latch,
        held: t.exec.meter.held.toString(),
        paid: t.exec.meter.paid.toString(),
        holdSize: t.exec.meter.holdSize.toString(),
        accruedNet: t.exec.meter.accruedNet().toString(),
        settledNet: t.exec.meter.settledNet.toString(),
        remaining: t.exec.meter.remaining().toString(),
        simMinutes: Number(t.exec.meter.simMs) / 60_000,
        current: t === cur,
      })),
      lastRequest: this.ui.lastRequest,
      denied: this.ui.denied.slice(-20),
      txs: this.ui.txs.slice(-40),
      receipts: this.ui.receipts,
      attacks: this.ui.attacks,
      f2SavedByGate: this.ui.f2SavedByGate,
      stopState: this.ui.stopState,
      pendingTx: this.committer?.pending() ?? 0,
      halted: this.committer?.isHalted()?.message ?? this.ui.halt,
      ended: this.endReason,
      stateVersion: this.ui.stateVersion,
      progressLog: this.progressLog.slice(-12),
    };
  }

  isEnded(): boolean {
    return !!this.endReason;
  }
}

/** copy a file into the bundle if it exists (used by the runner for spec.* in fresh dirs) */
export function copyIfExists(from: string, to: string): void {
  if (existsSync(from)) copyFileSync(from, to);
}
