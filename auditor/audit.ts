// audit.ts — third-party re-judgement of a CFO Agent bundle from the records + a public RPC (T9).
//
// Two stages so the judgement is a pure function (golden tests run without any RPC):
//   fetchChainData(rpc)  -> vault logs (1,000-block chunks), receipts (sender/status), block times,
//                           immutables. No historical eth_call: past state is REPLAYED from events.
//   judge(bundle, chain) -> PASS / FAIL / CANNOT_VERIFY with findings. Exit 0 / 1 / 2.
//
// Import boundary (R3-19, D3): rules / parse / record / spec / codes / chain (read side) /
// pricedoc / cost / prompts (pure renderers) only. Never executor, kiln, akash, session, commit
// or server (test/ts/audit.test.ts greps it).
//
// Checks (prompt.md §26):
//   1 recHash == keccak(file bytes)        2 prevHash chain linear, genesis first, SESSION_END last
//   3 founder signature over spec bytes     4 vault / chainId / spec_id binding, every record -> spec
//   5 every HoldOpened/ToppedUp has a gate PASS + CFO approve record (INFERENCE: chain-rule record)
//   6 gate rules recomputed == recorded; recorded chain inputs == replayed state at block N
//   7 paid vendor == job vendor, allow-listed at that moment (agent settles; founder bypass by D3)
//   8 logical-task job cap never exceeded (per spec, across migrations)
//   9 gross / fee: 3% floor per settle, INFERENCE 0
//  10 agent open/topUp/settle only while !paused and before the deadline (replayed state)
//  11 every backend Denied has its record; Denied after an approval = CHAIN_OVERRIDE (not FAIL)
//  12 Denied with no record = UNRECORDED_ATTEMPT (WARN, PASS kept); spend with no record = FAIL
//  13 the last record is anchored on-chain (else UNANCHORED_TAIL)
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getAddress, keccak256, type Hex, type Log, type PublicClient } from 'viem';
import { vaultAbi } from '../backend/abi.ts';
import { decodeVaultLogs, getLogsChunked, makePublicClient, type DecodedLog } from '../backend/chain.ts';
import { bytes32ToCode, describeBytes32, GATE_ORDER, NO_JOB, type DenyCode } from '../backend/codes.ts';
import { f1FromRaw, verdictFromRaw } from '../backend/parse.ts';
import { costToMicro } from '../backend/cost.ts';
import { parsePriceDoc } from '../backend/pricedoc.ts';
import { f2RequestLine } from '../backend/prompts.ts';
import { hashBytes, loadRecordDir, serialize, verifyChain, type DecisionRecord, type LlmEvidence, type LoadedRecord } from '../backend/record.ts';
import { chainRules, check, feeOf, gross, normGpu, specGross, type ChainView, type GateInput } from '../backend/rules.ts';
import { parseSpec, specJobCap, verifySpec, type WorkSpec } from '../backend/spec.ts';

// ------------------------------------------------------------------------------ types
export type Level = 'FAIL' | 'WARN' | 'INFO';
export type Finding = { level: Level; check: string; code: string; detail: string; seq?: number; tx?: string };

export type ChainData = {
  chainId: number;
  head: string;
  vault: Hex;
  codeExists: boolean;
  immutables: { founder: Hex; agent: Hex; feeTo: Hex; feeBps: string; inferencePayee: Hex; usdc: Hex };
  fromBlock: string;
  toBlock: string;
  logs: { address: Hex; topics: Hex[]; data: Hex; blockNumber: string; transactionHash: Hex; logIndex: number; transactionIndex: number }[];
  /** lower-case tx hash -> sender / block / status (null = not found on chain) */
  txs: Record<string, { from: Hex; blockNumber: string; status: 'success' | 'reverted' } | null>;
  /** block number (dec) -> timestamp (dec) */
  blocks: Record<string, string>;
};

export type LedgerLine = { status: string; rec?: Hex; tx?: Hex; fn?: string; result?: string; block?: string; seq?: number };

export type Bundle = {
  dir: string;
  run: { vault: Hex; chain_id: number; deploy_block: string; last_block?: string; flags?: Record<string, unknown> };
  specBytes: Uint8Array;
  specSig: Hex;
  records: LoadedRecord[];
  stray: string[];
  ledger: LedgerLine[];
  prices: Record<string, Uint8Array>;
};

export type AuditResult = {
  verdict: 'PASS' | 'FAIL' | 'CANNOT_VERIFY';
  exitCode: 0 | 1 | 2;
  findings: Finding[];
  failures: Finding[];
  warnings: Finding[];
  checks: { id: string; ok: boolean; summary: string }[];
  anchored: { upTo: number; total: number };
  unrecordedAttempts: { sender: Hex; code: string; tx: Hex; block: string }[];
  matching: { seq: number; kind: string; fn: string; from: string; tx: Hex | null; event: string; result: string }[];
};

export class CannotVerify extends Error {
  override name = 'CannotVerify';
}

// ------------------------------------------------------------------------------ bundle
export async function loadBundle(dir: string): Promise<Bundle> {
  const must = (f: string) => {
    if (!existsSync(join(dir, f))) throw new Error(`bundle: missing ${f}`);
    return join(dir, f);
  };
  const run = JSON.parse(await readFile(must('run.json'), 'utf8'));
  const specBytes = new Uint8Array(await readFile(must('spec.json')));
  const specSig = (await readFile(must('spec.sig'), 'utf8')).trim() as Hex;
  const { records, stray } = await loadRecordDir(must('records'));
  const ledger: LedgerLine[] = existsSync(join(dir, 'ledger.jsonl'))
    ? (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const prices: Record<string, Uint8Array> = {};
  if (existsSync(join(dir, 'prices'))) {
    for (const f of await readdir(join(dir, 'prices'))) prices[f] = new Uint8Array(await readFile(join(dir, 'prices', f)));
  }
  return { dir, run, specBytes, specSig, records, stray, ledger, prices };
}

/** Block numbers whose timestamps the judge needs (snapshot blocks referenced by records). */
export function snapshotBlocks(b: Bundle): string[] {
  const out = new Set<string>();
  for (const r of b.records) {
    const body = (r.record as { body?: Record<string, unknown> } | null)?.body;
    const gi = body?.gateInput as GateInput | undefined;
    const ri = body?.ruleInput as { chain?: ChainView } | undefined;
    if (gi?.chain?.blockNumber) out.add(gi.chain.blockNumber);
    if (ri?.chain?.blockNumber) out.add(ri.chain.blockNumber);
  }
  return [...out];
}

// ------------------------------------------------------------------------------ chain fetch
export async function fetchChainData(pc: PublicClient, o: { vault: Hex; fromBlock: bigint; toBlock: bigint; txHashes: Hex[]; blocks: string[] }): Promise<ChainData> {
  try {
    const chainId = await pc.getChainId();
    const head = await pc.getBlockNumber();
    if (head < o.toBlock) throw new CannotVerify(`RPC head ${head} is behind the bundle's last block ${o.toBlock}`);
    const code = await pc.getCode({ address: o.vault });
    const read = <T>(fn: string) => pc.readContract({ address: o.vault, abi: vaultAbi, functionName: fn as never }) as Promise<T>;
    const codeExists = !!code && code !== '0x';
    const immutables = codeExists
      ? {
          founder: await read<Hex>('founder'),
          agent: await read<Hex>('agent'),
          feeTo: await read<Hex>('feeTo'),
          feeBps: (await read<bigint>('feeBps')).toString(),
          inferencePayee: await read<Hex>('inferencePayee'),
          usdc: await read<Hex>('usdc'),
        }
      : { founder: '0x' as Hex, agent: '0x' as Hex, feeTo: '0x' as Hex, feeBps: '0', inferencePayee: '0x' as Hex, usdc: '0x' as Hex };
    const logs: Log[] = await getLogsChunked(pc, o.vault, o.fromBlock, o.toBlock);
    const hashes = new Set<string>([...logs.map((l) => l.transactionHash!.toLowerCase()), ...o.txHashes.map((h) => h.toLowerCase())]);
    const txs: ChainData['txs'] = {};
    for (const h of hashes) {
      try {
        const r = await pc.getTransactionReceipt({ hash: h as Hex });
        txs[h] = { from: getAddress(r.from), blockNumber: r.blockNumber.toString(), status: r.status };
      } catch (e) {
        if (/could not be found|not found/i.test((e as Error).message)) txs[h] = null;
        else throw e;
      }
    }
    const blockNums = new Set<string>([...logs.map((l) => l.blockNumber!.toString()), ...o.blocks]);
    const blocks: Record<string, string> = {};
    for (const n of blockNums) blocks[n] = (await pc.getBlock({ blockNumber: BigInt(n) })).timestamp.toString();
    return {
      chainId,
      head: head.toString(),
      vault: getAddress(o.vault),
      codeExists,
      immutables,
      fromBlock: o.fromBlock.toString(),
      toBlock: o.toBlock.toString(),
      logs: logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, blockNumber: l.blockNumber!.toString(), transactionHash: l.transactionHash!, logIndex: l.logIndex!, transactionIndex: l.transactionIndex! })),
      txs,
      blocks,
    };
  } catch (e) {
    if (e instanceof CannotVerify) throw e;
    throw new CannotVerify(`RPC: ${(e as Error).message.split('\n')[0]}`);
  }
}

