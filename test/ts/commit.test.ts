// T5 integration on anvil: commit() queue, classify, CHAIN_DENIED, receipt timeout (I4),
// concurrent intents (I8), same-block STOP race (I2), pre-send JobClosed, record HALT, ChainFork,
// chain watcher staleness / READ_FAILED.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { vaultAbi } from '../../backend/abi.ts';
import { ChainWatcher, decodeVaultLogs, readSnapshot, ReadFailedError } from '../../backend/chain.ts';
import { Committer, HaltError, type CommitDeps } from '../../backend/commit.ts';
import { loadRecordDir, verifyChain, writeRecordFile, type RecordDraft, type TxIntent } from '../../backend/record.ts';
import { ADDR, anvilAvailable, deployFixture, rpc, startAnvil, type Anvil, type Fixture } from './helpers/anvil.ts';

const SKIP = !anvilAvailable() && 'anvil or forge out/ not available';

function draft(kind: RecordDraft['kind'], tx: TxIntent | null, job_id: string | null = null, i = 0): RecordDraft {
  const base = { run_id: 'run-t', chain_id: 31337, vault: '0x0000000000000000000000000000000000000001' as Hex, spec_id: 'spec-t', req_id: `req-${i}`, job_id, at: '2026-09-29T00:00:00.000Z', tx };
  switch (kind) {
    case 'REQUEST':
      return {
        ...base,
        kind,
        body: { trigger: 'start', attempt: 0, snapshot: null, f1: null, request: null, gateInput: null, gateInputHash: null, gateResult: [], f2: null, verdict: null, decision: tx?.fn === 'recordDecision' ? 'DENY' : 'APPROVE', code: tx?.fn === 'recordDecision' ? 'QWEN_DENIED' : null, overrides: [] },
      };
    case 'SETTLE':
      return { ...base, kind, body: { by: tx!.from, vendor: ADDR.B, net: String(tx!.args[1]), accrued_net: '0', settled_before: '0', reason: 'checkpoint', sim_seconds: '0', checkpoint: null, snapshot: null } };
    case 'CLOSE':
      return { ...base, kind, body: { by: tx!.from, reason: 'test', unsettled_net: '0', snapshot: null } };
    case 'PAUSE':
      return { ...base, kind, body: { reason: 'test', snapshot: null } };
    default:
      return { ...base, kind: 'CHECKPOINT', tx: null, body: { checkpoint: { idx: i, loss: 1, accrued_net: '0', sim_seconds: '0' }, note: 'test' } };
  }
}

