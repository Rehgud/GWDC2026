// Deterministic gate rules. Pure: no I/O, no clock. The auditor re-runs check() on the recorded input.
// Amounts are net micro-USDC (6 decimals) as bigint. Contract parity: gross/maxNet match AgentBudgetVault.
import type { Hex } from 'viem'
import type { Code } from './codes.ts'

export const FEE_BPS = 300n
/** Simulation clock: 1 real second = 1 simulated minute. */
export const CLOCK_MULT = 60n

/** gross(v, a) = v == INFERENCE ? a : a + floor(a * 300 / 10000). Same as AgentBudgetVault.gross. */
export function gross(net: bigint, feeExempt: boolean): bigint {
  return feeExempt ? net : net + (net * FEE_BPS) / 10_000n
}

/** Largest net n with gross(n) <= hold. */
export function maxNet(hold: bigint, feeExempt: boolean): bigint {
  if (hold <= 0n) return 0n
  if (feeExempt) return hold
  let n = (hold * 10_000n) / (10_000n + FEE_BPS)
  while (gross(n + 1n, false) <= hold) n++
  while (n > 0n && gross(n, false) > hold) n--
  return n
}

/** Real seconds a net amount buys at a per-GPU-hour price: sim hours = amount / price, real s = sim h * 60. */
export function requestSeconds(amount: bigint, pricePerHour: bigint): bigint {
  if (pricePerHour <= 0n) return 0n
  return (amount * CLOCK_MULT + pricePerHour - 1n) / pricePerHour // ceil
}

/** Plateau only if all of the last 3 consecutive pairs improved < 0.5%. Needs >= 4 checkpoints and prev > 0. */
export function lossPlateau(losses: number[]): boolean {
  if (losses.length < 4) return false
  const last = losses.slice(-4)
  for (let i = 1; i < 4; i++) {
    const prev = last[i - 1], cur = last[i]
    if (!(prev > 0) || !Number.isFinite(cur)) return false
    if ((prev - cur) / prev >= 0.005) return false
  }
  return true
}

/** Chain values read at one pinned block (the watcher snapshot) for this request. */
export type ChainRead = {
  block: bigint
  blockTs: bigint
  paused: boolean
  deadline: bigint
  budget: bigint
  committed: bigint
  maxHold: bigint
  inferencePayee: Hex
  vendorAllowed: boolean // vendorAllowed[request.vendor]
}

export type GateInput = {
  kind: 'open' | 'topUp' | 'inference' // inference: chain rules only, no gate/F2 (D2)
  chain: ChainRead
  /** From the founder-signed spec. job_cap and deadline already converted. */
  spec: { allowed_gpu_types: string[]; job_cap: bigint; deadline: bigint }
  /** Frozen request R. tx arguments are built only from this. */
  request: { vendor: Hex; gpu: string; amount: bigint }
  /** Akash cache for (vendor, gpu), fixed for the session. */
  market: { pricePerHour: bigint; available: number }
  /** Gross already reserved (open + topUp) under this spec_id, across jobs (R3-11). */
  specGross: bigint
  /** Executor checkpoint losses, oldest first. Used for topUp only. */
  losses: number[]
}

/**
 * All violated rules, in the fixed order. codes[0] is the one recorded and anchored.
 * Chain codes keep the contract's relative order: PAUSED, PAST_DEADLINE, VENDOR_NOT_ALLOWED, OVER_MAX_HOLD, OVER_BUDGET_WITH_FEE.
 */
export function check(i: GateInput): Code[] {
  const c = i.chain
  const exempt = i.request.vendor.toLowerCase() === c.inferencePayee.toLowerCase()
  const g = gross(i.request.amount, exempt)
  const out: Code[] = []
  const gateRules = i.kind !== 'inference'

  if (c.paused) out.push('PAUSED')
  const effDeadline = i.spec.deadline < c.deadline ? i.spec.deadline : c.deadline
  const needS = gateRules ? requestSeconds(i.request.amount, i.market.pricePerHour) : 0n
  if (c.blockTs >= c.deadline || c.blockTs + needS > effDeadline) out.push('PAST_DEADLINE')
  if (!c.vendorAllowed) out.push('VENDOR_NOT_ALLOWED')
  if (gateRules && !i.spec.allowed_gpu_types.includes(i.request.gpu)) out.push('GPU_TYPE_NOT_ALLOWED')
  if (gateRules && i.market.available <= 0) out.push('NO_CAPACITY')
  if (i.request.amount > c.maxHold) out.push('OVER_MAX_HOLD')
  if (g > c.budget - c.committed) out.push('OVER_BUDGET_WITH_FEE')
  if (gateRules && i.specGross + g > i.spec.job_cap) out.push('OVER_JOB_CAP')
  if (i.kind === 'topUp' && i.losses.some((l) => Number.isNaN(l))) out.push('NAN_DETECTED')
  if (i.kind === 'topUp' && lossPlateau(i.losses)) out.push('LOSS_PLATEAU')
  return out
}

// ---- JSON round-trip for records (bigints are stored as decimal strings, NaN as "NaN") ----

const B = (x: unknown): bigint => BigInt(x as string)

export function gateInputFromJson(o: any): GateInput {
  return {
    kind: o.kind,
    chain: {
      block: B(o.chain.block), blockTs: B(o.chain.blockTs), paused: o.chain.paused, deadline: B(o.chain.deadline),
      budget: B(o.chain.budget), committed: B(o.chain.committed), maxHold: B(o.chain.maxHold),
      inferencePayee: o.chain.inferencePayee, vendorAllowed: o.chain.vendorAllowed,
    },
    spec: { allowed_gpu_types: o.spec.allowed_gpu_types, job_cap: B(o.spec.job_cap), deadline: B(o.spec.deadline) },
    request: { vendor: o.request.vendor, gpu: o.request.gpu, amount: B(o.request.amount) },
    market: { pricePerHour: B(o.market.pricePerHour), available: Number(o.market.available) },
    specGross: B(o.specGross),
    losses: o.losses.map(Number),
  }
}
