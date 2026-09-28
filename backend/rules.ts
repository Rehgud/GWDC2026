// rules.ts — deterministic gate rules + amount math ([IFACE]).
//
// ONE implementation shared by the gate (backend), the executor (stop/settle sizing) and the
// auditor (re-judging recorded decisions). The auditor imports this file unchanged (R3-19),
// so every function here is pure: no I/O, no clock, no floats in money math.
//
// Amount basis (R3-12):
//   open/topUp/settle `amount` is NET micro-USDC (6 decimals).
//   gross(v, a) = v == inferencePayee ? a : a + floor(a * feeBps / 10000)
//   OVER_MAX_HOLD:        net > maxHold          (compared before gross, like the contract)
//   OVER_BUDGET_WITH_FEE: committed + gross > budget
//   maxNet(h) = max n with gross(n) <= h        (so gross(maxNet(h)) <= h < gross(maxNet(h)+1))
//
// Time basis (R3-13): "now" is the snapshot's block timestamp, never the wall clock.
//   requested sim hours = net / net hourly price
//   real seconds        = sim hours * 3600 / CLOCK_MULT   (= sim hours * 60 at CLOCK_MULT=60)
//   Example: vendor B $2.56/h, request $5.12 -> 2 sim h -> 120 real s at CLOCK_MULT=60, so
//   PAST_DEADLINE iff blockTs + 120 > min(spec.deadline, vault.deadline).
import type { Hex } from 'viem';
import { CHAIN_RULE_ORDER, GATE_ORDER, type GateCode } from './codes.ts';

export const BPS = 10_000n;
export const USDC_DECIMALS = 6;
export const MICRO = 1_000_000n;
/** A real hour in milliseconds (used by executor accrual) */
export const HOUR_MS = 3_600_000n;

// ------------------------------------------------------------------------------ wire types
/** Canonical non-negative decimal integer string ("0", "5120000"). bigint on the wire. */
export type Dec = string;
/** Loss values as they appear in records: finite numbers, or the replacer's strings. */
export type LossWire = number | 'NaN' | 'Infinity' | '-Infinity';

export type JobView = {
  id: Dec;
  vendor: Hex;
  held: Dec; // gross reserved (open + topUps)
  paid: Dec; // gross paid (net + fee)
  closed: boolean;
};

/** Chain values the gate reads, all from ONE snapshot pinned at `blockNumber`. */
export type ChainView = {
  blockNumber: Dec;
  blockTimestamp: Dec;
  paused: boolean;
  deadline: Dec;
  budget: Dec;
  committed: Dec;
  maxHold: Dec;
  feeBps: Dec;
  inferencePayee: Hex;
  /** vendorAllowed[request.vendor] at blockNumber; false when the vendor did not resolve */
  vendorAllowed: boolean;
  /** topUp target job at blockNumber; null for open */
  job: JobView | null;
};

/**
 * The frozen request R. tx arguments are built from R only (S3-3):
 *   open(R.vendor, R.amount, rec) / topUp(R.jobId, R.amount, rec)
 */
export type GateRequest = {
  kind: 'open' | 'topUp';
  /** resolved vendor address; null when F1's label resolves to nothing */
  vendor: Hex | null;
  /** F1's raw vendor label, kept for the record */
  vendorLabel: string;
  /** F1's raw GPU string */
  gpu: string;
  /** NET micro-USDC */
  amount: Dec;
  /** topUp target, null for open */
  jobId: Dec | null;
};

/** Akash market entry for (vendor, gpu), fixed for the session. null = no entry. */
export type MarketView = {
  vendor: Hex;
  gpu: string;
  /** NET micro-USD per GPU-hour */
  price: Dec;
  capacity: number;
};

