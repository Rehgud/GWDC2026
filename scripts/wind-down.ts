// wind-down.ts — `make wind-down` / `npm run wind-down`: the runbook's escape hatch.
// Without the backend: founder key + the bundle's own files only.
//   per open vendor job: delta_net = ledger usage (max accrued_net in events.jsonl, i.e. up to the
//   executor halt) - chain Settled net, capped at maxNet(held - paid) -> founder settle -> close
//   INFERENCE: settle(sum of known Kiln cost from llm.jsonl, ceil once) -> close
//   refund(budget - committed) anchored by SESSION_END (reason EXECUTOR_CRASH unless --reason)
// Records continue the SAME chain through commit(), so the bundle stays auditable. Idempotent:
// closed jobs are skipped. An existing SESSION_END means there is nothing to do ONLY once its
// refund is on chain; a SESSION_END that was recorded but never sent (crash / HALT SEND_FAILED
// between the ledger intent and the send) gets its own refund sent now, under the same record.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWalletClient, defineChain, http, type Chain, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi } from '../backend/abi.ts';
import { decodeVaultLogs, getLogsChunked, makePublicClient, readSnapshot } from '../backend/chain.ts';
import { Committer, type Sender } from '../backend/commit.ts';
import { chainCfg, loadCurrentDeployment, loadDotEnv, opt, runDir, type Deployment } from '../backend/config.ts';
import { costToMicro } from '../backend/kiln.ts';
import { loadRecordDir, type LoadedRecord, type RecordDraft, type SessionEndReason } from '../backend/record.ts';
import { maxNet } from '../backend/rules.ts';
import { parseSpec } from '../backend/spec.ts';
import { ANVIL_AGENT, ANVIL_FOUNDER } from './deploy.ts';

export type WindDownOpts = {
  dir: string;
  dep: Deployment;
  chainId: number;
  pc: PublicClient;
  chain: Chain;
  founder: Sender;
  agent: Sender;
  reason: SessionEndReason;
  log?: (line: string) => void;
};
export type WindDownResult = { status: 'NOTHING_TO_DO' | 'WOUND_DOWN' | 'REANCHORED'; txs: number; refund: bigint | null };

type LedgerLine = { rec?: string; status?: string; tx?: Hex };
const ledgerLines = (dir: string): LedgerLine[] =>
  existsSync(join(dir, 'ledger.jsonl'))
    ? readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as LedgerLine)
    : [];

