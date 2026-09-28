// Decision records: one JSON file per record, hash-chained with `prev`.
// recHash = keccak256 of the file bytes exactly as written. Nobody (auditor included) re-serializes a record.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, type Hex } from 'viem'
import type { Code } from './codes.ts'

export const SCHEMA_VERSION = 1
export const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

export type RecordType =
  | 'SESSION_START' // seq 0: signed spec, vault, prices. Anchored through the prev chain.
  | 'DECISION'      // gate (+ F1/F2) verdict for open / topUp / inference open -> open/topUp/recordDecision rec
  | 'CHAIN_DENIED'  // approved off-chain, contract answered Denied (auditor: CHAIN_OVERRIDE). prev = the approval
  | 'CHECKPOINT'    // executor usage for one settle -> settle rec
  | 'CLOSE'         // job close -> close rec
  | 'RECEIPT'       // F3 explanation, written after Closed is decoded
  | 'STOP'          // founder STOP reason -> setPaused reasonHash
  | 'SESSION_END'   // windDown summary -> refund rec (the last tx anchors the whole chain)

export type KilnCall = {
  flow: 'F1' | 'F2' | 'F3'
  attempt: number
  http: number | null
  latency_ms: number
  gen_id: string | null // X-Neocloud-Generation-Id; "stub-..." in LLM_MODE=stub
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; cost: number | null } | null
  raw: string | null // message content / tool call arguments exactly as received
  finish_reason: string | null // the auditor needs it to recompute a verdict: parseVerdictRaw(raw, finish_reason)
  cost_known: boolean
  llm_mode: 'kiln' | 'stub'
}

// ---- Record bodies ([IFACE]: the orchestrator writes them, the auditor and the report read them) ----
// All amounts are micro-USDC decimal strings; addresses are checksummed Hex; job ids are decimal strings.

/** A scripted change to what an agent saw or said. Every one is listed in the README "대본 개입" table. */
export type Override = { field: string; from: unknown; to: unknown; by: `scenario:${string}` }

/** seq 0. The spec bytes are stored as the exact signed UTF-8 string. */
export type SessionStartBody = {
  vault: Hex; chainId: number; deployBlock: number
  founder: Hex; agent: Hex; feeTo: Hex; inferencePayee: Hex
  vendors: Record<'A' | 'B' | 'C', Hex>
  spec_raw: string // exactly the signed bytes (spec.makeSpec)
  spec_sig: Hex // EIP-191 by founder over spec_raw
  prices: { source: string; snapshotHash: Hex; gpu: string; vendors: Record<'A' | 'B' | 'C', { provider: string; hostUri: string; pricePerHour: string; available: number }> }
  scenario: string
  flags: Record<string, string> // LLM_MODE, SCENARIO, CLOCK_MULT, ... never URLs or secrets
}

/** Body of a DECISION record. gate.input is GateInput with bigints as strings (see rules.gateInputFromJson). */
export type Decision = {
  action: 'open' | 'topUp' | 'inference'
  req_id: string
  job_id: string | null // null before a job exists (anchored with NO_JOB)
  spec_id: string
  request: { vendorLabel: string; vendor: Hex; gpu: string; amount: string; rationale: string } // frozen R; tx args come only from it
  gate: { input: unknown; codes: Code[] }
  f1: KilnCall[] // empty for inference
  f2: KilnCall[] // empty when the gate already denied (the saving) or for inference
  verdict: { approve: true } | { approve: false; code: Code }
  reason: string // Qwen reason or the gate code, for the dashboard/receipt
  tx: { fn: 'open' | 'topUp' | 'recordDecision'; args: string[] } // what this record authorized (rec appended by commit)
  overrides: Override[]
}

/** The contract answered Denied to a tx whose DECISION approved it (auditor: CHAIN_OVERRIDE, not FAIL). */
export type ChainDeniedBody = { req_id: string; job_id: string | null; approval: Hex; code: string; txHash: Hex }

