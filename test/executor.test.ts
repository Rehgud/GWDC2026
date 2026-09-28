import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lossPlateau, gross } from '../src/rules.ts'
import type { ChainSnapshot } from '../src/types.ts'
import {
  lossAt, newJob, next, planWindDown, tick,
  type Action, type Intent, type Job, type JobEvent, type JobState, type Latch,
} from '../src/executor.ts'

const V = '0x000000000000000000000000000000000000000A' as const
const INF = '0x00000000000000000000000000000000000000fF' as const
const P = 2_560_000n // H100 (B) $2.56/h
const HOLD = gross(P, false) // 1 sim hour: $2.6368
const T0 = 1_000_000n
const normal = (m: number) => lossAt('normal', m)

function snap(t: number, o: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    block: 1n, blockTs: T0 + BigInt(Math.floor(t / 1000)), readAt: t, paused: false, deadline: T0 + 3600n,
    budget: 20_000_000n, committed: 0n, maxHold: 6_000_000n, feeBps: 300n, inferencePayee: INF,
    vendorAllowed: { [V.toLowerCase()]: true, [INF.toLowerCase()]: true }, jobs: [], ...o,
  }
}

const running = (): Job => next(next(newJob(V, P), { type: 'HoldOpened', jobId: 1n, gross: HOLD }), { type: 'Start' })

type Run = { step?: number; snap?: (t: number) => ChainSnapshot | null; loss?: (m: number) => number; settle?: boolean; margin?: bigint }

/** Ticks t0..t1 inclusive. Decodes each CHECKPOINT_SETTLE as Settled right away unless settle=false. */
function run(j: Job, t0: number, t1: number, o: Run = {}) {
  const log: { t: number; a: Action }[] = []
  for (let t = t0; t <= t1; t += o.step ?? 100) {
    const r = tick(j, { nowMs: t, snapshot: (o.snap ?? snap)(t), lossAtSimMinute: o.loss ?? normal, deadlineMarginS: o.margin })
    j = r.job
    for (const a of r.actions) {
      log.push({ t, a })
      if (a.type === 'CHECKPOINT_SETTLE' && o.settle !== false) j = next(j, { type: 'Settled', amount: a.amount })
    }
  }
  return { j, log }
}
const count = (log: { a: Action }[], type: Action['type']) => log.filter((x) => x.a.type === type).length
const settledSum = (log: { a: Action }[]) => log.reduce((s, x) => s + (x.a.type === 'CHECKPOINT_SETTLE' ? x.a.amount : 0n), 0n)

// ---- next(): every state x event -------------------------------------------------------------

