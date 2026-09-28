// spec.ts — the founder-signed work spec ([IFACE]).
//
// The spec is the source of "purpose". The founder signs the EXACT file bytes with EIP-191
// (personal_sign over the raw bytes); the auditor verifies those bytes as stored and never
// re-serializes them. The payload binds the vault, chain and a unique spec_id so one signed
// spec cannot be replayed onto another vault, chain or session (R3-16).
//
// File format: compact JSON, fields in SPEC_FIELDS order, no trailing newline (specBytes()).
import { recoverMessageAddress, type Hex } from 'viem';
import { parseBytes, serialize } from './record.ts';
import { isAddress, parseUsd, sameAddress } from './rules.ts';

export type WorkSpec = {
  schema_version: 1;
  spec_id: string;
  vault: Hex;
  chain_id: number;
  issued_at: string;
  purpose: string;
  success_metric: string;
  allowed_gpu_types: string[];
  /** gross USD cap for the whole logical task, decimal string with <= 6 decimals */
  job_cap_usd: string;
  /** unix seconds */
  deadline: number;
};

export const SPEC_FIELDS = [
  'schema_version',
  'spec_id',
  'vault',
  'chain_id',
  'issued_at',
  'purpose',
  'success_metric',
  'allowed_gpu_types',
  'job_cap_usd',
  'deadline',
] as const satisfies readonly (keyof WorkSpec)[];

export class SpecError extends Error {
  override name = 'SpecError';
}

const SPEC_ID_RE = /^[A-Za-z0-9._:-]{4,64}$/;

/** Validate a parsed spec object. Exact key set, strict types. */
export function assertSpec(x: unknown): WorkSpec {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new SpecError('spec: not an object');
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  const want = [...SPEC_FIELDS];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw new SpecError(`spec: keys must be exactly [${want.join(',')}] in order, got [${keys.join(',')}]`);
  }
  if (o.schema_version !== 1) throw new SpecError('spec.schema_version');
  if (typeof o.spec_id !== 'string' || !SPEC_ID_RE.test(o.spec_id)) throw new SpecError('spec.spec_id');
  if (!isAddress(o.vault)) throw new SpecError('spec.vault');
  if (!Number.isSafeInteger(o.chain_id) || (o.chain_id as number) <= 0) throw new SpecError('spec.chain_id');
  if (typeof o.issued_at !== 'string' || Number.isNaN(Date.parse(o.issued_at))) throw new SpecError('spec.issued_at');
  if (typeof o.purpose !== 'string' || !o.purpose.trim()) throw new SpecError('spec.purpose');
  if (typeof o.success_metric !== 'string' || !o.success_metric.trim()) throw new SpecError('spec.success_metric');
  if (
    !Array.isArray(o.allowed_gpu_types) ||
    o.allowed_gpu_types.length === 0 ||
    o.allowed_gpu_types.some((g) => typeof g !== 'string' || !g.trim())
  ) {
    throw new SpecError('spec.allowed_gpu_types');
  }
  if (typeof o.job_cap_usd !== 'string') throw new SpecError('spec.job_cap_usd');
  try {
    if (parseUsd(o.job_cap_usd) <= 0n) throw new Error();
  } catch {
    throw new SpecError('spec.job_cap_usd');
  }
  if (!Number.isSafeInteger(o.deadline) || (o.deadline as number) <= 0) throw new SpecError('spec.deadline');
  return o as unknown as WorkSpec;
}

/** Canonical bytes to write to spec.json and to sign. */
export function specBytes(spec: WorkSpec): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of SPEC_FIELDS) ordered[k] = spec[k];
  assertSpec(ordered);
  return serialize(ordered);
}

/** Parse stored spec bytes (as signed). Throws SpecError. */
export function parseSpec(bytes: Uint8Array): WorkSpec {
  let x: unknown;
  try {
    x = parseBytes(bytes);
  } catch {
    throw new SpecError('spec: not valid UTF-8 JSON');
  }
  return assertSpec(x);
}

/** job cap in micro-USDC (gross) */
export function specJobCap(spec: WorkSpec): bigint {
  return parseUsd(spec.job_cap_usd);
}

export type SpecIssue =
  | 'SPEC_UNPARSEABLE'
  | 'SPEC_BAD_SIGNATURE' // signature malformed or signer != founder
  | 'SPEC_WRONG_VAULT'
  | 'SPEC_WRONG_CHAIN';

export type SpecCheck = { spec: WorkSpec | null; signer: Hex | null; issues: { issue: SpecIssue; detail: string }[] };

/**
 * check 2 + binding: signer == vault.founder, spec.vault == expected vault,
 * spec.chain_id == expected chain. spec_id uniqueness is a bundle-level check (auditor).
 */
export async function verifySpec(args: {
  bytes: Uint8Array;
  sig: Hex;
  founder: Hex;
  vault: Hex;
  chainId: number;
}): Promise<SpecCheck> {
  const issues: SpecCheck['issues'] = [];
  let spec: WorkSpec | null = null;
  try {
    spec = parseSpec(args.bytes);
  } catch (e) {
    issues.push({ issue: 'SPEC_UNPARSEABLE', detail: (e as Error).message });
  }
  let signer: Hex | null = null;
  try {
    signer = await recoverMessageAddress({ message: { raw: args.bytes }, signature: args.sig });
  } catch (e) {
    issues.push({ issue: 'SPEC_BAD_SIGNATURE', detail: `unrecoverable signature: ${(e as Error).message.split('\n')[0]}` });
  }
  if (signer && !sameAddress(signer, args.founder)) {
    issues.push({ issue: 'SPEC_BAD_SIGNATURE', detail: `signer ${signer} != founder ${args.founder}` });
  }
  if (spec) {
    if (!sameAddress(spec.vault, args.vault)) {
      issues.push({ issue: 'SPEC_WRONG_VAULT', detail: `spec.vault ${spec.vault} != ${args.vault}` });
    }
    if (spec.chain_id !== args.chainId) {
      issues.push({ issue: 'SPEC_WRONG_CHAIN', detail: `spec.chain_id ${spec.chain_id} != ${args.chainId}` });
    }
  }
  return { spec, signer, issues };
}