export type GateInput = {
  v: 1;
  request: GateRequest;
  chain: ChainView;
  spec: {
    spec_id: string;
    allowed_gpu_types: string[];
    /** job_cap_usd in micro-USDC, gross */
    job_cap: Dec;
    /** unix seconds */
    deadline: Dec;
  };
  /**
   * OVER_JOB_CAP accumulates per signed spec (logical task), NOT per on-chain job id (R3-11):
   * spec_gross = specGross(all vendor jobs opened under this spec_id) at chain.blockNumber.
   */
  ledger: { spec_gross: Dec };
  market: MarketView | null;
  /** checkpoint losses of this logical task, oldest first */
  progress: { losses: LossWire[] };
  /** simulated seconds per real second (60 in the demo) */
  clockMult: number;
  /**
   * D2: vendors (addresses) whose open was denied earlier in this open sequence. The one
   * re-proposal must name a different vendor, so an open to one of them is VENDOR_NOT_ALLOWED.
   * Absent (older records) = none.
   */
  excluded?: string[];
};

/** Input for the INFERENCE open (D2): chain rules only, no spec/market/progress. */
export type ChainRuleInput = {
  v: 1;
  request: GateRequest;
  chain: ChainView;
};

export class GateInputError extends Error {
  override name = 'GateInputError';
}

// ------------------------------------------------------------------------------ parsing
const DEC_RE = /^(0|[1-9]\d*)$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const USD_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

export function dec(s: unknown, field = 'value'): bigint {
  if (typeof s !== 'string' || !DEC_RE.test(s)) {
    throw new GateInputError(`${field}: expected canonical decimal string, got ${JSON.stringify(s)}`);
  }
  return BigInt(s);
}

export function toDec(n: bigint): Dec {
  if (n < 0n) throw new RangeError(`negative amount ${n}`);
  return n.toString();
}

