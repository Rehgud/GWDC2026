// record.ts — decision record schema, exact bytes, recHash, prevHash chain ([IFACE]).
//
// A record is ONE JSON file. recHash = keccak256(the exact bytes written to disk):
//   - compact JSON (no indentation, no trailing newline), UTF-8
//   - object keys keep insertion order (records are built by code, never re-serialized)
//   - bigint -> decimal string, NaN -> "NaN", +-Infinity -> "Infinity"/"-Infinity"
//   - undefined, functions, symbols, Map/Set, class instances are REJECTED (throw), not dropped
// Files are written tmp + rename, read back and re-hashed. A mismatch throws
// RecordIntegrityError and the caller must HALT without sending the tx.
//
// Every record carries prevHash (ZERO_HASH for seq 0), so the whole session is one linear
// chain. Every tx that takes `rec` anchors the head on-chain; records without a tx
// (SESSION_START, CHAIN_DENIED, CHECKPOINT, RECEIPT, local READ_FAILED) are anchored by the next tx that
// chains after them. The last record must be anchored (SESSION_END -> refund(amount, rec)).
import { keccak256, type Hex } from 'viem';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DenyCode, GateCode } from './codes.ts';
import type { ChainRuleInput, Dec, GateInput, JobView, LossWire } from './rules.ts';

