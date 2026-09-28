// commit.ts — the ONE write path (T5). Every record and every tx goes through commit(draft),
// a Promise-chain queue, so records form one linear prevHash chain and txs never race.
//
// One unit, in order (리뷰 수정 사항 > 백엔드 쓰기 경로):
//   0. pre-send simulation (rec = 0): JobClosed on a closed job -> ALREADY_CLOSED (no record, no tx);
//      any other revert (Unauthorized, Panic, ...) -> HALT
//   1. head  2. compact JSON  3. raw bytes  4. keccak  5. tmp + rename  6. read back + re-hash
//      (mismatch -> HALT, no tx)
//   7. ledger `intent`  8. send  9. ledger `sent` {txHash} immediately  10. receipt (60 s)
//      -> timeout: ONE re-query of the same hash -> still nothing: HALT UNCONFIRMED.
//      Never re-sign with a new nonce, never bump fees.
//   11. classify(receipt)  12. ledger `mined`  13. head
//   Approved open/topUp/settle/close that the chain Denied -> CHAIN_DENIED record (prev = the
//   approved record). UNEXPECTED -> HALT. REVERTED -> returned to the caller (re-read the job).
// Kiln and gate work run outside the queue; only writes are serialized.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { vaultAbi } from './abi.ts';
import { classify, type Classified } from './chain.ts';
import { codeToBytes32, isDenyCode } from './codes.ts';
import {
  buildRecord,
  headOf,
  loadRecordDir,
  REC_ARG_FNS,
  verifyChain,
  writeRecordFile,
  ZERO_HASH,
  type DecisionRecord,
  type Head,
  type RecordDraft,
  type TxIntent,
} from './record.ts';

export type HaltReason = 'RECORD_INTEGRITY' | 'UNCONFIRMED' | 'UNEXPECTED' | 'PRESEND_REVERT' | 'SEND_FAILED' | 'CHAIN_FORK' | 'BAD_INTENT';

export class HaltError extends Error {
  override name = 'HaltError';
  readonly reason: HaltReason;
  constructor(reason: HaltReason, message: string) {
    super(`HALT ${reason}: ${message}`);
    this.reason = reason;
  }
}

export type Sender = { account: Account; wallet: WalletClient };

export type CommitDeps = {
  /** run dir: records/ and ledger.jsonl live here */
  dir: string;
  vault: Hex;
  pc: PublicClient;
  chain: Chain;
  senders: { agent: Sender; founder?: Sender };
  receiptTimeoutMs?: number;
  now?: () => Date;
  onEvent?: (ev: Record<string, unknown>) => void;
  /** test seam: defaults to writeRecordFile (tmp + rename + read-back verify) */
  writeRecord?: typeof writeRecordFile;
};

export type Written = { seq: number; hash: Hex; file: string };

export type CommitOutcome =
  | { status: 'RECORDED'; rec: Written }
  | { status: 'ALREADY_CLOSED'; errorName: string }
  | { status: 'MINED'; rec: Written; txHash: Hex; block: bigint; result: Classified; chainDenied: Written | null }
  | { status: 'REVERTED'; rec: Written; txHash: Hex; block: bigint };

/** Functions whose success after an off-chain approval must be mirrored by CHAIN_DENIED if Denied. */
const APPROVED_SPEND_FNS = new Set(['open', 'topUp', 'settle', 'close']);

/** ABI args for a TxIntent (+ trailing rec). Throws on malformed intents (programming error). */
export function encodeIntent(tx: TxIntent, rec: Hex): { functionName: string; args: unknown[] } {
  const a = tx.args;
  const uint = (x: unknown, i: number): bigint => {
    if (typeof x !== 'string' || !/^(0|[1-9]\d*)$/.test(x)) throw new HaltError('BAD_INTENT', `${tx.fn} arg ${i}: not a decimal string`);
    return BigInt(x);
  };
  const addr = (x: unknown, i: number): Hex => {
    if (typeof x !== 'string') throw new HaltError('BAD_INTENT', `${tx.fn} arg ${i}: not an address`);
    return getAddress(x);
  };
  const bool = (x: unknown, i: number): boolean => {
    if (typeof x !== 'boolean') throw new HaltError('BAD_INTENT', `${tx.fn} arg ${i}: not a bool`);
    return x;
  };
  const n = (k: number) => {
    if (a.length !== k) throw new HaltError('BAD_INTENT', `${tx.fn} expects ${k} args, got ${a.length}`);
  };
  switch (tx.fn) {
    case 'open':
      n(2);
      return { functionName: 'open', args: [addr(a[0], 0), uint(a[1], 1), rec] };
    case 'topUp':
    case 'settle':
      n(2);
      return { functionName: tx.fn, args: [uint(a[0], 0), uint(a[1], 1), rec] };
    case 'close':
      n(1);
      return { functionName: 'close', args: [uint(a[0], 0), rec] };
    case 'recordDecision': {
      n(2);
      const code = a[1];
      if (typeof code !== 'string' || !isDenyCode(code)) throw new HaltError('BAD_INTENT', `recordDecision code ${String(code)}`);
      return { functionName: 'recordDecision', args: [uint(a[0], 0), codeToBytes32(code), rec] };
    }
    case 'setPaused':
      n(1);
      return { functionName: 'setPaused', args: [bool(a[0], 0), rec] };
    case 'refund':
      n(1);
      return { functionName: 'refund', args: [uint(a[0], 0), rec] };
    case 'setVendor':
      n(2);
      return { functionName: 'setVendor', args: [addr(a[0], 0), bool(a[1], 1)] };
    case 'setMaxHold':
      n(1);
      return { functionName: 'setMaxHold', args: [uint(a[0], 0)] };
    default:
      throw new HaltError('BAD_INTENT', `unknown fn ${String((tx as TxIntent).fn)}`);
  }
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) return r.data?.errorName ?? r.signature ?? (r.reason ? `Error(${r.reason})` : 'revert');
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}

