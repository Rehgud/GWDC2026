// run.ts — run one scenario session against the CURRENT vault (npm run session -- --scenario normal).
// Needs: deployments/<...>/current.json (npm run deploy), <runDir>/spec.json+sig (npm run sign-spec),
// LLM_MODE=kiln|stub set explicitly. Writes the bundle to runs/<vault>/ (runs/local/<vault>/ on anvil).
// --serve starts the dashboard on 127.0.0.1:$PORT while the session runs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWalletClient, defineChain, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPrices } from '../backend/akash.ts';
import { makePublicClient } from '../backend/chain.ts';
import type { Sender } from '../backend/commit.ts';
import { chainCfg, loadCurrentDeployment, loadDemoConfig, loadDotEnv, opt, optInt, runDir, type Deployment } from '../backend/config.ts';
import { LlmClient, llmModeFromEnv } from '../backend/kiln.ts';
import { SCENARIOS } from '../backend/scenarios.ts';
import { Session } from '../backend/session.ts';
import type { SessionEndReason } from '../backend/record.ts';
import { ANVIL_AGENT, ANVIL_FOUNDER, gitSha } from './deploy.ts';

export type RunOpts = { scenario: string; dep?: Deployment; serve?: boolean; quiet?: boolean; onSession?: (s: Session) => void };

export async function runScenario(o: RunOpts): Promise<{ reason: SessionEndReason; dir: string; session: Session }> {
  const c = chainCfg();
  const dep = o.dep ?? loadCurrentDeployment(c);
  const sc = SCENARIOS[o.scenario];
  if (!sc) throw new Error(`unknown scenario ${o.scenario}; one of ${Object.keys(SCENARIOS).join(', ')}`);
  const mode = llmModeFromEnv(process.env.LLM_MODE);
  const demo = loadDemoConfig();
  const dir = runDir(c, dep.vault);
  if (!existsSync(join(dir, 'spec.json'))) throw new Error(`${dir}/spec.json missing: run npm run sign-spec first`);

  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: c.rpcUrls } } });
  const pc = makePublicClient(c.rpcUrls);
  const mk = (pk: Hex): Sender => {
    const account = privateKeyToAccount(pk);
    return { account, wallet: createWalletClient({ account, chain, transport: http(c.rpcUrls[0]) }) };
  };
  const agent = mk(opt('AGENT_PK', c.name === 'anvil' ? ANVIL_AGENT : '') as Hex);
  const founder = mk(opt('FOUNDER_PK', c.name === 'anvil' ? ANVIL_FOUNDER : '') as Hex);
  if (agent.account.address.toLowerCase() !== dep.agent.toLowerCase()) throw new Error('AGENT_PK does not match vault.agent');
  if (founder.account.address.toLowerCase() !== dep.founder.toLowerCase()) throw new Error('FOUNDER_PK does not match vault.founder (D1)');
  // InsufficientGas: refuse to start below 0.005 ETH on the agent
  const eth = await pc.getBalance({ address: agent.account.address });
  if (eth < 5_000_000_000_000_000n) throw new Error(`agent has ${formatEther(eth)} ETH < 0.005: refusing to start`);

  const hosts = JSON.parse((await import('node:fs')).readFileSync('config/demo.json', 'utf8')).akash_hosts as Record<string, string>;
  const prices = await loadPrices({
    pinned: demo.vendors.map((v) => ({ label: v.label, address: v.address, hostUri: hosts[v.label]! })),
    mode: opt('PRICE_SOURCE', 'live') === 'snapshot' ? 'snapshot' : 'live',
  });
  const llm = new LlmClient({
    mode,
    model: opt('KILN_MODEL', 'qwen3-32b'),
    url: opt('KILN_URL', ''),
    apiKey: opt('KILN_API_KEY', ''),
    callCap: optInt('LLM_CALL_CAP', 60),
    costCapMicro: demo.inferenceHold,
    timeoutMs: { F1: optInt('F1_TIMEOUT_MS', 10_000), F2: optInt('F2_TIMEOUT_MS', 10_000), F3: 15_000 },
    noThink: opt('NO_THINK', '1') !== '0',
    jsonlPath: join(dir, 'llm.jsonl'),
    stub: sc.stub,
    onWarn: (m) => console.warn(`llm: ${m}`),
  });
  const clockMult = optInt('CLOCK_MULT', 60);
  const session = await Session.create({
    chainCfg: c,
    dep,
    dir,
    pc,
    chain,
    agent,
    founder,
    llm,
    prices,
    scenario: sc,
    cfg: {
      runId: `${sc.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      clockMult,
      triggerTenths: BigInt(Math.round(Number(opt('TOPUP_TRIGGER', '0.4')) * 10)),
      deadlineMarginS: sc.deadlineMarginS ?? optInt('DEADLINE_MARGIN_S', 15),
      inferenceHold: demo.inferenceHold,
      tickMs: clockMult >= 300 ? 100 : 250,
      topupTimeoutMs: 60_000,
      gitSha: gitSha(),
      model: opt('KILN_MODEL', 'qwen3-32b'),
      llmCallCap: optInt('LLM_CALL_CAP', 60),
      flags: {
        KILN_HOST: (() => {
          try {
            return new URL(opt('KILN_URL', '')).host; // host only, never the key or path
          } catch {
            return '';
          }
        })(),
        F1_TIMEOUT_MS: optInt('F1_TIMEOUT_MS', 10_000),
        F2_TIMEOUT_MS: optInt('F2_TIMEOUT_MS', 10_000),
        NO_THINK: opt('NO_THINK', '1') !== '0',
      },
    },
    log: o.quiet ? undefined : (l) => console.log(l),
  });
  o.onSession?.(session);
  let server: { close: () => Promise<void> } | null = null;
  if (o.serve) {
    const { startServer } = await import('../backend/server.ts');
    server = await startServer(session, { port: optInt('PORT', 8787) });
  }
  try {
    const reason = await session.run();
    return { reason, dir, session };
  } finally {
    await server?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadDotEnv();
  const i = process.argv.indexOf('--scenario');
  const scenario = i >= 0 ? process.argv[i + 1]! : opt('SCENARIO', 'normal');
  runScenario({ scenario, serve: process.argv.includes('--serve') })
    .then(({ reason, dir }) => {
      console.log(`session: ended ${reason}; bundle ${dir}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`session: ${(e as Error).message}`);
      process.exit(1);
    });
}