export const SCHEMA_VERSION = 1 as const;
export const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`;

// ------------------------------------------------------------------------------ serialization
export class SerializeError extends Error {
  override name = 'SerializeError';
}

function toWire(v: unknown, path: string): unknown {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'bigint':
      return v.toString();
    case 'number':
      if (Number.isNaN(v)) return 'NaN';
      if (v === Number.POSITIVE_INFINITY) return 'Infinity';
      if (v === Number.NEGATIVE_INFINITY) return '-Infinity';
      return v;
    case 'object': {
      if (v === null) return null;
      if (Array.isArray(v)) return v.map((x, i) => toWire(x, `${path}[${i}]`));
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new SerializeError(`${path}: non-plain object (${proto?.constructor?.name ?? 'unknown'})`);
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) throw new SerializeError(`${path}.${k}: undefined (use null)`);
        out[k] = toWire(x, `${path}.${k}`);
      }
      return out;
    }
    default:
      throw new SerializeError(`${path}: unsupported ${typeof v}`);
  }
}

/** The exact bytes of a record / spec / snapshot file. */
export function serialize(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(toWire(value, '$')));
}

export function hashBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
export function parseBytes<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(utf8.decode(bytes)) as T;
}

// ------------------------------------------------------------------------------ schema
export type RecordKind =
  | 'SESSION_START' // genesis: signed spec, roles, vendors + price source, run config. no tx
  | 'INFERENCE_OPEN' // D2: chain-rule check (no gate, no F2) -> open(INFERENCE) | recordDecision
  | 'REQUEST' // F1 -> gate -> F2 -> open/topUp | recordDecision | none (local READ_FAILED)
  | 'CHAIN_DENIED' // an approved tx came back Denied on-chain (prev = the approved record). no tx
  | 'CHECKPOINT' // executor checkpoint that did not settle (zero delta). no tx
  | 'SETTLE' // settle(jobId, net, rec) by agent or founder; carries the checkpoint it closes
  | 'CLOSE' // close(jobId, rec) by agent or founder
  | 'RECEIPT' // F3 explanation after a vendor close. no tx
  | 'PAUSE' // founder STOP: setPaused(true, rec)
  | 'ADMIN' // founder setVendor / setMaxHold during a run (no rec arg; matched by tx hash)
  | 'SESSION_END'; // windDown end: refund(budget - committed, rec). must be the last record

export const RECORD_KINDS: readonly RecordKind[] = [
  'SESSION_START',
  'INFERENCE_OPEN',
  'REQUEST',
  'CHAIN_DENIED',
  'CHECKPOINT',
  'SETTLE',
  'CLOSE',
  'RECEIPT',
  'PAUSE',
  'ADMIN',
  'SESSION_END',
];

export type TxFn =
  | 'open'
  | 'topUp'
  | 'settle'
  | 'close'
  | 'recordDecision'
  | 'setPaused'
  | 'refund'
  | 'setVendor'
  | 'setMaxHold';

/** Which tx each record kind may carry (null tx = local-only record). */
export const KIND_TX: Readonly<Record<RecordKind, readonly TxFn[]>> = {
  SESSION_START: [],
  INFERENCE_OPEN: ['open', 'recordDecision'],
  REQUEST: ['open', 'topUp', 'recordDecision'],
  CHAIN_DENIED: [],
  CHECKPOINT: [],
  SETTLE: ['settle'],
  CLOSE: ['close'],
  RECEIPT: [],
  PAUSE: ['setPaused'],
  ADMIN: ['setVendor', 'setMaxHold'],
  SESSION_END: ['refund'],
};

/** Functions whose last argument is `rec` = this record's hash (appended at send time). */
export const REC_ARG_FNS: readonly TxFn[] = ['open', 'topUp', 'settle', 'close', 'recordDecision', 'setPaused', 'refund'];

/**
 * The tx this record authorizes. `args` EXCLUDE the trailing rec argument (it is this record's
 * own hash). Amounts are decimal strings; addresses are 0x-hex; bools are bools.
 */
export type TxIntent = {
  fn: TxFn;
  from: 'agent' | 'founder';
  args: (string | boolean)[];
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  /** Kiln usage.cost in USD as reported (string to keep exact digits); null if absent */
  cost: string | null;
};

export type LlmAttempt = {
  attempt: number;
  http: number | null;
  latency_ms: number;
  gen_id: string | null;
  finish_reason: string | null;
  usage: Usage | null;
  cost_known: boolean;
  /** short machine code: TIMEOUT | HTTP_429 | HTTP_5XX | NETWORK | TRUNCATED | EMPTY | ... */
  error: string | null;
};

/** Evidence of one LLM flow call (all attempts). raw = final assistant content, verbatim. */
export type LlmEvidence = {
  flow: 'F1' | 'F2' | 'F3';
  llm_mode: 'kiln' | 'stub';
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  attempts: LlmAttempt[];
  raw: string | null;
  gen_id: string | null;
  usage: Usage | null;
  /** fail-closed code when the flow produced no usable answer */
  code: DenyCode | null;
};

/** F1 work_request output after shape validation (vendor is a free label; the gate judges it). */
export type F1Request = { vendor: string; gpu: string; amount: string; reason: string };

/** A scripted scenario intervention (D5 injection, migration trigger, ...). */
export type Override = { field: string; from: unknown; to: unknown; by: `scenario:${string}`; actual?: unknown };

/**
 * One executor checkpoint (every 30 sim-min, and on top-up / halt / NaN). The loss series behind
 * NAN_DETECTED and LOSS_PLATEAU is anchored here as it happens, so a later REQUEST's
 * gateInput.progress.losses can be compared with what was recorded at each checkpoint.
 */
export type Checkpoint = {
  /** 0-based index within the logical task (spec_id), continues across a vendor migration */
  idx: number;
  loss: LossWire;
  /** cumulative NET usage of this job up to this checkpoint */
  accrued_net: Dec;
  /** cumulative simulated seconds of this job */
  sim_seconds: Dec;
};

/** Snapshot pinned at one block (multicall@N). All numbers are Dec strings. */
export type ChainSnapshot = {
  blockNumber: Dec;
  blockHash: Hex;
  blockTimestamp: Dec;
  paused: boolean;
  deadline: Dec;
  budget: Dec;
  committed: Dec;
  maxHold: Dec;
  feeBps: Dec;
  jobCount: Dec;
  /** lower-case address -> allowed, for every address the session cares about */
  vendorAllowed: Record<string, boolean>;
  jobs: JobView[];
};

export type SessionEndReason =
  | 'COMPLETED'
  | 'STOP'
  | 'DEADLINE'
  | 'INITIAL_OPEN_FAILED'
  | 'MIGRATION_OPEN_FAILED'
  | 'QWEN_FINAL_DENY'
  | 'NAN'
  | 'WIND_DOWN'
  | 'EXECUTOR_CRASH';

export type VendorEntry = {
  label: string;
  address: Hex;
  host_uri: string;
  gpu: string;
  /** NET micro-USD per GPU-hour */
  price: Dec;
  capacity: number;
};

export type Bodies = {
  SESSION_START: {
    spec: { file: string; hash: Hex; sig: Hex; signer: Hex };
    roles: { founder: Hex; agent: Hex; fee_to: Hex; inference_payee: Hex; usdc: Hex };
    vendors: VendorEntry[];
    prices: { source: string; file: string; hash: Hex; fetched_at: string };
    config: {
      llm_mode: 'kiln' | 'stub';
      model: string;
      clock_mult: number;
      topup_trigger_bps: number;
      deadline_margin_s: number;
      llm_call_cap: number;
      inference_hold: Dec;
      scenario: string;
      git_sha: string;
    };
    deploy_block: Dec;
  };
  INFERENCE_OPEN: {
    snapshot: ChainSnapshot;
    ruleInput: ChainRuleInput;
    ruleResult: GateCode[];
    decision: 'APPROVE' | 'DENY';
    code: DenyCode | null;
  };
  REQUEST: {
    trigger: 'start' | 'topup' | 'migration' | 'repropose' | 'rearm';
    attempt: number;
    snapshot: ChainSnapshot | null;
    f1: LlmEvidence | null;
    request: F1Request | null;
    gateInput: GateInput | null;
    gateInputHash: Hex | null;
    gateResult: GateCode[] | null;
    f2: LlmEvidence | null;
    verdict: { verdict: 'approve' | 'deny'; reason: string } | null;
    decision: 'APPROVE' | 'DENY';
    code: DenyCode | null;
    overrides: Override[];
  };
  CHAIN_DENIED: {
    ref: Hex; // recHash of the approved record whose tx was Denied
    tx_hash: Hex;
    fn: TxFn;
    code: string; // decoded code (or UNKNOWN(...))
    block: Dec;
  };
  CHECKPOINT: { checkpoint: Checkpoint; note: string };
  SETTLE: {
    by: 'agent' | 'founder';
    vendor: Hex;
    net: Dec;
    accrued_net: Dec; // ledger usage for the job up to the executor halt / checkpoint
    settled_before: Dec; // sum of decoded Settled net before this one
    reason: 'checkpoint' | 'topup' | 'halt' | 'wind_down';
    sim_seconds: Dec;
    /** the checkpoint this settle closes (null for a founder wind-down delta with no new checkpoint) */
    checkpoint: Checkpoint | null;
    snapshot: ChainSnapshot | null;
  };
  CLOSE: {
    by: 'agent' | 'founder';
    reason: string;
    unsettled_net: Dec; // must be "0" (UNPAID_USAGE otherwise)
    snapshot: ChainSnapshot | null;
  };
  RECEIPT: {
    close_ref: Hex;
    f3: LlmEvidence | null;
    text: string;
    receipt: {
      job_id: Dec;
      vendor_label: string;
      vendor: Hex;
      price_source: string;
      price_hash: Hex;
      sim_seconds: Dec;
      net: Dec;
      fee: Dec;
      spec_gross: Dec;
      tx_hashes: Hex[];
      qwen_reason: string | null;
    };
  };
  PAUSE: { reason: string; snapshot: ChainSnapshot | null };
  ADMIN: { reason: string; overrides: Override[] };
  SESSION_END: {
    reason: SessionEndReason;
    refund: Dec;
    snapshot: ChainSnapshot | null;
    totals: { vendor_net: Dec; fees: Dec; inference: Dec; llm_calls: number };
  };
};

export type RecordHeader = {
  schema_version: typeof SCHEMA_VERSION;
  seq: number;
  prevHash: Hex;
  run_id: string;
  chain_id: number;
  vault: Hex;
  spec_id: string;
  req_id: string | null;
  job_id: Dec | null;
  /** wall clock ISO time, informational only (rules use block time) */
  at: string;
  tx: TxIntent | null;
};

export type DecisionRecord<K extends RecordKind = RecordKind> = K extends RecordKind
  ? RecordHeader & { kind: K; body: Bodies[K] }
  : never;

/** Fields the caller supplies; seq/prevHash come from the chain head. */
export type RecordDraft<K extends RecordKind = RecordKind> = K extends RecordKind
  ? Omit<RecordHeader, 'schema_version' | 'seq' | 'prevHash'> & { kind: K; body: Bodies[K] }
  : never;

export type Head = { seq: number; hash: Hex } | null;

/** Build the next record on top of `head` (key order is fixed here, so bytes are stable). */
export function buildRecord<K extends RecordKind>(head: Head, d: RecordDraft<K>): DecisionRecord<K> {
  const rec = {
    schema_version: SCHEMA_VERSION,
    seq: head ? head.seq + 1 : 0,
    prevHash: head ? head.hash : ZERO_HASH,
    kind: d.kind,
    run_id: d.run_id,
    chain_id: d.chain_id,
    vault: d.vault,
    spec_id: d.spec_id,
    req_id: d.req_id,
    job_id: d.job_id,
    at: d.at,
    tx: d.tx,
    body: d.body,
  };
  return rec as unknown as DecisionRecord<K>;
}

// ------------------------------------------------------------------------------ light validation
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Structural checks shared by the writer and the auditor. Returns problems (empty = OK). */
export function validateRecord(r: unknown): string[] {
  const p: string[] = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['not an object'];
  const x = r as Record<string, unknown>;
  if (x.schema_version !== SCHEMA_VERSION) p.push('schema_version');
  if (!Number.isSafeInteger(x.seq) || (x.seq as number) < 0) p.push('seq');
  if (typeof x.prevHash !== 'string' || !HEX32.test(x.prevHash)) p.push('prevHash');
  if (typeof x.kind !== 'string' || !RECORD_KINDS.includes(x.kind as RecordKind)) p.push('kind');
  if (typeof x.run_id !== 'string' || !x.run_id) p.push('run_id');
  if (!Number.isSafeInteger(x.chain_id)) p.push('chain_id');
  if (typeof x.vault !== 'string' || !ADDR.test(x.vault)) p.push('vault');
  if (typeof x.spec_id !== 'string' || !x.spec_id) p.push('spec_id');
  if (x.job_id !== null && (typeof x.job_id !== 'string' || !/^(0|[1-9]\d*)$/.test(x.job_id))) p.push('job_id');
  if (!x.body || typeof x.body !== 'object') p.push('body');
  const kind = x.kind as RecordKind;
  if (x.tx !== null) {
    const tx = x.tx as Record<string, unknown>;
    if (!tx || typeof tx !== 'object') p.push('tx');
    else {
      const allowed = KIND_TX[kind] ?? [];
      if (!allowed.includes(tx.fn as TxFn)) p.push(`tx.fn ${String(tx.fn)} not allowed for ${kind}`);
      if (tx.from !== 'agent' && tx.from !== 'founder') p.push('tx.from');
      if (!Array.isArray(tx.args)) p.push('tx.args');
    }
  } else if (kind === 'SESSION_END' || kind === 'SETTLE' || kind === 'CLOSE' || kind === 'PAUSE' || kind === 'ADMIN') {
    p.push(`${kind} requires a tx`);
  }
  return p;
}

// ------------------------------------------------------------------------------ files
export class RecordIntegrityError extends Error {
  override name = 'RecordIntegrityError';
}

export function recordFileName(seq: number, hash: Hex): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 999_999) throw new RangeError(`seq ${seq}`);
  return `${String(seq).padStart(6, '0')}-${hash.toLowerCase()}.json`;
}

const FILE_RE = /^(\d{6})-(0x[0-9a-f]{64})\.json$/;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export type WrittenRecord = { hash: Hex; bytes: Uint8Array; file: string; path: string };

/**
 * Serialize once, hash those bytes, write tmp + fsync + rename, read back and re-hash.
 * Throws RecordIntegrityError on any mismatch (caller HALTs; no tx is sent).
 */
export async function writeRecordFile(dir: string, rec: DecisionRecord): Promise<WrittenRecord> {
  const problems = validateRecord(rec);
  if (problems.length) throw new RecordIntegrityError(`invalid record: ${problems.join(', ')}`);
  await mkdir(dir, { recursive: true });
  const bytes = serialize(rec);
  const hash = hashBytes(bytes);
  const file = recordFileName(rec.seq, hash);
  const path = join(dir, file);
  const tmp = join(dir, `.tmp-${String(rec.seq).padStart(6, '0')}-${process.pid}`);
  if (await exists(path)) throw new RecordIntegrityError(`record already exists: ${file}`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw new RecordIntegrityError(`rename failed: ${(e as Error).message}`);
  }
  const back = new Uint8Array(await readFile(path));
  if (back.length !== bytes.length || hashBytes(back) !== hash) {
    throw new RecordIntegrityError(`read-back hash mismatch for ${file}`);
  }
  return { hash, bytes, file, path };
}

export type LoadedRecord = {
  file: string;
  seq: number;
  nameHash: Hex;
  bytes: Uint8Array;
  hash: Hex;
  record: DecisionRecord | null; // null when unparseable
};

/** Load records/<seq6>-<hash>.json sorted by seq. Unknown file names are returned as issues. */
export async function loadRecordDir(dir: string): Promise<{ records: LoadedRecord[]; stray: string[] }> {
  const names = (await readdir(dir)).sort();
  const records: LoadedRecord[] = [];
  const stray: string[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) {
      stray.push(name);
      continue;
    }
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    let record: DecisionRecord | null = null;
    try {
      record = parseBytes<DecisionRecord>(bytes);
    } catch {
      record = null;
    }
    records.push({ file: name, seq: Number(m[1]), nameHash: m[2] as Hex, bytes, hash: hashBytes(bytes), record });
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, stray };
}

export type ChainIssueKind =
  | 'HASH_MISMATCH' // keccak(bytes) != hash in the file name
  | 'PARSE_ERROR'
  | 'SCHEMA'
  | 'SEQ_MISMATCH' // seq in body != seq in file name
  | 'SEQ_GAP' // missing / duplicated seq
  | 'PREV_MISMATCH' // prevHash does not point at the previous record
  | 'CRLF_SUSPECT'; // bytes contain CR: likely a core.autocrlf checkout (hint only)

export type ChainIssue = { seq: number; file: string; kind: ChainIssueKind; detail: string };

/** check 1: every recHash matches its bytes, and prevHash links 0..n-1 without gaps. */
export function verifyChain(records: readonly LoadedRecord[]): ChainIssue[] {
  const issues: ChainIssue[] = [];
  let expectPrev: Hex = ZERO_HASH;
  let expectSeq = 0;
  for (const r of records) {
    if (r.bytes.includes(0x0d)) {
      issues.push({ seq: r.seq, file: r.file, kind: 'CRLF_SUSPECT', detail: 'CR byte found; re-clone with core.autocrlf=false or check .gitattributes' });
    }
    if (r.hash !== r.nameHash) {
      issues.push({ seq: r.seq, file: r.file, kind: 'HASH_MISMATCH', detail: `keccak(bytes)=${r.hash}` });
    }
    if (!r.record) {
      issues.push({ seq: r.seq, file: r.file, kind: 'PARSE_ERROR', detail: 'not valid UTF-8 JSON' });
    } else {
      const probs = validateRecord(r.record);
      if (probs.length) issues.push({ seq: r.seq, file: r.file, kind: 'SCHEMA', detail: probs.join(', ') });
      if (r.record.seq !== r.seq) issues.push({ seq: r.seq, file: r.file, kind: 'SEQ_MISMATCH', detail: `body seq ${r.record.seq}` });
      if (r.record.prevHash !== expectPrev) {
        issues.push({ seq: r.seq, file: r.file, kind: 'PREV_MISMATCH', detail: `prevHash ${r.record.prevHash} != ${expectPrev}` });
      }
    }
    if (r.seq !== expectSeq) {
      issues.push({ seq: r.seq, file: r.file, kind: 'SEQ_GAP', detail: `expected seq ${expectSeq}` });
    }
    expectSeq = r.seq + 1;
    // chain continues from the hash in the file name (the claimed hash) so one bad file
    // produces one HASH_MISMATCH instead of cascading PREV_MISMATCH on every later record
    expectPrev = r.nameHash;
  }
  return issues;
}

/** Head of a verified chain (last record), or null for an empty dir. */
export function headOf(records: readonly LoadedRecord[]): Head {
  const last = records[records.length - 1];
  return last ? { seq: last.seq, hash: last.nameHash } : null;
}

/** Re-export for consumers that only need the loss wire type with records. */
export type { LossWire };
