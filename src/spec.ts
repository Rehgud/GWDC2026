// Founder-signed job spec (doc "작업 명세" + R3-16). The signature covers the stored bytes exactly;
// nobody (auditor included) re-serializes: verifySpec/parseSpecForGate take the bytes as stored.
import { parseUnits, recoverMessageAddress, type Hex, type LocalAccount } from 'viem'

export type Spec = {
  spec_id: string
  vault: Hex
  chain_id: number
  issued_at: string
  purpose: string
  success_metric: string
  allowed_gpu_types: string[]
  job_cap_usd: string // decimal string, <= 6 decimals, e.g. "12.5"
  deadline: number // unix seconds
}

const KEYS = ['spec_id', 'vault', 'chain_id', 'issued_at', 'purpose', 'success_metric', 'allowed_gpu_types', 'job_cap_usd', 'deadline'] as const
const DECIMAL = /^\d+(\.\d{1,6})?$/

/** Compact JSON, fixed key order, no trailing newline. These bytes are what gets signed and stored. */
export function makeSpec(s: Spec): Buffer {
  for (const k of KEYS) if (s[k] === undefined || s[k] === null) throw new Error(`spec: missing ${k}`)
  if (typeof s.job_cap_usd !== 'string' || !DECIMAL.test(s.job_cap_usd)) throw new Error('spec: job_cap_usd must be a decimal string')
  if (!Number.isSafeInteger(s.deadline) || !Number.isSafeInteger(s.chain_id)) throw new Error('spec: deadline and chain_id must be integers')
  return Buffer.from(JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, s[k]]))), 'utf8')
}

/** EIP-191 personal_sign over the exact bytes (== `cast wallet sign "$(cat spec.json)"`). */
export const signSpec = (bytes: Uint8Array, founder: LocalAccount): Promise<Hex> => founder.signMessage({ message: { raw: bytes } })

/** Recovered signer; the auditor compares it to vault.founder(). */
export const verifySpec = (bytes: Uint8Array, sig: Hex): Promise<Hex> => recoverMessageAddress({ message: { raw: bytes }, signature: sig })

/** The gate's view of the spec (rules.GateInput.spec). */
export function parseSpecForGate(bytes: Uint8Array): { allowed_gpu_types: string[]; job_cap: bigint; deadline: bigint } {
  const s = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!Array.isArray(s.allowed_gpu_types) || !s.allowed_gpu_types.every((g: unknown) => typeof g === 'string')) throw new Error('spec: allowed_gpu_types')
  if (typeof s.job_cap_usd !== 'string' || !DECIMAL.test(s.job_cap_usd)) throw new Error('spec: job_cap_usd')
  if (!Number.isSafeInteger(s.deadline)) throw new Error('spec: deadline')
  return { allowed_gpu_types: s.allowed_gpu_types, job_cap: parseUnits(s.job_cap_usd, 6), deadline: BigInt(s.deadline) }
}