export function isAddress(s: unknown): s is Hex {
  return typeof s === 'string' && ADDR_RE.test(s);
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

/** "5.12" -> 5_120_000n. Strict: no sign, no "$", no exponent, at most 6 decimals. */
export function parseUsd(s: string): bigint {
  if (typeof s !== 'string' || !USD_RE.test(s)) throw new RangeError(`bad USD amount ${JSON.stringify(s)}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * MICRO + BigInt((frac + '000000').slice(0, 6));
}

/** 5_120_000n -> "5.12" (at least 2 decimals, trailing zeros trimmed beyond that) */
export function formatUsd(micro: bigint): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const whole = a / MICRO;
  let frac = (a % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function normGpu(s: string): string {
  return String(s).trim().toUpperCase();
}

// ------------------------------------------------------------------------------ amount math
function assertNonNeg(x: bigint, what: string): void {
  if (x < 0n) throw new RangeError(`${what} must be >= 0, got ${x}`);
}

/** fee = floor(net * feeBps / 10000); 0 for the fee-exempt INFERENCE payee */
export function feeOf(net: bigint, feeBps: bigint, feeExempt: boolean): bigint {
  assertNonNeg(net, 'net');
  assertNonNeg(feeBps, 'feeBps');
  return feeExempt ? 0n : (net * feeBps) / BPS;
}

export function gross(net: bigint, feeBps: bigint, feeExempt: boolean): bigint {
  return net + feeOf(net, feeBps, feeExempt);
}

/** Largest net n with gross(n) <= hold. Start at floor(h*10000/(10000+fee)), then correct by +-1. */
export function maxNet(hold: bigint, feeBps: bigint, feeExempt: boolean): bigint {
  assertNonNeg(hold, 'hold');
  if (feeExempt || feeBps === 0n) return hold;
  let n = (hold * BPS) / (BPS + feeBps);
  while (gross(n + 1n, feeBps, feeExempt) <= hold) n += 1n;
  while (n > 0n && gross(n, feeBps, feeExempt) > hold) n -= 1n;
  return n;
}

export function isFeeExempt(vendor: string | null, inferencePayee: string): boolean {
  return sameAddress(vendor, inferencePayee);
}

/** gross for a vendor as the vault computes it (INFERENCE exempt) */
export function grossFor(vendor: string | null, net: bigint, feeBps: bigint, inferencePayee: string): bigint {
  return gross(net, feeBps, isFeeExempt(vendor, inferencePayee));
}

/**
 * OVER_JOB_CAP accumulator for one logical task: closed jobs count what was actually paid
 * (their unspent hold was released), open jobs count their full reserved hold.
 */
export function specGross(jobs: readonly { held: bigint; paid: bigint; closed: boolean }[]): bigint {
  let s = 0n;
  for (const j of jobs) s += j.closed ? j.paid : j.held;
  return s;
}

// ------------------------------------------------------------------------------ time
/**
 * Real seconds a NET amount buys at a NET hourly price, rounded UP (conservative).
 * sim_hours = net / price ; real_s = sim_hours * 3600 / clockMult.
 */
export function realSeconds(net: bigint, pricePerHour: bigint, clockMult: number): bigint {
  assertNonNeg(net, 'net');
  if (pricePerHour <= 0n) throw new RangeError('price must be > 0');
  if (!Number.isSafeInteger(clockMult) || clockMult <= 0) throw new RangeError(`bad clockMult ${clockMult}`);
  const num = net * 3600n;
  const den = pricePerHour * BigInt(clockMult);
  return (num + den - 1n) / den;
}

export function effectiveDeadline(specDeadline: bigint, vaultDeadline: bigint): bigint {
  return specDeadline < vaultDeadline ? specDeadline : vaultDeadline;
}

/**
 * Gate PAST_DEADLINE: the request cannot start at/after the effective deadline, and the time it
 * buys must end by it: now >= eff || now + real_s > eff. (The contract checks now >= vault
 * deadline; the gate is strictly stronger and uses the same code literal.)
 */
export function pastDeadline(now: bigint, realS: bigint, eff: bigint): boolean {
  return now >= eff || now + realS > eff;
}

// ------------------------------------------------------------------------------ progress signals
export function lossToNumber(l: LossWire): number {
  if (typeof l === 'number') return l;
  if (l === 'NaN') return Number.NaN;
  if (l === 'Infinity') return Number.POSITIVE_INFINITY;
  if (l === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw new GateInputError(`bad loss value ${JSON.stringify(l)}`);
}

/** NAN_DETECTED: any recorded loss is NaN (non-finite losses count as NaN: training diverged). */
export function hasNaN(losses: readonly LossWire[]): boolean {
  return losses.some((l) => !Number.isFinite(lossToNumber(l)));
}

/**
 * LOSS_PLATEAU: the last 3 consecutive pairs of the last 4 checkpoints ALL improved by less than
 * 0.5%: (prev - cur) / prev < 0.005. False with fewer than 4 checkpoints, when any prev <= 0,
 * or when a value is non-finite (NAN_DETECTED catches that first).
 */
export function isLossPlateau(losses: readonly LossWire[]): boolean {
  if (losses.length < 4) return false;
  const w = losses.slice(-4).map(lossToNumber);
  if (w.some((x) => !Number.isFinite(x))) return false;
  for (let i = 1; i < 4; i++) {
    const prev = w[i - 1]!;
    const cur = w[i]!;
    if (prev <= 0) return false;
    if (!((prev - cur) / prev < 0.005)) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------ decoding
type DecodedChain = {
  ts: bigint;
  paused: boolean;
  deadline: bigint;
  budget: bigint;
  committed: bigint;
  maxHold: bigint;
  feeBps: bigint;
  inferencePayee: Hex;
  vendorAllowed: boolean;
  job: { vendor: Hex; held: bigint; paid: bigint; closed: boolean } | null;
};

type DecodedRequest = {
  kind: 'open' | 'topUp';
  vendor: Hex | null;
  gpu: string;
  amount: bigint;
  jobId: bigint | null;
};

function decodeRequest(r: GateRequest): DecodedRequest {
  if (!r || (r.kind !== 'open' && r.kind !== 'topUp')) throw new GateInputError('request.kind');
  if (r.vendor !== null && !isAddress(r.vendor)) throw new GateInputError('request.vendor');
  if (typeof r.vendorLabel !== 'string') throw new GateInputError('request.vendorLabel');
  if (typeof r.gpu !== 'string') throw new GateInputError('request.gpu');
  const amount = dec(r.amount, 'request.amount');
  let jobId: bigint | null = null;
  if (r.kind === 'topUp') jobId = dec(r.jobId, 'request.jobId');
  else if (r.jobId !== null) throw new GateInputError('request.jobId must be null for open');
  return { kind: r.kind, vendor: r.vendor, gpu: r.gpu, amount, jobId };
}

function decodeChain(c: ChainView, req: DecodedRequest): DecodedChain {
  if (!c) throw new GateInputError('chain');
  dec(c.blockNumber, 'chain.blockNumber');
  if (typeof c.paused !== 'boolean') throw new GateInputError('chain.paused');
  if (typeof c.vendorAllowed !== 'boolean') throw new GateInputError('chain.vendorAllowed');
  if (!isAddress(c.inferencePayee)) throw new GateInputError('chain.inferencePayee');
  let job: DecodedChain['job'] = null;
  if (req.kind === 'topUp') {
    const j = c.job;
    if (!j) throw new GateInputError('chain.job is required for topUp');
    if (dec(j.id, 'chain.job.id') !== req.jobId) throw new GateInputError('chain.job.id != request.jobId');
    if (!isAddress(j.vendor)) throw new GateInputError('chain.job.vendor');
    if (typeof j.closed !== 'boolean') throw new GateInputError('chain.job.closed');
    job = { vendor: j.vendor, held: dec(j.held, 'chain.job.held'), paid: dec(j.paid, 'chain.job.paid'), closed: j.closed };
  } else if (c.job !== null) {
    throw new GateInputError('chain.job must be null for open');
  }
  return {
    ts: dec(c.blockTimestamp, 'chain.blockTimestamp'),
    paused: c.paused,
    deadline: dec(c.deadline, 'chain.deadline'),
    budget: dec(c.budget, 'chain.budget'),
    committed: dec(c.committed, 'chain.committed'),
    maxHold: dec(c.maxHold, 'chain.maxHold'),
    feeBps: dec(c.feeBps, 'chain.feeBps'),
    inferencePayee: c.inferencePayee,
    vendorAllowed: c.vendorAllowed,
    job,
  };
}

/**
 * VENDOR_NOT_ALLOWED as both layers see it. The vendor must resolve and be allow-listed; for a
 * topUp it must also be the job's own vendor (a topUp pays job.vendor, so a request naming a
 * different vendor is out of scope for that job).
 */
function vendorOk(req: DecodedRequest, ch: DecodedChain): boolean {
  if (req.vendor === null || !ch.vendorAllowed) return false;
  if (req.kind === 'topUp') return ch.job !== null && sameAddress(ch.job.vendor, req.vendor);
  return true;
}

// ------------------------------------------------------------------------------ rules
/**
 * Chain rules only, mirroring the contract's open/topUp checks (PAST_DEADLINE here is the
 * contract's `blockTs >= vault.deadline`). Used for the INFERENCE open (D2). Returns every
 * violated code in CHAIN_RULE_ORDER; the decision is codes[0].
 * One deliberate gate-only extension: for a topUp, a request naming a vendor other than the
 * job's vendor is VENDOR_NOT_ALLOWED here, while the contract's topUp(jobId, net, rec) carries
 * no vendor and only checks vendorAllowed[job.vendor]. (So the D5 "send the same request with
 * cast" replay must be open(<vendor>, net, rec), which the contract Denies.)
 */
export function chainRules(input: ChainRuleInput): GateCode[] {
  if (!input || input.v !== 1) throw new GateInputError('ChainRuleInput.v must be 1');
  const req = decodeRequest(input.request);
  const ch = decodeChain(input.chain, req);
  const hit = new Set<GateCode>();
  if (ch.paused) hit.add('PAUSED');
  if (ch.ts >= ch.deadline) hit.add('PAST_DEADLINE');
  if (!vendorOk(req, ch)) hit.add('VENDOR_NOT_ALLOWED');
  if (req.amount > ch.maxHold) hit.add('OVER_MAX_HOLD');
  if (ch.committed + grossFor(req.vendor, req.amount, ch.feeBps, ch.inferencePayee) > ch.budget) {
    hit.add('OVER_BUDGET_WITH_FEE');
  }
  return CHAIN_RULE_ORDER.filter((c) => hit.has(c));
}

/**
 * The 10-rule deterministic gate. Returns every violated code in GATE_ORDER; an empty array is
 * PASS; the decision code is codes[0]. Throws GateInputError on a malformed input (the auditor
 * reports that as a FAIL of the record, never as a PASS). Besides the topUp vendor match above,
 * VENDOR_NOT_ALLOWED also covers the D2 re-proposal: an open naming a vendor in `excluded`.
 */
export function check(input: GateInput): GateCode[] {
  if (!input || input.v !== 1) throw new GateInputError('GateInput.v must be 1');
  const req = decodeRequest(input.request);
  const ch = decodeChain(input.chain, req);
  const spec = input.spec;
  if (!spec || !Array.isArray(spec.allowed_gpu_types)) throw new GateInputError('spec.allowed_gpu_types');
  const jobCap = dec(spec.job_cap, 'spec.job_cap');
  const specDeadline = dec(spec.deadline, 'spec.deadline');
  const specGrossNow = dec(input.ledger?.spec_gross, 'ledger.spec_gross');
  if (!Number.isSafeInteger(input.clockMult) || input.clockMult <= 0) throw new GateInputError('clockMult');
  const losses = input.progress?.losses;
  if (!Array.isArray(losses)) throw new GateInputError('progress.losses');
  const excluded = input.excluded ?? [];
  if (!Array.isArray(excluded) || !excluded.every((a) => typeof a === 'string' && isAddress(a))) throw new GateInputError('excluded');
  const reproposedDenied = req.kind === 'open' && req.vendor !== null && excluded.some((a) => sameAddress(a, req.vendor!));

  // market entry must be the one for exactly (request.vendor, request.gpu)
  let price: bigint | null = null;
  let capacity = 0;
  const m = input.market;
  if (m !== null) {
    if (!m || !isAddress(m.vendor) || typeof m.gpu !== 'string' || !Number.isFinite(m.capacity)) {
      throw new GateInputError('market');
    }
    const p = dec(m.price, 'market.price');
    if (sameAddress(m.vendor, req.vendor) && normGpu(m.gpu) === normGpu(req.gpu) && p > 0n) {
      price = p;
      capacity = m.capacity;
    }
  }

  const g = grossFor(req.vendor, req.amount, ch.feeBps, ch.inferencePayee);
  const eff = effectiveDeadline(specDeadline, ch.deadline);
  const realS = price !== null ? realSeconds(req.amount, price, input.clockMult) : 0n;
  const allowed = new Set(spec.allowed_gpu_types.map(normGpu));

  const hit = new Set<GateCode>();
  if (ch.paused) hit.add('PAUSED');
  if (pastDeadline(ch.ts, realS, eff)) hit.add('PAST_DEADLINE');
  if (!vendorOk(req, ch) || reproposedDenied) hit.add('VENDOR_NOT_ALLOWED');
  if (req.amount > ch.maxHold) hit.add('OVER_MAX_HOLD');
  if (ch.committed + g > ch.budget) hit.add('OVER_BUDGET_WITH_FEE');
  if (!allowed.has(normGpu(req.gpu))) hit.add('GPU_TYPE_NOT_ALLOWED');
  if (specGrossNow + g > jobCap) hit.add('OVER_JOB_CAP');
  if (price === null || capacity <= 0) hit.add('NO_CAPACITY');
  if (hasNaN(losses)) hit.add('NAN_DETECTED');
  if (isLossPlateau(losses)) hit.add('LOSS_PLATEAU');
  return GATE_ORDER.filter((c) => hit.has(c));
}

/** First violated code, or null for PASS. */
export function decide(codes: readonly GateCode[]): GateCode | null {
  return codes.length > 0 ? codes[0]! : null;
}
