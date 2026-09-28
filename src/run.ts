// CLI + factory for the orchestrator. Deploys a fresh vault, runs one scenario to completion (windDown), prints a summary.
// The dashboard server (src/server.ts) imports bootSession() to get a Session before start(), exactly like this CLI.
// Usage: LLM_MODE=kiln|stub node --env-file-if-exists=.env src/run.ts --scenario <name>
//        [--chain anvil|base-sepolia] [--rpc URL] [--speed N] [--margin S] [--no-deploy --vault 0x..]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Hex } from 'viem'
import { AKASH_URL } from './akash.ts'
import { CHAINS } from './chainread.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from './deploy.ts'
import { costToMicro, llmMode } from './kiln.ts'
import { readChain, type Decision } from './record.ts'
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

export type BootOpts = {
  scenario: ScenarioDef
  chain: ChainName
  rpc: string
  speed?: number
  deadlineMarginS?: bigint
  vault?: Hex // reuse deployments/<chainId>-<vault>.json instead of deploying (--no-deploy)
  keysDir?: string
  outDir?: string // deployments/
  runsDir?: string
  fetch?: typeof fetch // the Akash warm-up (tests pass a fast-failing one)
  log?: (s: string) => void
}

/** What every entry point does before running: warm the Akash cache, deploy a fresh vault (or load --vault), createSession. */
export async function bootSession(o: BootOpts): Promise<Session> {
  const log = o.log ?? (() => {})
  // Warm up the Akash Cloudflare cache (a cold miss can take ~16s) before loadPrices' 5s budget runs inside start().
  // It runs while the vault deploys; start() comes after both.
  const warm = (o.fetch ?? fetch)(AKASH_URL, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => {})
  // A short (deadline demo) vault's clock starts at fund, deploy's last tx: a cold warm-up must not run after it.
  if (o.scenario.vault.deadlineHours < 2) await warm
  let dep: Deployment
  if (o.vault) {
    dep = JSON.parse(readFileSync(join(o.outDir ?? 'deployments', `${CHAINS[o.chain].id}-${o.vault}.json`), 'utf8'))
  } else {
    log(`deploying a fresh vault for scenario "${o.scenario.name}" on ${o.chain} (${o.rpc}) ...`)
    dep = await Session.deployFor(o.scenario, { chain: o.chain, rpcUrls: [o.rpc], keysDir: o.keysDir, outDir: o.outDir, log: (s) => log(`  ${s}`) })
    log(`  vault ${dep.vault}  agent ${dep.agent}  deployBlock ${dep.deployBlock}`)
  }
  await warm
  return createSession({ deployment: dep, chain: o.chain, rpcUrls: [o.rpc], scenario: o.scenario, speed: o.speed, deadlineMarginS: o.deadlineMarginS, keysDir: o.keysDir, runsDir: o.runsDir })
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

  if (a['no-deploy'] && !a.vault) throw new Error('--no-deploy needs --vault 0x..')
  const session = await bootSession({ scenario: sc, chain, rpc, speed, deadlineMarginS: margin, vault: a['no-deploy'] ? (a.vault as Hex) : undefined, log: console.log })
  const t0 = Date.now()
  let failed: unknown = null
  try { await session.run() } catch (e) { failed = e } // still print what the bundle holds, then exit 1
  console.log(`\n=== summary: ${sc.name} on ${chain}, speed ${speed}, ${Math.round((Date.now() - t0) / 1000)} s ===`)
  console.log(summarize(session.dir, session.state()).join('\n'))
  console.log(`audit        node src/audit.ts ${session.dir}${chain === 'anvil' ? ` --rpc ${rpc}` : ''}`)
  if (failed) throw failed
}

/** What the bundle proves, from the files an auditor reads (records/, events.jsonl, kiln.jsonl) plus the final dashboard state. */
export function summarize(dir: string, st: ReturnType<Session['state']>): string[] {
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ') || 'none'
  const jsonl = (f: string): any[] => { try { return readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
  const recs = readChain(join(dir, 'records'))
  const ds = recs.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision).filter((d) => d.action !== 'inference')
  const denied = (f: (d: Decision) => boolean) => count(ds.filter((d) => !d.verdict.approve && f(d)).map((d) => (d.verdict as { code: string }).code))
  const events = jsonl('events.jsonl')
  const mined = events.filter((e) => e.src === 'commit' && e.ev === 'mined')
  const enforced = mined.filter((e) => (e.events ?? []).some((x: any) => x.name === 'Denied' && x.args?.enforced)).map((e) => `${e.fn}:${e.code}`)
  const stolen = events.filter((e) => e.src === 'scenario' && e.ev === 'stolen_key').map((e) => `${e.fn}:${e.code ?? e.error ?? 'no Denied'}`)
  const cost = costToMicro(jsonl('kiln.jsonl').map((l) => l.usage?.cost ?? null))
  const usd = (m: string | bigint) => `$${(Number(m) / 1e6).toFixed(6)}`
  const g = st.grant
  return [
    `bundle       ${dir}`,
    `report       ${join(dir, 'report.md')}`,
    `records      ${recs.length} (${count(recs.map((r) => r.rec.type))})`,
    `txs          ${mined.length} backend txs mined (${count(mined.map((e) => e.status))})`,
    `decisions    ${ds.length}: approved ${ds.filter((d) => d.verdict.approve).length}; gate-denied, 0 F2 calls: ${denied((d) => d.gate.codes.length > 0)}; ` +
      `F2 denied: ${denied((d) => d.f2.length > 0)}; other: ${denied((d) => !d.gate.codes.length && !d.f2.length)}`,
    `chain Denied ${count(enforced)} (the contract refused a backend tx)`,
    `stolen key   ${stolen.length ? stolen.join(', ') : 'not run'}`,
    `money        budget ${usd(g.budget)} = vendors ${usd(g.paid)} + fees ${usd(g.fees)} + inference ${usd(g.inference_paid)} + open holds ${usd(g.open_holds)} + refundable ${usd(g.refundable)}`,
    `Kiln         ${st.health.kiln.calls} attempts (${st.health.kiln.mode}), ${st.health.kiln.errors} errors, cost ${usd(cost.micro)}${cost.unknown ? ` (+${cost.unknown} unknown)` : ''}`,
    `stop         ${st.stop}; committer halted: ${st.health.halted ?? 'no'}`,
  ]
}

if (import.meta.main) {
  main().catch((e) => { console.error(`run failed: ${e?.message ?? e}`); process.exit(1) })
}
