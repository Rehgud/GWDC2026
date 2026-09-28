// chain.ts — read side of the chain: clients, vault log decoding, classify(receipt), pinned
// snapshots and the single chain watcher (T5).
//
// The auditor imports the pure parts of this file (decodeVaultLogs, classify, getLogsChunked),
// so nothing here touches the executor, Kiln, Akash or the server.
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { vaultAbi } from './abi.ts';
import { describeBytes32 } from './codes.ts';
import type { ChainSnapshot, TxFn } from './record.ts';
import type { Dec, JobView } from './rules.ts';

// ------------------------------------------------------------------------------ clients
export function makePublicClient(rpcUrls: string[], opts: { timeoutMs?: number } = {}): PublicClient {
  const transports = rpcUrls.map((u) => http(u, { timeout: opts.timeoutMs ?? 8_000, retryCount: 0 }));
  return createPublicClient({ transport: transports.length > 1 ? fallback(transports) : transports[0]! }) as PublicClient;
}

// ------------------------------------------------------------------------------ decoding
export type VaultEvent =
  | { name: 'Funded'; amount: bigint; deadline: bigint }
  | { name: 'VendorSet'; vendor: Hex; allowed: boolean }
  | { name: 'MaxHoldSet'; maxHold: bigint }
  | { name: 'PausedSet'; paused: boolean; rec: Hex }
  | { name: 'HoldOpened'; jobId: bigint; vendor: Hex; net: bigint; gross: bigint; rec: Hex }
  | { name: 'ToppedUp'; jobId: bigint; net: bigint; gross: bigint; rec: Hex }
  | { name: 'Settled'; jobId: bigint; vendor: Hex; net: bigint; fee: bigint; rec: Hex }
  | { name: 'Closed'; jobId: bigint; released: bigint; rec: Hex }
  | { name: 'Refunded'; amount: bigint; rec: Hex }
  | { name: 'Denied'; jobId: bigint; code: Hex; rec: Hex; enforced: boolean }
  | { name: 'Unknown'; topic0: Hex | null };

export type DecodedLog = VaultEvent & { blockNumber: bigint; txHash: Hex; logIndex: number; txIndex: number };

type RawLog = Pick<Log, 'address' | 'topics' | 'data' | 'blockNumber' | 'transactionHash' | 'logIndex' | 'transactionIndex'>;

/** Decode ONLY logs emitted by the vault address. Undecodable vault logs become 'Unknown'. */
export function decodeVaultLogs(vault: Hex, logs: readonly RawLog[]): DecodedLog[] {
  const v = vault.toLowerCase();
  const out: DecodedLog[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== v) continue;
    const meta = {
      blockNumber: l.blockNumber ?? 0n,
      txHash: (l.transactionHash ?? '0x') as Hex,
      logIndex: l.logIndex ?? 0,
      txIndex: l.transactionIndex ?? 0,
    };
    let ev: VaultEvent;
    try {
      const d = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
      const a = d.args as Record<string, unknown>;
      switch (d.eventName) {
        case 'Funded':
          ev = { name: 'Funded', amount: a.amount as bigint, deadline: a.deadline as bigint };
          break;
        case 'VendorSet':
          ev = { name: 'VendorSet', vendor: a.vendor as Hex, allowed: a.allowed as boolean };
          break;
        case 'MaxHoldSet':
          ev = { name: 'MaxHoldSet', maxHold: a.maxHold as bigint };
          break;
        case 'PausedSet':
          ev = { name: 'PausedSet', paused: a.paused as boolean, rec: a.rec as Hex };
          break;
        case 'HoldOpened':
          ev = { name: 'HoldOpened', jobId: a.jobId as bigint, vendor: a.vendor as Hex, net: a.net as bigint, gross: a.gross as bigint, rec: a.recordHash as Hex };
          break;
        case 'ToppedUp':
          ev = { name: 'ToppedUp', jobId: a.jobId as bigint, net: a.net as bigint, gross: a.gross as bigint, rec: a.recordHash as Hex };
          break;
        case 'Settled':
          ev = { name: 'Settled', jobId: a.jobId as bigint, vendor: a.vendor as Hex, net: a.net as bigint, fee: a.fee as bigint, rec: a.recordHash as Hex };
          break;
        case 'Closed':
          ev = { name: 'Closed', jobId: a.jobId as bigint, released: a.released as bigint, rec: a.rec as Hex };
          break;
        case 'Refunded':
          ev = { name: 'Refunded', amount: a.amount as bigint, rec: a.rec as Hex };
          break;
        case 'Denied':
          ev = { name: 'Denied', jobId: a.jobId as bigint, code: a.code as Hex, rec: a.rec as Hex, enforced: a.enforced as boolean };
          break;
        default:
          ev = { name: 'Unknown', topic0: (l.topics[0] ?? null) as Hex | null };
      }
    } catch {
      ev = { name: 'Unknown', topic0: (l.topics[0] ?? null) as Hex | null };
    }
    out.push({ ...ev, ...meta } as DecodedLog);
  }
  return out;
}

