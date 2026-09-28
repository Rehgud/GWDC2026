// Mock GPU job executor: the job state machine next(), the 60x clock tick() and the windDown plan. Pure: no chain, no Kiln, no I/O.
// Amounts are net micro-USDC unless named gross/held/holdSize. 1 real second = 1 simulated minute (rules.CLOCK_MULT).
import type { Hex } from 'viem'
import { TRANSIENT, type Code } from './codes.ts'
import { gross, maxNet } from './rules.ts'
import type { ChainSnapshot } from './types.ts'

export type JobState = 'NO_JOB' | 'OPEN' | 'RUNNING' | 'AWAITING_TOPUP' | 'HOLD_EXHAUSTED' | 'STOPPED' | 'CLOSED'
export type Latch = 'none' | 'inflight' | 'denied'
/** PAUSED / PAST_DEADLINE / NAN_DETECTED come from tick(); END and MIGRATE are applied by the orchestrator before windDown/close. */
export type StopReason = 'PAUSED' | 'PAST_DEADLINE' | 'NAN_DETECTED' | 'END' | 'MIGRATE'

export type Job = {
  id: bigint | null // from HoldOpened only
  vendor: Hex
  pricePerHour: bigint // net per GPU-hour, > 0
  feeExempt: boolean
  state: JobState
  latch: Latch
  denyCode: Code | null // why the latch is 'denied'
  rearms: number // transient re-arms used (max 1 per job, D4)
  epoch: number // async flows carry it; a change means CANCELLED, no tx
  stopReason: StopReason | null
  holdSize: bigint // gross of the last open/topUp (fixed); the 40% trigger base
  held: bigint // gross, tracked from decoded HoldOpened/ToppedUp/Settled/Closed
  runningMs: bigint // total RUNNING ms that counted (fresh snapshot); usage derives from this
  accrued: bigint // net usage = floor(runningMs * pricePerHour / 60_000)
  settledNet: bigint // sum of decoded Settled; unsettled = accrued - settledNet
  pendingNet: bigint // CHECKPOINT_SETTLE issued but not yet Settled/failed (prevents paying a span twice)
  losses: number[] // one per checkpoint, oldest first (gate LOSS_PLATEAU input)
  checkpointMs: bigint // runningMs at the last checkpoint
  topupAtMs: number | null // when the in-flight top-up flow started
  deniedAtMs: number | null // first tick that saw a re-armable (transient) denial
  accrueFromMs: number | null // set by a tick that was RUNNING with a fresh snapshot
}

export type JobEvent =
  | { type: 'HoldOpened'; jobId: bigint; gross: bigint }
  | { type: 'Start' }
  | { type: 'TopupRequested'; atMs: number }
  | { type: 'ToppedUp'; gross: bigint }
  | { type: 'TopupDenied'; code: Code } // gate / Qwen / chain Denied / TOPUP_TIMEOUT; transient = codes.TRANSIENT
  | { type: 'Rearm' }
  | { type: 'Settled'; amount: bigint }
  | { type: 'SettleFailed'; amount: bigint } // an issued settle ended Denied / CANCELLED / HALT
  | { type: 'Exhausted' }
  | { type: 'Stop'; reason: StopReason }
  | { type: 'Closed' }

export type Action =
  | { type: 'REQUEST_TOPUP'; epoch: number }
  | { type: 'CHECKPOINT_SETTLE'; amount: bigint }
  | { type: 'TOPUP_TIMEOUT' } // recordDecision(job, TOPUP_TIMEOUT)
  | { type: 'STOPPED'; reason: StopReason }

const MS_PER_SIM_HOUR = 60_000n
const CHECKPOINT_MS = 30_000n // 30 sim minutes of running
const TOPUP_TIMEOUT_MS = 60_000
const STALE_MS = 10_000
const DEADLINE_MARGIN_S = 15n

export function newJob(vendor: Hex, pricePerHour: bigint, feeExempt = false): Job {
  if (pricePerHour <= 0n) throw new Error(`pricePerHour must be > 0, got ${pricePerHour}`)
  return {
    id: null, vendor, pricePerHour, feeExempt, state: 'NO_JOB', latch: 'none', denyCode: null, rearms: 0, epoch: 0,
    stopReason: null, holdSize: 0n, held: 0n, runningMs: 0n, accrued: 0n, settledNet: 0n, pendingNet: 0n, losses: [],
    checkpointMs: 0n, topupAtMs: null, deniedAtMs: null, accrueFromMs: null,
  }
}

