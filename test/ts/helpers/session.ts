// Test helper: a real Session on a fresh anvil vault with a scriptable stub LLM.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, type Hex, type PublicClient } from 'viem';
import { loadPrices } from '../../../backend/akash.ts';
import type { ChainCfg, Deployment } from '../../../backend/config.ts';
import { LOSS_CURVES } from '../../../backend/executor.ts';
import { LlmClient, type LlmConfig, type StubResponder } from '../../../backend/kiln.ts';
import { Session, type Scenario, type SessionConfig } from '../../../backend/session.ts';
import { specBytes } from '../../../backend/spec.ts';
import { ADDR, deployFixture, startAnvil, type Anvil, type Fixture } from './anvil.ts';

const HOSTS = { A: 'https://provider.h100.siamaidol.com:8443', B: 'https://provider.h100.ams.val.akash.pub:8443', C: 'https://provider.h100.wdc.hh.akash.pub:8443' };

export type TestSession = { session: Session; fx: Fixture; anvil: Anvil; dir: string; cleanup: () => Promise<void>; records: () => Promise<Record<string, any>[]>; ledger: () => Promise<Record<string, any>[]> };

export async function makeSession(o: {
  stub: StubResponder;
  scenario?: Partial<Scenario>;
  cfg?: Partial<SessionConfig>;
  llm?: Partial<LlmConfig>;
  wrapPc?: (pc: PublicClient) => PublicClient;
}): Promise<TestSession> {
  const anvil = await startAnvil(['--block-time', '1']);
  const fx = await deployFixture(anvil, { runway: 7200n });
  const dir = await mkdtemp(join(tmpdir(), 'cfo-sess-'));
  const bytes = specBytes({
    schema_version: 1,
    spec_id: `spec-test-${Date.now()}`,
    vault: fx.vault,
    chain_id: 31337,
    issued_at: '2026-09-29T00:00:00Z',
    purpose: 'Fine-tune a 7B support-ticket classifier to beat the baseline.',
    success_metric: 'eval loss < 1.20',
    allowed_gpu_types: ['H100'],
    job_cap_usd: '12.00',
    deadline: Number(fx.deadline),
  });
  await writeFile(join(dir, 'spec.json'), bytes);
  await writeFile(join(dir, 'spec.sig'), await fx.founder.account.signMessage!({ message: { raw: bytes } }));
  const scenario: Scenario = { name: 'test', lossAt: LOSS_CURVES.normal, maxCheckpoints: 4, stub: o.stub, ...o.scenario };
  const prices = await loadPrices({ pinned: (['A', 'B', 'C'] as const).map((l) => ({ label: l, address: ADDR[l] as Hex, hostUri: HOSTS[l] })), mode: 'snapshot' });
  const llm = new LlmClient({ mode: 'stub', model: 'qwen3-32b', callCap: 60, costCapMicro: 50_000n, stub: o.stub, jsonlPath: join(dir, 'llm.jsonl'), ...o.llm });
  const c: ChainCfg = { name: 'anvil', id: 31337, rpcUrls: [anvil.url], explorer: null, deploymentsDir: dir, runsDir: dir };
  const dep: Deployment = {
    schema_version: 1,
    label: 'test',
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
  const pc = o.wrapPc ? o.wrapPc(fx.pc) : fx.pc;
  const session = await Session.create({
    chainCfg: c,
    dep,
    dir,
    pc,
    chain: fx.chain,
    agent: fx.agent,
    founder: fx.founder,
    llm,
    prices,
    scenario,
    cfg: { runId: 'test', clockMult: 600, triggerTenths: 4n, deadlineMarginS: 15, inferenceHold: 50_000n, tickMs: 100, topupTimeoutMs: 60_000, gitSha: 'test', model: 'qwen3-32b', llmCallCap: 60, ...o.cfg },
  });
  return {
    session,
    fx,
    anvil,
    dir,
    cleanup: async () => {
      await anvil.stop();
      await rm(dir, { recursive: true, force: true });
    },
    records: async () => Promise.all((await readdir(join(dir, 'records'))).sort().map(async (f) => JSON.parse(await readFile(join(dir, 'records', f), 'utf8')))),
    ledger: async () => (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)),
  };
}