// ------------------------------------------------------------------------------ replay
type RJob = { vendor: Hex; held: bigint; paid: bigint; closed: boolean };
type RState = { budget: bigint; committed: bigint; deadline: bigint; paused: boolean; maxHold: bigint; allowed: Map<string, boolean>; jobs: RJob[] };

const cloneState = (s: RState): RState => ({ ...s, allowed: new Map(s.allowed), jobs: s.jobs.map((j) => ({ ...j })) });

function applyEvent(s: RState, e: DecodedLog): string | null {
  switch (e.name) {
    case 'Funded':
      s.budget += e.amount;
      s.deadline = e.deadline;
      return null;
    case 'VendorSet':
      s.allowed.set(e.vendor.toLowerCase(), e.allowed);
      return null;
    case 'MaxHoldSet':
      s.maxHold = e.maxHold;
      return null;
    case 'PausedSet':
      s.paused = e.paused;
      return null;
    case 'HoldOpened':
      if (e.jobId !== BigInt(s.jobs.length)) return `HoldOpened jobId ${e.jobId} != next id ${s.jobs.length}`;
      s.jobs.push({ vendor: e.vendor, held: e.gross, paid: 0n, closed: false });
      s.committed += e.gross;
      return null;
    case 'ToppedUp': {
      const j = s.jobs[Number(e.jobId)];
      if (!j || j.closed) return `ToppedUp on unknown/closed job ${e.jobId}`;
      j.held += e.gross;
      s.committed += e.gross;
      return null;
    }
    case 'Settled': {
      const j = s.jobs[Number(e.jobId)];
      if (!j || j.closed) return `Settled on unknown/closed job ${e.jobId}`;
      j.paid += e.net + e.fee;
      if (j.paid > j.held) return `job ${e.jobId} paid ${j.paid} > held ${j.held}`;
      return null;
    }
    case 'Closed': {
      const j = s.jobs[Number(e.jobId)];
      if (!j || j.closed) return `Closed on unknown/closed job ${e.jobId}`;
      if (e.released !== j.held - j.paid) return `Closed released ${e.released} != held-paid ${j.held - j.paid}`;
      j.closed = true;
      s.committed -= e.released;
      return null;
    }
    case 'Refunded':
      if (e.amount > s.budget - s.committed) return `Refunded ${e.amount} > budget-committed`;
      s.budget -= e.amount;
      return null;
    case 'Denied':
      return null;
    default:
      return `unknown vault log`;
  }
}

// ------------------------------------------------------------------------------ judge
const lc = (a: string | null | undefined) => (a ?? '').toLowerCase();
const eqA = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);

export type JudgeOpts = { expectedVault: Hex; expectedChainId?: number; submission?: boolean };