// ------------------------------------------------------------------------------ classify
/** The success event each write function must emit. */
export const EXPECTED_EVENT: Readonly<Record<TxFn | 'fund', VaultEvent['name']>> = {
  open: 'HoldOpened',
  topUp: 'ToppedUp',
  settle: 'Settled',
  close: 'Closed',
  refund: 'Refunded',
  setPaused: 'PausedSet',
  recordDecision: 'Denied',
  setVendor: 'VendorSet',
  setMaxHold: 'MaxHoldSet',
  fund: 'Funded',
};

export type Classified =
  | { kind: 'OK'; event: DecodedLog; jobId: bigint | null }
  | { kind: 'DENIED'; code: string; codeHex: Hex; event: DecodedLog }
  | { kind: 'REVERTED' }
  | { kind: 'UNEXPECTED'; detail: string };

/**
 * THE single decision point for every tx result (R3-8). Never trust `status` alone:
 *   status 0                                -> REVERTED
 *   exactly one expected success event      -> OK (jobId only ever comes from HoldOpened)
 *   exactly one Denied(enforced=true)       -> DENIED(code)   (rule violation, nothing moved)
 *   recordDecision: exactly one Denied(enforced=false) with our rec -> OK
 *   anything else (no vault log, both, extra, wrong rec) -> UNEXPECTED (caller HALTs)
 */
export function classify(
  receipt: Pick<TransactionReceipt, 'status' | 'logs'>,
  vault: Hex,
  fn: TxFn | 'fund',
  rec: Hex | null,
): Classified {
  if (receipt.status !== 'success') return { kind: 'REVERTED' };
  const logs = decodeVaultLogs(vault, receipt.logs as RawLog[]);
  if (logs.some((l) => l.name === 'Unknown')) return { kind: 'UNEXPECTED', detail: 'undecodable vault log' };
  const want = EXPECTED_EVENT[fn];
  const recOk = (l: DecodedLog) => rec === null || !('rec' in l) || (l as { rec: Hex }).rec.toLowerCase() === rec.toLowerCase();

  if (fn === 'recordDecision') {
    if (logs.length === 1 && logs[0]!.name === 'Denied' && !logs[0]!.enforced && recOk(logs[0]!)) {
      return { kind: 'OK', event: logs[0]!, jobId: null };
    }
    return { kind: 'UNEXPECTED', detail: `recordDecision logs: ${logs.map((l) => l.name).join(',') || 'none'}` };
  }
  const success = logs.filter((l) => l.name === want);
  const denied = logs.filter((l) => l.name === 'Denied');
  if (success.length === 1 && denied.length === 0 && logs.length === 1) {
    const ev = success[0]!;
    if (!recOk(ev)) return { kind: 'UNEXPECTED', detail: `${want} carries a different rec` };
    return { kind: 'OK', event: ev, jobId: ev.name === 'HoldOpened' ? ev.jobId : null };
  }
  if (denied.length === 1 && success.length === 0 && logs.length === 1) {
    const ev = denied[0]!;
    if (ev.name !== 'Denied' || !ev.enforced) return { kind: 'UNEXPECTED', detail: 'Denied(enforced=false) from a rule-checked call' };
    if (!recOk(ev)) return { kind: 'UNEXPECTED', detail: 'Denied carries a different rec' };
    return { kind: 'DENIED', code: describeBytes32(ev.code), codeHex: ev.code, event: ev };
  }
  return { kind: 'UNEXPECTED', detail: `expected ${want} or Denied, got [${logs.map((l) => l.name).join(',') || 'no vault logs'}]` };
}