const rearmable = (j: Job) => j.latch === 'denied' && j.denyCode !== null && TRANSIENT.has(j.denyCode) && j.rearms < 1

/** Pure transition. Illegal combinations throw. */
export function next(job: Job, e: JobEvent): Job {
  const s = job.state
  const bad = (): never => { throw new Error(`illegal ${e.type} in ${s} (latch ${job.latch})`) }
  if (s === 'CLOSED') return bad()
  if (s === 'NO_JOB') return e.type === 'HoldOpened' ? { ...job, state: 'OPEN', id: e.jobId, held: e.gross, holdSize: e.gross } : bad()
  switch (e.type) {
    case 'HoldOpened': return bad()
    case 'Start': return s === 'OPEN' ? { ...job, state: 'RUNNING' } : bad()
    case 'TopupRequested':
      if (job.latch !== 'none' || (s !== 'RUNNING' && s !== 'HOLD_EXHAUSTED')) return bad()
      return { ...job, state: s === 'RUNNING' ? s : 'AWAITING_TOPUP', latch: 'inflight', topupAtMs: e.atMs, epoch: job.epoch + 1 }
    case 'ToppedUp': {
      // Chain fact: held grows regardless. Only the flow we wait for resumes; STOPPED and denied/timed-out flows never do.
      const j = { ...job, held: job.held + e.gross }
      if (job.latch !== 'inflight') return j
      return { ...j, latch: 'none', holdSize: e.gross, topupAtMs: null, state: s === 'AWAITING_TOPUP' ? 'RUNNING' : s }
    }
    case 'TopupDenied':
      if (job.latch !== 'inflight') return bad()
      return { ...job, latch: 'denied', denyCode: e.code, topupAtMs: null, epoch: job.epoch + 1, state: s === 'AWAITING_TOPUP' ? 'HOLD_EXHAUSTED' : s }
    case 'Rearm':
      if ((s !== 'RUNNING' && s !== 'HOLD_EXHAUSTED') || !rearmable(job)) return bad()
      return { ...job, latch: 'none', rearms: job.rearms + 1, deniedAtMs: null }
    case 'Settled': {
      if (s === 'OPEN') return bad()
      if (e.amount > job.accrued - job.settledNet) throw new Error(`Settled ${e.amount} exceeds unsettled usage ${job.accrued - job.settledNet}`)
      // pendingNet == 0 means a founder/windDown settle; otherwise it must be (part of) what we issued.
      const pendingNet = job.pendingNet === 0n ? 0n : job.pendingNet - e.amount
      const held = job.held - gross(e.amount, job.feeExempt)
      if (pendingNet < 0n || held < 0n) throw new Error(`Settled ${e.amount} does not match pending ${job.pendingNet} / held ${job.held}`)
      return { ...job, settledNet: job.settledNet + e.amount, pendingNet, held }
    }
    case 'SettleFailed':
      if (s === 'OPEN' || e.amount > job.pendingNet) return bad()
      return { ...job, pendingNet: job.pendingNet - e.amount }
    case 'Exhausted':
      return s === 'RUNNING' ? { ...job, state: job.latch === 'inflight' ? 'AWAITING_TOPUP' : 'HOLD_EXHAUSTED' } : bad()
    case 'Stop':
      if (s === 'STOPPED') return job // persists until CLOSED; the first reason wins
      return { ...job, state: 'STOPPED', stopReason: e.reason, epoch: job.epoch + 1 }
    case 'Closed':
      return s === 'STOPPED' || s === 'HOLD_EXHAUSTED' ? { ...job, state: 'CLOSED', held: 0n, epoch: job.epoch + 1 } : bad()
  }
}

export type TickInput = {
  nowMs: number // integer ms (Date.now())
  snapshot: ChainSnapshot | null // null = the read failed (READ_FAILED)
  lossAtSimMinute: (simMinute: number) => number
  deadlineMarginS?: bigint // default 15; 0n turns the margin off for the deadline-Denied demo
}

