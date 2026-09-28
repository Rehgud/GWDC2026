// B7: executor next() matrix, 60x clock, edge trigger at 36.0 s, AWAITING accrues 0,
// pause/deadline/NaN stop on that tick, STALE accrues 0, sum(settle) == sum(usage), re-arm once.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRearm,
  IllegalTransition,
  INITIAL_STATE,
  JobExecutor,
  JobMeter,
  LOSS_CURVES,
  next,
  type ChainTickView,
  type JobEvent,
  type JobPhase,
  type JobState,
  type TickAction,
} from '../../backend/executor.ts';
import { feeOf, gross, maxNet } from '../../backend/rules.ts';

const PRICE_B = 2_560_000n; // $2.56/h
const HOLD_NET = 2_560_000n; // 1 sim hour
const HOLD_GROSS = gross(HOLD_NET, 300n, false); // 2_636_800
const T0 = 1_800_000_000n;

const st = (phase: JobPhase, latch: JobState['latch'] = 'none', extra: Partial<JobState> = {}): JobState => ({ ...INITIAL_STATE, phase, latch, ...extra });

describe('B7 next(): state x event matrix', () => {
  const PHASES: JobPhase[] = ['NO_JOB', 'OPEN', 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED', 'STOPPED', 'CLOSED'];
  const EVENTS: JobEvent[] = [
    { type: 'HOLD_OPENED' },
    { type: 'START' },
    { type: 'TRIGGER' },
    { type: 'EXHAUSTED' },
    { type: 'TOPPED_UP', resumeOk: true },
    { type: 'TOPUP_DENIED', code: 'QWEN_DENIED' },
    { type: 'REARM' },
    { type: 'STOP', reason: 'PAUSED' },
    { type: 'CLOSED' },
  ];
  // expected phase after the event from (phase, latch=none) — or 'throw'
  const EXPECT: Record<JobPhase, Record<string, JobPhase | 'throw'>> = {
    NO_JOB: { HOLD_OPENED: 'OPEN', START: 'throw', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'throw', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'throw', CLOSED: 'CLOSED' },
    OPEN: { HOLD_OPENED: 'throw', START: 'RUNNING', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'throw', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'STOPPED', CLOSED: 'CLOSED' },
    RUNNING: { HOLD_OPENED: 'throw', START: 'throw', TRIGGER: 'RUNNING', EXHAUSTED: 'HOLD_EXHAUSTED', TOPPED_UP: 'RUNNING', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'STOPPED', CLOSED: 'CLOSED' },
    AWAITING_TOPUP: { HOLD_OPENED: 'throw', START: 'throw', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'RUNNING', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'STOPPED', CLOSED: 'CLOSED' },
    HOLD_EXHAUSTED: { HOLD_OPENED: 'throw', START: 'throw', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'RUNNING', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'STOPPED', CLOSED: 'CLOSED' },
    STOPPED: { HOLD_OPENED: 'throw', START: 'throw', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'STOPPED', TOPUP_DENIED: 'STOPPED', REARM: 'throw', STOP: 'STOPPED', CLOSED: 'CLOSED' },
    CLOSED: { HOLD_OPENED: 'throw', START: 'throw', TRIGGER: 'throw', EXHAUSTED: 'throw', TOPPED_UP: 'throw', TOPUP_DENIED: 'throw', REARM: 'throw', STOP: 'throw', CLOSED: 'throw' },
  };
  for (const p of PHASES) {
    for (const e of EVENTS) {
      const want = EXPECT[p][e.type]!;
      test(`${p} + ${e.type} -> ${want}`, () => {
        if (want === 'throw') assert.throws(() => next(st(p), e), IllegalTransition);
        else assert.equal(next(st(p), e).phase, want);
      });
    }
  }

  test('latch: TRIGGER only from none; TOPUP_DENIED needs inflight; AWAITING + denied -> HOLD_EXHAUSTED', () => {
    assert.throws(() => next(st('RUNNING', 'inflight'), { type: 'TRIGGER' }), IllegalTransition);
    assert.equal(next(st('RUNNING', 'inflight'), { type: 'EXHAUSTED' }).phase, 'AWAITING_TOPUP');
    const d = next(st('AWAITING_TOPUP', 'inflight'), { type: 'TOPUP_DENIED', code: 'QWEN_DENIED' });
    assert.deepEqual([d.phase, d.latch], ['HOLD_EXHAUSTED', 'denied']);
    assert.equal(next(st('RUNNING', 'inflight'), { type: 'TOPUP_DENIED', code: 'QWEN_DENIED' }).latch, 'denied');
  });

  test('STOPPED holds until CLOSED: late ToppedUp / unpause do not resume', () => {
    const s = next(st('STOPPED', 'inflight', { stopReason: 'PAUSED' }), { type: 'TOPPED_UP', resumeOk: true });
    assert.equal(s.phase, 'STOPPED');
  });

  test('AWAITING + ToppedUp while paused/after deadline does not resume', () => {
    assert.equal(next(st('AWAITING_TOPUP', 'inflight'), { type: 'TOPPED_UP', resumeOk: false }).phase, 'AWAITING_TOPUP');
  });

  test('D4 re-arm: transient code once per job; final codes never', () => {
    const t = st('RUNNING', 'denied', { deniedCode: 'QWEN_UNAVAILABLE' });
    assert.equal(canRearm(t), true);
    const r = next(t, { type: 'REARM' });
    assert.deepEqual([r.latch, r.rearmed], ['none', 1]);
    const again = { ...r, latch: 'denied' as const, deniedCode: 'READ_FAILED' as const };
    assert.equal(canRearm(again), false);
    assert.throws(() => next(again, { type: 'REARM' }), IllegalTransition);
    for (const c of ['QWEN_DENIED', 'QWEN_UNPARSEABLE', 'LOSS_PLATEAU', 'OVER_BUDGET_WITH_FEE', 'LLM_CALL_CAP'] as const) {
      assert.equal(canRearm(st('RUNNING', 'denied', { deniedCode: c })), false, c);
    }
    assert.equal(canRearm(st('RUNNING', 'denied', { deniedCode: 'TOPUP_TIMEOUT' })), true);
  });
});

// ------------------------------------------------------------------------------ tick harness
function harness(opts: { clockMult?: number; deadlineMarginS?: number; lossAt?: (i: number) => number } = {}) {
  const meter = new JobMeter(PRICE_B, 300n);
  const ex = new JobExecutor(0n, 'B', meter, { clockMult: opts.clockMult ?? 60, deadlineMarginS: opts.deadlineMarginS ?? 15, lossAt: opts.lossAt ?? LOSS_CURVES.normal });
  let now = 0;
  const view: ChainTickView = { paused: false, deadline: T0 + 7200n, blockTimestamp: T0, fetchedAtMs: 0, stale: false };
  ex.opened(HOLD_GROSS, now);
  const actions: { t: number; a: TickAction }[] = [];
  const settle = (net: bigint) => meter.onSettled(net, feeOf(net, 300n, false));
  /** advance wall time in `step` ms ticks, auto-settling checkpoints like the session does */
  const run = (ms: number, step = 100, autoSettle = true) => {
    for (let t = 0; t < ms; t += step) {
      now += step;
      view.fetchedAtMs = now; // fresh snapshot each tick
      for (const a of ex.tick(now, view)) {
        actions.push({ t: now, a });
        if (a.kind === 'checkpoint' && autoSettle) settle(a.settleNet);
      }
    }
  };
  return { ex, meter, view, actions, run, settle, now: () => now };
}

describe('B7 tick: 60x clock, checkpoints, edge trigger', () => {
  test('1 real second = 1 sim minute: $2.56/h accrues $0.042666 per real second', () => {
    const h = harness();
    h.run(1000, 1000);
    assert.equal(h.meter.accruedNet(), (PRICE_B * 60_000n) / 3_600_000n);
    assert.equal(h.meter.accruedNet(), 42_666n);
  });

  test('checkpoint every 30 sim-min = 30 real s; trigger fires ONCE at 36.0 s; no extra F1 in the next 20 ticks', () => {
    const h = harness();
    h.run(36_000);
    const ck = h.actions.filter((x) => x.a.kind === 'checkpoint');
    assert.equal(ck.length, 1);
    assert.equal(ck[0]!.t, 30_000);
    // without the 30 s settle the trigger point is 36.0 s (remaining < 40% of the hold)
    const h2 = harness();
    h2.run(40_000, 100, false);
    const trig = h2.actions.filter((x) => x.a.kind === 'trigger');
    assert.equal(trig.length, 1);
    assert.ok(trig[0]!.t >= 35_900 && trig[0]!.t <= 36_100, `trigger at ${trig[0]!.t}`);
    const before = h2.actions.length;
    h2.run(2_000, 100, false); // 20 more ticks
    assert.equal(h2.actions.slice(before).filter((x) => x.a.kind === 'trigger').length, 0);
    assert.equal(h2.ex.state.latch, 'inflight');
  });

  test('exhaustion with a top-up in flight -> AWAITING_TOPUP, which accrues nothing', () => {
    const h = harness();
    h.run(70_000);
    assert.equal(h.ex.state.phase, 'AWAITING_TOPUP');
    const acc = h.meter.accruedNet();
    assert.ok(h.meter.unsettled() <= maxNet(h.meter.avail(), 300n, false), 'never above maxNet(avail)');
    h.run(10_000);
    assert.equal(h.meter.accruedNet(), acc, 'AWAITING accrues 0');
    // ToppedUp decoded -> resume
    h.meter.onToppedUp(HOLD_GROSS);
    h.ex.apply({ type: 'TOPPED_UP', resumeOk: true });
    h.run(1_000);
    assert.equal(h.ex.state.phase, 'RUNNING');
    assert.ok(h.meter.accruedNet() > acc);
  });

  test('denied top-up -> runs down the remaining hold -> HOLD_EXHAUSTED; settle(unsettled) never over-settles', () => {
    const h = harness();
    h.run(37_000);
    h.ex.apply({ type: 'TOPUP_DENIED', code: 'QWEN_DENIED' });
    h.run(60_000);
    assert.equal(h.ex.state.phase, 'HOLD_EXHAUSTED');
    const n = h.meter.unsettled();
    assert.ok(h.meter.paid + gross(n, 300n, false) <= h.meter.held, 'final settle fits the hold (no OVER_HOLD)');
    h.settle(n);
    assert.equal(h.meter.unsettled(), 0n);
    assert.equal(h.meter.settledNet, h.meter.accruedNet(), 'sum(settle) == sum(usage)');
  });

  test('STOP (paused) is detected on the very tick it appears; no accrual after', () => {
    const h = harness();
    h.run(10_000);
    const acc = h.meter.accruedNet();
    h.view.paused = true;
    h.run(100);
    assert.deepEqual([h.ex.state.phase, h.ex.state.stopReason], ['STOPPED', 'PAUSED']);
    assert.equal(h.meter.accruedNet(), acc, 'no usage after STOP');
    h.view.paused = false; // unpause does not resume
    h.run(5_000);
    assert.equal(h.ex.state.phase, 'STOPPED');
    assert.equal(h.ex.haltedAtAccrued, acc);
  });

  test('deadline: stops at chain deadline - 15 s on that tick; margin 0 runs to the deadline', () => {
    const h = harness();
    h.view.deadline = T0 + 20n;
    // chain time advances with wall time (a new block every second)
    let stoppedAt = -1;
    for (let i = 0; i < 200 && h.ex.state.phase === 'RUNNING'; i++) {
      h.view.blockTimestamp = T0 + BigInt(Math.floor(h.now() / 1000));
      h.run(100);
      if ((h.ex.state.phase as string) === 'STOPPED') stoppedAt = h.now();
    }
    assert.equal(h.ex.state.stopReason, 'DEADLINE');
    assert.ok(stoppedAt >= 5_000 && stoppedAt <= 5_200, `stopped at ${stoppedAt} ms (deadline 20 s - margin 15 s)`);
    const h0 = harness({ deadlineMarginS: 0 });
    h0.view.deadline = T0 + 3n;
    h0.view.blockTimestamp = T0 + 2n;
    h0.run(100);
    assert.equal(h0.ex.state.phase, 'RUNNING', 'still before the deadline with margin 0');
    h0.view.blockTimestamp = T0 + 3n;
    h0.run(100);
    assert.equal(h0.ex.state.stopReason, 'DEADLINE');
  });

  test('NaN at a checkpoint stops the job on the next tick (code handles it, no Qwen)', () => {
    const h = harness({ lossAt: LOSS_CURVES.nan });
    h.run(125_000); // checkpoints 0..3 (NaN at 3), with top-ups to keep running
    const idxs = h.actions.filter((x) => x.a.kind === 'checkpoint').length;
    assert.ok(idxs >= 1);
    // drive to checkpoint 3 quickly with generous holds
    const h2 = harness({ lossAt: LOSS_CURVES.nan });
    h2.meter.onToppedUp(20_000_000n);
    h2.ex.apply({ type: 'TOPPED_UP', resumeOk: true });
    h2.run(125_000);
    assert.equal(h2.ex.state.stopReason, 'NAN');
    assert.equal(h2.ex.losses.at(-1), 'NaN');
  });

  test('STALE snapshot: no accrual on those ticks, resumes when fresh', () => {
    const h = harness();
    h.run(5_000);
    const acc = h.meter.accruedNet();
    h.view.stale = true;
    h.run(3_000);
    assert.equal(h.meter.accruedNet(), acc);
    assert.ok(h.actions.some((x) => x.a.kind === 'stale'));
    h.view.stale = false;
    h.run(1_000);
    assert.ok(h.meter.accruedNet() > acc);
  });

  test('CLOCK_MULT=600 (local e2e): the same hold lasts 6 real seconds', () => {
    const h = harness({ clockMult: 600 });
    h.run(7_000, 50, false);
    assert.ok(h.ex.state.phase === 'HOLD_EXHAUSTED' || h.ex.state.phase === 'AWAITING_TOPUP');
  });

  test('loss curves: normal reaches < 1.20 by checkpoint 4, plateau is flat after 3, nan at 3', () => {
    assert.ok(LOSS_CURVES.normal(4) < 1.2);
    for (let i = 1; i < 8; i++) assert.ok((LOSS_CURVES.plateau(i) - LOSS_CURVES.plateau(i + 1)) / LOSS_CURVES.plateau(i) < 0.005);
    assert.ok(Number.isNaN(LOSS_CURVES.nan(3)));
  });
});
