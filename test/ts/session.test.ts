// Session integration on anvil (stub LLM, CLOCK_MULT=600):
//   B10 F3 failing never blocks the close (receipt says "설명 생성 실패", close is mined first)
//   B11 windDown is idempotent: a second call sends 0 txs; vendor net paid == ledger usage
//   the full honest run audits PASS
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, type Hex } from 'viem';
import { usdcAbi } from '../../backend/abi.ts';
import { loadPrices } from '../../backend/akash.ts';
import type { ChainCfg, Deployment } from '../../backend/config.ts';
import { LOSS_CURVES } from '../../backend/executor.ts';
import { LlmClient } from '../../backend/kiln.ts';
import { contextStub } from '../../backend/scenarios.ts';
import { Session, type Scenario } from '../../backend/session.ts';
import { specBytes } from '../../backend/spec.ts';
import { auditBundle } from '../../auditor/audit.ts';
import { ADDR, anvilAvailable, deployFixture, startAnvil, type Anvil, type Fixture } from './helpers/anvil.ts';

const SKIP = !anvilAvailable() && 'anvil or forge out/ not available';
const HOSTS = { A: 'https://provider.h100.siamaidol.com:8443', B: 'https://provider.h100.ams.val.akash.pub:8443', C: 'https://provider.h100.wdc.hh.akash.pub:8443' };

describe('session on anvil', { skip: SKIP }, () => {
  let anvil: Anvil;
  let fx: Fixture;
  let dir: string;
  let session: Session;
  let reason = '';

  before(async () => {
    anvil = await startAnvil(['--block-time', '1']);
    fx = await deployFixture(anvil, { runway: 7200n });
    dir = await mkdtemp(join(tmpdir(), 'cfo-session-'));
    const spec = {
      schema_version: 1 as const,
      spec_id: 'spec-session-test',
      vault: fx.vault,
      chain_id: 31337,
      issued_at: '2026-09-29T00:00:00Z',
      purpose: 'Fine-tune a 7B support-ticket classifier to beat the baseline.',
      success_metric: 'eval loss < 1.20',
      allowed_gpu_types: ['H100'],
      job_cap_usd: '12.00',
      deadline: Number(fx.deadline),
    };
    const bytes = specBytes(spec);
    await writeFile(join(dir, 'spec.json'), bytes);
    await writeFile(join(dir, 'spec.sig'), await fx.founder.account.signMessage!({ message: { raw: bytes } }));
    const base = contextStub();
    const scenario: Scenario = {
      name: 'session-test',
      lossAt: LOSS_CURVES.normal,
      maxCheckpoints: 2,
      // F3 always fails with HTTP 500 (after the one allowed retry)
      stub: (flow, msgs) => (flow === 'F3' ? { content: null, http: 500 } : base(flow, msgs)),
    };
    const prices = await loadPrices({ pinned: (['A', 'B', 'C'] as const).map((l) => ({ label: l, address: ADDR[l] as Hex, hostUri: HOSTS[l] })), mode: 'snapshot' });
    const llm = new LlmClient({ mode: 'stub', model: 'qwen3-32b', callCap: 60, costCapMicro: 50_000n, stub: scenario.stub, jsonlPath: join(dir, 'llm.jsonl'), sleep: async () => {} });
    const c: ChainCfg = { name: 'anvil', id: 31337, rpcUrls: [anvil.url], explorer: null, deploymentsDir: dir, runsDir: dir };
    const dep: Deployment = {
      schema_version: 1,
      label: 'session-test',
      chainId: 31337,
      vault: getAddress(fx.vault),
      usdc: fx.usdc,
      founder: fx.founder.account.address,
      agent: fx.agent.account.address,
      feeTo: ADDR.FEE_TO as Hex,
      inferencePayee: ADDR.INF as Hex,
      vendors: (['A', 'B', 'C'] as const).map((l) => ({ label: l, address: ADDR[l] as Hex })),
      budget: '20000000',
      maxHold: '6000000',
      feeBps: 300,
      deadline: Number(fx.deadline),
      deployBlock: fx.deployBlock.toString(),
      setupTxs: [],
      gitSha: 'test',
      deployedAt: new Date().toISOString(),
      retired: null,
    };
    session = await Session.create({
      chainCfg: c,
      dep,
      dir,
      pc: fx.pc,
      chain: fx.chain,
      agent: fx.agent,
      founder: fx.founder,
      llm,
      prices,
      scenario,
      cfg: { runId: 'session-test', clockMult: 600, triggerTenths: 4n, deadlineMarginS: 15, inferenceHold: 50_000n, tickMs: 100, topupTimeoutMs: 60_000, gitSha: 'test', model: 'qwen3-32b', llmCallCap: 60 },
    });
    reason = await session.run();
  });

  after(async () => {
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const records = async () =>
    Promise.all((await readdir(join(dir, 'records'))).sort().map(async (f) => JSON.parse(await readFile(join(dir, 'records', f), 'utf8'))));
  const ledger = async () => (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

  test('the run completes', () => {
    assert.equal(reason, 'COMPLETED');
  });

  test('B10 F3 failure: the vendor close is mined, the receipt says "설명 생성 실패", nothing blocks', async () => {
    const recs = await records();
    const close = recs.find((r) => r.kind === 'CLOSE' && r.body.by === 'agent' && r.body.reason === 'success metric reached');
    const receipt = recs.find((r) => r.kind === 'RECEIPT');
    assert.ok(close && receipt);
    assert.ok(receipt.seq > close.seq, 'receipt is written after the close');
    assert.match(receipt.body.text, /^설명 생성 실패\(QWEN_UNAVAILABLE\)/);
    assert.equal(receipt.body.f3.code, 'QWEN_UNAVAILABLE');
    assert.equal(receipt.body.f3.attempts.length, 2, '5xx retried exactly once');
    const l = await ledger();
    assert.ok(l.some((x) => x.seq === close.seq && x.status === 'mined' && x.result === 'OK'), 'the close tx was mined OK');
  });

  test('B11 windDown twice: the second call sends 0 txs; vendor paid net == ledger usage', async () => {
    const before = (await ledger()).length;
    const n0 = await fx.pc.getTransactionCount({ address: fx.founder.account.address });
    const a0 = await fx.pc.getTransactionCount({ address: fx.agent.account.address });
    assert.equal(await session.windDown('WIND_DOWN'), 'COMPLETED');
    assert.equal((await ledger()).length, before);
    assert.equal(await fx.pc.getTransactionCount({ address: fx.founder.account.address }), n0);
    assert.equal(await fx.pc.getTransactionCount({ address: fx.agent.account.address }), a0);
    const st = session.state();
    const job = st.jobs[0]!;
    assert.equal(job.accruedNet, job.settledNet, 'every unit of ledger usage was settled');
    const vendorBal = (await fx.pc.readContract({ address: fx.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [ADDR.B as Hex] })) as bigint;
    assert.equal(vendorBal.toString(), job.settledNet, 'vendor received exactly the settled net');
  });

  test('the honest run audits PASS against the live chain', async () => {
    const r = await auditBundle({ dir, rpcUrl: anvil.url, expectedVault: fx.vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
  });
});
