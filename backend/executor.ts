// executor.ts — mock GPU executor: the job state machine, the usage meter and the tick (T6).
//
// State machine (diagram 2): NO_JOB -> OPEN -> RUNNING <-> AWAITING_TOPUP -> HOLD_EXHAUSTED
// -> STOPPED -> CLOSED, with the top-up latch none | inflight | denied. next() is pure and throws
// on an illegal transition. Transitions happen only on DECODED chain events (HoldOpened,
// ToppedUp, Closed) or on tick-detected conditions (paused, deadline, NaN).
//
// Meter: all money in bigint micro-USDC. Simulated time runs CLOCK_MULT x real time.
//   accruedNet = floor(price * simMs / 3_600_000)           (price = NET micro-USD per hour)
//   avail      = held - paid        (gross, from decoded HoldOpened/ToppedUp/Settled)
//   unsettled  = accruedNet - settledNet (settledNet only moves on a decoded Settled)
//   remaining  = avail - gross(unsettled)
//   trigger    : remaining * 10 < holdSize * triggerTenths && latch == none   (edge, once)
//   exhausted  : unsettled >= maxNet(avail)  -> accrual is clamped there, never above
//   so a settle of `unsettled` always satisfies paid + gross(net) <= held (no OVER_HOLD).
// Every tick checks paused, chain deadline - margin, NaN (from the last checkpoint) and snapshot
// freshness; a STALE snapshot (> 10 s) accrues nothing that tick.
import type { DenyCode } from './codes.ts';
import { isTransient } from './codes.ts';
import { gross, HOUR_MS, maxNet, type LossWire } from './rules.ts';

// ------------------------------------------------------------------------------ state machine
export type JobPhase = 'NO_JOB' | 'OPEN' | 'RUNNING' | 'AWAITING_TOPUP' | 'HOLD_EXHAUSTED' | 'STOPPED' | 'CLOSED';
export type Latch = 'none' | 'inflight' | 'denied';
export type StopReason = 'PAUSED' | 'DEADLINE' | 'NAN' | 'MANUAL';

export type JobState = {
  phase: JobPhase;
  latch: Latch;
  /** D4: a denial with a transient code may re-arm once per job */
  rearmed: number;
  deniedCode: DenyCode | null;
  stopReason: StopReason | null;
};

export type JobEvent =
  | { type: 'HOLD_OPENED' }
  | { type: 'START' }
  | { type: 'TRIGGER' }
  | { type: 'EXHAUSTED' }
  | { type: 'TOPPED_UP'; resumeOk: boolean }
  | { type: 'TOPUP_DENIED'; code: DenyCode }
  | { type: 'REARM' }
  | { type: 'STOP'; reason: StopReason }
  | { type: 'CLOSED' };

export class IllegalTransition extends Error {
  override name = 'IllegalTransition';
}

export const INITIAL_STATE: JobState = { phase: 'NO_JOB', latch: 'none', rearmed: 0, deniedCode: null, stopReason: null };