const STATES: JobState[] = ['NO_JOB', 'OPEN', 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED', 'STOPPED', 'CLOSED']
const CANON_LATCH: Record<JobState, Latch> = {
  NO_JOB: 'none', OPEN: 'none', RUNNING: 'none', AWAITING_TOPUP: 'inflight', HOLD_EXHAUSTED: 'denied', STOPPED: 'none', CLOSED: 'none',
}
function inState(state: JobState, latch = CANON_LATCH[state], denyCode: Job['denyCode'] = latch === 'denied' ? 'QWEN_DENIED' : null): Job {
  return { ...newJob(V, P), id: state === 'NO_JOB' ? null : 1n, state, latch, denyCode, held: 2000n, holdSize: 2000n, accrued: 1000n, pendingNet: 500n }
}
const EV: Record<string, JobEvent> = {
  HoldOpened: { type: 'HoldOpened', jobId: 1n, gross: HOLD },
  Start: { type: 'Start' },
  TopupRequested: { type: 'TopupRequested', atMs: 0 },
  ToppedUp: { type: 'ToppedUp', gross: 100n },
  TopupDenied: { type: 'TopupDenied', code: 'QWEN_DENIED' },
  Rearm: { type: 'Rearm' },
  Settled: { type: 'Settled', amount: 500n },
  SettleFailed: { type: 'SettleFailed', amount: 500n },
  Exhausted: { type: 'Exhausted' },
  Stop: { type: 'Stop', reason: 'PAUSED' },
  Closed: { type: 'Closed' },
}
const x = null // throws
// columns follow STATES
const MATRIX: Record<string, (JobState | null)[]> = {
  HoldOpened:     ['OPEN', x, x, x, x, x, x],
  Start:          [x, 'RUNNING', x, x, x, x, x],
  TopupRequested: [x, x, 'RUNNING', x, x, x, x],
  ToppedUp:       [x, 'OPEN', 'RUNNING', 'RUNNING', 'HOLD_EXHAUSTED', 'STOPPED', x],
  TopupDenied:    [x, x, x, 'HOLD_EXHAUSTED', x, x, x],
  Rearm:          [x, x, x, x, x, x, x],
  Settled:        [x, x, 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED', 'STOPPED', x],
  SettleFailed:   [x, x, 'RUNNING', 'AWAITING_TOPUP', 'HOLD_EXHAUSTED', 'STOPPED', x],
  Exhausted:      [x, x, 'HOLD_EXHAUSTED', x, x, x, x],
  Stop:           [x, 'STOPPED', 'STOPPED', 'STOPPED', 'STOPPED', 'STOPPED', x],
  Closed:         [x, x, x, x, 'CLOSED', 'CLOSED', x],
}

test('next: every state x event (canonical latch per state)', () => {
  for (const [ev, row] of Object.entries(MATRIX)) {
    STATES.forEach((s, k) => {
      const want = row[k]
      const j = inState(s)
      if (want === null) assert.throws(() => next(j, EV[ev]), undefined, `${s} + ${ev} should throw`)
      else assert.equal(next(j, EV[ev]).state, want, `${s} + ${ev}`)
    })
  }
})

test('next: latch-dependent transitions', () => {
  const inflight = inState('RUNNING', 'inflight')
  assert.throws(() => next(inflight, EV.TopupRequested))
  assert.equal(next(inflight, EV.Exhausted).state, 'AWAITING_TOPUP')
  const denied = next(inflight, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })
  assert.deepEqual([denied.state, denied.latch, denied.epoch], ['RUNNING', 'denied', inflight.epoch + 1])
  const rearmed = next(denied, EV.Rearm)
  assert.deepEqual([rearmed.latch, rearmed.rearms], ['none', 1])
  const again = next(next(rearmed, EV.TopupRequested), { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })
  assert.throws(() => next(again, EV.Rearm), undefined, 'second transient re-arm')
  assert.throws(() => next(inState('RUNNING', 'denied', 'LOSS_PLATEAU'), EV.Rearm), undefined, 'final code re-arm')

  assert.equal(next(inState('HOLD_EXHAUSTED', 'none'), EV.TopupRequested).state, 'AWAITING_TOPUP')
  const up = next(inState('AWAITING_TOPUP'), { type: 'ToppedUp', gross: 777n })
  assert.deepEqual([up.state, up.latch, up.holdSize, up.held], ['RUNNING', 'none', 777n, 2777n])

  // STOPPED persists: a late ToppedUp only moves held, a late denial only the latch.
  const st = inState('STOPPED', 'inflight')
  assert.deepEqual([next(st, EV.ToppedUp).state, next(st, EV.ToppedUp).held], ['STOPPED', 2100n])
  assert.equal(next(st, EV.TopupDenied).state, 'STOPPED')
  // A denied / timed-out flow that still lands on chain does not resume the job.
  const late = next(inState('HOLD_EXHAUSTED', 'denied', 'TOPUP_TIMEOUT'), EV.ToppedUp)
  assert.deepEqual([late.state, late.latch, late.held], ['HOLD_EXHAUSTED', 'denied', 2100n])
  // Stop keeps the first reason and bumps the epoch, so an in-flight top-up flow ends CANCELLED.
  assert.equal(next(next(inState('RUNNING'), EV.Stop), { type: 'Stop', reason: 'NAN_DETECTED' }).stopReason, 'PAUSED')
  assert.equal(next(inflight, EV.Stop).epoch, inflight.epoch + 1)
})

test('next: Settled guards against paying more than usage or than what was issued', () => {
  assert.throws(() => next(inState('RUNNING'), { type: 'Settled', amount: 1001n }), /exceeds unsettled/)
  assert.throws(() => next(inState('RUNNING'), { type: 'Settled', amount: 600n }), /pending/)
  assert.throws(() => next(inState('RUNNING'), { type: 'SettleFailed', amount: 501n }))
  const founder = next({ ...inState('STOPPED'), pendingNet: 0n }, { type: 'Settled', amount: 1000n })
  assert.deepEqual([founder.settledNet, founder.held], [1000n, 2000n - 1030n])
  assert.throws(() => newJob(V, 0n))
})

// ---- tick() ----------------------------------------------------------------------------------

test('tick: H100 1 sim hour hold -> trigger fires once at ~36.0s, then 20 ticks fire nothing', () => {
  const { j, log } = run(running(), 0, 36_100)
  const req = log.filter((e) => e.a.type === 'REQUEST_TOPUP')
  assert.equal(req.length, 1)
  assert.equal(req[0].t, 36_100) // 36.000s is exactly 40% (not below); the next 100ms tick crosses
  assert.equal(j.latch, 'inflight')
  // checkpoint at 30 sim minutes, and another at the top-up request
  assert.deepEqual(log.filter((e) => e.a.type === 'CHECKPOINT_SETTLE').map((e) => [e.t, (e.a as any).amount]), [[30_000, 1_280_000n], [36_100, 260_266n]])
  assert.equal(j.losses.length, 2)
  const after = run(j, 36_200, 38_100)
  assert.equal(count(after.log, 'REQUEST_TOPUP'), 0)
})

test('tick: hold exhausts at 60s -> AWAITING_TOPUP accrues 0; ToppedUp resumes with the new hold size', () => {
  let { j } = run(running(), 0, 60_000)
  assert.equal(j.state, 'AWAITING_TOPUP')
  assert.equal(j.accrued, P) // exactly 1 sim hour, never more than maxNet(held)
  const wait = run(j, 60_100, 70_000)
  assert.equal(wait.j.accrued, P)
  assert.equal(count(wait.log, 'CHECKPOINT_SETTLE') + count(wait.log, 'REQUEST_TOPUP'), 0)
  j = next(wait.j, { type: 'ToppedUp', gross: gross(2n * P, false) })
  assert.deepEqual([j.state, j.latch, j.holdSize], ['RUNNING', 'none', gross(2n * P, false)])
  const res = run(j, 70_100, 80_100)
  assert.equal(res.j.accrued, P + (10_000n * P) / 60_000n) // 70.1 re-arms the clock, 70.1..80.1 = 10s
})

test('tick: pause stops on the same tick (also in AWAITING_TOPUP); unpause and late ToppedUp are ignored', () => {
  const a = run(running(), 0, 10_000)
  const p = tick(a.j, { nowMs: 10_100, snapshot: snap(10_100, { paused: true }), lossAtSimMinute: normal })
  assert.deepEqual([p.job.state, p.job.stopReason, p.job.accrued], ['STOPPED', 'PAUSED', a.j.accrued])
  assert.equal(count(p.actions.map((a) => ({ a })), 'CHECKPOINT_SETTLE'), 0) // agent settle would be Denied(PAUSED)
  const later = run(next(p.job, { type: 'ToppedUp', gross: HOLD }), 10_200, 20_000)
  assert.deepEqual([later.j.state, later.j.accrued, later.log.length], ['STOPPED', a.j.accrued, 0])

  const w = run(running(), 0, 60_000).j
  assert.equal(w.state, 'AWAITING_TOPUP')
  const ws = tick(w, { nowMs: 60_100, snapshot: snap(60_100, { paused: true }), lossAtSimMinute: normal }).job
  assert.equal(ws.state, 'STOPPED')
  assert.equal(ws.losses.length, w.losses.length) // no running since the last checkpoint -> no repeated loss point
})

test('tick: deadline stops at deadline - 15s on that tick; margin 0 stops only at the deadline', () => {
  const a = run(running(), 0, 5_000).j
  const at = (blockTs: bigint, margin?: bigint) =>
    tick(a, { nowMs: 5_100, snapshot: snap(5_100, { blockTs }), lossAtSimMinute: normal, deadlineMarginS: margin }).job
  assert.equal(at(T0 + 3600n - 16n).state, 'RUNNING')
  const stopped = at(T0 + 3600n - 15n)
  assert.deepEqual([stopped.state, stopped.stopReason, stopped.accrued], ['STOPPED', 'PAST_DEADLINE', a.accrued])
  assert.equal(at(T0 + 3599n, 0n).state, 'RUNNING')
  assert.equal(at(T0 + 3600n, 0n).state, 'STOPPED')
})

test('tick: NaN loss stops on that tick and settles all usage (agent path)', () => {
  const { j, log } = run(running(), 0, 25_000, { loss: (m) => lossAt('nan', m, 20) })
  assert.deepEqual([j.state, j.stopReason], ['STOPPED', 'NAN_DETECTED'])
  const stopAt = log.find((e) => e.a.type === 'STOPPED')!.t
  assert.equal(stopAt, 20_000)
  assert.equal(j.accrued, (20_000n * P) / 60_000n)
  assert.ok(Number.isNaN(j.losses.at(-1)))
  assert.equal(settledSum(log), j.accrued)
  assert.equal(j.settledNet, j.accrued)
})

test('tick: a failed or stale read accrues 0', () => {
  const a = run(running(), 0, 10_000).j
  const failed = tick(a, { nowMs: 10_100, snapshot: null, lossAtSimMinute: normal }).job
  assert.equal(failed.accrued, a.accrued)
  assert.equal(failed.state, 'RUNNING')
  const stale = tick(a, { nowMs: 10_100, snapshot: snap(99), lossAtSimMinute: normal }).job // 10.001 s old
  assert.equal(stale.accrued, a.accrued)
  assert.equal(tick(a, { nowMs: 10_100, snapshot: snap(100), lossAtSimMinute: normal }).job.runningMs, a.runningMs + 100n) // 10 s: still fresh
  // the first fresh tick after a gap only re-arms the clock; the gap is never billed
  const back = run(failed, 10_200, 10_300)
  assert.equal(back.j.runningMs, a.runningMs + 100n)
})

test('tick: sum of checkpoint settles == usage across a top-up and a final denial', () => {
  let { j, log } = run(running(), 0, 40_000)
  j = next(j, { type: 'ToppedUp', gross: gross(2n * P, false) }) // approved at 40s
  const r2 = run(j, 40_100, 140_000) // second trigger fires at ~132s (40% of the 2h top-up left), then:
  assert.equal(count(r2.log, 'REQUEST_TOPUP'), 1)
  j = next(r2.j, { type: 'TopupDenied', code: 'QWEN_DENIED' })
  const r3 = run(j, 140_100, 220_000)
  assert.equal(r3.j.state, 'HOLD_EXHAUSTED')
  assert.equal(r3.j.accrued, 3n * P) // exactly the 3 sim hours held
  assert.equal(settledSum([...log, ...r2.log, ...r3.log]), r3.j.accrued)
  assert.equal(r3.j.settledNet, r3.j.accrued)
  assert.equal(count(r3.log, 'REQUEST_TOPUP'), 0)
})

test('tick: a settle still in flight is not paid twice by the next checkpoint', () => {
  const { j, log } = run(running(), 0, 36_100, { settle: false })
  assert.equal(settledSum(log), j.accrued)
  assert.equal(j.pendingNet, j.accrued)
  assert.equal(j.settledNet, 0n)
})

test('tick: transient denial re-arms exactly once; LOSS_PLATEAU never re-arms', () => {
  let { j, log } = run(running(), 0, 40_000)
  j = next(j, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })
  const r2 = run(j, 40_100, 60_000) // next checkpoint (60s, also exhaustion) re-arms and asks again
  assert.equal(count(r2.log, 'REQUEST_TOPUP'), 1)
  assert.deepEqual([r2.j.state, r2.j.rearms], ['AWAITING_TOPUP', 1])
  j = next(r2.j, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })
  const r3 = run(j, 60_100, 90_000)
  assert.equal(count(r3.log, 'REQUEST_TOPUP'), 0)
  assert.equal(r3.j.state, 'HOLD_EXHAUSTED')
  assert.equal(count(log, 'REQUEST_TOPUP') + count(r2.log, 'REQUEST_TOPUP') + count(r3.log, 'REQUEST_TOPUP'), 2)

  let p = run(running(), 0, 40_000).j
  p = next(p, { type: 'TopupDenied', code: 'LOSS_PLATEAU' })
  const rp = run(p, 40_100, 120_000)
  assert.equal(count(rp.log, 'REQUEST_TOPUP'), 0)
  assert.deepEqual([rp.j.state, rp.j.rearms], ['HOLD_EXHAUSTED', 0])
})

