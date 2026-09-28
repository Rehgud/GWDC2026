// cli.ts — npm run audit -- <bundleDir> [--vault 0x..] [--rpc URL ...] [--chain-id N] [--submission] [--json]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT_VERIFY. Defaults: vault and chain from run.json; RPC by chain
// (84532 -> https://sepolia.base.org, the PUBLIC endpoint: no archive node, no API key).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditBundle, type AuditResult } from './audit.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (n: string) => many(n)[0];
const dir = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]!.startsWith('--')));
if (!dir) {
  console.error('usage: npm run audit -- <bundleDir> [--vault 0x..] [--rpc URL] [--chain-id N] [--submission] [--json] [--dump-chain file]');
  process.exit(2);
}
const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const chainId = Number(one('--chain-id') ?? run.chain_id);
const rpc = many('--rpc').length ? many('--rpc') : chainId === 84532 ? ['https://sepolia.base.org'] : ['http://127.0.0.1:8545'];
const vault = one('--vault') ?? run.vault;

const res: AuditResult = await auditBundle({
  dir,
  rpcUrl: rpc,
  expectedVault: vault,
  expectedChainId: chainId,
  submission: flag('--submission'),
  chainOut: one('--dump-chain') ? (c) => writeFileSync(one('--dump-chain')!, JSON.stringify(c)) : undefined,
});

if (flag('--json')) {
  console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} else {
  console.log(`audit ${dir}\n  vault ${vault} chain ${chainId} rpc ${rpc.map((u) => new URL(u).host).join(', ')}${flag('--submission') ? ' (--submission)' : ''}`);
  for (const c of res.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id.padEnd(10)} ${c.summary}`);
  for (const f of res.findings.filter((x) => x.level !== 'INFO')) console.log(`  [${f.level}] ${f.check} ${f.code}${f.seq !== undefined ? ` #${f.seq}` : ''}: ${f.detail}`);
  const info = res.findings.filter((x) => x.level === 'INFO');
  const byCode = new Map<string, number>();
  for (const i of info) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1);
  for (const [k, n] of byCode) console.log(`  [INFO] ${k} x${n}`);
  if (res.unrecordedAttempts.length) {
    console.log(`  unrecorded attempts (not in the 1:1 ledger match, PASS kept):`);
    for (const u of res.unrecordedAttempts) console.log(`    sender ${u.sender} code ${u.code} tx ${u.tx} block ${u.block}`);
  }
  console.log(`  anchored up to #${res.anchored.upTo} / ${res.anchored.total}; ${res.matching.length} backend/founder txs matched 1:1`);
  if (res.findings.some((f) => f.code === 'CRLF_SUSPECT')) console.log('  hint: CR bytes found — the bundle looks like a core.autocrlf checkout; re-clone with -c core.autocrlf=false');
  console.log(`VERDICT: ${res.verdict} (exit ${res.exitCode})`);
}
process.exit(res.exitCode);