describe('commit() on anvil', { skip: SKIP }, () => {
  let anvil: Anvil;
  let fx: Fixture;
  let dir: string;
  const tmpDirs: string[] = [];

  async function newCommitter(extra: Partial<CommitDeps> = {}): Promise<{ c: Committer; dir: string }> {
    const d = await mkdtemp(join(tmpdir(), 'cfo-commit-'));
    tmpDirs.push(d);
    const c = await Committer.open({ dir: d, vault: fx.vault, pc: fx.pc, chain: fx.chain, senders: { agent: fx.agent, founder: fx.founder }, receiptTimeoutMs: 20_000, ...extra });
    return { c, dir: d };
  }
  const ledger = async (d: string) => (await readFile(join(d, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

  before(async () => {
    anvil = await startAnvil();
    fx = await deployFixture(anvil);
  });
  after(async () => {
    await anvil?.stop();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  test('open: record -> intent -> sent -> mined OK; HoldOpened carries the record hash', async () => {
    const { c, dir: d } = await newCommitter();
    dir = d;
    const out = await c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.B, '2560000'] }));
    assert.equal(out.status, 'MINED');
    if (out.status !== 'MINED') return;
    assert.equal(out.result.kind, 'OK');
    assert.equal(out.result.kind === 'OK' && out.result.jobId, 0n);
    const rc = await fx.pc.getTransactionReceipt({ hash: out.txHash });
    const ev = decodeVaultLogs(fx.vault, rc.logs).find((l) => l.name === 'HoldOpened');
    assert.equal(ev && 'rec' in ev && ev.rec, out.rec.hash);
    const bytes = await readFile(join(d, 'records', out.rec.file));
    assert.equal(keccak256(bytes), out.rec.hash);
    assert.deepEqual((await ledger(d)).map((l) => l.status), ['intent', 'sent', 'mined']);
  });

  test('I8: 20 concurrent intents -> one linear prevHash chain, consecutive nonces', async () => {
    const { c, dir: d } = await newCommitter();
    const n0 = await fx.pc.getTransactionCount({ address: fx.agent.account.address });
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        c.commit(i % 2 ? draft('CHECKPOINT', null, '0', i) : draft('REQUEST', { fn: 'recordDecision', from: 'agent', args: ['0', 'QWEN_DENIED'] }, null, i)),
      ),
    );
    assert.equal(outs.length, 20);
    const { records } = await loadRecordDir(join(d, 'records'));
    assert.equal(records.length, 20);
    assert.deepEqual(verifyChain(records), []);
    assert.deepEqual(records.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i));
    const n1 = await fx.pc.getTransactionCount({ address: fx.agent.account.address });
    assert.equal(n1 - n0, 10);
  });

  test('approved topUp after STOP -> Denied(PAUSED) on-chain -> CHAIN_DENIED record chained right after', async () => {
    const { c, dir: d } = await newCommitter();
    const o = await c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.B, '1000000'] }));
    assert.equal(o.status, 'MINED');
    const jobId = o.status === 'MINED' && o.result.kind === 'OK' ? o.result.jobId!.toString() : '';
    await c.commit(draft('PAUSE', { fn: 'setPaused', from: 'founder', args: [true] }));
    const t = await c.commit(draft('REQUEST', { fn: 'topUp', from: 'agent', args: [jobId, '1000000'] }, jobId));
    assert.equal(t.status, 'MINED');
    if (t.status !== 'MINED') return;
    assert.deepEqual([t.result.kind, t.result.kind === 'DENIED' && t.result.code], ['DENIED', 'PAUSED']);
    assert.ok(t.chainDenied);
    const { records } = await loadRecordDir(join(d, 'records'));
    const cd = records.find((r) => r.record?.kind === 'CHAIN_DENIED')!;
    assert.equal(cd.record!.prevHash, t.rec.hash, 'CHAIN_DENIED prev = the approved record');
    assert.equal((cd.record as { body: { ref: Hex } }).body.ref, t.rec.hash);
    assert.deepEqual(verifyChain(records), []);
    // founder close still works while paused; agent close would be Denied(PAUSED) -> CHAIN_DENIED
    const ac = await c.commit(draft('CLOSE', { fn: 'close', from: 'agent', args: [jobId] }, jobId));
    assert.equal(ac.status === 'MINED' && ac.result.kind, 'DENIED');
    const fc = await c.commit(draft('CLOSE', { fn: 'close', from: 'founder', args: [jobId] }, jobId));
    assert.equal(fc.status === 'MINED' && fc.result.kind, 'OK');
    await c.commit(draft('PAUSE', { fn: 'setPaused', from: 'founder', args: [false] }));
  });

  test('pre-send JobClosed on a closed job -> ALREADY_CLOSED, no record, no tx', async () => {
    const { c, dir: d } = await newCommitter();
    const o = await c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.B, '1000'] }));
    const jobId = o.status === 'MINED' && o.result.kind === 'OK' ? o.result.jobId!.toString() : '';
    await c.commit(draft('CLOSE', { fn: 'close', from: 'agent', args: [jobId] }, jobId));
    const before = (await readdir(join(d, 'records'))).length;
    const n0 = await fx.pc.getTransactionCount({ address: fx.agent.account.address });
    const again = await c.commit(draft('CLOSE', { fn: 'close', from: 'agent', args: [jobId] }, jobId));
    assert.equal(again.status, 'ALREADY_CLOSED');
    assert.equal((await readdir(join(d, 'records'))).length, before);
    assert.equal(await fx.pc.getTransactionCount({ address: fx.agent.account.address }), n0);
    assert.equal(c.isHalted(), null);
  });

  test('record read-back mismatch -> HALT RECORD_INTEGRITY, no tx sent, queue halted', async () => {
    // emulate writeRecordFile's read-back verification failing (RecordIntegrityError)
    const failing: typeof writeRecordFile = async () => {
      throw new Error('read-back hash mismatch');
    };
    const { c } = await newCommitter({ writeRecord: failing });
    const n0 = await fx.pc.getTransactionCount({ address: fx.agent.account.address });
    await assert.rejects(c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.B, '1000'] })), (e: unknown) => e instanceof HaltError && e.reason === 'RECORD_INTEGRITY');
    assert.equal(await fx.pc.getTransactionCount({ address: fx.agent.account.address }), n0, 'no tx after a record failure');
    await assert.rejects(c.commit(draft('CHECKPOINT', null)), HaltError);
  });

  test('ChainFork: a broken records dir refuses to start', async () => {
    const { c, dir: d } = await newCommitter();
    await c.commit(draft('CHECKPOINT', null, '0', 0));
    await c.commit(draft('CHECKPOINT', null, '0', 1));
    const files = (await readdir(join(d, 'records'))).sort();
    const p = join(d, 'records', files[0]!);
    const t = (await readFile(p, 'utf8')).replace('"note":"test"', '"note":"TEST"');
    await writeFile(p, t);
    await assert.rejects(Committer.open({ dir: d, vault: fx.vault, pc: fx.pc, chain: fx.chain, senders: { agent: fx.agent } }), (e: unknown) => e instanceof HaltError && e.reason === 'CHAIN_FORK');
  });

  test('restart continues the same chain from the head on disk', async () => {
    const { c, dir: d } = await newCommitter();
    await c.commit(draft('CHECKPOINT', null, '0', 0));
    const c2 = await Committer.open({ dir: d, vault: fx.vault, pc: fx.pc, chain: fx.chain, senders: { agent: fx.agent } });
    assert.deepEqual(c2.getHead(), c.getHead());
    await c2.commit(draft('CHECKPOINT', null, '0', 1));
    assert.deepEqual(verifyChain((await loadRecordDir(join(d, 'records'))).records), []);
  });

  test('chain watcher: pinned snapshot, stale after 10 s without a read, READ_FAILED on a dead RPC', async () => {
    const snap = await readSnapshot(fx.pc, fx.vault, { addresses: [ADDR.A, ADDR.BAD], jobIds: [0n, 99n] });
    assert.equal(snap.vendorAllowed[ADDR.A.toLowerCase()], true);
    assert.equal(snap.vendorAllowed[ADDR.BAD.toLowerCase()], false);
    assert.equal(snap.jobs.length, 1, 'ids beyond jobCount are skipped');
    let now = 1_000_000;
    const w = new ChainWatcher(fx.pc, fx.vault, [ADDR.A], { now: () => now });
    assert.equal(w.stale(), true, 'no snapshot yet = stale');
    await w.fresh();
    assert.equal(w.stale(), false);
    now += 10_001;
    assert.equal(w.stale(), true, 'STALE_CHAIN after 10 s');
    const dead = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0, timeout: 500 }) }) as PublicClient;
    const w2 = new ChainWatcher(dead, fx.vault, [ADDR.A]);
    await assert.rejects(w2.fresh(), ReadFailedError);
  });
});

