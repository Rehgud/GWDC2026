// preflight.ts — assert the deployed vault is exactly what the run expects (T4, 운영 체크리스트 5).
// Prints every item by name; exit 1 if any fails. Usage: npm run preflight [-- --min-runway 30]
import { createPublicClient, formatEther, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { usdcAbi, vaultAbi } from '../backend/abi.ts';
import { chainCfg, loadCurrentDeployment, loadDotEnv, opt, type ChainCfg, type Deployment } from '../backend/config.ts';

export type PreflightItem = { name: string; ok: boolean; detail: string };
export type PreflightResult = { ok: boolean; items: PreflightItem[] };

const MIN_AGENT_ETH = 5_000_000_000_000_000n; // 0.005 ETH: below this the backend refuses to start
const MIN_FOUNDER_ETH = 2_000_000_000_000_000n;
const EXPECTED_TXS = 200n;
const GAS_PER_TX = 150_000n;

export async function runPreflight(c: ChainCfg, dep: Deployment, opts: { minRunwaySeconds?: number } = {}): Promise<PreflightResult> {
  const items: PreflightItem[] = [];
  const add = (name: string, ok: boolean, detail: string) => items.push({ name, ok, detail });
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const pc = createPublicClient({ transport: http(c.rpcUrls[0]) });
  const v = { address: dep.vault, abi: vaultAbi } as const;

  try {
    const chainId = await pc.getChainId();
    add('rpc.chainId', chainId === c.id, `rpc ${chainId}, expected ${c.id}`);
    const block = await pc.getBlock();
    const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    // anvil without --block-time only mines on demand, so its head can look old
    add('rpc.headFresh', c.name === 'anvil' || Math.abs(age) < 30, `block ${block.number} age ${age}s`);

    const [vaultCode, usdcCode] = await Promise.all([pc.getCode({ address: dep.vault }), pc.getCode({ address: dep.usdc })]);
    add('code.vault', !!vaultCode && vaultCode !== '0x', dep.vault);
    add('code.usdc', !!usdcCode && usdcCode !== '0x', dep.usdc);

    const read = <T>(functionName: string, args: unknown[] = []) =>
      pc.readContract({ ...v, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [founder, agent, feeTo, feeBps, inf, usdc, budget, committed, deadline, paused, maxHold, jobCount] = await Promise.all([
      read<Hex>('founder'),
      read<Hex>('agent'),
      read<Hex>('feeTo'),
      read<bigint>('feeBps'),
      read<Hex>('inferencePayee'),
      read<Hex>('usdc'),
      read<bigint>('budget'),
      read<bigint>('committed'),
      read<bigint>('deadline'),
      read<boolean>('paused'),
      read<bigint>('maxHold'),
      read<bigint>('jobCount'),
    ]);
    add('role.founder', eq(founder, dep.founder), `${founder}`);
    add('role.agent', eq(agent, dep.agent), `${agent}`);
    add('role.agentNotFounder', !eq(agent, founder), 'agent and founder must be different keys (D3 guards)');
    const agentPk = opt('AGENT_PK', '');
    if (agentPk) add('role.agentKeyMatches', eq(privateKeyToAccount(agentPk as Hex).address, agent), 'AGENT_PK address == vault.agent');
    const founderPk = opt('FOUNDER_PK', '');
    if (founderPk && c.name !== 'anvil') {
      add('role.founderPkMatches', eq(privateKeyToAccount(founderPk as Hex).address, founder), 'FOUNDER_PK (dashboard actions, D1) == vault.founder');
    }
    add('role.feeTo', eq(feeTo, dep.feeTo), feeTo);
    add('role.inferencePayee', eq(inf, dep.inferencePayee), inf);
    add('role.usdc', eq(usdc, dep.usdc), usdc);
    add('feeBps==300', feeBps === 300n, `${feeBps}`);

    const allowed = await Promise.all(
      [...dep.vendors.map((x) => [x.label, x.address] as const), ['INFERENCE', dep.inferencePayee] as const].map(async ([l, a]) => [l, await read<boolean>('vendorAllowed', [a])] as const),
    );
    for (const [l, ok] of allowed) add(`vendorAllowed.${l}`, ok, ok ? 'allowed' : 'NOT allowed');

    add('maxHold', maxHold === BigInt(dep.maxHold), `${maxHold}`);
    add('budget', budget === BigInt(dep.budget), `${budget}`);
    add('committed==0', committed === 0n, `${committed}`);
    add('jobCount==0 (fresh vault)', jobCount === 0n, `${jobCount}`);
    add('!paused', !paused, `${paused}`);
    const bal = (await pc.readContract({ address: dep.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [dep.vault] })) as bigint;
    add('usdc.balanceOf(vault)==budget', bal === budget, `${bal}`);
    const runway = Number(deadline) - Number(block.timestamp);
    const minRunway = opts.minRunwaySeconds ?? 7200;
    add('deadline', deadline === BigInt(dep.deadline) && runway > minRunway, `deadline ${deadline}, runway ${runway}s (min ${minRunway}s)`);

    const gasPrice = await pc.getGasPrice();
    const need = EXPECTED_TXS * GAS_PER_TX * gasPrice;
    const [agentEth, founderEth] = await Promise.all([pc.getBalance({ address: agent }), pc.getBalance({ address: founder })]);
    const agentNeed = need > MIN_AGENT_ETH ? need : MIN_AGENT_ETH;
    add('eth.agent', agentEth >= agentNeed, `${formatEther(agentEth)} ETH (need ${formatEther(agentNeed)})`);
    add('eth.founder', founderEth >= MIN_FOUNDER_ETH, `${formatEther(founderEth)} ETH (need ${formatEther(MIN_FOUNDER_ETH)})`);

    const mode = opt('LLM_MODE', '');
    add('llm.mode', mode === 'kiln' || mode === 'stub', mode ? `LLM_MODE=${mode}` : 'LLM_MODE must be set explicitly (kiln|stub)');
    if (mode === 'kiln') add('llm.kilnConfigured', !!opt('KILN_URL', '') && !!opt('KILN_API_KEY', ''), 'KILN_URL + KILN_API_KEY present');
  } catch (e) {
    add('rpc', false, (e as Error).message.split('\n')[0]!);
  }
  return { ok: items.every((i) => i.ok), items };
}

export function printPreflight(r: PreflightResult): void {
  for (const i of r.items) console.log(`${i.ok ? 'PASS' : 'FAIL'}  ${i.name.padEnd(34)} ${i.detail}`);
  console.log(r.ok ? 'preflight: PASS' : `preflight: FAIL (${r.items.filter((i) => !i.ok).map((i) => i.name).join(', ')})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadDotEnv();
  const c = chainCfg();
  const dep = loadCurrentDeployment(c);
  const i = process.argv.indexOf('--min-runway');
  const r = await runPreflight(c, { ...dep, vault: getAddress(dep.vault) }, { minRunwaySeconds: i > 0 ? Number(process.argv[i + 1]) : undefined });
  printPreflight(r);
  process.exit(r.ok ? 0 : 1);
}
