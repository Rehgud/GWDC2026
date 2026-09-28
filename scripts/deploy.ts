// deploy.ts — `make deploy` / `npm run deploy` (T4).
//   forge test -> forge script Deploy (MockUSDC -> mint -> Vault -> approve(exact) -> fund(X, deadline)
//   -> setVendor x4 -> setMaxHold) -> deployments/<chainId>-<vault>.json + current.json -> preflight
//
// Founder = deployer. On base-sepolia the founder signs with the forge keystore
// (`--account ${FOUNDER_ACCOUNT:-founder}`, password prompt: run it in your own terminal, e.g.
// `! npm run deploy` inside Claude Code). On anvil it uses FOUNDER_PK or anvil account 0.
// Every recorded run uses a NEW vault and a NEW agent key (AGENT_PK).
//
// Flags: --skip-tests   --deadline-seconds N (short-deadline vault for the deadline demo)
//        --budget USD (smaller vault for the budget / stolen-key scenarios)   --label NAME
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, getAddress, http, type Hex } from 'viem';
import { vaultAbi } from '../backend/abi.ts';
import {
  chainCfg,
  currentDeploymentFile,
  deploymentFile,
  loadDemoConfig,
  loadDotEnv,
  opt,
  type Deployment,
} from '../backend/config.ts';
import { parseUsd } from '../backend/rules.ts';
import { runPreflight, printPreflight, type PreflightResult } from './preflight.ts';