export function judge(b: Bundle, chain: ChainData, o: JudgeOpts): AuditResult {
  const F: Finding[] = [];
  const add = (level: Level, check: string, code: string, detail: string, extra: { seq?: number; tx?: string } = {}) => F.push({ level, check, code, detail, ...extra });
  const recs = b.records;
  const bySeq = new Map<number, LoadedRecord>();
  const byHash = new Map<string, LoadedRecord>();
  for (const r of recs) {
    bySeq.set(r.seq, r);
    byHash.set(lc(r.nameHash), r);
  }
  const R = (r: LoadedRecord) => r.record as DecisionRecord;

  // ---- check 1 + 2: bytes and chain ------------------------------------------------------------
  const chainIssues = verifyChain(recs);
  for (const i of chainIssues) {
    if (i.kind === 'CRLF_SUSPECT') add('INFO', 'check1', 'CRLF_SUSPECT', `${i.file}: ${i.detail}`, { seq: i.seq });
    else add('FAIL', i.kind === 'HASH_MISMATCH' || i.kind === 'PARSE_ERROR' ? 'check1' : 'check2', i.kind, `${i.file}: ${i.detail}`, { seq: i.seq });
  }
  for (const s of b.stray) if (!s.startsWith('.tmp-')) add('FAIL', 'check1', 'STRAY_FILE', `records/${s} is not <seq6>-<hash>.json`);
  if (!recs.length) add('FAIL', 'check2', 'EMPTY', 'no records');
  const parsed = recs.filter((r) => r.record);
  const starts = parsed.filter((r) => R(r).kind === 'SESSION_START');
  const ends = parsed.filter((r) => R(r).kind === 'SESSION_END');
  if (starts.length !== 1 || starts[0]!.seq !== 0) add('FAIL', 'check2', 'GENESIS', `expected exactly one SESSION_START at seq 0, found ${starts.map((x) => x.seq).join(',') || 'none'}`);
  if (ends.length !== 1 || ends[0]!.seq !== recs[recs.length - 1]?.seq) add('FAIL', 'check2', 'SESSION_END', `expected exactly one SESSION_END as the last record, found ${ends.map((x) => x.seq).join(',') || 'none'}`);

  // ---- run.json / vault / chain ----------------------------------------------------------------
  const vault = getAddress(o.expectedVault);
  if (!eqA(b.run.vault, vault)) add('FAIL', 'check4', 'WRONG_VAULT', `run.json vault ${b.run.vault} != expected ${vault}`);
  if (!eqA(chain.vault, vault)) add('FAIL', 'check4', 'WRONG_VAULT', `chain data is for ${chain.vault}, expected ${vault}`);
  const chainId = o.expectedChainId ?? b.run.chain_id;
  if (chain.chainId !== chainId) add('FAIL', 'check4', 'WRONG_CHAIN', `RPC chainId ${chain.chainId} != ${chainId}`);
  if (!chain.codeExists) add('FAIL', 'check4', 'NO_CODE', `no contract at ${vault}`);
  const imm = chain.immutables;
  const feeBps = BigInt(imm.feeBps);
  if (imm.feeBps !== '300') add('FAIL', 'check9', 'FEE_BPS', `vault feeBps ${imm.feeBps} != designed 300 (3%)`);

  // ---- check 3 + 4: spec ----------------------------------------------------------------------
  let spec: WorkSpec | null = null;
  try {
    spec = parseSpec(b.specBytes);
  } catch (e) {
    add('FAIL', 'check3', 'SPEC_UNPARSEABLE', (e as Error).message);
  }
  // signature (sync-verified by the caller: see auditBundle) is carried in via chain-independent check below
  const genesis = starts[0] ? (R(starts[0]) as DecisionRecord<'SESSION_START'>) : null;
  if (genesis) {
    const gb = genesis.body;
    if (lc(gb.spec.hash) !== lc(hashBytes(b.specBytes))) add('FAIL', 'check3', 'SPEC_HASH', `SESSION_START.spec.hash != keccak(spec.json)`, { seq: 0 });
    if (lc(gb.spec.sig) !== lc(b.specSig)) add('FAIL', 'check3', 'SPEC_SIG_FILE', 'SESSION_START.spec.sig != spec.sig', { seq: 0 });
    const roles = gb.roles;
    for (const [k, v] of [['founder', imm.founder], ['agent', imm.agent], ['fee_to', imm.feeTo], ['inference_payee', imm.inferencePayee], ['usdc', imm.usdc]] as const) {
      if (!eqA((roles as Record<string, string>)[k], v)) add('FAIL', 'check4', 'ROLE_MISMATCH', `SESSION_START.roles.${k} ${(roles as Record<string, string>)[k]} != chain ${v}`, { seq: 0 });
    }
    if (o.submission && (gb.config.llm_mode !== 'kiln')) add('FAIL', 'submission', 'STUB_IN_SUBMISSION', `SESSION_START.config.llm_mode=${gb.config.llm_mode}`, { seq: 0 });
  }
  if (spec) {
    if (!eqA(spec.vault, vault)) add('FAIL', 'check4', 'SPEC_WRONG_VAULT', `spec.vault ${spec.vault} != ${vault}`);
    if (spec.chain_id !== chainId) add('FAIL', 'check4', 'SPEC_WRONG_CHAIN', `spec.chain_id ${spec.chain_id} != ${chainId}`);
    const jobSpecs = new Map<string, Set<string>>();
    for (const r of parsed) {
      const x = R(r);
      if (x.spec_id !== spec.spec_id) add('FAIL', 'check4', 'SPEC_REF', `record references spec_id ${x.spec_id}, bundle spec is ${spec.spec_id}`, { seq: r.seq });
      if (!eqA(x.vault, vault)) add('FAIL', 'check4', 'RECORD_WRONG_VAULT', `record vault ${x.vault}`, { seq: r.seq });
      if (x.chain_id !== chainId) add('FAIL', 'check4', 'RECORD_WRONG_CHAIN', `record chain ${x.chain_id}`, { seq: r.seq });
      if (x.job_id !== null) {
        const s = jobSpecs.get(x.job_id) ?? new Set<string>();
        s.add(x.spec_id);
        jobSpecs.set(x.job_id, s);
      }
    }
    for (const [j, s] of jobSpecs) if (s.size !== 1) add('FAIL', 'check4', 'JOB_MULTI_SPEC', `job ${j} references ${s.size} specs`);
  }
  // spec_id reuse inside one bundle (two sessions on one vault / a replayed genesis)
  const specIds = starts.map((r) => (R(r) as DecisionRecord<'SESSION_START'>).spec_id);
  if (new Set(specIds).size !== specIds.length) add('FAIL', 'check4', 'SPEC_REUSE', `spec_id used by ${specIds.length} sessions in this bundle`);

  // ---- prices -------------------------------------------------------------------------------------
  type MarketRow = { address: string; gpu: string; price: bigint; capacity: number; label: string };
  let market: MarketRow[] = [];
  if (genesis) {
    const pf = genesis.body.prices;
    const file = pf.file.replace(/^prices\//, '');
    const bytes = b.prices[file];
    if (!bytes) add('FAIL', 'check6', 'PRICE_FILE_MISSING', `bundle lacks ${pf.file}`, { seq: 0 });
    else if (lc(keccak256(bytes)) !== lc(pf.hash)) add('FAIL', 'check6', 'PRICE_FILE_HASH', `keccak(${pf.file}) != SESSION_START.prices.hash`, { seq: 0 });
    else {
      try {
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        const pinned = genesis.body.vendors.map((v) => ({ label: v.label, address: v.address, hostUri: v.host_uri }));
        const entries = parsePriceDoc(doc, pinned, genesis.body.vendors[0]?.gpu ?? 'H100');
        market = entries.map((e) => ({ address: lc(e.address), gpu: e.gpu, price: e.price, capacity: e.capacity, label: e.label }));
        for (const v of genesis.body.vendors) {
          const e = market.find((m) => m.address === lc(v.address));
          if (!e || e.price.toString() !== v.price || e.capacity !== v.capacity) add('FAIL', 'check6', 'PRICE_MISMATCH', `SESSION_START vendor ${v.label} does not match the price file`, { seq: 0 });
        }
      } catch (e) {
        add('FAIL', 'check6', 'PRICE_FILE_INVALID', (e as Error).message, { seq: 0 });
      }
    }
  }

  // ---- stub submission ---------------------------------------------------------------------------
  const evidences = (x: DecisionRecord): LlmEvidence[] => {
    const body = x.body as Record<string, unknown>;
    return (['f1', 'f2', 'f3'] as const).map((k) => body[k] as LlmEvidence | null | undefined).filter((e): e is LlmEvidence => !!e);
  };
  if (o.submission) {
    for (const r of parsed) {
      for (const ev of evidences(R(r))) {
        if (ev.llm_mode !== 'kiln' || (ev.gen_id ?? '').startsWith('stub-') || ev.attempts.some((a) => (a.gen_id ?? '').startsWith('stub-'))) {
          add('FAIL', 'submission', 'STUB_IN_SUBMISSION', `${ev.flow} evidence is from LLM_MODE=${ev.llm_mode} (gen ${ev.gen_id})`, { seq: r.seq });
        }
      }
    }
  }

  // ---- decode + order chain events --------------------------------------------------------------
  const decoded = decodeVaultLogs(vault, chain.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) })) as never).sort((a, b2) =>
    a.blockNumber === b2.blockNumber ? a.logIndex - b2.logIndex : a.blockNumber < b2.blockNumber ? -1 : 1,
  );
  const ts = (block: bigint): bigint | null => (chain.blocks[block.toString()] ? BigInt(chain.blocks[block.toString()]!) : null);
  const sender = (h: Hex) => chain.txs[lc(h)] ?? null;
  const role = (a: Hex | undefined) => (eqA(a, imm.agent) ? 'agent' : eqA(a, imm.founder) ? 'founder' : 'other');

  // state-at-block queries for check 6 (snapshot blocks)
  type Q = { block: bigint; seq: number };
  const queries: Q[] = [];
  for (const r of parsed) {
    const body = R(r).body as Record<string, unknown>;
    const gi = body.gateInput as GateInput | null | undefined;
    const ri = body.ruleInput as { chain: ChainView } | undefined;
    const bn = gi?.chain?.blockNumber ?? ri?.chain?.blockNumber;
    if (bn) queries.push({ block: BigInt(bn), seq: r.seq });
  }
  queries.sort((a, c) => (a.block < c.block ? -1 : a.block > c.block ? 1 : 0));
  const stateAt = new Map<number, RState>(); // seq -> replayed state at the end of its snapshot block

  const st: RState = { budget: 0n, committed: 0n, deadline: 0n, paused: false, maxHold: 0n, allowed: new Map(), jobs: [] };
  let qi = 0;
  const flushQueries = (upToBlock: bigint) => {
    while (qi < queries.length && queries[qi]!.block < upToBlock) {
      stateAt.set(queries[qi]!.seq, cloneState(st));
      qi++;
    }
  };

  const recRefs = new Map<string, DecodedLog[]>();
  const anchoredSeqs: { seq: number; ev: DecodedLog }[] = [];
  const unrecorded: AuditResult['unrecordedAttempts'] = [];
  const jobCap = spec ? specJobCap(spec) : 0n;
  const isInf = (v: Hex | null | undefined) => eqA(v, imm.inferencePayee);
  const taskGross = () => specGross(st.jobs.filter((j) => !isInf(j.vendor)));
  const chainDeniedFor = new Map<string, DecisionRecord<'CHAIN_DENIED'>>();
  for (const r of parsed) if (R(r).kind === 'CHAIN_DENIED') chainDeniedFor.set(lc((R(r) as DecisionRecord<'CHAIN_DENIED'>).body.ref), R(r) as DecisionRecord<'CHAIN_DENIED'>);

  // F1/F6 binding: a record authorizes ONLY the event(s) of its own tx (ledger mined, else sent,
  // else the first event carrying its hash). The rec is public: anyone holding the agent key can
  // replay it, and such a replay must count as unrecorded, never as gated.
  const ledgerByRec = new Map<string, LedgerLine[]>();
  for (const l of b.ledger) if (l.rec) ledgerByRec.set(lc(l.rec), [...(ledgerByRec.get(lc(l.rec)) ?? []), l]);
  const firstEventTx = new Map<string, string>();
  for (const ev of decoded) if ('rec' in ev && ev.rec && !firstEventTx.has(lc(ev.rec))) firstEventTx.set(lc(ev.rec), lc(ev.txHash));
  const ownerTx = (rec: string): string | undefined => {
    const lines = ledgerByRec.get(lc(rec)) ?? [];
    const t = lines.find((l) => l.status === 'mined' && l.tx)?.tx ?? lines.find((l) => l.status === 'sent' && l.tx)?.tx;
    return t ? lc(t) : firstEventTx.get(lc(rec));
  };

  // F7: the anchored checkpoint loss series of the task, in record order
  const lossSeries: string[] = [];
  const lossBefore = new Map<number, number>();
  let nanSeq = Infinity;
  for (const r of parsed) {
    lossBefore.set(r.seq, lossSeries.length);
    const x = R(r);
    if (x.kind === 'SETTLE' || x.kind === 'CHECKPOINT') {
      const ck = (x.body as { checkpoint?: { loss: unknown } | null }).checkpoint;
      if (ck) {
        lossSeries.push(JSON.stringify(ck.loss));
        if ((ck.loss === 'NaN' || ck.loss === 'Infinity' || ck.loss === '-Infinity') && r.seq < nanSeq) nanSeq = r.seq;
      }
    }
  }
  /** gate losses must be a prefix of the anchored series and have seen all but at most the newest anchored entry */
  const lossesConsistent = (seq: number, losses: unknown[]): boolean => {
    const g = losses.map((l) => JSON.stringify(l));
    if (g.length > lossSeries.length) return false;
    for (let i = 0; i < g.length; i++) if (g[i] !== lossSeries[i]) return false;
    return g.length >= (lossBefore.get(seq) ?? 0) - 1;
  };
  const labelOf = (addr: string | null) => genesis?.body.vendors.find((v) => eqA(v.address, addr))?.label ?? addr ?? '';
  const specText = new TextDecoder().decode(b.specBytes);
  const lastTopUpBlock = new Map<string, bigint>();
  let infOpens = 0;

  const checkTxIntent = (x: DecisionRecord, fn: string, args: (string | boolean)[], seq: number, txHash: Hex) => {
    if (!x.tx || x.tx.fn !== fn) return add('FAIL', 'check5', 'TX_FN_MISMATCH', `record tx ${x.tx?.fn ?? 'none'} but chain ran ${fn}`, { seq, tx: txHash });
    const a = x.tx.args.map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
    const e = args.map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
    if (JSON.stringify(a) !== JSON.stringify(e)) add('FAIL', 'check5', 'TX_ARGS_MISMATCH', `record args ${JSON.stringify(x.tx.args)} != chain ${JSON.stringify(args)}`, { seq, tx: txHash });
    const s = sender(txHash);
    if (s && x.tx.from !== role(s.from)) add('FAIL', 'check5', 'TX_SENDER_MISMATCH', `record says ${x.tx.from}, chain sender is ${role(s.from)} ${s.from}`, { seq, tx: txHash });
  };

  const verifyApproval = (x: DecisionRecord, seq: number, ev: DecodedLog & { name: 'HoldOpened' | 'ToppedUp' }) => {
    const kind = ev.name === 'HoldOpened' ? 'open' : 'topUp';
    const vendor = ev.name === 'HoldOpened' ? ev.vendor : (st.jobs[Number(ev.jobId)]?.vendor ?? null);
    if (isInf(vendor)) {
      // D2: INFERENCE open has no gate / F2, but a recorded chain-rule PASS; exactly one, fixed
      // $0.05, and no top-up path. Anything else is not covered by the exemption.
      if (ev.name === 'ToppedUp') return add('FAIL', 'check5', 'INFERENCE_TOPUP', `D2: the INFERENCE job has no top-up path (topUp ${ev.net})`, { seq, tx: ev.txHash });
      if (x.kind !== 'INFERENCE_OPEN') return add('FAIL', 'check5', 'UNGATED_SPEND', `${ev.name} to INFERENCE backed by a ${x.kind} record`, { seq, tx: ev.txHash });
      if (++infOpens > 1) add('FAIL', 'check5', 'INFERENCE_MULTI', 'D2: more than one INFERENCE hold in one session', { seq, tx: ev.txHash });
      const hold = genesis?.body.config.inference_hold;
      if (hold !== '50000' || ev.net.toString() !== hold) add('FAIL', 'check5', 'INFERENCE_HOLD', `D2: INFERENCE hold ${ev.net} != fixed $0.05 (config ${hold})`, { seq, tx: ev.txHash });
      const b2 = (x as DecisionRecord<'INFERENCE_OPEN'>).body;
      if (BigInt(b2.ruleInput.chain.blockNumber) >= ev.blockNumber) add('FAIL', 'check6', 'SNAPSHOT_ORDER', `rule snapshot block ${b2.ruleInput.chain.blockNumber} is not before the tx block ${ev.blockNumber}`, { seq, tx: ev.txHash });
      let re: string[] = ['<throw>'];
      try {
        re = chainRules(b2.ruleInput);
      } catch (e) {
        add('FAIL', 'check6', 'RULE_INPUT_INVALID', (e as Error).message, { seq });
      }
      if (b2.decision !== 'APPROVE' || re.length || JSON.stringify(re) !== JSON.stringify(b2.ruleResult)) add('FAIL', 'check6', 'CHAIN_RULES_MISMATCH', `recomputed ${JSON.stringify(re)} vs recorded ${JSON.stringify(b2.ruleResult)} (${b2.decision})`, { seq });
      if (!eqA(b2.ruleInput.request.vendor, vendor) || b2.ruleInput.request.amount !== ev.net.toString()) add('FAIL', 'check5', 'R_MISMATCH', 'ruleInput.request != on-chain open', { seq, tx: ev.txHash });
      checkTxIntent(x, 'open', [vendor!, ev.net.toString()], seq, ev.txHash);
      return;
    }
    if (x.kind !== 'REQUEST') return add('FAIL', 'check5', 'UNGATED_SPEND', `${ev.name} backed by a ${x.kind} record`, { seq, tx: ev.txHash });
    const body = (x as DecisionRecord<'REQUEST'>).body;
    if (body.decision !== 'APPROVE') add('FAIL', 'check5', 'SPEND_ON_DENY', `record decision ${body.decision} but ${ev.name} happened`, { seq, tx: ev.txHash });
    const gi = body.gateInput;
    if (!gi) return add('FAIL', 'check5', 'NO_GATE_INPUT', 'approved request without gateInput', { seq });
    let re: string[] = ['<throw>'];
    try {
      re = check(gi);
    } catch (e) {
      add('FAIL', 'check6', 'GATE_INPUT_INVALID', (e as Error).message, { seq });
    }
    if (re.length || JSON.stringify(re) !== JSON.stringify(body.gateResult)) add('FAIL', 'check6', 'GATE_MISMATCH', `recomputed ${JSON.stringify(re)} vs recorded ${JSON.stringify(body.gateResult)}`, { seq });
    if (body.gateInputHash && lc(body.gateInputHash) !== lc(hashBytes(serialize(gi.request)))) add('FAIL', 'check5', 'R_HASH', 'gateInputHash != keccak(R)', { seq });
    // CFO: exact approve re-derived from the raw text
    const f2 = body.f2;
    const v = f2 ? verdictFromRaw(f2.raw, f2.attempts.at(-1)?.finish_reason ?? null) : null;
    if (!f2 || !v || !v.ok) add('FAIL', 'check5', 'NO_CFO_APPROVAL', `no re-derivable F2 approve (${v && !v.ok ? v.code : 'missing'})`, { seq, tx: ev.txHash });
    // tx built from R only
    const r0 = gi.request;
    if (r0.kind !== kind || (kind === 'open' ? !eqA(r0.vendor, vendor) : r0.jobId !== ev.jobId.toString()) || r0.amount !== ev.net.toString()) {
      add('FAIL', 'check5', 'R_MISMATCH', `R ${JSON.stringify(r0)} != on-chain ${ev.name}(${kind === 'open' ? vendor : ev.jobId}, ${ev.net})`, { seq, tx: ev.txHash });
    }
    checkTxIntent(x, kind, kind === 'open' ? [vendor!, ev.net.toString()] : [ev.jobId.toString(), ev.net.toString()], seq, ev.txHash);
    // F4: the gate must have judged a snapshot taken BEFORE this tx, recent, with no other top-up
    // of the same job landing in between
    const snapBlock = BigInt(gi.chain.blockNumber);
    if (snapBlock >= ev.blockNumber) add('FAIL', 'check6', 'SNAPSHOT_ORDER', `gate snapshot block ${snapBlock} is not before the tx block ${ev.blockNumber}`, { seq, tx: ev.txHash });
    const txTs = ts(ev.blockNumber);
    if (txTs !== null && txTs - BigInt(gi.chain.blockTimestamp) > 180n) add('FAIL', 'check6', 'SNAPSHOT_STALE', `gate snapshot is ${txTs - BigInt(gi.chain.blockTimestamp)} s older than the tx (> 180 s)`, { seq, tx: ev.txHash });
    if (kind === 'topUp') {
      const last = lastTopUpBlock.get(ev.jobId.toString());
      if (last !== undefined && last > snapBlock) add('FAIL', 'check6', 'INTERVENING_TOPUP', `another top-up of job ${ev.jobId} landed at block ${last}, after the gate snapshot ${snapBlock}`, { seq, tx: ev.txHash });
    }
    // F5: R comes from F1's own words, and F2 reviewed exactly this R against the signed spec
    const f1p = body.f1 && !body.f1.code ? f1FromRaw(body.f1.raw, body.f1.attempts.at(-1)?.finish_reason ?? null) : null;
    if (!f1p || !f1p.ok) add('FAIL', 'check5', 'F1_NOT_BOUND', 'approval without a parseable F1 request', { seq });
    else {
      const p = f1p.value;
      if (r0.vendorLabel !== p.vendor || r0.gpu !== p.gpu || r0.amount !== p.amountMicro.toString()) add('FAIL', 'check5', 'F1_NOT_BOUND', `R ${r0.vendorLabel}/${r0.gpu}/${r0.amount} != F1 ${p.vendor}/${p.gpu}/${p.amountMicro}`, { seq });
      const br = body.request;
      if (!br || br.vendor !== p.vendor || br.gpu !== p.gpu || br.amount !== p.amount) add('FAIL', 'check5', 'F1_NOT_BOUND', 'body.request differs from the F1 raw answer', { seq });
    }
    if (f2) {
      const user = f2.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const line = f2RequestLine(kind, labelOf(r0.vendor), normGpu(r0.gpu), BigInt(r0.amount), gross(BigInt(r0.amount), feeBps, isInf(r0.vendor)));
      if (!user.includes(specText)) add('FAIL', 'check5', 'F2_NOT_BOUND', 'F2 did not review the signed spec text', { seq });
      if (!user.includes(line)) add('FAIL', 'check5', 'F2_NOT_BOUND', `F2 did not review this request (expected "${line}")`, { seq });
    }
    // F7: approvals must be computed on the anchored loss series, and never after a NaN
    if (!lossesConsistent(seq, gi.progress.losses)) add('FAIL', 'check6', 'LOSS_HISTORY_MISMATCH', `gate losses [${gi.progress.losses.join(', ')}] are not the anchored checkpoint series`, { seq });
    if (spec) {
      const sp = gi.spec;
      if (sp.spec_id !== spec.spec_id || sp.job_cap !== jobCap.toString() || sp.deadline !== String(spec.deadline) || JSON.stringify(sp.allowed_gpu_types) !== JSON.stringify(spec.allowed_gpu_types)) {
        add('FAIL', 'check6', 'SPEC_INPUT_MISMATCH', 'gateInput.spec differs from the signed spec', { seq });
      }
    }
  };

  const verifyGateChainInputs = (seq: number, chainView: ChainView, requestVendor: Hex | null, jobId: string | null, specGrossRecorded: string | null) => {
    const s = stateAt.get(seq);
    if (!s) return add('FAIL', 'check6', 'SNAPSHOT_BLOCK', `snapshot block ${chainView.blockNumber} outside the audited range`, { seq });
    const t = chain.blocks[chainView.blockNumber];
    const diffs: string[] = [];
    if (t !== undefined && t !== chainView.blockTimestamp) diffs.push(`blockTimestamp ${chainView.blockTimestamp} != ${t}`);
    if (chainView.paused !== s.paused) diffs.push(`paused ${chainView.paused} != ${s.paused}`);
    if (chainView.deadline !== s.deadline.toString()) diffs.push(`deadline ${chainView.deadline} != ${s.deadline}`);
    if (chainView.budget !== s.budget.toString()) diffs.push(`budget ${chainView.budget} != ${s.budget}`);
    if (chainView.committed !== s.committed.toString()) diffs.push(`committed ${chainView.committed} != ${s.committed}`);
    if (chainView.maxHold !== s.maxHold.toString()) diffs.push(`maxHold ${chainView.maxHold} != ${s.maxHold}`);
    if (chainView.feeBps !== imm.feeBps) diffs.push(`feeBps ${chainView.feeBps} != ${imm.feeBps}`);
    if (!eqA(chainView.inferencePayee, imm.inferencePayee)) diffs.push('inferencePayee');
    const allowed = requestVendor ? (s.allowed.get(lc(requestVendor)) ?? false) : false;
    if (chainView.vendorAllowed !== allowed) diffs.push(`vendorAllowed ${chainView.vendorAllowed} != ${allowed}`);
    if (jobId !== null) {
      const j = s.jobs[Number(jobId)];
      const cj = chainView.job;
      if (!j || !cj || !eqA(cj.vendor, j.vendor) || cj.held !== j.held.toString() || cj.paid !== j.paid.toString() || cj.closed !== j.closed) diffs.push(`job ${jobId} ${JSON.stringify(cj)} != replay`);
    }
    if (specGrossRecorded !== null) {
      const g = specGross(s.jobs.filter((j) => !isInf(j.vendor)));
      if (specGrossRecorded !== g.toString()) diffs.push(`ledger.spec_gross ${specGrossRecorded} != replay ${g}`);
    }
    if (diffs.length) add('FAIL', 'check6', 'CHAIN_INPUT_MISMATCH', diffs.join('; '), { seq });
  };

  // every REQUEST / INFERENCE_OPEN: recompute and compare inputs (whatever its outcome)
  const overridesSeen: { label: string; to: number }[] = [];
  const lossesSeen: string[] = [];
  const perRecordInputChecks = (r: LoadedRecord) => {
    const x = R(r);
    const body = x.body as Record<string, unknown>;
    for (const ov of (body.overrides as { field: string; to: unknown }[] | undefined) ?? []) {
      const m = /^akash\.capacity\.(\w+)$/.exec(ov.field);
      if (m && typeof ov.to === 'number') overridesSeen.push({ label: m[1]!, to: ov.to });
    }
    if (x.kind === 'SETTLE' || x.kind === 'CHECKPOINT') {
      const ck = (body as { checkpoint?: { loss: unknown } | null }).checkpoint;
      if (ck) lossesSeen.push(JSON.stringify(ck.loss));
    }
    if (x.kind === 'REQUEST') {
      const gi = (x as DecisionRecord<'REQUEST'>).body.gateInput;
      if (gi) {
        verifyGateChainInputs(r.seq, gi.chain, gi.request.vendor, gi.request.jobId, gi.ledger.spec_gross);
        // market input == price file entry (with any recorded capacity override)
        const e = market.find((m) => m.address === lc(gi.request.vendor) && m.gpu === gi.request.gpu.trim().toUpperCase());
        if (gi.market) {
          const ov = [...overridesSeen].reverse().find((z) => z.label === e?.label);
          const cap = ov ? ov.to : e?.capacity;
          if (!e || gi.market.price !== e.price.toString() || gi.market.capacity !== cap) add('FAIL', 'check6', 'MARKET_INPUT_MISMATCH', `gateInput.market ${JSON.stringify(gi.market)} vs price file`, { seq: r.seq });
        } else if (e) add('FAIL', 'check6', 'MARKET_INPUT_MISMATCH', 'gateInput.market is null but the price file has an entry', { seq: r.seq });
        if (gi.clockMult !== genesis?.body.config.clock_mult) add('FAIL', 'check6', 'CLOCK_MISMATCH', `clockMult ${gi.clockMult} != run config`, { seq: r.seq });
        if (!lossesConsistent(r.seq, gi.progress.losses)) add('FAIL', 'check6', 'LOSS_HISTORY_MISMATCH', `gate losses ${gi.progress.losses.length} are not a prefix of the anchored checkpoint series (${lossesSeen.length} anchored before)`, { seq: r.seq });
        // the recorded result must be what the rules give, whatever the decision
        try {
          const re = check(gi);
          if (JSON.stringify(re) !== JSON.stringify((x as DecisionRecord<'REQUEST'>).body.gateResult)) add('FAIL', 'check6', 'GATE_MISMATCH', `recomputed ${JSON.stringify(re)} vs recorded ${JSON.stringify((x as DecisionRecord<'REQUEST'>).body.gateResult)}`, { seq: r.seq });
        } catch (e) {
          add('FAIL', 'check6', 'GATE_INPUT_INVALID', (e as Error).message, { seq: r.seq });
        }
      }
    }
    if (x.kind === 'REQUEST') {
      // F8: F2 only after a gate PASS; every non-local deny is written on-chain
      const b2 = (x as DecisionRecord<'REQUEST'>).body;
      const gateDenied = !!b2.gateResult && b2.gateResult.length > 0;
      if (b2.f2 && gateDenied) add('FAIL', 'check6', 'F2_AFTER_GATE_DENY', 'F2 was called although the gate denied', { seq: r.seq });
      if (b2.f2 && !b2.gateResult) add('FAIL', 'check6', 'F2_WITHOUT_GATE_PASS', 'F2 ran without a recorded gate PASS', { seq: r.seq });
      if (b2.decision === 'DENY' && b2.code !== 'READ_FAILED' && x.tx?.fn !== 'recordDecision') add('FAIL', 'check11', 'DENY_NOT_ON_CHAIN', `DENY(${b2.code}) is not written on-chain with recordDecision`, { seq: r.seq });
    }
    if (x.kind === 'INFERENCE_OPEN') {
      const ri = (x as DecisionRecord<'INFERENCE_OPEN'>).body.ruleInput;
      verifyGateChainInputs(r.seq, ri.chain, ri.request.vendor, null, null);
    }
  };

  // F3: the latch and final denials, re-played over the records in order. After a final code
  // (rule, QWEN_DENIED, QWEN_UNPARSEABLE, LLM_CALL_CAP, or the chain overriding an approval) the
  // job gets no further request; after a transient code exactly one re-arm; operational codes
  // must be re-derivable from their own evidence.
  const TRANSIENT = new Set(['QWEN_UNAVAILABLE', 'READ_FAILED', 'TOPUP_TIMEOUT']);
  const requestHistory = () => {
    const latch = new Map<string, { state: 'none' | 'final' | 'transient'; rearmed: boolean }>();
    let deniedOpens: string[] = [];
    for (const r of parsed) {
      const x = R(r);
      if (x.kind !== 'REQUEST') continue;
      const b2 = (x as DecisionRecord<'REQUEST'>).body;
      const code = b2.code;
      // operational codes re-derived from evidence (no relabeling a Qwen deny as transient)
      const f2v = b2.f2 ? verdictFromRaw(b2.f2.raw, b2.f2.attempts.at(-1)?.finish_reason ?? null) : null;
      if (b2.decision === 'DENY') {
        if (code === 'READ_FAILED' && (b2.gateInput !== null || b2.f2 !== null)) add('FAIL', 'check11', 'RELABELED_DENY', 'READ_FAILED although the gate input was read / F2 ran', { seq: r.seq });
        if ((code === 'QWEN_UNAVAILABLE' || code === 'LLM_CALL_CAP') && b2.f1?.code !== code && b2.f2?.code !== code) add('FAIL', 'check11', 'RELABELED_DENY', `${code} not visible in the F1/F2 evidence`, { seq: r.seq });
        // covers TOPUP_TIMEOUT too: a timeout may follow an F2 approve (slow commit), never an F2 deny
        if (f2v && !f2v.ok && f2v.code === 'QWEN_DENIED' && code !== 'QWEN_DENIED') add('FAIL', 'check11', 'RELABELED_DENY', `F2 said deny but the record says ${code}`, { seq: r.seq });
      }
      const overridden = chainDeniedFor.has(lc(r.nameHash));
      const approved = b2.decision === 'APPROVE' && !overridden;
      const isTopUp = b2.gateInput ? b2.gateInput.request.kind === 'topUp' : x.job_id !== null;
      if (isTopUp && x.job_id !== null) {
        const L = latch.get(x.job_id) ?? { state: 'none' as const, rearmed: false };
        if (L.state === 'final') add('FAIL', 'check5', 'FINAL_DENY_REASKED', `job ${x.job_id} asked again after a final denial`, { seq: r.seq });
        else if (L.state === 'transient') {
          if (L.rearmed) add('FAIL', 'check5', 'REARM_TWICE', `job ${x.job_id} re-armed more than once (D4)`, { seq: r.seq });
          L.rearmed = true;
        }
        L.state = approved ? 'none' : code && TRANSIENT.has(code) ? 'transient' : 'final';
        latch.set(x.job_id, L);
      } else if (!isTopUp) {
        const v = b2.request?.vendor ?? '';
        if (approved) {
          if (deniedOpens.length >= 2) add('FAIL', 'check5', 'OPEN_RETRIED_BEYOND_ONCE', `open approved after ${deniedOpens.length} denied opens (one re-proposal allowed)`, { seq: r.seq });
          if (deniedOpens.includes(v)) add('FAIL', 'check5', 'REPROPOSE_SAME_VENDOR', `re-proposal to the vendor that was just denied (${v})`, { seq: r.seq });
          deniedOpens = [];
        } else {
          deniedOpens.push(v);
          if (deniedOpens.length > 2) add('FAIL', 'check5', 'OPEN_RETRIED_BEYOND_ONCE', `${deniedOpens.length} open attempts in a row`, { seq: r.seq });
        }
      }
    }
  };

  // walk records and events together: queries need replay state, replay order is chain order
  // (records' snapshot blocks are always <= their tx block, so a single pass over events works)
  for (const ev of decoded) {
    flushQueries(ev.blockNumber); // state at the end of every earlier snapshot block
    const s0 = cloneState(st);
    const tx = sender(ev.txHash);
    const from = tx?.from;
    const who = role(from);
    const blockTs = ts(ev.blockNumber);
    const rec = 'rec' in ev ? ev.rec : null;
    const known = rec ? byHash.get(lc(rec)) : undefined;
    // bound only when this event sits in the record's own tx; a foreign reuse of a public rec is
    // handled as unrecorded activity (UNGATED_SPEND / UNRECORDED_ATTEMPT / UNRECORDED_ACTION)
    const bound = !!known && ownerTx(rec!) === lc(ev.txHash);
    if (known && !bound) add('WARN', 'check11', 'DUPLICATE_REC_REF', `record #${known.seq}'s public hash reused by ${ev.name} in foreign tx ${ev.txHash} (${who} ${from})`, { seq: known.seq, tx: ev.txHash });
    const lr = bound ? known : undefined;
    const x = lr?.record ? R(lr) : null;
    if (rec && lr) {
      const list = recRefs.get(lc(rec)) ?? [];
      list.push(ev);
      recRefs.set(lc(rec), list);
      anchoredSeqs.push({ seq: lr.seq, ev });
    }
    if (!tx) add('FAIL', 'check11', 'RECEIPT_MISSING', `no receipt for ${ev.txHash}`, { tx: ev.txHash });

    switch (ev.name) {
      case 'HoldOpened':
      case 'ToppedUp':
      case 'Settled': {
        if (!x) {
          add('FAIL', 'check12', 'UNGATED_SPEND', `${ev.name} (job ${ev.jobId}, net ${ev.net}) from ${who} ${from} has no record (rec ${rec})`, { tx: ev.txHash });
          break;
        }
        if ((ev.name === 'HoldOpened' || ev.name === 'ToppedUp') && lr!.seq > nanSeq && !isInf(ev.name === 'HoldOpened' ? ev.vendor : s0.jobs[Number(ev.jobId)]?.vendor)) {
          add('FAIL', 'check6', 'SPEND_AFTER_NAN', `${ev.name} approved after the anchored NaN checkpoint #${nanSeq}`, { seq: lr!.seq, tx: ev.txHash });
        }
        // check 10: agent spends only while !paused and before the deadline (state before this tx)
        if (who === 'agent') {
          if (s0.paused) add('FAIL', 'check10', 'SPEND_WHILE_PAUSED', `${ev.name} by agent while paused`, { seq: lr!.seq, tx: ev.txHash });
          if (blockTs === null || blockTs >= s0.deadline) add('FAIL', 'check10', 'SPEND_AFTER_DEADLINE', `${ev.name} by agent at ${blockTs} >= deadline ${s0.deadline}`, { seq: lr!.seq, tx: ev.txHash });
        }
        if (ev.name === 'Settled') {
          const j = s0.jobs[Number(ev.jobId)];
          if (x.kind !== 'SETTLE') add('FAIL', 'check5', 'SETTLE_RECORD', `Settled backed by a ${x.kind} record`, { seq: lr!.seq, tx: ev.txHash });
          checkTxIntent(x, 'settle', [ev.jobId.toString(), ev.net.toString()], lr!.seq, ev.txHash);
          // check 7: payee == job.vendor, allow-listed at that moment for agent settles (D3)
          if (!j || !eqA(ev.vendor, j.vendor)) add('FAIL', 'check7', 'PAYEE_NOT_JOB_VENDOR', `paid ${ev.vendor} but job vendor is ${j?.vendor}`, { tx: ev.txHash });
          if (who === 'agent' && !(s0.allowed.get(lc(ev.vendor)) ?? false)) add('FAIL', 'check7', 'VENDOR_NOT_ALLOWED_AT_SETTLE', `${ev.vendor} not allow-listed when the agent settled`, { tx: ev.txHash });
          // check 9: fee floor per settle (split settles floor individually), INFERENCE 0
          if (ev.fee !== feeOf(ev.net, feeBps, isInf(ev.vendor))) add('FAIL', 'check9', 'FEE_MISMATCH', `fee ${ev.fee} != floor(${ev.net} * ${feeBps} / 1e4)`, { tx: ev.txHash });
        } else {
          verifyApproval(x, lr!.seq, ev);
          const v = ev.name === 'HoldOpened' ? ev.vendor : (s0.jobs[Number(ev.jobId)]?.vendor ?? null);
          if (ev.gross !== gross(ev.net, feeBps, isInf(v))) add('FAIL', 'check9', 'GROSS_MISMATCH', `gross ${ev.gross} != gross(${ev.net})`, { tx: ev.txHash });
          if (v && !(s0.allowed.get(lc(v)) ?? false)) add('FAIL', 'check7', 'VENDOR_NOT_ALLOWED_AT_HOLD', `${v} was not allow-listed`, { tx: ev.txHash });
        }
        break;
      }
      case 'Denied': {
        const code = bytes32ToCode(ev.code);
        const label = describeBytes32(ev.code);
        if (!x) {
          unrecorded.push({ sender: from ?? ('0x' as Hex), code: label, tx: ev.txHash, block: ev.blockNumber.toString() });
          add('WARN', 'check12', 'UNRECORDED_ATTEMPT', `sender=${from} (${who}) code=${label} tx=${ev.txHash} block=${ev.blockNumber}`, { tx: ev.txHash });
          break;
        }
        if (!ev.enforced) {
          // recordDecision: the recorded DENY must re-derive to this exact code
          const body = x.body as Record<string, unknown>;
          if ((x.kind !== 'REQUEST' && x.kind !== 'INFERENCE_OPEN') || body.decision !== 'DENY' || body.code !== code) {
            add('FAIL', 'check11', 'DENY_RECORD_MISMATCH', `Denied(${label}) but record ${x.kind} decision ${String(body.decision)} code ${String(body.code)}`, { seq: lr!.seq, tx: ev.txHash });
            break;
          }
          const jid = ev.jobId === NO_JOB ? NO_JOB.toString() : ev.jobId.toString();
          checkTxIntent(x, 'recordDecision', [jid, label], lr!.seq, ev.txHash);
          if (x.kind === 'INFERENCE_OPEN') {
            const re = chainRules((x as DecisionRecord<'INFERENCE_OPEN'>).body.ruleInput);
            if (re[0] !== code) add('FAIL', 'check6', 'DENY_NOT_REDERIVED', `chainRules -> ${re[0] ?? 'PASS'} != ${label}`, { seq: lr!.seq });
          } else {
            const b2 = (x as DecisionRecord<'REQUEST'>).body;
            const gateCode = (GATE_ORDER as readonly string[]).includes(label);
            if (gateCode) {
              let re: string[] = [];
              try {
                re = b2.gateInput ? check(b2.gateInput) : [];
              } catch {
                re = ['<invalid>'];
              }
              if (re[0] !== code) add('FAIL', 'check6', 'DENY_NOT_REDERIVED', `gate recomputes ${re[0] ?? 'PASS'} != ${label}`, { seq: lr!.seq });
            } else if (code === 'QWEN_DENIED' || code === 'QWEN_UNPARSEABLE') {
              const fromF2 = b2.f2 ? verdictFromRaw(b2.f2.raw, b2.f2.attempts.at(-1)?.finish_reason ?? null) : null;
              const fromF1 = b2.f1 && !b2.f1.code ? f1FromRaw(b2.f1.raw, b2.f1.attempts.at(-1)?.finish_reason ?? null) : null;
              const ok = (fromF2 && !fromF2.ok && fromF2.code === code) || (code === 'QWEN_UNPARSEABLE' && ((fromF1 && !fromF1.ok) || b2.f1?.code === code || b2.f2?.code === code));
              if (!ok) add('FAIL', 'check5', 'QWEN_DENY_NOT_REDERIVED', `${label} cannot be re-derived from the raw Qwen text`, { seq: lr!.seq });
            } else {
              add('INFO', 'check11', 'OPERATIONAL_DENY', `${label}`, { seq: lr!.seq }); // evidence re-derived in the request history check
            }
          }
        } else {
          // the chain overrode an approval (STOP / deadline / race): CHAIN_OVERRIDE, not FAIL
          const cd = chainDeniedFor.get(lc(rec!));
          add('INFO', 'check11', 'CHAIN_OVERRIDE', `${x.kind}#${lr!.seq} approved off-chain, chain answered Denied(${label})`, { seq: lr!.seq, tx: ev.txHash });
          if (!cd) add('WARN', 'check11', 'CHAIN_DENIED_RECORD_MISSING', `no CHAIN_DENIED record references #${lr!.seq}`, { seq: lr!.seq });
          else if (cd.body.code !== label) add('FAIL', 'check11', 'CHAIN_DENIED_CODE', `CHAIN_DENIED code ${cd.body.code} != ${label}`, { seq: lr!.seq });
        }
        break;
      }
      case 'Closed':
        if (!x) add('WARN', 'check12', 'UNRECORDED_ACTION', `Closed(job ${ev.jobId}) by ${who} ${from} without a record`, { tx: ev.txHash });
        else {
          if (x.kind !== 'CLOSE') add('FAIL', 'check11', 'CLOSE_RECORD', `Closed backed by ${x.kind}`, { seq: lr!.seq });
          else if ((x as DecisionRecord<'CLOSE'>).body.unsettled_net !== '0') add('WARN', 'check11', 'UNPAID_USAGE', `job ${ev.jobId} closed with ${(x as DecisionRecord<'CLOSE'>).body.unsettled_net} micro-USD of ledger usage unsettled`, { seq: lr!.seq, tx: ev.txHash });
          checkTxIntent(x, 'close', [ev.jobId.toString()], lr!.seq, ev.txHash);
        }
        break;
      case 'Refunded':
        if (!x) add('WARN', 'check12', 'UNRECORDED_ACTION', `Refunded ${ev.amount} by ${who} without a record`, { tx: ev.txHash });
        else {
          if (x.kind !== 'SESSION_END') add('FAIL', 'check11', 'REFUND_RECORD', `Refunded backed by ${x.kind}`, { seq: lr!.seq });
          checkTxIntent(x, 'refund', [ev.amount.toString()], lr!.seq, ev.txHash);
          if (ev.amount !== s0.budget - s0.committed) add('INFO', 'check11', 'PARTIAL_REFUND', `refund ${ev.amount} < budget-committed ${s0.budget - s0.committed}`, { tx: ev.txHash });
        }
        break;
      case 'PausedSet':
        if (!x) add('WARN', 'check12', 'UNRECORDED_ACTION', `PausedSet(${ev.paused}) by ${who} without a record`, { tx: ev.txHash });
        else checkTxIntent(x, 'setPaused', [ev.paused], lr!.seq, ev.txHash);
        break;
      case 'Funded':
      case 'VendorSet':
      case 'MaxHoldSet':
        if (who !== 'founder') add('FAIL', 'check4', 'ADMIN_NOT_FOUNDER', `${ev.name} from ${from}`, { tx: ev.txHash });
        break;
      default:
        add('FAIL', 'check11', 'UNKNOWN_EVENT', `undecodable vault log in ${ev.txHash}`, { tx: ev.txHash });
    }

    const err = applyEvent(st, ev);
    if (err) add('FAIL', 'check9', 'REPLAY', err, { tx: ev.txHash });
    if (ev.name === 'ToppedUp') lastTopUpBlock.set(ev.jobId.toString(), ev.blockNumber);
    if (st.committed > st.budget) add('FAIL', 'check9', 'OVER_BUDGET', `committed ${st.committed} > budget ${st.budget}`, { tx: ev.txHash });
    // check 8: the logical task's cumulative gross never exceeds the signed job cap
    if ((ev.name === 'HoldOpened' || ev.name === 'ToppedUp') && spec && !isInf(ev.name === 'HoldOpened' ? ev.vendor : st.jobs[Number(ev.jobId)]?.vendor)) {
      const g = taskGross();
      if (g > jobCap) add('FAIL', 'check8', 'OVER_JOB_CAP', `task gross ${g} > job cap ${jobCap}`, { tx: ev.txHash });
    }
  }
  flushQueries(BigInt(chain.toBlock) + 1n);
  for (const r of parsed) perRecordInputChecks(r);
  requestHistory();
  // INFERENCE settles vs the recorded Kiln cost evidence (calls of cancelled flows are not in
  // records, hence WARN): the chain already caps the settle at the $0.05 hold
  {
    const costs: (string | null)[] = [];
    for (const r of parsed) for (const e of evidences(R(r))) for (const a of e.attempts) costs.push(a.cost_known && a.usage ? a.usage.cost : null);
    const evidenced = costToMicro(costs).micro;
    const settledInf = decoded.filter((e) => e.name === 'Settled' && isInf(e.vendor)).reduce((a2, e) => a2 + (e as { net: bigint }).net, 0n);
    if (settledInf > evidenced) add('WARN', 'check9', 'INFERENCE_COST_UNEVIDENCED', `INFERENCE settled ${settledInf} micro-USD > recorded Kiln cost ${evidenced}`);
  }

  // ---- duplicates, 1:1 matching, anchoring ------------------------------------------------------
  for (const [rec, evs] of recRefs) if (evs.length > 1) add('WARN', 'check11', 'DUPLICATE_REC_REF', `rec ${rec} referenced by ${evs.length} events (${evs.map((e) => e.name).join(',')})`);
  const matching: AuditResult['matching'] = [];
  const REC_FNS = new Set(['open', 'topUp', 'settle', 'close', 'recordDecision', 'setPaused', 'refund']);
  for (const r of parsed) {
    const x = R(r);
    if (!x.tx) continue;
    const evs = recRefs.get(lc(r.nameHash)) ?? [];
    const mined = (ledgerByRec.get(lc(r.nameHash)) ?? []).find((l) => l.status === 'mined');
    if (REC_FNS.has(x.tx.fn)) {
      if (!evs.length) {
        // a record whose tx never produced a vault event moved no money; the ledger says why.
        // intent only = the backend died before sending (I7 crash) -> WARN; sent but not on chain
        // = dropped/unconfirmed -> WARN; mined with a success result but no event = contradiction
        const lines = ledgerByRec.get(lc(r.nameHash)) ?? [];
        const sent = lines.find((l) => l.status === 'sent');
        const onChain = sent?.tx ? chain.txs[lc(sent.tx)] : null;
        const minedOnChain = mined?.tx ? chain.txs[lc(mined.tx)] : null;
        if (minedOnChain?.status === 'reverted' || (!mined && onChain?.status === 'reverted')) add('WARN', 'check13', 'TX_REVERTED', `${x.kind}#${r.seq} ${x.tx.fn} reverted on-chain`, { seq: r.seq, tx: mined?.tx ?? sent?.tx });
        else if (!sent && !mined) add('WARN', 'check13', 'TX_NEVER_SENT', `${x.kind}#${r.seq} ${x.tx.fn} was recorded but never sent (backend stopped before sending); nothing moved`, { seq: r.seq });
        else if (sent && !mined && !onChain) add('WARN', 'check13', 'TX_NOT_MINED', `${x.kind}#${r.seq} ${x.tx.fn} sent as ${sent.tx} but not on chain (HALT UNCONFIRMED / dropped); nothing moved`, { seq: r.seq, tx: sent.tx });
        else add('FAIL', 'check13', 'TX_NOT_ON_CHAIN', `${x.kind}#${r.seq} authorizes ${x.tx.fn} but no vault event carries its hash`, { seq: r.seq, tx: mined?.tx ?? sent?.tx });
      }
      matching.push({ seq: r.seq, kind: x.kind, fn: x.tx.fn, from: x.tx.from, tx: evs[0]?.txHash ?? mined?.tx ?? null, event: evs.map((e) => e.name).join(',') || '-', result: evs.some((e) => e.name === 'Denied' && e.enforced) ? 'CHAIN_OVERRIDE' : evs.length ? 'OK' : 'MISSING' });
    } else {
      // setVendor / setMaxHold carry no rec: matched by the ledger tx hash
      const h = mined?.tx;
      const onChain = h ? decoded.filter((e) => lc(e.txHash) === lc(h)) : [];
      const ok = onChain.some((e) => (x.tx!.fn === 'setVendor' ? e.name === 'VendorSet' && eqA(e.vendor, String(x.tx!.args[0])) && e.allowed === x.tx!.args[1] : e.name === 'MaxHoldSet' && e.maxHold.toString() === x.tx!.args[0]));
      if (!ok) add('FAIL', 'check13', 'ADMIN_TX_MISMATCH', `${x.kind}#${r.seq} ${x.tx.fn} not found on-chain by its ledger tx hash`, { seq: r.seq, tx: h });
      matching.push({ seq: r.seq, kind: x.kind, fn: x.tx.fn, from: x.tx.from, tx: h ?? null, event: onChain.map((e) => e.name).join(',') || '-', result: ok ? 'OK' : 'MISSING' });
    }
  }
  // every tx in the ledger must still be on chain (reorg / fabricated hash)
  for (const l of b.ledger) {
    if (l.status !== 'mined' || !l.tx) continue;
    const t = chain.txs[lc(l.tx)];
    if (!t) add('FAIL', 'check13', 'LEDGER_TX_MISSING', `ledger tx ${l.tx} not found on chain`, { tx: l.tx });
    else if (l.block && t.blockNumber !== String(l.block)) add('FAIL', 'check13', 'LEDGER_TX_BLOCK', `ledger block ${l.block} != chain ${t.blockNumber}`, { tx: l.tx });
  }
  // anchoring: order of anchored records on chain follows seq; the last record is anchored
  let prev = -1;
  for (const a of anchoredSeqs) {
    if (a.seq < prev) add('FAIL', 'check13', 'RECORD_ORDER', `record #${a.seq} anchored after #${prev}`, { seq: a.seq, tx: a.ev.txHash });
    prev = Math.max(prev, a.seq);
  }
  const upTo = anchoredSeqs.reduce((m, a) => Math.max(m, a.seq), -1);
  const total = recs.length ? recs[recs.length - 1]!.seq : -1;
  if (upTo < total) add('FAIL', 'check13', 'UNANCHORED_TAIL', `anchored up to #${upTo} / ${total}: records after the last on-chain anchor are unverifiable`);

  // ---- verdict ------------------------------------------------------------------------------------
  const failures = F.filter((f) => f.level === 'FAIL');
  const warnings = F.filter((f) => f.level === 'WARN');
  const ids = ['check1', 'check2', 'check3', 'check4', 'check5', 'check6', 'check7', 'check8', 'check9', 'check10', 'check11', 'check12', 'check13', 'submission'];
  const NAMES: Record<string, string> = {
    check1: 'recHash == keccak(record bytes)',
    check2: 'prevHash chain / genesis / SESSION_END last',
    check3: 'founder signature over the spec bytes',
    check4: 'vault / chainId / spec_id binding',
    check5: 'every hold/top-up had gate PASS + CFO approve (INFERENCE: chain rules)',
    check6: 'gate rules + recorded chain inputs re-derived',
    check7: 'paid vendor == job vendor, allow-listed',
    check8: 'task job cap (per spec, across jobs)',
    check9: 'gross / fee / budget arithmetic',
    check10: 'agent spends before deadline, not paused',
    check11: 'Denied events matched to records',
    check12: 'unrecorded chain activity classified',
    check13: 'tx <-> record 1:1, last record anchored',
    submission: 'no stub LLM evidence (--submission)',
  };
  const checks = ids.filter((id) => id !== 'submission' || o.submission).map((id) => ({ id, ok: !failures.some((f) => f.check === id), summary: NAMES[id]! }));
  const verdict = failures.length ? 'FAIL' : 'PASS';
  return { verdict, exitCode: failures.length ? 1 : 0, findings: F, failures, warnings, checks, anchored: { upTo, total }, unrecordedAttempts: unrecorded, matching };
}