export class Committer {
  private tail: Promise<unknown> = Promise.resolve();
  private head: Head = null;
  private halted: HaltError | null = null;
  private pendingCount = 0;
  private readonly recordsDir: string;
  private readonly ledgerPath: string;
  private readonly d: CommitDeps;

  private constructor(d: CommitDeps) {
    this.d = d;
    this.recordsDir = join(d.dir, 'records');
    this.ledgerPath = join(d.dir, 'ledger.jsonl');
  }

  /** Load and verify the existing chain. A broken chain refuses to start (ChainFork). */
  static async open(d: CommitDeps): Promise<Committer> {
    const c = new Committer(d);
    await mkdir(c.recordsDir, { recursive: true });
    const { records, stray } = await loadRecordDir(c.recordsDir);
    const issues = verifyChain(records).filter((i) => i.kind !== 'CRLF_SUSPECT');
    if (issues.length || stray.some((s) => !s.startsWith('.tmp-'))) {
      throw new HaltError('CHAIN_FORK', `records dir is not a clean chain: ${JSON.stringify(issues.slice(0, 3))} stray=${stray.join(',')}`);
    }
    c.head = headOf(records);
    return c;
  }

  getHead(): Head {
    return this.head;
  }

  isHalted(): HaltError | null {
    return this.halted;
  }

  pending(): number {
    return this.pendingCount;
  }

