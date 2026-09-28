// sign-spec.ts — founder signs the work spec for the CURRENT vault (R3-16).
// Writes <runDir>/spec.json (exact signed bytes) and spec.sig, then verifies the signature
// against vault.founder on-chain. base-sepolia: forge keystore via
// `cast wallet sign --account ${FOUNDER_ACCOUNT:-founder} 0x<bytes>` (password prompt).
// anvil: FOUNDER_PK or anvil account 0.
// Flags: --spec-id ID  --deadline UNIX  --template config/spec.template.json
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToHex, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi } from '../backend/abi.ts';
import { chainCfg, loadCurrentDeployment, loadDotEnv, opt, runDir } from '../backend/config.ts';
import { specBytes, verifySpec, type WorkSpec } from '../backend/spec.ts';

const ANVIL_FOUNDER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

loadDotEnv();
const c = chainCfg();
const dep = loadCurrentDeployment(c);
const tpl = JSON.parse(readFileSync(arg('--template') ?? 'config/spec.template.json', 'utf8'));
const pc = createPublicClient({ transport: http(c.rpcUrls[0]) });
const vaultDeadline = Number(await pc.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'deadline' }));
const founder = (await pc.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'founder' })) as Hex;

const spec: WorkSpec = {
  schema_version: 1,
  spec_id: arg('--spec-id') ?? `spec-${c.id}-${dep.vault.slice(2, 10).toLowerCase()}-${Date.now()}`,
  vault: dep.vault,
  chain_id: c.id,
  issued_at: new Date().toISOString(),
  purpose: tpl.purpose,
  success_metric: tpl.success_metric,
  allowed_gpu_types: tpl.allowed_gpu_types,
  job_cap_usd: tpl.job_cap_usd,
  deadline: arg('--deadline') ? Number(arg('--deadline')) : vaultDeadline,
};
const bytes = specBytes(spec);

let sig: Hex;
if (c.name === 'anvil') {
  sig = await privateKeyToAccount(opt('FOUNDER_PK', ANVIL_FOUNDER) as Hex).signMessage({ message: { raw: bytes } });
} else {
  const r = spawnSync('cast', ['wallet', 'sign', '--account', opt('FOUNDER_ACCOUNT', 'founder'), bytesToHex(bytes)], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('cast wallet sign failed');
  sig = r.stdout.trim() as Hex;
}

const check = await verifySpec({ bytes, sig, founder, vault: dep.vault, chainId: c.id });
if (check.issues.length) {
  console.error('sign-spec: verification FAILED', check.issues);
  process.exit(1);
}
const dir = runDir(c, dep.vault);
mkdirSync(dir, { recursive: true });
if (existsSync(join(dir, 'spec.json'))) {
  console.error(`sign-spec: ${dir}/spec.json already exists (one spec per vault/session); refusing to overwrite`);
  process.exit(1);
}
writeFileSync(join(dir, 'spec.json'), bytes);
writeFileSync(join(dir, 'spec.sig'), sig);
console.log(`sign-spec: ${spec.spec_id} signed by ${check.signer} -> ${dir}/spec.json + spec.sig`);