const LIVE: readonly JobPhase[] = ['OPEN', 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED'];

export function next(s: JobState, e: JobEvent): JobState {
  const bad = (): never => {
    throw new IllegalTransition(`${s.phase}/${s.latch} + ${e.type}`);
  };
  if (s.phase === 'CLOSED') bad();
  switch (e.type) {
    case 'HOLD_OPENED':
      return s.phase === 'NO_JOB' ? { ...s, phase: 'OPEN' } : bad();
    case 'START':
      return s.phase === 'OPEN' ? { ...s, phase: 'RUNNING' } : bad();
    case 'TRIGGER':
      return s.phase === 'RUNNING' && s.latch === 'none' ? { ...s, latch: 'inflight' } : bad();
    case 'EXHAUSTED':
      if (s.phase !== 'RUNNING') bad();
      return { ...s, phase: s.latch === 'inflight' ? 'AWAITING_TOPUP' : 'HOLD_EXHAUSTED' };
    case 'TOPPED_UP':
      // late ToppedUp after STOP is ignored: STOPPED holds until CLOSED
      if (s.phase === 'STOPPED') return s;
      if (s.phase === 'RUNNING') return { ...s, latch: 'none', deniedCode: null };
      if (s.phase === 'AWAITING_TOPUP' || s.phase === 'HOLD_EXHAUSTED') {
        return { ...s, phase: e.resumeOk ? 'RUNNING' : s.phase, latch: 'none', deniedCode: null };
      }
      return bad();
    case 'TOPUP_DENIED':
      if (s.phase === 'STOPPED') return { ...s, latch: 'denied', deniedCode: e.code };
      if (s.latch !== 'inflight') bad();
      if (s.phase === 'RUNNING') return { ...s, latch: 'denied', deniedCode: e.code };
      if (s.phase === 'AWAITING_TOPUP') return { ...s, phase: 'HOLD_EXHAUSTED', latch: 'denied', deniedCode: e.code };
      return bad();
    case 'REARM':
      if (s.latch !== 'denied' || !s.deniedCode || !isTransient(s.deniedCode) || s.rearmed >= 1) bad();
      if (s.phase !== 'RUNNING') bad();
      return { ...s, latch: 'none', rearmed: s.rearmed + 1, deniedCode: null };
    case 'STOP':
      if (s.phase === 'STOPPED') return s;
      return LIVE.includes(s.phase) ? { ...s, phase: 'STOPPED', stopReason: e.reason } : bad();
    case 'CLOSED':
      return { ...s, phase: 'CLOSED' };
  }
}

/** True when a denied top-up may re-arm at the next checkpoint (transient code, once per job). */
export function canRearm(s: JobState): boolean {
  return s.phase === 'RUNNING' && s.latch === 'denied' && !!s.deniedCode && isTransient(s.deniedCode) && s.rearmed < 1;
}

// ------------------------------------------------------------------------------ meter
export class JobMeter {
  held = 0n;
  paid = 0n;
  holdSize = 0n;
  settledNet = 0n;
  simMs = 0n;
  readonly price: bigint;
  readonly feeBps: bigint;
  readonly feeExempt: boolean;

  constructor(price: bigint, feeBps: bigint, feeExempt = false) {
    if (price <= 0n) throw new RangeError('price must be > 0');
    this.price = price;
    this.feeBps = feeBps;
    this.feeExempt = feeExempt;
  }

  accruedNet(): bigint {
    return (this.price * this.simMs) / HOUR_MS;
  }
  unsettled(): bigint {
    return this.accruedNet() - this.settledNet;
  }
  avail(): bigint {
    return this.held - this.paid;
  }
  maxUnsettled(): bigint {
    return maxNet(this.avail(), this.feeBps, this.feeExempt);
  }
  remaining(): bigint {
    return this.avail() - gross(this.unsettled(), this.feeBps, this.feeExempt);
  }
  exhausted(): boolean {
    return this.unsettled() >= this.maxUnsettled();
  }
  /** edge condition for the top-up trigger (latch checked by the caller) */
  belowTrigger(triggerTenths: bigint): boolean {
    return this.remaining() * 10n < this.holdSize * triggerTenths;
  }

  /** advance simulated time, clamped so unsettled never exceeds maxNet(avail) */
  advance(simDeltaMs: bigint): { exhausted: boolean } {
    if (simDeltaMs < 0n) throw new RangeError('negative time');
    const cand = this.simMs + simDeltaMs;
    const cap = this.settledNet + this.maxUnsettled();
    if ((this.price * cand) / HOUR_MS > cap) {
      // largest s with floor(price*s/HOUR) <= cap
      const s = ((cap + 1n) * HOUR_MS - 1n) / this.price;
      this.simMs = s > this.simMs ? s : this.simMs;
      return { exhausted: true };
    }
    this.simMs = cand;
    return { exhausted: this.exhausted() };
  }

  onOpened(g: bigint): void {
    this.held = g;
    this.holdSize = g;
  }
  onToppedUp(g: bigint): void {
    this.held += g;
    this.holdSize = g;
  }
  onSettled(net: bigint, fee: bigint): void {
    this.settledNet += net;
    this.paid += net + fee;
  }
}

// ------------------------------------------------------------------------------ tick
export type ChainTickView = {
  /** from the latest snapshot */
  paused: boolean;
  deadline: bigint;
  blockTimestamp: bigint;
  /** wall ms when that snapshot was taken */
  fetchedAtMs: number;
  /** watcher staleness (> 10 s since the last good snapshot) */
  stale: boolean;
};

export type TickAction =
  | { kind: 'checkpoint'; idx: number; loss: LossWire; settleNet: bigint; simSeconds: bigint }
  | { kind: 'trigger' }
  | { kind: 'exhausted'; awaiting: boolean }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'stale' }
  | { kind: 'log'; line: string };