test('tick: top-up flow older than 60s -> TOPUP_TIMEOUT (transient: one more try at the next checkpoint, then final)', () => {
  const { log, j } = run(running(), 0, 250_000)
  const kinds = log.filter((e) => e.a.type === 'TOPUP_TIMEOUT' || e.a.type === 'REQUEST_TOPUP').map((e) => [e.t, e.a.type])
  // the retry waits 30 s (the next checkpoint), never the same tick as the timeout
  assert.deepEqual(kinds, [[36_100, 'REQUEST_TOPUP'], [96_200, 'TOPUP_TIMEOUT'], [126_200, 'REQUEST_TOPUP'], [186_300, 'TOPUP_TIMEOUT']])
  assert.deepEqual([j.state, j.latch, j.denyCode], ['HOLD_EXHAUSTED', 'denied', 'TOPUP_TIMEOUT'])
})

test('tick: a transient denial after exhaustion re-arms 30 s later (next checkpoint), not on the next tick', () => {
  let j = run(running(), 0, 60_000).j
  assert.equal(j.state, 'AWAITING_TOPUP')
  j = next(j, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })
  const wait = run(j, 60_100, 90_000)
  assert.deepEqual([wait.j.state, wait.log.length], ['HOLD_EXHAUSTED', 0])
  const retry = run(wait.j, 90_100, 90_100)
  assert.deepEqual(retry.log.map((e) => e.a.type), ['REQUEST_TOPUP'])
  assert.deepEqual([retry.j.state, retry.j.rearms], ['AWAITING_TOPUP', 1])
})