export const ANVIL_FOUNDER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_AGENT = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export function gitSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'contracts', 'script', 'backend', 'auditor'], { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

type BroadcastTx = {
  hash: Hex;
  transactionType: string;
  contractName: string | null;
  contractAddress: Hex | null;
  function: string | null;
  arguments: string[] | null;
};
type BroadcastReceipt = { transactionHash: Hex; blockNumber: string; status: string };

export type DeployOpts = {
  skipTests?: boolean;
  deadlineSeconds?: number;
  budgetUsd?: string;
  label?: string;
  /** forward forge output (default true for the CLI) */
  verbose?: boolean;
};

export async function deploy(o: DeployOpts = {}): Promise<{ dep: Deployment; preflight: PreflightResult }> {
  const c = chainCfg();
  const demo = loadDemoConfig();
  const rpc = c.rpcUrls[0]!;
  const stdio = o.verbose === false ? 'pipe' : 'inherit';

  const agentPk = (opt('AGENT_PK', c.name === 'anvil' ? ANVIL_AGENT : '') || null) as Hex | null;
  if (!agentPk) throw new Error('AGENT_PK is required (use a NEW agent key for every recorded vault)');
  const agent = privateKeyToAccount(agentPk).address;

  const pc = createPublicClient({ transport: http(rpc) });
  const chainNow = Number((await pc.getBlock()).timestamp);
  const now = Math.max(chainNow, Math.floor(Date.now() / 1000));
  const deadline = o.deadlineSeconds ? now + o.deadlineSeconds : now + demo.runwayHours * 3600;
  const label = o.label ?? `${c.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (o.budgetUsd) demo.budget = parseUsd(o.budgetUsd);

  if (!o.skipTests) {
    if (o.verbose !== false) console.log('deploy: forge test');
    const t = spawnSync('forge', ['test'], { stdio, shell: false });
    if (t.status !== 0) throw new Error('forge test failed — deploy aborted');
  }

  const auth: string[] = c.name === 'anvil' ? ['--private-key', opt('FOUNDER_PK', ANVIL_FOUNDER)] : ['--account', opt('FOUNDER_ACCOUNT', 'founder')];
  const env = {
    ...process.env,
    AGENT_ADDR: agent,
    FEE_TO: demo.feeTo,
    INFERENCE_PAYEE: demo.inferencePayee,
    VENDOR_A: demo.vendors[0]!.address,
    VENDOR_B: demo.vendors[1]!.address,
    VENDOR_C: demo.vendors[2]!.address,
    BUDGET_MICRO: demo.budget.toString(),
    VAULT_DEADLINE: String(deadline),
    MAX_HOLD_MICRO: demo.maxHold.toString(),
    FEE_BPS: String(demo.feeBps),
  };
  const fargs = ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', rpc, '--broadcast', ...auth];
  if (c.name !== 'anvil') fargs.push('--slow');
  if (o.verbose !== false) console.log(`deploy: forge ${fargs.map((a) => (a.startsWith('0x') && a.length > 60 ? '<key>' : a)).join(' ')}`);
  const r = spawnSync('forge', fargs, { stdio: c.name === 'anvil' ? stdio : 'inherit', env });
  if (r.status !== 0) throw new Error(`forge script failed${r.stderr ? `: ${String(r.stderr).slice(0, 400)}` : ''}`);

  const run = JSON.parse(readFileSync(`broadcast/Deploy.s.sol/${c.id}/run-latest.json`, 'utf8')) as { transactions: BroadcastTx[]; receipts: BroadcastReceipt[] };
  const byHash = new Map(run.receipts.map((x) => [x.transactionHash.toLowerCase(), x]));
  for (const x of run.receipts) if (x.status !== '0x1') throw new Error(`setup tx ${x.transactionHash} failed`);
  const created = (name: string) => {
    const t = run.transactions.find((x) => x.transactionType === 'CREATE' && x.contractName === name);
    if (!t?.contractAddress) throw new Error(`no ${name} CREATE in broadcast`);
    return t;
  };
  const vaultTx = created('AgentBudgetVault');
  const usdcTx = created('MockUSDC');
  const vault = getAddress(vaultTx.contractAddress!);
  const setupTxs = run.transactions.map((t) => {
    const rc = byHash.get(t.hash.toLowerCase());
    const step = t.transactionType === 'CREATE' ? `deploy ${t.contractName}` : `${t.contractName}.${t.function}${t.arguments ? `(${t.arguments.join(', ')})` : ''}`;
    return { step, hash: t.hash, block: rc ? BigInt(rc.blockNumber).toString() : '?' };
  });
  const deployBlock = BigInt(byHash.get(vaultTx.hash.toLowerCase())!.blockNumber).toString();
  const founder = getAddress((await pc.readContract({ address: vault, abi: vaultAbi, functionName: 'founder' })) as Hex);
  const dep: Deployment = {
    schema_version: 1,
    label,
    chainId: c.id,
    vault,
    usdc: getAddress(usdcTx.contractAddress!),
    founder,
    agent,
    feeTo: demo.feeTo,
    inferencePayee: demo.inferencePayee,
    vendors: demo.vendors,
    budget: demo.budget.toString(),
    maxHold: demo.maxHold.toString(),
    feeBps: demo.feeBps,
    deadline,
    deployBlock,
    setupTxs,
    gitSha: gitSha(),
    deployedAt: new Date().toISOString(),
    retired: null,
  };
  mkdirSync(c.deploymentsDir, { recursive: true });
  writeFileSync(deploymentFile(c, vault), JSON.stringify(dep, null, 2) + '\n');
  writeFileSync(currentDeploymentFile(c), JSON.stringify(dep, null, 2) + '\n');
  if (o.verbose !== false) {
    console.log(`deploy: vault ${vault} (deployBlock ${deployBlock}) -> ${deploymentFile(c, vault)}`);
    if (c.explorer) console.log(`deploy: ${c.explorer}/address/${vault}`);
  }
  const preflight = await runPreflight(c, dep, { minRunwaySeconds: o.deadlineSeconds ? Math.max(1, Math.floor(o.deadlineSeconds / 3)) : 7200 });
  return { dep, preflight };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadDotEnv();
  const arg = (n: string) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? (process.argv[i + 1] ?? undefined) : undefined;
  };
  deploy({
    skipTests: process.argv.includes('--skip-tests'),
    deadlineSeconds: arg('--deadline-seconds') ? Number(arg('--deadline-seconds')) : undefined,
    budgetUsd: arg('--budget'),
    label: arg('--label'),
  })
    .then(({ preflight }) => {
      printPreflight(preflight);
      process.exit(preflight.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`deploy: ${(e as Error).message}`);
      process.exit(1);
    });
}
