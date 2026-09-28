// CLI + factory for the orchestrator. Deploys a fresh vault, runs one scenario to completion (windDown), prints a summary.
// The dashboard server (src/server.ts, another agent) imports createSession() to get a Session before start().
// Usage: LLM_MODE=kiln|stub node --env-file-if-exists=.env src/run.ts --scenario <name>
//        [--chain anvil|base-sepolia] [--rpc URL] [--speed N] [--margin S] [--no-deploy --vault 0x..]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Hex } from 'viem'
import { AKASH_URL } from './akash.ts'
import { CHAINS } from './chainread.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from './deploy.ts'
import { costToMicro, llmMode, llmStats } from './kiln.ts'
import { scenario, type ScenarioDef } from './scenarios.ts'
import { Session, type SessionOpts } from './session.ts'
import type { ChainName, Deployment } from './types.ts'

export type CreateOpts = {
  deployment: Deployment
  chain: ChainName
  rpcUrls: string[]
  publicRpc?: string
  scenario: ScenarioDef
  speed?: number
  deadlineMarginS?: bigint
  keysDir?: string
  runsDir?: string
  llmStub?: SessionOpts['llm']['stub']
  onEvent?: SessionOpts['onEvent']
}

/** Build a Session (not yet started) from a deployment. The server calls this, then start()/loop()/action(). */
export function createSession(o: CreateOpts): Session {
  const mode = llmMode()
  const founderPk = o.chain === 'anvil' ? ANVIL_FOUNDER_PK : (process.env.FOUNDER_PK as Hex)
  if (!founderPk) throw new Error('FOUNDER_PK required for base-sepolia')
  const publicRpc = o.publicRpc ?? (o.chain === 'anvil' ? o.rpcUrls[0] : 'https://sepolia.base.org')
  return new Session({
    chain: o.chain, rpcUrls: o.rpcUrls, publicRpc, deployment: o.deployment,
    agentPk: loadAgentKey(o.deployment.vault, o.keysDir), founderPk, runsDir: o.runsDir, scenario: o.scenario,
    llm: { mode, stub: o.llmStub ?? o.scenario.stub }, speed: o.speed ?? o.scenario.suggestedSpeed ?? 1,
    deadlineMarginS: o.deadlineMarginS ?? o.scenario.suggestedMarginS ?? 15n, onEvent: o.onEvent,
  })
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      scenario: { type: 'string' }, chain: { type: 'string' }, rpc: { type: 'string' }, speed: { type: 'string' },
      margin: { type: 'string' }, 'no-deploy': { type: 'boolean' }, vault: { type: 'string' },
    },
  })
  if (!a.scenario) throw new Error('--scenario <name> is required')
  llmMode() // fail fast if LLM_MODE is unset
  const sc = scenario(a.scenario)
  const chain = (a.chain ?? process.env.CHAIN ?? 'anvil') as ChainName
  if (!(chain in CHAINS)) throw new Error(`--chain must be anvil or base-sepolia`)
  const rpc = a.rpc || process.env.RPC_URL || (chain === 'anvil' ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org')
  const speed = a.speed ? Number(a.speed) : sc.suggestedSpeed ?? 1
  const margin = a.margin !== undefined ? BigInt(a.margin) : sc.suggestedMarginS ?? 15n

  // Warm up the Akash Cloudflare cache (a cold miss can take ~16s) before loadPrices' 5s budget runs inside start().
  await fetch(AKASH_URL, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => {})

  let dep: Deployment
  if (a['no-deploy']) {
    if (!a.vault) throw new Error('--no-deploy needs --vault 0x..')
    dep = JSON.parse(readFileSync(join('deployments', `${CHAINS[chain].id}-${a.vault}.json`), 'utf8'))
  } else {
    console.log(`deploying a fresh vault for scenario "${sc.name}" on ${chain} (${rpc}) ...`)
    dep = await Session.deployFor(sc, { chain, rpcUrls: [rpc], log: (s) => console.log(`  ${s}`) })
    console.log(`  vault ${dep.vault}  agent ${dep.agent}  deployBlock ${dep.deployBlock}`)
  }

  const session = createSession({ deployment: dep, chain, rpcUrls: [rpc], scenario: sc, speed, deadlineMarginS: margin })
  await session.run()

  const denied = new Set<string>()
  for (const l of session.ledger) if (l.status === 'DENIED' && l.code) denied.add(l.code)
  for (const t of session.topups) if (t.code) denied.add(t.code)
  const cost = costToMicro((session as unknown as { kilnCosts: (number | null)[] }).kilnCosts ?? [])
  console.log('\n=== summary ===')
  console.log(`bundle       ${session.dir}`)
  console.log(`report       ${join(session.dir, 'report.md')}`)
  console.log(`tx (commits) ${session.ledger.length}  (OK ${session.ledger.filter((l) => l.status === 'OK').length}, DENIED ${session.ledger.filter((l) => l.status === 'DENIED').length})`)
  console.log(`Denied codes ${[...denied].join(', ') || 'none'}`)
  console.log(`Kiln calls   ${llmStats.calls}  cost ${(Number(cost.micro) / 1e6).toFixed(6)} USD${cost.unknown ? ` (+${cost.unknown} unknown)` : ''}`)
  console.log(`halted       ${session.committer.haltReason ?? 'no'}`)
}

if (import.meta.main) {
  main().catch((e) => { console.error(`run failed: ${e?.message ?? e}`); process.exit(1) })
}