test('lossAt: normal never plateaus, plateau trips LOSS_PLATEAU, nan is NaN from the minute', () => {
  const at = (sc: 'normal' | 'plateau', ms: number[]) => ms.map((m) => lossAt(sc, m))
  assert.equal(lossPlateau(at('normal', [30, 31, 32, 33, 34])), false)
  assert.equal(lossPlateau(at('normal', [60, 90, 120, 150, 180])), false)
  assert.equal(lossPlateau(at('plateau', [30, 36, 60, 90])), false)
  assert.equal(lossPlateau(at('plateau', [60, 90, 120, 150])), true)
  assert.ok(Number.isNaN(lossAt('nan', 45, 45)) && !Number.isNaN(lossAt('nan', 44, 45)))
})

// ---- planWindDown() --------------------------------------------------------------------------

type ChainJob = ChainSnapshot['jobs'][number]
/** Minimal vault: open/settle/close/refund with the contract's gross/held/committed bookkeeping. */
function vault() {
  const c = { budget: 20_000_000n, committed: 0n, jobs: [] as ChainJob[], received: new Map<string, bigint>() }
  const open = (vendor: `0x${string}`, net: bigint) => {
    const g = gross(net, vendor === INF)
    c.jobs.push({ vendor, held: g, paid: 0n, closed: false }); c.committed += g
    return { id: BigInt(c.jobs.length - 1), g }
  }
  const settle = (id: bigint, net: bigint) => {
    const j = c.jobs[Number(id)]; const g = gross(net, j.vendor === INF)
    assert.ok(!j.closed && g <= j.held, 'OVER_HOLD'); j.held -= g; j.paid += g
    c.received.set(j.vendor, (c.received.get(j.vendor) ?? 0n) + net)
  }
  const apply = (ins: Intent[], jobs: Job[]) => {
    for (const it of ins) {
      if (it.kind === 'refund') { assert.ok(it.amount <= c.budget - c.committed); c.budget -= it.amount; continue }
      const k = jobs.findIndex((j) => j.id === it.jobId)
      if (it.kind === 'settle') { settle(it.jobId, it.amount); if (k >= 0) jobs[k] = next(jobs[k], { type: 'Settled', amount: it.amount }) }
      else { const j = c.jobs[Number(it.jobId)]; assert.ok(!j.closed); c.committed -= j.held; j.held = 0n; j.closed = true; if (k >= 0) jobs[k] = next(jobs[k], { type: 'Closed' }) }
    }
  }
  const at = (t: number, o: Partial<ChainSnapshot> = {}) =>
    snap(t, { budget: c.budget, committed: c.committed, jobs: c.jobs.map((j) => ({ ...j })), ...o })
  return { c, open, settle, apply, at }
}

