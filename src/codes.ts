// Deny codes: the ONE list shared by the gate, the executor, the auditor and the dashboard.
// Chain codes are the same ASCII literals as AgentBudgetVault.sol, encoded as right-padded bytes32.
import { hexToString, stringToHex, type Hex } from 'viem'

/** Enforced by the contract (Denied event, enforced=true). Order = contract check order. */
export const CHAIN_CODES = ['PAUSED', 'PAST_DEADLINE', 'VENDOR_NOT_ALLOWED', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE', 'OVER_HOLD'] as const

/** Decided off-chain, anchored with recordDecision (Denied event, enforced=false). */
export const GATE_CODES = ['GPU_TYPE_NOT_ALLOWED', 'NO_CAPACITY', 'OVER_JOB_CAP', 'NAN_DETECTED', 'LOSS_PLATEAU'] as const
export const QWEN_CODES = ['QWEN_DENIED', 'QWEN_UNAVAILABLE', 'QWEN_UNPARSEABLE'] as const
export const OPS_CODES = ['READ_FAILED', 'TOPUP_TIMEOUT', 'LLM_CALL_CAP'] as const

export const CODES = [...CHAIN_CODES, ...GATE_CODES, ...QWEN_CODES, ...OPS_CODES] as const
export type Code = (typeof CODES)[number]

/** Transient: may re-arm once per job at the next checkpoint (D4). Everything else is final. */
export const TRANSIENT: ReadonlySet<Code> = new Set<Code>(['QWEN_UNAVAILABLE', 'READ_FAILED', 'TOPUP_TIMEOUT'])

export const toBytes32 = (c: Code): Hex => stringToHex(c, { size: 32 })

/** Decodes a Denied topic. Returns the raw string even if it is not a known code (auditor reports it). */
export const fromBytes32 = (h: Hex): string => hexToString(h, { size: 32 })

export const isCode = (s: string): s is Code => (CODES as readonly string[]).includes(s)
