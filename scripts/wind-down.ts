// wind-down.ts — `make wind-down` / `npm run wind-down`: the runbook's escape hatch.
// Without the backend: founder key + the bundle's own files only.
//   per open vendor job: delta_net = ledger usage (max accrued_net in events.jsonl, i.e. up to the
//   executor halt) - chain Settled net, capped at maxNet(held - paid) -> founder settle -> close
//   INFERENCE: settle(sum of known Kiln cost from llm.jsonl, ceil once) -> close
//   refund(budget - committed) anchored by SESSION_END (reason EXECUTOR_CRASH unless --reason)
// Records continue the SAME chain through commit(), so the bundle stays auditable. Idempotent:
// closed jobs are skipped and an existing SESSION_END means there is nothing to do.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi } from '../backend/abi.ts';
import { decodeVaultLogs, getLogsChunked, makePublicClient, readSnapshot } from '../backend/chain.ts';
import { Committer, type Sender } from '../backend/commit.ts';
import { chainCfg, loadCurrentDeployment, loadDotEnv, opt, runDir } from '../backend/config.ts';
import { costToMicro } from '../backend/kiln.ts';
import { loadRecordDir, type RecordDraft, type SessionEndReason } from '../backend/record.ts';
import { maxNet } from '../backend/rules.ts';
import { parseSpec } from '../backend/spec.ts';
import { ANVIL_AGENT, ANVIL_FOUNDER } from './deploy.ts';

loadDotEnv();
const c = chainCfg();
const dep = loadCurrentDeployment(c);
const dir = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1]! : runDir(c, dep.vault);
const reason = (process.argv.includes('--reason') ? process.argv[process.argv.indexOf('--reason') + 1] : 'EXECUTOR_CRASH') as SessionEndReason;

const { records } = await loadRecordDir(join(dir, 'records'));
if (records.some((r) => r.record?.kind === 'SESSION_END')) {
  console.log('wind-down: SESSION_END already recorded — nothing to do');
  process.exit(0);
}
const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const spec = parseSpec(new Uint8Array(readFileSync(join(dir, 'spec.json'))));
const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: c.rpcUrls } } });
const pc = makePublicClient(c.rpcUrls);
const mk = (pk: Hex): Sender => {
  const account = privateKeyToAccount(pk);
  return { account, wallet: createWalletClient({ account, chain, transport: http(c.rpcUrls[0]) }) };
};
const founder = mk(opt('FOUNDER_PK', c.name === 'anvil' ? ANVIL_FOUNDER : '') as Hex);
const agent = mk(opt('AGENT_PK', c.name === 'anvil' ? ANVIL_AGENT : '') as Hex);
if (founder.account.address.toLowerCase() !== dep.founder.toLowerCase()) throw new Error('FOUNDER_PK does not match vault.founder');
const committer = await Committer.open({ dir, vault: dep.vault, pc, chain, senders: { agent, founder } });

const header = (kind: RecordDraft['kind'], jobId: bigint | null, tx: RecordDraft['tx']) => ({
  kind,
  run_id: run.run_id,
  chain_id: c.id,
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
  await committer.commit({ ...header('CLOSE', id, { fn: 'close', from: 'founder', args: [id.toString()] }), body: { by: 'founder', reason: `wind-down: ${reason}`, unsettled_net: '0', snapshot: null } } as RecordDraft);
  txs++;
}
const snap = await readSnapshot(pc, dep.vault, { addresses: [] });
const refund = BigInt(snap.budget) - BigInt(snap.committed);
const o = await committer.commit({
  ...header('SESSION_END', null, { fn: 'refund', from: 'founder', args: [refund.toString()] }),
  body: { reason, refund: refund.toString(), snapshot: snap, totals: { vendor_net: [...settled.values()].reduce((a, b) => a + b, 0n).toString(), fees: '0', inference: llmCost.toString(), llm_calls: 0 } },
} as RecordDraft);
txs++;
if (o.status === 'MINED') writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, last_block: o.block.toString(), end_reason: reason, ended_at: new Date().toISOString() }, null, 2) + '\n');
console.log(`wind-down: ${txs} founder tx(s); refund ${refund} micro-USDC; run npm run audit -- ${dir}`);