export async function windDownBundle(o: WindDownOpts): Promise<WindDownResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (o.founder.account.address.toLowerCase() !== o.dep.founder.toLowerCase()) throw new Error('FOUNDER_PK does not match vault.founder');
  const { records } = await loadRecordDir(join(o.dir, 'records'));
  const run = JSON.parse(readFileSync(join(o.dir, 'run.json'), 'utf8'));
  const endIdx = records.findIndex((r) => r.record?.kind === 'SESSION_END');
  if (endIdx >= 0) return reanchorEnd(o, records, endIdx, run, log);

  const { dep, pc, dir } = o;
  const spec = parseSpec(new Uint8Array(readFileSync(join(dir, 'spec.json'))));
  const committer = await Committer.open({ dir, vault: dep.vault, pc, chain: o.chain, senders: { agent: o.agent, founder: o.founder } });
  const header = (kind: RecordDraft['kind'], jobId: bigint | null, tx: RecordDraft['tx']) => ({
    kind,
    run_id: run.run_id,
    chain_id: o.chainId,
    vault: dep.vault,
    spec_id: spec.spec_id,
    req_id: null,
    job_id: jobId === null ? null : jobId.toString(),
    at: new Date().toISOString(),
    tx,
  });

  // ledger usage per job (up to the executor halt) from events.jsonl
  const usage = new Map<string, bigint>();
  if (existsSync(join(dir, 'events.jsonl'))) {
    for (const l of readFileSync(join(dir, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(l);
      if (e.src === 'usage' && e.job_id !== undefined) {
        const v = BigInt(e.accrued_net);
        if (v > (usage.get(String(e.job_id)) ?? 0n)) usage.set(String(e.job_id), v);
      }
    }
  }
  // chain Settled net per job
  const logs = decodeVaultLogs(dep.vault, await getLogsChunked(pc, dep.vault, BigInt(dep.deployBlock), await pc.getBlockNumber()));
  const settled = new Map<string, bigint>();
  for (const l of logs) if (l.name === 'Settled') settled.set(l.jobId.toString(), (settled.get(l.jobId.toString()) ?? 0n) + l.net);
  const llmCost = existsSync(join(dir, 'llm.jsonl'))
    ? costToMicro(readFileSync(join(dir, 'llm.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((l) => (l.cost_known ? l.usage?.cost : null))).micro
    : 0n;

  const n = (await pc.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'jobCount' })) as bigint;
  const feeBps = BigInt(dep.feeBps);
  let txs = 0;
  for (let id = 0n; id < n; id++) {
    const j = (await pc.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'getJob', args: [id] })) as { vendor: Hex; held: bigint; paid: bigint; closed: boolean };
    if (j.closed) continue;
    const isInf = j.vendor.toLowerCase() === dep.inferencePayee.toLowerCase();
    const room = maxNet(j.held - j.paid, feeBps, isInf);
    // INFERENCE: known Kiln cost, never above the hold (room); vendor jobs: ledger usage - settled
    const want = isInf ? llmCost : (usage.get(id.toString()) ?? 0n) - (settled.get(id.toString()) ?? 0n);
    const delta = want > room ? room : want;
    if (delta > 0n) {
      await committer.commit({
        ...header('SETTLE', id, { fn: 'settle', from: 'founder', args: [id.toString(), delta.toString()] }),
        body: { by: 'founder', vendor: j.vendor, net: delta.toString(), accrued_net: (isInf ? llmCost : usage.get(id.toString()) ?? 0n).toString(), settled_before: (settled.get(id.toString()) ?? 0n).toString(), reason: 'wind_down', sim_seconds: '0', checkpoint: null, snapshot: null },
      } as RecordDraft);
      txs++;
    }
    // usage beyond the hold stays unpaid: recorded honestly (auditor WARN UNPAID_USAGE)
    const unsettled = want - delta; // delta = min(want, room): > 0 only when usage exceeded the hold
    await committer.commit({ ...header('CLOSE', id, { fn: 'close', from: 'founder', args: [id.toString()] }), body: { by: 'founder', reason: `wind-down: ${o.reason}`, unsettled_net: unsettled.toString(), snapshot: null } } as RecordDraft);
    txs++;
  }
  const snap = await readSnapshot(pc, dep.vault, { addresses: [] });
  const refund = BigInt(snap.budget) - BigInt(snap.committed);
  const out = await committer.commit({
    ...header('SESSION_END', null, { fn: 'refund', from: 'founder', args: [refund.toString()] }),
    body: { reason: o.reason, refund: refund.toString(), snapshot: snap, totals: { vendor_net: [...settled.values()].reduce((a, b) => a + b, 0n).toString(), fees: '0', inference: llmCost.toString(), llm_calls: 0 } },
  } as RecordDraft);
  txs++;
  if (out.status === 'MINED') writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, last_block: out.block.toString(), end_reason: o.reason, ended_at: new Date().toISOString() }, null, 2) + '\n');
  log(`wind-down: ${txs} founder tx(s); refund ${refund} micro-USDC; run npm run audit -- ${dir}`);
  return { status: 'WOUND_DOWN', txs, refund };
}