export type ExecutorOpts = {
  clockMult: number;
  /** trigger threshold in tenths (4 = 40%) */
  triggerTenths?: bigint;
  /** stop at chain deadline - margin (15 s; 0 for the deadline-Denied demo) */
  deadlineMarginS?: number;
  /** simulated ms between checkpoints (30 sim-min) */
  checkpointEverySimMs?: bigint;
  /** loss for checkpoint index idx (scenario curve) */
  lossAt: (idx: number) => number;
  /** first checkpoint index for this job (the task's counter continues across migration) */
  firstCheckpointIdx?: number;
};

/** One vendor job on the mock GPU. The session feeds it decoded events and ticks it. */
export class JobExecutor {
  state: JobState = INITIAL_STATE;
  readonly meter: JobMeter;
  readonly jobId: bigint;
  readonly label: string;
  private lastTickMs: number | null = null;
  private nextCkptSimMs: bigint;
  private ckptIdx: number;
  private readonly o: Required<Omit<ExecutorOpts, 'firstCheckpointIdx'>>;
  readonly losses: LossWire[] = [];
  /** usage evidence for the founder wind-down (ledger usage at executor halt) */
  haltedAtAccrued: bigint | null = null;

  constructor(jobId: bigint, label: string, meter: JobMeter, opts: ExecutorOpts) {
    this.jobId = jobId;
    this.label = label;
    this.meter = meter;
    this.o = {
      clockMult: opts.clockMult,
      triggerTenths: opts.triggerTenths ?? 4n,
      deadlineMarginS: opts.deadlineMarginS ?? 15,
      checkpointEverySimMs: opts.checkpointEverySimMs ?? 1_800_000n,
      lossAt: opts.lossAt,
    };
    this.ckptIdx = opts.firstCheckpointIdx ?? 0;
    this.nextCkptSimMs = this.o.checkpointEverySimMs;
  }

  apply(e: JobEvent): void {
    this.state = next(this.state, e);
    if ((e.type === 'STOP' || e.type === 'EXHAUSTED') && this.haltedAtAccrued === null) this.haltedAtAccrued = this.meter.accruedNet();
  }

  /** decoded HoldOpened */
  opened(g: bigint, nowMs: number): void {
    this.meter.onOpened(g);
    this.apply({ type: 'HOLD_OPENED' });
    this.apply({ type: 'START' });
    this.lastTickMs = nowMs;
  }

  /** a checkpoint forced by halt/close: returns the unsettled amount to settle */
  forceCheckpoint(): TickAction & { kind: 'checkpoint' } {
    return this.makeCheckpoint();
  }