  /**
   * Run fn inside the queue WITHOUT writing a record (the stolen-key demo sends its raw txs here
   * so they never race the backend's nonces: "cast only while the backend is idle").
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const p = this.tail.then(() => {
      if (this.halted) throw this.halted;
      return fn();
    });
    this.tail = p.catch(() => {});
    return p.finally(() => {
      this.pendingCount--;
    });
  }

  /** Resolves when everything queued so far has finished. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /** Enqueue one unit. Resolves with its outcome; rejects with HaltError (and halts the queue). */
  commit(draft: RecordDraft): Promise<CommitOutcome> {
    this.pendingCount++;
    const p = this.tail.then(() => this.run(draft));
    this.tail = p.catch(() => {});
    return p.finally(() => {
      this.pendingCount--;
    });
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private async ledger(line: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify({ ts: this.now().toISOString(), ...line }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    await appendFile(this.ledgerPath, text + '\n');
    this.d.onEvent?.({ src: 'commit', ...line });
  }

  private halt(reason: HaltReason, msg: string): never {
    this.halted = new HaltError(reason, msg);
    throw this.halted;
  }

  private sender(from: 'agent' | 'founder'): Sender {
    const s = from === 'agent' ? this.d.senders.agent : this.d.senders.founder;
    if (!s) this.halt('BAD_INTENT', `no ${from} key configured`);
    return s;
  }

  private async write(draft: RecordDraft): Promise<Written> {
    const rec = buildRecord(this.head, draft) as DecisionRecord;
    try {
      const w = await (this.d.writeRecord ?? writeRecordFile)(this.recordsDir, rec);
      this.head = { seq: rec.seq, hash: w.hash };
      return { seq: rec.seq, hash: w.hash, file: w.file };
    } catch (e) {
      this.halt('RECORD_INTEGRITY', (e as Error).message);
    }
  }

  private async run(draft: RecordDraft): Promise<CommitOutcome> {
    if (this.halted) throw this.halted;
    const tx = draft.tx;

    // 0. pre-send simulation (no record, no tx on revert)
    let call: { functionName: string; args: unknown[] } | null = null;
    let sender: Sender | null = null;
    if (tx) {
      call = encodeIntent(tx, ZERO_HASH);
      sender = this.sender(tx.from);
      try {
        await this.d.pc.simulateContract({
          address: this.d.vault,
          abi: vaultAbi,
          functionName: call.functionName as never,
          args: call.args as never,
          account: sender.account,
        });
      } catch (e) {
        const name = revertName(e);
        await this.ledger({ kind: draft.kind, fn: tx.fn, from: tx.from, status: 'presend_revert', error: name });
        if (name === 'JobClosed' && (tx.fn === 'close' || tx.fn === 'settle' || tx.fn === 'topUp')) {
          return { status: 'ALREADY_CLOSED', errorName: name };
        }
        this.halt('PRESEND_REVERT', `${tx.fn}: ${name}`);
      }
    }

    // 1-6. record
    const w = await this.write(draft);
    if (!tx || !call || !sender) {
      await this.ledger({ seq: w.seq, rec: w.hash, kind: draft.kind, status: 'recorded' });
      return { status: 'RECORDED', rec: w };
    }

    // 7. intent
    await this.ledger({ seq: w.seq, rec: w.hash, kind: draft.kind, fn: tx.fn, from: tx.from, args: tx.args, status: 'intent' });

    // 8-9. send, then record the hash immediately
    const real = encodeIntent(tx, REC_ARG_FNS.includes(tx.fn) ? w.hash : ZERO_HASH);
    let txHash: Hex;
    try {
      txHash = await sender.wallet.sendTransaction({
        account: sender.account,
        chain: this.d.chain,
        to: this.d.vault,
        data: encodeFunctionData({ abi: vaultAbi, functionName: real.functionName as never, args: real.args as never }),
      });
    } catch (e) {
      await this.ledger({ seq: w.seq, rec: w.hash, fn: tx.fn, status: 'send_failed', error: revertName(e) });
      this.halt('SEND_FAILED', `${tx.fn}: ${revertName(e)}`);
    }
    await this.ledger({ seq: w.seq, rec: w.hash, fn: tx.fn, status: 'sent', tx: txHash });

    // 10. receipt: 60 s, then ONE re-query of the same hash. No re-send.
    let receipt;
    try {
      receipt = await this.d.pc.waitForTransactionReceipt({ hash: txHash, timeout: this.d.receiptTimeoutMs ?? 60_000, pollingInterval: 500 });
    } catch {
      try {
        receipt = await this.d.pc.getTransactionReceipt({ hash: txHash });
      } catch {
        receipt = null;
      }
      if (!receipt) {
        await this.ledger({ seq: w.seq, rec: w.hash, fn: tx.fn, status: 'unconfirmed', tx: txHash });
        this.halt('UNCONFIRMED', `tx ${txHash} not mined; do not re-send (manual same-nonce replacement only)`);
      }
    }

    // 11-12. classify + mined
    const result = classify(receipt, this.d.vault, tx.fn, REC_ARG_FNS.includes(tx.fn) ? w.hash : null);
    await this.ledger({
      seq: w.seq,
      rec: w.hash,
      fn: tx.fn,
      status: 'mined',
      tx: txHash,
      block: receipt.blockNumber,
      result: result.kind,
      code: result.kind === 'DENIED' ? result.code : undefined,
      jobId: result.kind === 'OK' && result.jobId !== null ? result.jobId : undefined,
      detail: result.kind === 'UNEXPECTED' ? result.detail : undefined,
    });

    if (result.kind === 'UNEXPECTED') this.halt('UNEXPECTED', `${tx.fn} ${txHash}: ${result.detail}`);
    if (result.kind === 'REVERTED') return { status: 'REVERTED', rec: w, txHash, block: receipt.blockNumber };

    // 13. approved spend came back Denied: CHAIN_DENIED record right after the approval
    let chainDenied: Written | null = null;
    if (result.kind === 'DENIED' && APPROVED_SPEND_FNS.has(tx.fn)) {
      chainDenied = await this.write({
        kind: 'CHAIN_DENIED',
        run_id: draft.run_id,
        chain_id: draft.chain_id,
        vault: draft.vault,
        spec_id: draft.spec_id,
        req_id: draft.req_id,
        job_id: draft.job_id,
        at: this.now().toISOString(),
        tx: null,
        body: { ref: w.hash, tx_hash: txHash, fn: tx.fn, code: result.code, block: receipt.blockNumber.toString() },
      });
      await this.ledger({ seq: chainDenied.seq, rec: chainDenied.hash, kind: 'CHAIN_DENIED', status: 'recorded', ref: w.hash, code: result.code });
    }
    return { status: 'MINED', rec: w, txHash, block: receipt.blockNumber, result, chainDenied };
  }
}