// ------------------------------------------------------------------------------ logs (chunked)
export class RpcLimitError extends Error {
  override name = 'RpcLimitError';
}

/**
 * eth_getLogs for the vault address only, in <= 1,000-block chunks (sepolia.base.org limit).
 * Throws RpcLimitError if the RPC keeps failing (auditor maps it to exit 2 CANNOT_VERIFY).
 */
export async function getLogsChunked(pc: PublicClient, vault: Hex, fromBlock: bigint, toBlock: bigint, chunk = 1_000n): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    let lastErr: unknown = null;
    let got: Log[] | null = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try {
        got = await pc.getLogs({ address: vault, fromBlock: start, toBlock: end });
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (got === null) throw new RpcLimitError(`getLogs ${start}..${end}: ${(lastErr as Error)?.message?.split('\n')[0]}`);
    out.push(...got);
  }
  return out;
}

// ------------------------------------------------------------------------------ snapshot
export class ReadFailedError extends Error {
  override name = 'ReadFailedError';
}

const dec = (x: bigint): Dec => x.toString();

/**
 * Read every vault value the gate / executor / dashboard need at ONE block N. All reads are
 * pinned to the same block number, so the snapshot is consistent even without multicall.
 */
export async function readSnapshot(
  pc: PublicClient,
  vault: Hex,
  opts: { addresses: readonly Hex[]; jobIds?: readonly bigint[]; blockNumber?: bigint },
): Promise<ChainSnapshot> {
  const block = opts.blockNumber === undefined ? await pc.getBlock({ blockTag: 'latest' }) : await pc.getBlock({ blockNumber: opts.blockNumber });
  const blockNumber = block.number!;
  const r = <T>(functionName: string, args: unknown[] = []) =>
    pc.readContract({ address: vault, abi: vaultAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const [paused, deadline, budget, committed, maxHold, feeBps, jobCount] = await Promise.all([
    r<boolean>('paused'),
    r<bigint>('deadline'),
    r<bigint>('budget'),
    r<bigint>('committed'),
    r<bigint>('maxHold'),
    r<bigint>('feeBps'),
    r<bigint>('jobCount'),
  ]);
  const uniq = [...new Set(opts.addresses.map((a) => a.toLowerCase()))] as Hex[];
  const allowed = await Promise.all(uniq.map((a) => r<boolean>('vendorAllowed', [a])));
  const vendorAllowed: Record<string, boolean> = {};
  uniq.forEach((a, i) => (vendorAllowed[a] = allowed[i]!));
  const ids = (opts.jobIds ?? []).filter((id) => id < jobCount);
  const jobsRaw = await Promise.all(ids.map((id) => r<{ vendor: Hex; held: bigint; paid: bigint; closed: boolean }>('getJob', [id])));
  const jobs: JobView[] = jobsRaw.map((j, i) => ({ id: dec(ids[i]!), vendor: j.vendor, held: dec(j.held), paid: dec(j.paid), closed: j.closed }));
  return {
    blockNumber: dec(blockNumber),
    blockHash: block.hash!,
    blockTimestamp: dec(block.timestamp),
    paused,
    deadline: dec(deadline),
    budget: dec(budget),
    committed: dec(committed),
    maxHold: dec(maxHold),
    feeBps: dec(feeBps),
    jobCount: dec(jobCount),
    vendorAllowed,
    jobs,
  };
}

// ------------------------------------------------------------------------------ watcher
export type WatcherState = {
  snapshot: ChainSnapshot | null;
  /** wall-clock ms of the last successful snapshot */
  fetchedAt: number | null;
  /** last read error (cleared on success) */
  error: string | null;
};

export type WatcherOpts = {
  pollMs?: number;
  staleMs?: number;
  now?: () => number;
  onLogs?: (logs: DecodedLog[]) => void;
  onSnapshot?: (s: ChainSnapshot) => void;
  fromBlock?: bigint;
};

/**
 * The ONE chain watcher. Polls the head; on a new block it reads a pinned snapshot and the
 * vault logs since the last block. Gate, executor and dashboard all read `state()`.
 *   stale(now)  -> true when the last good snapshot is older than staleMs (STALE_CHAIN:
 *                  the executor stops accruing).
 *   fresh()     -> read a new snapshot NOW, retrying once; throws ReadFailedError (READ_FAILED,
 *                  fail-closed) if both attempts fail. Used right before every gate decision.
 */
export class ChainWatcher {
  private st: WatcherState = { snapshot: null, fetchedAt: null, error: null };
  private timer: NodeJS.Timeout | null = null;
  private jobIds = new Set<bigint>();
  private lastLogBlock: bigint | null = null;
  private busy = false;
  private readonly pc: PublicClient;
  private readonly vault: Hex;
  private readonly addresses: readonly Hex[];
  private readonly opts: WatcherOpts;
  constructor(pc: PublicClient, vault: Hex, addresses: readonly Hex[], opts: WatcherOpts = {}) {
    this.pc = pc;
    this.vault = vault;
    this.addresses = addresses;
    this.opts = opts;
    this.lastLogBlock = opts.fromBlock !== undefined ? opts.fromBlock - 1n : null;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  trackJob(id: bigint): void {
    this.jobIds.add(id);
  }

  state(): WatcherState {
    return this.st;
  }

  stale(now = this.now()): boolean {
    return this.st.fetchedAt === null || now - this.st.fetchedAt > (this.opts.staleMs ?? 10_000);
  }

  private async readOnce(): Promise<ChainSnapshot> {
    const s = await readSnapshot(this.pc, this.vault, { addresses: this.addresses, jobIds: [...this.jobIds] });
    this.st = { snapshot: s, fetchedAt: this.now(), error: null };
    this.opts.onSnapshot?.(s);
    return s;
  }

  async fresh(): Promise<ChainSnapshot> {
    try {
      return await this.readOnce();
    } catch {
      try {
        return await this.readOnce();
      } catch (e) {
        this.st = { ...this.st, error: (e as Error).message.split('\n')[0]! };
        throw new ReadFailedError(this.st.error!);
      }
    }
  }

  /** one poll step (exposed for tests) */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = await this.pc.getBlockNumber();
      const s = this.st.snapshot;
      if (!s || BigInt(s.blockNumber) < head || this.stale()) await this.readOnce();
      if (this.opts.onLogs && this.lastLogBlock !== null && head > this.lastLogBlock) {
        const logs = await this.pc.getLogs({ address: this.vault, fromBlock: this.lastLogBlock + 1n, toBlock: head });
        this.lastLogBlock = head;
        const d = decodeVaultLogs(this.vault, logs);
        if (d.length) this.opts.onLogs(d);
      } else if (this.lastLogBlock === null) {
        this.lastLogBlock = head;
      }
    } catch (e) {
      this.st = { ...this.st, error: (e as Error).message.split('\n')[0]! };
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, this.opts.pollMs ?? 1_000);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
