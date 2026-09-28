// e2e-sepolia.ts — E1: the recorded run = the submission bundle, on Base Sepolia with the REAL Kiln.
//   npm run e2e:sepolia -- --scenario normal [--skip-deploy]
// Interactive (forge keystore password prompts): run it in your own terminal, e.g. `! npm run e2e:sepolia`.
// Needs .env: CHAIN=base-sepolia, RPC_URL(+_FALLBACK), AGENT_PK (npm run new-agent, funded),
// FOUNDER_PK (same address as the keystore account, D1), LLM_MODE=kiln, KILN_URL, KILN_API_KEY.
// Steps: preflight gates -> deploy (new vault) -> sign-spec -> session (CLOCK_MULT=60) with the
// dashboard on 127.0.0.1:$PORT -> audit with the PUBLIC RPC and --submission -> token/energy report.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditBundle } from '../auditor/audit.ts';
import { chainCfg, loadCurrentDeployment, loadDotEnv, need } from '../backend/config.ts';
import { llmModeFromEnv } from '../backend/kiln.ts';
import { SCENARIOS } from '../backend/scenarios.ts';
import { deploy } from './deploy.ts';
import { printPreflight } from './preflight.ts';
import { computeMetrics, renderMarkdown } from './report.ts';
import { runScenario } from './run.ts';
import { signSpec } from './sign-spec.ts';

loadDotEnv();
const c = chainCfg();
if (c.name !== 'base-sepolia') throw new Error('CHAIN must be base-sepolia');
if (llmModeFromEnv(process.env.LLM_MODE) !== 'kiln') throw new Error('LLM_MODE=kiln is required for the submission run (stub evidence FAILs audit --submission)');
need('KILN_URL');
need('KILN_API_KEY');
need('AGENT_PK');
need('FOUNDER_PK');
const i = process.argv.indexOf('--scenario');
const name = i >= 0 ? process.argv[i + 1]! : 'normal';
const sc = SCENARIOS[name];
if (!sc) throw new Error(`unknown scenario ${name}`);
const clockMult = Number(process.env.CLOCK_MULT ?? '60');

let dep = process.argv.includes('--skip-deploy') ? loadCurrentDeployment(c) : null;
if (!dep) {
  const r = await deploy({
    budgetUsd: sc.deploy.budgetUsd,
    deadlineSeconds: sc.deploy.deadlineSimHours ? Math.ceil((sc.deploy.deadlineSimHours * 3600) / clockMult) + 60 : undefined,
    label: `sepolia-${name}`,
  });
  printPreflight(r.preflight);
  if (!r.preflight.ok) throw new Error('preflight failed: fix the items above (ETH, keys, LLM_MODE) and retry');
  dep = r.dep;
}
const { dir } = await signSpec({ dep, specId: `spec-${name}-${dep.vault.slice(2, 10).toLowerCase()}-${Date.now()}` });
console.log(`e2e:sepolia: dashboard http://127.0.0.1:${process.env.PORT ?? 8787}  vault ${c.explorer}/address/${dep.vault}`);
const { reason } = await runScenario({ scenario: name, dep, serve: true });
console.log(`e2e:sepolia: session ended ${reason}; auditing with the public RPC (sepolia.base.org)`);
// give the public RPC a moment to index the last block
await new Promise((r) => setTimeout(r, 8_000));
const audit = await auditBundle({ dir, rpcUrl: 'https://sepolia.base.org', expectedVault: dep.vault, expectedChainId: 84532, submission: true });
writeFileSync(join(dir, 'audit.json'), JSON.stringify(audit, null, 2));
console.log(`e2e:sepolia: audit ${audit.verdict} (exit ${audit.exitCode}); ${audit.warnings.length} WARN; anchored #${audit.anchored.upTo}/${audit.anchored.total}`);
for (const f of audit.failures) console.log(`  FAIL ${f.check} ${f.code}: ${f.detail}`);
const md = renderMarkdown(computeMetrics([dir]));
writeFileSync(join(dir, 'metrics.md'), md);
console.log(md);
spawnSync('git', ['status', '--short', dir], { stdio: 'inherit' });
process.exit(audit.exitCode);
