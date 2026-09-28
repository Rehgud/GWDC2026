// config.ts — env, chain selection, demo addresses and the current deployment.
// Only two config sources (design 운영 체크리스트): deployments/*.json for addresses, and
// off-chain parameters from .env. Anything the contract knows is read from the chain.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, type Hex } from 'viem';
import { parseUsd } from './rules.ts';

// ------------------------------------------------------------------------------ .env
/** Minimal .env loader (no dependency). Existing process.env values win. */
export function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new ConfigError(`missing required env ${name} (see .env.example)`);
  return v;
}

export function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}

export function optInt(name: string, dflt: number): number {
  const v = opt(name, String(dflt));
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new ConfigError(`env ${name} must be an integer, got ${v}`);
  return n;
}

// ------------------------------------------------------------------------------ chains
export type ChainName = 'anvil' | 'base-sepolia';

export type ChainCfg = {
  name: ChainName;
  id: number;
  rpcUrls: string[];
  explorer: string | null;
  /** deployments/ for evidence chains, deployments/local/ (git-ignored) for anvil */
  deploymentsDir: string;
  /** runs/ for evidence chains, runs/local/ (git-ignored) for anvil */
  runsDir: string;
};

export function chainCfg(): ChainCfg {
  const name = opt('CHAIN', 'anvil') as ChainName;
  const rpc = [opt('RPC_URL', ''), opt('RPC_URL_FALLBACK', '')].filter(Boolean);
  if (name === 'anvil') {
    return { name, id: 31337, rpcUrls: rpc.length ? rpc : ['http://127.0.0.1:8545'], explorer: null, deploymentsDir: 'deployments/local', runsDir: 'runs/local' };
  }
  if (name === 'base-sepolia') {
    return { name, id: 84532, rpcUrls: rpc.length ? rpc : ['https://sepolia.base.org'], explorer: 'https://sepolia.basescan.org', deploymentsDir: 'deployments', runsDir: 'runs' };
  }
  throw new ConfigError(`CHAIN must be anvil | base-sepolia, got ${name}`);
}

// ------------------------------------------------------------------------------ demo config
export type DemoConfig = {
  budget: bigint;
  maxHold: bigint;
  feeBps: number;
  runwayHours: number;
  inferenceHold: bigint;
  vendors: { label: string; address: Hex }[];
  inferencePayee: Hex;
  feeTo: Hex;
};

export function loadDemoConfig(file = 'config/demo.json'): DemoConfig {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const addr = (envName: string, fallback: string): Hex => getAddress(opt(envName, fallback));
  const vendors = (['A', 'B', 'C'] as const).map((l) => ({ label: l, address: addr(`VENDOR_${l}`, j.vendors[l]) }));
  return {
    budget: parseUsd(j.budget_usd),
    maxHold: parseUsd(j.max_hold_usd),
    feeBps: j.fee_bps,
    runwayHours: j.vault_runway_hours,
    inferenceHold: parseUsd(j.inference_hold_usd),
    vendors,
    inferencePayee: addr('INFERENCE_PAYEE', j.inference_payee),
    feeTo: addr('FEE_TO', j.fee_to),
  };
}

// ------------------------------------------------------------------------------ deployments
export type Deployment = {
  schema_version: 1;
  label: string;
  chainId: number;
  vault: Hex;
  usdc: Hex;
  founder: Hex;
  agent: Hex;
  feeTo: Hex;
  inferencePayee: Hex;
  vendors: { label: string; address: Hex }[];
  budget: string;
  maxHold: string;
  feeBps: number;
  deadline: number;
  deployBlock: string;
  setupTxs: { step: string; hash: Hex; block: string }[];
  gitSha: string;
  deployedAt: string;
  retired: string | null;
};

export function deploymentFile(c: ChainCfg, vault: Hex): string {
  return join(c.deploymentsDir, `${c.id}-${vault.toLowerCase()}.json`);
}

export function currentDeploymentFile(c: ChainCfg): string {
  return join(c.deploymentsDir, 'current.json');
}

export function loadCurrentDeployment(c: ChainCfg): Deployment {
  const f = currentDeploymentFile(c);
  if (!existsSync(f)) throw new ConfigError(`no ${f}; run npm run deploy first`);
  const d = JSON.parse(readFileSync(f, 'utf8')) as Deployment;
  if (d.chainId !== c.id) throw new ConfigError(`${f} is for chain ${d.chainId}, CHAIN is ${c.name} (${c.id})`);
  return d;
}

export function runDir(c: ChainCfg, vault: Hex): string {
  return join(c.runsDir, vault.toLowerCase());
}
