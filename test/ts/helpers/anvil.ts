// Test helper: spawn anvil on a free port and deploy MockUSDC + AgentBudgetVault from forge
// artifacts (out/). Integration tests skip when anvil or out/ is missing.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { usdcAbi, vaultAbi } from '../../../backend/abi.ts';

export const KEYS = {
  founder: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  attacker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const;

export const ADDR = {
  A: '0xB58557467B587928c0444f6d15743738Fb19BA38',
  B: '0x59E64c085b6cc41a98Cf6FBF8AA0e64b9c65403C',
  C: '0x9850F9CEdE2711d0bC1FC57715dF742daE81Ca8E',
  INF: '0xb0978A57294f0fA5033e947eD48a1d439AdC36B8',
  FEE_TO: '0x193502baA5d98096E6681021c93eB1670640F4Bb',
  BAD: '0xBAd0000000000000000000000000000000000Bad',
} as const;

export function anvilAvailable(): boolean {
  return spawnSync('anvil', ['--version']).status === 0 && existsSync('out/AgentBudgetVault.sol/AgentBudgetVault.json');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export type Anvil = { url: string; port: number; proc: ChildProcess; stop: () => Promise<void> };

export async function startAnvil(extra: string[] = []): Promise<Anvil> {
  const port = await freePort();
  const proc = spawn('anvil', ['--port', String(port), '--silent', ...extra], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('anvil did not start');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url,
    port,
    proc,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill();
      }),
  };
}

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

export type Fixture = {
  anvil: Anvil;
  chain: Chain;
  pc: PublicClient;
  founder: { account: Account; wallet: WalletClient };
  agent: { account: Account; wallet: WalletClient };
  attacker: { account: Account; wallet: WalletClient };
  vault: Hex;
  usdc: Hex;
  deployBlock: bigint;
  deadline: bigint;
};

function artifact(name: string): { abi: unknown[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

/** Fresh vault: budget $20, maxHold $6, vendors A/B/C + INFERENCE allowed, deadline now+runway. */
export async function deployFixture(anvil: Anvil, opts: { budget?: bigint; maxHold?: bigint; runway?: bigint } = {}): Promise<Fixture> {
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
  const pc = createPublicClient({ chain, transport: http(anvil.url) }) as PublicClient;
  const mk = (pk: Hex) => {
    const account = privateKeyToAccount(pk);
    return { account, wallet: createWalletClient({ account, chain, transport: http(anvil.url) }) };
  };
  const founder = mk(KEYS.founder);
  const agent = mk(KEYS.agent);
  const attacker = mk(KEYS.attacker);
  const budget = opts.budget ?? 20_000_000n;
  const maxHold = opts.maxHold ?? 6_000_000n;

  const wait = async (h: Hex) => {
    const r = await pc.waitForTransactionReceipt({ hash: h, pollingInterval: 50 });
    if (r.status !== 'success') throw new Error(`setup tx failed ${h}`);
    return r;
  };
  const u = artifact('MockUSDC');
  const usdcR = await wait(await founder.wallet.deployContract({ abi: u.abi, bytecode: u.bytecode, account: founder.account, chain }));
  const usdc = usdcR.contractAddress!;
  const v = artifact('AgentBudgetVault');
  const vaultR = await wait(
    await founder.wallet.deployContract({ abi: v.abi, bytecode: v.bytecode, account: founder.account, chain, args: [usdc, agent.account.address, ADDR.FEE_TO, 300n, ADDR.INF] }),
  );
  const vault = vaultR.contractAddress!;
  const block = await pc.getBlock();
  const deadline = block.timestamp + (opts.runway ?? 3600n);
  const w = (address: Hex, abi: readonly unknown[], functionName: string, args: unknown[]) =>
    founder.wallet.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: founder.account, chain }).then(wait);
  await w(usdc, usdcAbi, 'mint', [founder.account.address, budget]);
  await w(usdc, usdcAbi, 'approve', [vault, budget]);
  await w(vault, vaultAbi, 'fund', [budget, deadline]);
  for (const a of [ADDR.A, ADDR.B, ADDR.C, ADDR.INF]) await w(vault, vaultAbi, 'setVendor', [a, true]);
  await w(vault, vaultAbi, 'setMaxHold', [maxHold]);
  return { anvil, chain, pc, founder, agent, attacker, vault, usdc, deployBlock: vaultR.blockNumber, deadline };
}