/** One settle: usage the executor accrued for a job since the last decoded Settled. */
export type CheckpointBody = {
  job_id: string; amount: string; signer: 'agent' | 'founder'
  reason: 'periodic' | 'topup' | 'stop' | 'exhausted' | 'windDown'
  accrued: string; settledNet: string; runningMs: string; loss: number | string
}

export type CloseBody = { job_id: string; signer: 'agent' | 'founder'; reason: string; accrued: string; settledNet: string }
export type ReceiptBody = { job_id: string; f3: KilnCall[]; text: string } // text = trimmed F3 content, or "설명 생성 실패(<code>)"
export type StopBody = { reason: string; by: 'founder' } // anchored as setPaused reasonHash
export type SessionEndBody = { refund: string; inference_usage: string; kiln_calls: number; kiln_cost_unknown: number; jobs: string[] }

export type Rec = {
  schema_version: typeof SCHEMA_VERSION
  seq: number
  prev: Hex
  type: RecordType
  run_id: string
  t: number // unix ms, informational only
  body: Record<string, unknown>
}

/** Compact JSON: no indentation, no trailing newline, bigint -> decimal string, NaN/Infinity -> string. */
export function serialize(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
    ),
  )
}

export const hashBytes = (b: Uint8Array): Hex => keccak256(b)

export const recordFile = (seq: number, hash: Hex) => `${String(seq).padStart(6, '0')}-${hash}.json`

/** Append-only writer. Single-threaded by design: all appends go through the commit() queue. */
export class RecordChain {
  head: Hex = ZERO_HASH
  seq = 0
  dir: string
  runId: string
  constructor(dir: string, runId: string) {
    this.dir = dir
    this.runId = runId
    mkdirSync(dir, { recursive: true })
    const last = readChain(dir).at(-1)
    if (last) { this.head = last.hash; this.seq = last.rec.seq + 1 }
  }

  /** Writes tmp -> rename -> read back -> re-hash. Throws (caller HALTs, no tx) if the bytes don't round-trip. */
  append(type: RecordType, body: Record<string, unknown>, now = Date.now()): { hash: Hex; rec: Rec; path: string } {
    const rec: Rec = { schema_version: SCHEMA_VERSION, seq: this.seq, prev: this.head, type, run_id: this.runId, t: now, body }
    const bytes = serialize(rec)
    const hash = hashBytes(bytes)
    const path = join(this.dir, recordFile(rec.seq, hash))
    writeFileSync(`${path}.tmp`, bytes)
    renameSync(`${path}.tmp`, path)
    if (hashBytes(readFileSync(path)) !== hash) throw new Error(`record read-back mismatch: ${path}`)
    this.head = hash
    this.seq++
    return { hash, rec, path }
  }
}

export type StoredRecord = { rec: Rec; hash: Hex; bytes: Buffer; file: string }

/** Reads records in seq order. Hash is recomputed from bytes; the file name is NOT trusted. */
export function readChain(dir: string): StoredRecord[] {
  let files: string[]
  try { files = readdirSync(dir).filter((f) => /^\d{6}-0x[0-9a-f]{64}\.json$/.test(f)).sort() } catch { return [] }
  return files.map((file) => {
    const bytes = readFileSync(join(dir, file))
    return { rec: JSON.parse(bytes.toString('utf8')) as Rec, hash: hashBytes(bytes), bytes, file }
  })
}

/** Chain problems: seq gaps, broken prev links, file name != content hash. Empty = intact. */
export function verifyChain(records: StoredRecord[]): string[] {
  const errs: string[] = []
  let prev = ZERO_HASH
  records.forEach((r, i) => {
    if (r.rec.seq !== i) errs.push(`${r.file}: seq ${r.rec.seq}, expected ${i}`)
    if (r.rec.prev !== prev) errs.push(`${r.file}: prev ${r.rec.prev}, expected ${prev}`)
    if (!r.file.includes(r.hash)) errs.push(`${r.file}: content hash ${r.hash} != file name`)
    prev = r.hash
  })
  return errs
}