// ------------------------------------------------------------------------------ one call
export type AuditBundleOpts = { dir: string; rpcUrl: string | string[]; expectedVault: string; expectedChainId?: number; submission?: boolean; pc?: PublicClient; chainOut?: (c: ChainData) => void };

export async function auditBundle(o: AuditBundleOpts): Promise<AuditResult> {
  const b = await loadBundle(o.dir);
  const pc = o.pc ?? makePublicClient(Array.isArray(o.rpcUrl) ? o.rpcUrl : [o.rpcUrl], { timeoutMs: 15_000 });
  let chain: ChainData;
  try {
    const fromBlock = BigInt(b.run.deploy_block);
    const toBlock = b.run.last_block ? BigInt(b.run.last_block) : await pc.getBlockNumber();
    chain = await fetchChainData(pc, {
      vault: getAddress(o.expectedVault),
      fromBlock,
      toBlock,
      txHashes: b.ledger.filter((l) => l.status === 'mined' && l.tx).map((l) => l.tx!),
      blocks: snapshotBlocks(b),
    });
  } catch (e) {
    const f: Finding = { level: 'FAIL', check: 'rpc', code: 'CANNOT_VERIFY', detail: (e as Error).message };
    return { verdict: 'CANNOT_VERIFY', exitCode: 2, findings: [f], failures: [f], warnings: [], checks: [], anchored: { upTo: -1, total: -1 }, unrecordedAttempts: [], matching: [] };
  }
  o.chainOut?.(chain);
  const res = judge(b, chain, { expectedVault: getAddress(o.expectedVault), expectedChainId: o.expectedChainId, submission: o.submission });
  // check 3 needs signature recovery (async): fold it in here
  const sig = await verifySpec({ bytes: b.specBytes, sig: b.specSig, founder: chain.immutables.founder, vault: getAddress(o.expectedVault), chainId: o.expectedChainId ?? b.run.chain_id });
  return mergeSpecCheck(res, sig.issues);
}

/** Fold the (async) signature verification into a judge() result. */
export function mergeSpecCheck(res: AuditResult, issues: { issue: string; detail: string }[]): AuditResult {
  const extra: Finding[] = issues.filter((i) => i.issue === 'SPEC_BAD_SIGNATURE' || i.issue === 'SPEC_UNPARSEABLE').map((i) => ({ level: 'FAIL' as const, check: 'check3', code: i.issue, detail: i.detail }));
  if (!extra.length) return res;
  const findings = [...res.findings, ...extra];
  const failures = findings.filter((f) => f.level === 'FAIL');
  return { ...res, findings, failures, verdict: 'FAIL', exitCode: 1, checks: res.checks.map((c) => (c.id === 'check3' ? { ...c, ok: false } : c)) };
}

export async function judgeWithSig(b: Bundle, chain: ChainData, o: JudgeOpts): Promise<AuditResult> {
  const res = judge(b, chain, o);
  const sig = await verifySpec({ bytes: b.specBytes, sig: b.specSig, founder: chain.immutables.founder, vault: getAddress(o.expectedVault), chainId: o.expectedChainId ?? b.run.chain_id });
  return mergeSpecCheck(res, sig.issues);
}

export type { DenyCode };