test('planWindDown: STOP path pays the vendor exactly the ledger usage; a second run plans nothing', () => {
  const v = vault()
  const inf = v.open(INF, 50_000n)
  const job = v.open(V, P)
  let j = next(next(newJob(V, P), { type: 'HoldOpened', jobId: job.id, gross: job.g }), { type: 'Start' })
  // run 45s: checkpoint settles at 30s and at the trigger land on chain
  for (let t = 0; t <= 45_000; t += 100) {
    const r = tick(j, { nowMs: t, snapshot: snap(t), lossAtSimMinute: normal })
    j = r.job
    for (const a of r.actions) if (a.type === 'CHECKPOINT_SETTLE') { v.settle(job.id, a.amount); j = next(j, { type: 'Settled', amount: a.amount }) }
  }
  j = tick(j, { nowMs: 45_100, snapshot: v.at(45_100, { paused: true }), lossAtSimMinute: normal }).job
  assert.equal(j.state, 'STOPPED')
  const usage = j.accrued
  assert.ok(usage > j.settledNet, 'something left for the founder to settle')

  const s1 = v.at(45_200, { paused: true })
  const plan = planWindDown({ jobs: [j], inference: { jobId: inf.id, usageNet: 8_400n }, snapshot: s1 })
  assert.deepEqual(plan.map((p) => [p.kind, p.signer]), [
    ['settle', 'founder'], ['close', 'founder'], ['settle', 'founder'], ['close', 'founder'], ['refund', 'founder'],
  ])
  assert.equal((plan[0] as any).amount, usage - j.settledNet)
  const jobs = [j]
  v.apply(plan, jobs)
  assert.equal(v.c.received.get(V), usage) // vendor net == ledger usage
  assert.equal(v.c.received.get(INF), 8_400n)
  assert.equal(v.c.budget, v.c.committed) // everything not spent went back to the founder
  assert.equal(jobs[0].state, 'CLOSED')
  // second run: fresh snapshot, even with the executor's stale (pre-close) job objects
  assert.deepEqual(planWindDown({ jobs: [j], inference: { jobId: inf.id, usageNet: 8_400n }, snapshot: v.at(45_300, { paused: true }) }), [])
})