/** One executor step. Checks pause/deadline/NaN every tick, accrues usage, checkpoints, fires the top-up trigger once. */
export function tick(job: Job, i: TickInput): { job: Job; actions: Action[] } {
  const actions: Action[] = []
  const s0 = job.state
  if (s0 !== 'OPEN' && s0 !== 'RUNNING' && s0 !== 'AWAITING_TOPUP' && s0 !== 'HOLD_EXHAUSTED') return { job, actions }
  const snap = i.snapshot
  const fresh = snap !== null && i.nowMs - snap.readAt <= STALE_MS // else READ_FAILED / STALE_CHAIN: no accrual
  const from = job.accrueFromMs
  const lossNow = (j: Job) => i.lossAtSimMinute(Number(j.runningMs / 1000n))
  let j: Job = { ...job, accrueFromMs: null }

  // Before accrual, so the tick that sees pause/deadline bills nothing.
  const margin = i.deadlineMarginS ?? DEADLINE_MARGIN_S
  const reason = !snap ? null : snap.paused ? 'PAUSED' : snap.blockTs >= snap.deadline - margin ? 'PAST_DEADLINE' : null
  if (reason) return stop(j, reason, lossNow(j), actions)

  if (j.latch === 'inflight' && j.topupAtMs !== null && i.nowMs - j.topupAtMs > TOPUP_TIMEOUT_MS) {
    j = next(j, { type: 'TopupDenied', code: 'TOPUP_TIMEOUT' })
    actions.push({ type: 'TOPUP_TIMEOUT' })
  }

  if (rearmable(j) && j.deniedAtMs === null) j.deniedAtMs = i.nowMs

  let exhausted = false
  if (j.state === 'RUNNING' && fresh && from !== null) {
    // Usage comes from total running ms (no per-tick rounding), capped at the largest ms whose usage
    // keeps unsettled <= maxNet(held), so the honest path never hits OVER_HOLD.
    const cap = j.settledNet + maxNet(j.held, j.feeExempt)
    const maxMs = ((cap + 1n) * MS_PER_SIM_HOUR - 1n) / j.pricePerHour
    const want = j.runningMs + (i.nowMs > from ? BigInt(i.nowMs - from) : 0n)
    exhausted = want >= maxMs
    j.runningMs = exhausted ? maxMs : want
    j.accrued = (j.runningMs * j.pricePerHour) / MS_PER_SIM_HOUR
  }

  const loss = lossNow(j)
  if (Number.isNaN(loss)) return stop(j, 'NAN_DETECTED', loss, actions)

  const periodic = j.runningMs / CHECKPOINT_MS > j.checkpointMs / CHECKPOINT_MS
  // D4: a transient denial re-arms once per job at the next checkpoint. An exhausted job has no running checkpoints
  // left, so its next one is 30 s (30 sim minutes) of wall clock after the denial, never the same tick.
  const waited = j.state === 'HOLD_EXHAUSTED' && j.deniedAtMs !== null && BigInt(i.nowMs - j.deniedAtMs) >= CHECKPOINT_MS
  if (rearmable(j) && (periodic || exhausted || waited)) j = next(j, { type: 'Rearm' })
  // Edge trigger: remaining = held - gross(unsettled) below 40% of the current hold, latch none.
  const fire = (j.state === 'RUNNING' || j.state === 'HOLD_EXHAUSTED') && j.latch === 'none' &&
    (j.held - gross(j.accrued - j.settledNet, j.feeExempt)) * 10n < j.holdSize * 4n
  if (periodic || exhausted || fire) j = checkpoint(j, loss, true, actions)
  if (fire) {
    j = next(j, { type: 'TopupRequested', atMs: i.nowMs })
    actions.push({ type: 'REQUEST_TOPUP', epoch: j.epoch })
  }
  if (exhausted) j = next(j, { type: 'Exhausted' })
  if (j.state === 'RUNNING' && fresh) j.accrueFromMs = i.nowMs
  return { job: j, actions }
}

function stop(j: Job, reason: StopReason, loss: number, actions: Action[]) {
  actions.push({ type: 'STOPPED', reason })
  // After pause/deadline an agent settle is Denied on chain; windDown's founder settle pays the delta instead.
  return { job: checkpoint(next(j, { type: 'Stop', reason }), loss, reason === 'NAN_DETECTED', actions), actions }
}

function checkpoint(j: Job, loss: number, settle: boolean, actions: Action[]): Job {
  const out = { ...j, checkpointMs: j.runningMs, losses: j.runningMs > j.checkpointMs ? [...j.losses, loss] : j.losses }
  if (!settle) return out
  const due = out.accrued - out.settledNet - out.pendingNet
  const room = maxNet(out.held - gross(out.pendingNet, out.feeExempt), out.feeExempt)
  const amount = due < room ? due : room
  if (amount > 0n) {
    out.pendingNet += amount
    actions.push({ type: 'CHECKPOINT_SETTLE', amount })
  }
  return out
}

