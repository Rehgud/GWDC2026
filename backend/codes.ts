// codes.ts — the ONE list of decision codes ([IFACE]).
//
// Codes are bytes32 ASCII strings, not an enum: Solidity writes bytes32("PAUSED"),
// TS writes stringToHex("PAUSED", { size: 32 }). Both are left-aligned ASCII,
// zero-padded on the right. fixtures/deny-codes.json is generated from this file
// (npm run gen:fixtures) and read by forge (C12) and by test/ts/codes.test.ts, so a
// literal that drifts on either side fails a test.
import { hexToString, stringToHex, type Hex } from 'viem';

/** Every decision code, grouped by who decides it. */
export const DENY_CODES = [
  // --- enforced by the contract AND mirrored by the gate (same literal, same order)
  'PAUSED',
  'PAST_DEADLINE',
  'VENDOR_NOT_ALLOWED',
  'OVER_MAX_HOLD',
  'OVER_BUDGET_WITH_FEE',
  // settle only: paid + gross(net) > held. Contract-only; the executor prevents it with maxNet.
  'OVER_HOLD',
  // --- gate only (signed spec / market data / executor log)
  'GPU_TYPE_NOT_ALLOWED',
  'OVER_JOB_CAP',
  'NO_CAPACITY',
  'NAN_DETECTED',
  'LOSS_PLATEAU',
  // --- CFO review (Qwen F2, and F1 parse/availability). Fail-closed.
  'QWEN_DENIED',
  'QWEN_UNAVAILABLE',
  'QWEN_UNPARSEABLE',
  // --- operational (the only three codes the CEO review added)
  'READ_FAILED',
  'TOPUP_TIMEOUT',
  'LLM_CALL_CAP',
] as const;

export type DenyCode = (typeof DENY_CODES)[number];

/** Codes the vault itself emits with enforced=true. */
export const CHAIN_CODES = [
  'PAUSED',
  'PAST_DEADLINE',
  'VENDOR_NOT_ALLOWED',
  'OVER_MAX_HOLD',
  'OVER_BUDGET_WITH_FEE',
  'OVER_HOLD',
] as const satisfies readonly DenyCode[];

/**
 * Order in which rules.check() evaluates the 10 gate rules. The first five are the
 * contract's check order for open/topUp; the rest are off-chain rules evaluated after
 * them. check() returns every violated code in this order; the decision is codes[0].
 */
export const GATE_ORDER = [
  'PAUSED',
  'PAST_DEADLINE',
  'VENDOR_NOT_ALLOWED',
  'OVER_MAX_HOLD',
  'OVER_BUDGET_WITH_FEE',
  'GPU_TYPE_NOT_ALLOWED',
  'OVER_JOB_CAP',
  'NO_CAPACITY',
  'NAN_DETECTED',
  'LOSS_PLATEAU',
] as const satisfies readonly DenyCode[];

export type GateCode = (typeof GATE_ORDER)[number];

/** Chain-rule subset used for the INFERENCE open (D2: no gate, no F2, chain rules + record). */
export const CHAIN_RULE_ORDER = [
  'PAUSED',
  'PAST_DEADLINE',
  'VENDOR_NOT_ALLOWED',
  'OVER_MAX_HOLD',
  'OVER_BUDGET_WITH_FEE',
] as const satisfies readonly GateCode[];

/**
 * D4: after a denial the top-up latch may re-arm ONCE (next checkpoint, per job) only for
 * these transient codes. Everything else (rule codes, QWEN_DENIED, QWEN_UNPARSEABLE,
 * LLM_CALL_CAP) is final.
 */
export const TRANSIENT_CODES = ['QWEN_UNAVAILABLE', 'READ_FAILED', 'TOPUP_TIMEOUT'] as const satisfies readonly DenyCode[];

/** jobId used for denials that happen before any job exists. type(uint256).max */
export const NO_JOB = (1n << 256n) - 1n;

const CODE_SET: ReadonlySet<string> = new Set(DENY_CODES);

export function isDenyCode(s: string): s is DenyCode {
  return CODE_SET.has(s);
}

export function isTransient(c: DenyCode): boolean {
  return (TRANSIENT_CODES as readonly string[]).includes(c);
}

export function isChainCode(c: DenyCode): boolean {
  return (CHAIN_CODES as readonly string[]).includes(c);
}

/** bytes32 exactly as Solidity's bytes32("CODE") literal. */
export function codeToBytes32(c: DenyCode): Hex {
  if (!isDenyCode(c)) throw new Error(`unknown deny code: ${String(c)}`);
  return stringToHex(c, { size: 32 });
}

/**
 * Decode a bytes32 code from an event topic. Returns the code if it is one of ours,
 * otherwise null (an attacker may emit arbitrary bytes via recordDecision; the caller
 * decides how to report it). Requires strict left-aligned ASCII + zero padding.
 */
export function bytes32ToCode(h: Hex): DenyCode | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return null;
  const s = hexToString(h, { size: 32 });
  const end = s.indexOf('\u0000');
  const text = end === -1 ? s : s.slice(0, end);
  // everything after the first NUL must also be NUL
  if (end !== -1 && /[^\u0000]/.test(s.slice(end))) return null;
  if (!isDenyCode(text)) return null;
  // round-trip guard: reject non-canonical encodings
  return codeToBytes32(text).toLowerCase() === h.toLowerCase() ? text : null;
}

/** Human label for an unknown bytes32 (printable ASCII prefix, or the raw hex). */
export function describeBytes32(h: Hex): string {
  const c = bytes32ToCode(h);
  if (c) return c;
  try {
    const s = hexToString(h, { size: 32 }).replace(/\u0000+$/, '');
    if (/^[\x20-\x7e]+$/.test(s)) return `UNKNOWN(${s})`;
  } catch {
    /* fallthrough */
  }
  return `UNKNOWN(${h})`;
}