test('planWindDown: a re-run after only the settle landed never pays the vendor twice', () => {
  const v = vault()
  const job = v.open(V, 3n * P)
  let j = next(next(newJob(V, P), { type: 'HoldOpened', jobId: job.id, gross: job.g }), { type: 'Start' })
  j = next(run(j, 0, 20_000, { settle: false }).j, { type: 'Stop', reason: 'PAUSED' })
  const plan = planWindDown({ jobs: [j], inference: null, snapshot: v.at(20_000, { paused: true }) })
  v.apply(plan.slice(0, 1), []) // founder settle landed; close HALTed and the Settled never reached the job object
  assert.throws(() => planWindDown({ jobs: [j], inference: null, snapshot: v.at(20_100, { paused: true }) }), /missing Settled/)
  const synced = next(j, { type: 'Settled', amount: (plan[0] as any).amount })
  const again = planWindDown({ jobs: [synced], inference: null, snapshot: v.at(20_100, { paused: true }) })
  assert.deepEqual(again.map((p) => p.kind), ['close', 'refund'])
  assert.equal(v.c.received.get(V), j.accrued)
})

test('planWindDown: a HOLD_EXHAUSTED job that can still re-arm must be stopped first', () => {
  let j = run(running(), 0, 60_000).j
  j = next(j, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' }) // HOLD_EXHAUSTED, transient, not yet re-armed
  const s = snap(60_100, { jobs: [{ vendor: V, held: HOLD, paid: 0n, closed: true }, { vendor: V, held: HOLD - gross(P, false), paid: gross(P, false), closed: false }] })
  assert.throws(() => planWindDown({ jobs: [j], inference: null, snapshot: s }), /stop it first/)
  assert.equal(planWindDown({ jobs: [next(j, { type: 'Stop', reason: 'END' })], inference: null, snapshot: s })[0].kind, 'close')
  const final = next(next(j, { type: 'Rearm' }), { type: 'TopupRequested', atMs: 60_100 })
  assert.equal(planWindDown({ jobs: [next(final, { type: 'TopupDenied', code: 'QWEN_UNAVAILABLE' })], inference: null, snapshot: s })[0].kind, 'close')
})

test('planWindDown: agent signs settle/close while live; refuses running jobs and settles in flight', () => {
  const v = vault()
  const inf = v.open(INF, 50_000n)
  const job = v.open(V, P)
  const base = next(next(newJob(V, P), { type: 'HoldOpened', jobId: job.id, gross: job.g }), { type: 'Start' })
  const r = run(base, 0, 20_000, { settle: false }) // no checkpoint yet at 20s
  assert.equal(r.log.length, 0)
  assert.throws(() => planWindDown({ jobs: [r.j], inference: null, snapshot: v.at(20_000) }), /stop it first/)
  const stopped = next(r.j, { type: 'Stop', reason: 'END' })
  const plan = planWindDown({ jobs: [stopped], inference: { jobId: inf.id, usageNet: 0n }, snapshot: v.at(20_000) })
  assert.deepEqual(plan.map((p) => [p.kind, p.signer]), [['settle', 'agent'], ['close', 'agent'], ['close', 'agent'], ['refund', 'founder']])
  // past deadline - margin -> founder
  const late = planWindDown({ jobs: [stopped], inference: null, snapshot: v.at(20_000, { blockTs: T0 + 3600n - 15n }) })
  assert.deepEqual(late.slice(0, 2).map((p) => p.signer), ['founder', 'founder'])
  // vendor allowlist revoked: agent settle would be Denied (D3), so the founder settles; the agent may still close
  const revoked = planWindDown({ jobs: [stopped], inference: null, snapshot: v.at(20_000, { vendorAllowed: {} }) })
  assert.deepEqual(revoked.slice(0, 2).map((p) => p.signer), ['founder', 'agent'])
  // ledger usage that does not fit the chain hold -> refuse instead of a settle that would be Denied(OVER_HOLD)
  assert.throws(() => planWindDown({ jobs: [{ ...stopped, accrued: 2n * P }], inference: null, snapshot: v.at(20_000) }), /does not fit/)
  // settle in flight -> refuse (would pay the same span twice)
  assert.throws(() => planWindDown({ jobs: [{ ...stopped, pendingNet: 1n }], inference: null, snapshot: v.at(20_000) }), /in flight/)
})