export type LossScenario = 'normal' | 'plateau' | 'nan'

/** Synthetic training loss. normal: -1% per sim minute (never plateaus); plateau: flat from minute `at`; nan: NaN from minute `at`. */
export function lossAt(scenario: LossScenario, simMinute: number, at = 60): number {
  if (scenario === 'nan' && simMinute >= at) return NaN
  return 2.5 * 0.99 ** (scenario === 'plateau' ? Math.min(simMinute, at) : simMinute)
}

export type Signer = 'agent' | 'founder'
export type Intent =
  | { kind: 'settle'; jobId: bigint; amount: bigint; signer: Signer }
  | { kind: 'close'; jobId: bigint; signer: Signer }
  | { kind: 'refund'; amount: bigint; signer: 'founder' }

/**
 * Session end for [종료], [STOP] and [기한]. Plan on a fresh snapshot after the commit queue drained.
 * Per open vendor job: settle(usage up to the executor stop - decoded Settled sum) if > 0, then close; then INFERENCE
 * settle(usage - paid) + close; then refund(budget - committed after those). Jobs closed on chain are skipped, so a
 * second run after the first one landed plans nothing.
 */
export function planWindDown(i: {
  jobs: Job[] // vendor jobs as the executor holds them
  inference: { jobId: bigint; usageNet: bigint } | null
  snapshot: ChainSnapshot
  deadlineMarginS?: bigint
}): Intent[] {
  const s = i.snapshot
  // Agent settle/close are Denied after pause or deadline (D3); the founder bypasses both.
  const agentOk = !s.paused && s.blockTs < s.deadline - (i.deadlineMarginS ?? DEADLINE_MARGIN_S)
  const out: Intent[] = []
  let committed = s.committed
  const wind = (id: bigint, delta: bigint) => {
    const c = s.jobs[Number(id)]
    if (!c) throw new Error(`windDown: job ${id} not in snapshot`)
    if (c.closed) return
    const exempt = c.vendor.toLowerCase() === s.inferencePayee.toLowerCase()
    if (delta < 0n || gross(delta, exempt) > c.held) throw new Error(`windDown: job ${id} delta ${delta} does not fit held ${c.held}`)
    if (delta > 0n) out.push({ kind: 'settle', jobId: id, amount: delta, signer: agentOk && s.vendorAllowed[c.vendor.toLowerCase()] ? 'agent' : 'founder' })
    out.push({ kind: 'close', jobId: id, signer: agentOk ? 'agent' : 'founder' })
    committed -= c.held - gross(delta, exempt)
  }
  for (const j of i.jobs) {
    if (j.id === null || j.state === 'CLOSED' || s.jobs[Number(j.id)]?.closed) continue
    // A HOLD_EXHAUSTED job that can still re-arm would ask for a top-up again; the orchestrator must Stop it first.
    if (j.state !== 'STOPPED' && !(j.state === 'HOLD_EXHAUSTED' && !rearmable(j))) throw new Error(`windDown: job ${j.id} is ${j.state} (latch ${j.latch}); stop it first`)
    if (j.pendingNet !== 0n) throw new Error(`windDown: job ${j.id} has a settle of ${j.pendingNet} in flight`)
    // Chain paid is the sum of per-settle gross, which never exceeds gross(sum). More means the ledger missed a
    // Settled (e.g. a re-run with stale job objects after a settle landed) and the delta would pay that span twice.
    const c = s.jobs[Number(j.id)]
    if (c && c.paid > gross(j.settledNet, j.feeExempt)) throw new Error(`windDown: job ${j.id} chain paid ${c.paid} > ledger settled ${j.settledNet}; apply the missing Settled first`)
    wind(j.id, j.accrued - j.settledNet)
  }
  // INFERENCE is fee-exempt, so chain paid == net settled.
  if (i.inference) wind(i.inference.jobId, i.inference.usageNet - (s.jobs[Number(i.inference.jobId)]?.paid ?? 0n))
  const refund = s.budget - committed
  if (refund > 0n) out.push({ kind: 'refund', amount: refund, signer: 'founder' })
  return out
}
