// crash-test.ts — I7: kill -9 the backend mid-run, then `wind-down` (founder key + bundle files only)
// -> audit PASS. npm run crash:test
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { deploy } from './deploy.ts';
import { signSpec } from './sign-spec.ts';

const port: number = await new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const a = s.address();
    s.close(() => r(typeof a === 'object' && a ? a.port : 8545));
  });
});
const env = { ...process.env, CHAIN: 'anvil', RPC_URL: `http://127.0.0.1:${port}`, RPC_URL_FALLBACK: '', LLM_MODE: 'stub', CLOCK_MULT: '600', PRICE_SOURCE: 'snapshot', AGENT_PK: '', FOUNDER_PK: '' };
Object.assign(process.env, env);
const anvil = spawn('anvil', ['--port', String(port), '--block-time', '1', '--silent'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(env.RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const { dep } = await deploy({ skipTests: true, verbose: false, label: 'crash-test' });
  const { rmSync } = await import('node:fs');
  rmSync(`runs/local/${dep.vault.toLowerCase()}`, { recursive: true, force: true });
  const { dir } = await signSpec({ dep, specId: `spec-crash-${dep.vault.slice(2, 10).toLowerCase()}` });
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run.ts', '--scenario', 'normal'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  // wait until the session is mid-run (a vendor job opened and at least one checkpoint settled)
  const { existsSync, readdirSync } = await import('node:fs');
  for (let i = 0; i < 300; i++) {
    const rd = `${dir}/records`;
    if (existsSync(rd) && readdirSync(rd).length >= 5) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL'); // crash: no windDown, jobs left open
  await new Promise((r) => setTimeout(r, 500));
  console.log('crash-test: backend killed mid-run; running wind-down');
  const w = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/wind-down.ts', '--dir', dir], { env, encoding: 'utf8' });
  console.log(w.stdout.trim(), w.stderr.trim());
  const w2 = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/wind-down.ts', '--dir', dir], { env, encoding: 'utf8' });
  console.log(`crash-test: second wind-down -> ${w2.stdout.trim()}`);
  const a = spawnSync(process.execPath, ['--import', 'tsx', 'auditor/cli.ts', dir, '--rpc', env.RPC_URL], { env, encoding: 'utf8' });
  console.log(a.stdout);
  process.exitCode = a.status ?? 1;
} finally {
  anvil.kill();
}
