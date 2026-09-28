// health.ts — `make health` / `npm run health`: T-5 checklist in one command.
//   preflight (roles, allow-list, budget, deadline, ETH, head freshness, LLM_MODE) + no pending tx
//   (pending nonce == latest nonce for agent and founder) + the running dashboard's /health if any.
import { createPublicClient, http } from 'viem';
import { chainCfg, loadCurrentDeployment, loadDotEnv, optInt } from '../backend/config.ts';
import { printPreflight, runPreflight } from './preflight.ts';

loadDotEnv();
const c = chainCfg();
const dep = loadCurrentDeployment(c);
const pf = await runPreflight(c, dep, { minRunwaySeconds: 60 });
const pc = createPublicClient({ transport: http(c.rpcUrls[0]) });
for (const [who, addr] of [['agent', dep.agent], ['founder', dep.founder]] as const) {
  const [latest, pending] = await Promise.all([pc.getTransactionCount({ address: addr, blockTag: 'latest' }), pc.getTransactionCount({ address: addr, blockTag: 'pending' })]);
  pf.items.push({ name: `nonce.${who}.noPending`, ok: latest === pending, detail: `latest ${latest}, pending ${pending}` });
}
try {
  const r = await fetch(`http://127.0.0.1:${optInt('PORT', 8787)}/health`, { signal: AbortSignal.timeout(1500) });
  const h = (await r.json()) as { ok: boolean; stale: boolean; halted: string | null; pendingTx: number };
  pf.items.push({ name: 'dashboard./health', ok: h.ok, detail: JSON.stringify(h) });
} catch {
  pf.items.push({ name: 'dashboard./health', ok: true, detail: 'no session running (skipped)' });
}
pf.ok = pf.items.every((i) => i.ok);
printPreflight(pf);
process.exit(pf.ok ? 0 : 1);
