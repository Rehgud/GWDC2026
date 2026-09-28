// e2e-local.ts — T2 tier: anvil + stub LLM + CLOCK_MULT=600, every scenario on its own fresh vault.
//   npm run e2e:local [-- normal qwen-deny ...]      (default: all scenarios)
// Per scenario: deploy (new vault) -> preflight -> sign-spec -> session -> audit (when available).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chainCfg, loadDotEnv, runDir } from '../backend/config.ts';
import { SCENARIOS } from '../backend/scenarios.ts';
import { deploy } from './deploy.ts';
import { printPreflight } from './preflight.ts';
import { signSpec } from './sign-spec.ts';
import { runScenario } from './run.ts';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 8545));
    });
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  // local tier: no secrets from .env are needed; keep .env from overriding the anvil setup
  Object.assign(process.env, { CHAIN: 'anvil', RPC_URL: `http://127.0.0.1:${port}`, RPC_URL_FALLBACK: '', LLM_MODE: 'stub', CLOCK_MULT: process.env.CLOCK_MULT ?? '600', PRICE_SOURCE: process.env.PRICE_SOURCE ?? 'snapshot', AGENT_PK: '', FOUNDER_PK: '' });
  loadDotEnv();
  const anvil = spawn('anvil', ['--port', String(port), '--block-time', '1', '--silent'], { stdio: 'ignore' });
  const stop = () => anvil.kill();
  process.on('exit', stop);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(process.env.RPC_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = names.length ? names : Object.keys(SCENARIOS);
  const results: { scenario: string; vault: string; reason: string; ms: number; audit: string }[] = [];
  let first = true;
  for (const name of list) {
    const sc = SCENARIOS[name];
    if (!sc) throw new Error(`unknown scenario ${name}`);
    const t0 = Date.now();
    const { dep, preflight } = await deploy({ skipTests: !first || process.argv.includes('--skip-tests'), budgetUsd: sc.deploy.budgetUsd, deadlineSeconds: sc.deploy.deadlineSimHours ? Math.ceil((sc.deploy.deadlineSimHours * 3600) / Number(process.env.CLOCK_MULT)) + 8 : undefined, label: `e2e-${name}`, verbose: false });
    first = false;
    if (!preflight.ok) {
      printPreflight(preflight);
      throw new Error(`preflight failed for ${name}`);
    }
    // anvil addresses repeat across fresh chains: clear this vault's old LOCAL bundle only
    const { rmSync } = await import('node:fs');
    const local = runDir(chainCfg(), dep.vault);
    if (local.split('\\').join('/').startsWith('runs/local/')) rmSync(local, { recursive: true, force: true });
    await signSpec({ dep, specId: `spec-e2e-${name}-${dep.vault.slice(2, 10).toLowerCase()}` });
    const { reason, dir } = await runScenario({ scenario: name, dep, quiet: true });
    let audit = 'n/a';
    try {
      const { auditBundle } = await import('../auditor/audit.ts');
      let chainData: unknown = null;
      const r = await auditBundle({ dir, rpcUrl: process.env.RPC_URL!, expectedVault: dep.vault, chainOut: (c) => (chainData = c) });
      if (process.argv.includes('--golden') && r.verdict === 'PASS') {
        // freeze bundle + the chain data it was judged against (audit() is pure over these)
        const { cpSync, mkdirSync, rmSync: rm, writeFileSync } = await import('node:fs');
        const out = `test/fixtures/golden/${name}`;
        rm(out, { recursive: true, force: true });
        mkdirSync(`${out}/bundle`, { recursive: true });
        for (const f of ['run.json', 'spec.json', 'spec.sig', 'ledger.jsonl']) cpSync(`${dir}/${f}`, `${out}/bundle/${f}`);
        cpSync(`${dir}/records`, `${out}/bundle/records`, { recursive: true });
        cpSync(`${dir}/prices`, `${out}/bundle/prices`, { recursive: true });
        writeFileSync(`${out}/chain.json`, JSON.stringify(chainData));
        console.log(`e2e: golden fixture -> ${out}`);
      }
      audit = `${r.verdict}${r.warnings.length ? ` (${r.warnings.length} WARN: ${[...new Set(r.warnings.map((w) => w.code))].join(',')})` : ''}`;
      if (r.verdict !== 'PASS') for (const f of r.failures.slice(0, 8)) console.log(`   FAIL ${f.check} ${f.code}${f.seq !== undefined ? ` #${f.seq}` : ''}: ${f.detail}`);
    } catch (e) {
      audit = `ERROR ${(e as Error).message.split('\n')[0]}`;
    }
    results.push({ scenario: name, vault: dep.vault, reason, ms: Date.now() - t0, audit });
    console.log(`e2e: ${name.padEnd(11)} ${reason.padEnd(22)} audit=${audit} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${dir}`);
  }
  stop();
  console.table(results);
}

main().catch((e) => {
  console.error(`e2e: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