/** SESSION_END exists: done if its refund is on chain, otherwise send that refund (same record). */
async function reanchorEnd(o: WindDownOpts, records: LoadedRecord[], endIdx: number, run: Record<string, unknown>, log: (l: string) => void): Promise<WindDownResult> {
  const { dep, pc, dir } = o;
  const end = records[endIdx]!;
  const rec = end.hash.toLowerCase();
  const lines = ledgerLines(dir).filter((l) => l.rec?.toLowerCase() === rec);
  if (lines.some((l) => l.status === 'mined')) {
    log('wind-down: SESSION_END already recorded and anchored — nothing to do');
    return { status: 'NOTHING_TO_DO', txs: 0, refund: null };
  }
  const logs = decodeVaultLogs(dep.vault, await getLogsChunked(pc, dep.vault, BigInt(dep.deployBlock), await pc.getBlockNumber()));
  if (logs.some((l) => l.name === 'Refunded' && l.rec.toLowerCase() === rec)) {
    log('wind-down: SESSION_END refund is already on chain — nothing to do');
    return { status: 'NOTHING_TO_DO', txs: 0, refund: null };
  }
  // a refund that reached the node keeps the no-re-sign rule (pending, dropped or reverted alike):
  // only a SESSION_END whose tx never left this machine (intent / send_failed) is sent here
  const sent = lines.find((l) => l.status === 'sent' && l.tx);
  if (sent) throw new Error(`SESSION_END refund was sent as ${sent.tx} but is not mined; no re-send (wait, or replace it manually with the same nonce)`);
  if (endIdx !== records.length - 1) throw new Error(`records follow SESSION_END #${end.seq}; wind-down cannot repair this bundle`);
  const tx = end.record?.tx;
  if (!tx || tx.fn !== 'refund') throw new Error(`SESSION_END #${end.seq} has no refund intent`);
  const snap = await readSnapshot(pc, dep.vault, { addresses: [] });
  const refund = BigInt(snap.budget) - BigInt(snap.committed);
  if (refund.toString() !== tx.args[0]) throw new Error(`refund changed since SESSION_END #${end.seq} was recorded (${String(tx.args[0])} -> ${refund}); manual review`);
  const committer = await Committer.open({ dir, vault: dep.vault, pc, chain: o.chain, senders: { agent: o.agent, founder: o.founder } });
  const out = await committer.anchorTail();
  if (out.status !== 'MINED' || out.result.kind !== 'OK') throw new Error(`SESSION_END #${end.seq} refund: ${out.status}${out.status === 'MINED' ? ` ${out.result.kind}` : ''}`);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, last_block: out.block.toString(), end_reason: end.record!.body && (end.record!.body as { reason?: string }).reason, ended_at: new Date().toISOString() }, null, 2) + '\n');
  log(`wind-down: SESSION_END #${end.seq} was recorded but never anchored; sent its refund ${refund} micro-USDC (same record); run npm run audit -- ${dir}`);
  return { status: 'REANCHORED', txs: 1, refund };
}

// ------------------------------------------------------------------------------------- CLI
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadDotEnv();
  const c = chainCfg();
  const dep = loadCurrentDeployment(c);
  const argv = process.argv;
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1]! : runDir(c, dep.vault);
  const reason = (argv.includes('--reason') ? argv[argv.indexOf('--reason') + 1] : 'EXECUTOR_CRASH') as SessionEndReason;
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: c.rpcUrls } } });
  const mk = (pk: Hex): Sender => {
    const account = privateKeyToAccount(pk);
    return { account, wallet: createWalletClient({ account, chain, transport: http(c.rpcUrls[0]) }) };
  };
  try {
    await windDownBundle({
      dir,
      dep,
      chainId: c.id,
      pc: makePublicClient(c.rpcUrls),
      chain,
      founder: mk(opt('FOUNDER_PK', c.name === 'anvil' ? ANVIL_FOUNDER : '') as Hex),
      agent: mk(opt('AGENT_PK', c.name === 'anvil' ? ANVIL_AGENT : '') as Hex),
      reason,
    });
  } catch (e) {
    console.error(`wind-down: ${(e as Error).message}`);
    process.exit(1);
  }
}