// Separate anvil with automine OFF for the mining-order cases.
describe('commit() with manual mining', { skip: SKIP }, () => {
  let anvil: Anvil;
  let fx: Fixture;
  const tmpDirs: string[] = [];
  before(async () => {
    anvil = await startAnvil();
    fx = await deployFixture(anvil);
    await rpc(anvil.url, 'evm_setAutomine', [false]);
  });
  after(async () => {
    await anvil?.stop();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  async function committer(timeoutMs: number) {
    const d = await mkdtemp(join(tmpdir(), 'cfo-commit-m-'));
    tmpDirs.push(d);
    return { d, c: await Committer.open({ dir: d, vault: fx.vault, pc: fx.pc, chain: fx.chain, senders: { agent: fx.agent, founder: fx.founder }, receiptTimeoutMs: timeoutMs }) };
  }
  const mineSoon = (ms: number) => setTimeout(() => void rpc(anvil.url, 'evm_mine'), ms);

  test('I2: STOP and an approved open land in the same block (pause first) -> CHAIN_DENIED, not resumed', async () => {
    const { c } = await committer(20_000);
    // founder pauses directly (not via this committer), then the backend's approved open is sent
    const pauseHash = await fx.founder.wallet.writeContract({ address: fx.vault, abi: vaultAbi, functionName: 'setPaused', args: [true, keccak256(toHex('stop'))], account: fx.founder.account, chain: fx.chain });
    mineSoon(1500);
    const out = await c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.B, '1000000'] }));
    const pr = await fx.pc.getTransactionReceipt({ hash: pauseHash });
    assert.equal(out.status, 'MINED');
    if (out.status !== 'MINED') return;
    assert.equal(out.block, pr.blockNumber, 'same block');
    assert.deepEqual([out.result.kind, out.result.kind === 'DENIED' && out.result.code], ['DENIED', 'PAUSED']);
    assert.ok(out.chainDenied, 'CHAIN_DENIED recorded');
    assert.equal(await fx.pc.readContract({ address: fx.vault, abi: vaultAbi, functionName: 'jobCount' }), 0n, 'no ghost job');
    const unpause = await fx.founder.wallet.writeContract({ address: fx.vault, abi: vaultAbi, functionName: 'setPaused', args: [false, keccak256(toHex('go'))], account: fx.founder.account, chain: fx.chain });
    await rpc(anvil.url, 'evm_mine');
    await fx.pc.waitForTransactionReceipt({ hash: unpause });
  });

  test('I4: receipt timeout -> one re-query -> HALT UNCONFIRMED, no re-send, no double spend', async () => {
    const { c, d } = await committer(1_500);
    const n0 = await fx.pc.getTransactionCount({ address: fx.agent.account.address, blockTag: 'pending' });
    await assert.rejects(c.commit(draft('REQUEST', { fn: 'open', from: 'agent', args: [ADDR.C, '1000000'] })), (e: unknown) => e instanceof HaltError && e.reason === 'UNCONFIRMED');
    const n1 = await fx.pc.getTransactionCount({ address: fx.agent.account.address, blockTag: 'pending' });
    assert.equal(n1 - n0, 1, 'exactly one tx was ever signed');
    const lines = (await readFile(join(d, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.status), ['intent', 'sent', 'unconfirmed']);
    await assert.rejects(c.commit(draft('CHECKPOINT', null)), HaltError, 'queue stays halted');
    // mining later yields exactly one HoldOpened for that tx
    await rpc(anvil.url, 'evm_mine');
    const rc = await fx.pc.getTransactionReceipt({ hash: lines[1].tx });
    assert.equal(decodeVaultLogs(fx.vault, rc.logs).filter((l) => l.name === 'HoldOpened').length, 1);
  });
});