  private makeCheckpoint(): TickAction & { kind: 'checkpoint' } {
    const idx = this.ckptIdx++;
    const raw = this.o.lossAt(idx);
    const loss: LossWire = Number.isNaN(raw) ? 'NaN' : raw === Infinity ? 'Infinity' : raw === -Infinity ? '-Infinity' : raw;
    this.losses.push(loss);
    return { kind: 'checkpoint', idx, loss, settleNet: this.meter.unsettled(), simSeconds: this.meter.simMs / 1000n };
  }

  /** chain time now, estimated from the snapshot's block time + wall time since it was read */
  static chainNow(v: ChainTickView, nowMs: number): bigint {
    return v.blockTimestamp + BigInt(Math.max(0, Math.floor((nowMs - v.fetchedAtMs) / 1000)));
  }

  tick(nowMs: number, v: ChainTickView): TickAction[] {
    const out: TickAction[] = [];
    const last = this.lastTickMs ?? nowMs;
    this.lastTickMs = nowMs;
    const phase = this.state.phase;
    if (phase === 'CLOSED' || phase === 'STOPPED' || phase === 'NO_JOB') return out;

    // stop conditions, every tick (AWAITING included)
    const lastLoss = this.losses[this.losses.length - 1];
    let stop: StopReason | null = null;
    if (v.paused) stop = 'PAUSED';
    else if (JobExecutor.chainNow(v, nowMs) >= v.deadline - BigInt(this.o.deadlineMarginS)) stop = 'DEADLINE';
    else if (lastLoss !== undefined && (lastLoss === 'NaN' || lastLoss === 'Infinity' || lastLoss === '-Infinity')) stop = 'NAN';
    if (stop) {
      this.apply({ type: 'STOP', reason: stop });
      out.push({ kind: 'stop', reason: stop });
      return out;
    }
    if (v.stale) {
      out.push({ kind: 'stale' });
      return out; // STALE_CHAIN: no accrual this tick
    }
    if (this.state.phase !== 'RUNNING') return out; // AWAITING / HOLD_EXHAUSTED accrue nothing

    const simDelta = BigInt(Math.max(0, nowMs - last)) * BigInt(this.o.clockMult);
    // cross checkpoint boundaries one at a time so each gets its own settle
    let remainingDelta = simDelta;
    while (remainingDelta > 0n && this.state.phase === 'RUNNING') {
      const toCkpt = this.nextCkptSimMs - this.meter.simMs;
      const step = toCkpt > 0n && toCkpt < remainingDelta ? toCkpt : remainingDelta;
      const before = this.meter.simMs;
      const { exhausted } = this.meter.advance(step);
      remainingDelta -= step;
      if (this.meter.simMs >= this.nextCkptSimMs) {
        this.nextCkptSimMs += this.o.checkpointEverySimMs;
        out.push(this.makeCheckpoint());
      }
      if (this.state.latch === 'none' && this.meter.belowTrigger(this.o.triggerTenths)) {
        this.apply({ type: 'TRIGGER' });
        out.push({ kind: 'trigger' });
      }
      if (exhausted) {
        const awaiting = this.state.latch === 'inflight';
        this.apply({ type: 'EXHAUSTED' });
        out.push({ kind: 'exhausted', awaiting });
        break;
      }
      if (this.meter.simMs === before) break;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------ loss curves
export type LossCurve = (idx: number) => number;

export const LOSS_CURVES = {
  /** steady ~3.5% improvement per checkpoint from 1.35 */
  normal: (i: number) => Math.round(1.35 * 0.965 ** i * 1e4) / 1e4,
  /** improves once, then flat (< 0.5% per checkpoint): plateau detected after checkpoint 4 */
  plateau: (i: number) => Math.round((i < 2 ? 1.35 * 0.965 ** i : 1.35 * 0.965 * 0.999 ** (i - 1)) * 1e4) / 1e4,
  /** diverges to NaN at checkpoint 3 */
  nan: (i: number) => (i >= 3 ? Number.NaN : Math.round(1.35 * 0.965 ** i * 1e4) / 1e4),
} satisfies Record<string, LossCurve>;
