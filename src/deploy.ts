// Deploy one vault (= one recording = one bundle) and preflight it.
// CLI: node --env-file-if-exists=.env src/deploy.ts [--chain anvil|base-sepolia] [--rpc URL] [--budget 20] [--max-hold 6] [--deadline-hours 36] [--label name]
// Sequence: MockUSDC -> mint(founder) -> Vault(usdc, agent, feeTo, inference) -> setVendor x4 -> setMaxHold -> ETH to agent
//   -> approve(exact) -> fund(budget, deadline). fund goes last so a short demo deadline starts when the vault is ready, not
//   ~11 blocks earlier (doc ops checklist 3 lists fund before setVendor; the order has no on-chain effect). Run `forge test` first.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { getAddress, keccak256, parseEther, parseUnits, slice, toBytes, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { usdcAbi, usdcBytecode, vaultAbi, vaultBytecode } from './abi.ts'
import { makeWallet } from './chain.ts'
import { CHAINS, errText, makePublicClient, snapshot } from './chainread.ts'
import type { ChainName, Deployment } from './types.ts'

/** anvil account #0: public, test-only. */
export const ANVIL_FOUNDER_PK: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** Deterministic payee: anyone can recompute it from the label. Nobody holds its key. */
export const payee = (label: string): Hex => getAddress(slice(keccak256(toBytes(`cfo-agent/${label}`)), 12))
export const PAYEES = {
  vendors: { A: payee('vendor/A'), B: payee('vendor/B'), C: payee('vendor/C') },
  feeTo: payee('feeTo'),
  inferencePayee: payee('inference'),
}

/** ETH for ~200 txs at the current gas price, never below the error registry's 0.005 ETH start gate
 *  (at Base Sepolia's ~0.001 gwei the estimate alone is ~4e-5 ETH: one gas spike and every send fails). */
const GAS_PER_TX = 200_000n
const ETH_FLOOR = parseEther('0.005')
export const minEth = async (client: PublicClient) => {
  const est = (await client.getGasPrice()) * GAS_PER_TX * 200n
  return est > ETH_FLOOR ? est : ETH_FLOOR
}

export const agentKeyPath = (vault: Hex, keysDir = 'keys') => join(keysDir, `${getAddress(vault)}.agent`)
export const loadAgentKey = (vault: Hex, keysDir = 'keys') => readFileSync(agentKeyPath(vault, keysDir), 'utf8').trim() as Hex

export type DeployOpts = {
  chain: ChainName
  rpcUrls: string[]
  founderPk: Hex
  budget: bigint // micro-USDC
  maxHold: bigint // micro-USDC, net
  deadline: number | (() => number) // unix seconds (fund overwrites it: always explicit); a function is called right before fund
  label: string
  outDir?: string // deployments/
  keysDir?: string // keys/ (gitignored)
  log?: (s: string) => void
}

export async function deploy(o: DeployOpts): Promise<Deployment> {
  const log = o.log ?? (() => {})
  const outDir = o.outDir ?? 'deployments'
  const keysDir = o.keysDir ?? 'keys'
  const client = makePublicClient(o.chain, o.rpcUrls)
  const w = makeWallet(o.chain, o.rpcUrls, o.founderPk)
  const founder = w.account!.address
  const agentPk = generatePrivateKey()
  const agent = privateKeyToAccount(agentPk).address
  const setupTxs: Hex[] = []

  const wait = async (hash: Hex, what: string) => {
    setupTxs.push(hash)
    const r = await client.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`)
    log(`${what} ${hash}`)
    return r
  }
  const call = async (address: Hex, abi: any, functionName: string, args: unknown[]) =>
    wait(await w.writeContract({ address, abi, functionName, args, account: w.account!, chain: CHAINS[o.chain] } as any), functionName)

  const usdc = getAddress((await wait(await w.deployContract({ abi: usdcAbi, bytecode: usdcBytecode, account: w.account!, chain: CHAINS[o.chain] }), 'MockUSDC')).contractAddress!)
  await call(usdc, usdcAbi, 'mint', [founder, o.budget])
  const vr = await wait(
    await w.deployContract({ abi: vaultAbi, bytecode: vaultBytecode, args: [usdc, agent, PAYEES.feeTo, PAYEES.inferencePayee], account: w.account!, chain: CHAINS[o.chain] }),
    'AgentBudgetVault',
  )
  const vault = getAddress(vr.contractAddress!)
  mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  writeFileSync(agentKeyPath(vault, keysDir), agentPk, { mode: 0o600 })
  chmodSync(agentKeyPath(vault, keysDir), 0o600)

  for (const v of [PAYEES.vendors.A, PAYEES.vendors.B, PAYEES.vendors.C, PAYEES.inferencePayee]) await call(vault, vaultAbi, 'setVendor', [v, true])
  await call(vault, vaultAbi, 'setMaxHold', [o.maxHold])
  const gas = o.chain === 'anvil' ? parseEther('1') : 3n * (await minEth(client))
  await wait(await w.sendTransaction({ to: agent, value: gas, account: w.account!, chain: CHAINS[o.chain] }), 'agent gas')
  await call(usdc, usdcAbi, 'approve', [vault, o.budget])
  const deadline = typeof o.deadline === 'function' ? o.deadline() : o.deadline
  await call(vault, vaultAbi, 'fund', [o.budget, BigInt(deadline)])

  let gitSha = 'unknown'
  try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  const dep: Deployment = {
    label: o.label,
    chain: o.chain,
    chainId: CHAINS[o.chain].id,
    vault,
    usdc,
    founder,
    agent,
    feeTo: PAYEES.feeTo,
    inferencePayee: PAYEES.inferencePayee,
    vendors: PAYEES.vendors,
    budget: o.budget.toString(),
    maxHold: o.maxHold.toString(),
    deadline,
    deployBlock: Number(vr.blockNumber),
    setupTxs,
    gitSha,
  }
  mkdirSync(outDir, { recursive: true })
  const json = JSON.stringify(dep, null, 2) + '\n'
  writeFileSync(join(outDir, `${dep.chainId}-${vault}.json`), json)
  writeFileSync(join(outDir, 'current.json'), json)
  return dep
}

/** Failing item names; [] = PASS. relaxDeadline: the short-deadline demo vault only needs deadline > now. */
export async function preflight(dep: Deployment, client: PublicClient, opts: { relaxDeadline?: boolean; now?: number } = {}): Promise<string[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const labelled: [string, Hex][] = [['A', dep.vendors.A], ['B', dep.vendors.B], ['C', dep.vendors.C], ['INFERENCE', dep.inferencePayee]]
  const s = await snapshot(client, dep.vault, { vendors: labelled.map(([, a]) => a) })
  const r = (functionName: string): Promise<any> => client.readContract({ address: dep.vault, abi: vaultAbi, functionName, blockNumber: s.block } as any)
  const [founder, agent, feeTo, usdc, founderEth, agentEth, need] = await Promise.all([
    r('founder'), r('agent'), r('feeTo'), r('usdc'),
    client.getBalance({ address: dep.founder }), client.getBalance({ address: dep.agent }), minEth(client),
  ])
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const checks: [string, boolean][] = [
    ['founder', eq(founder, dep.founder)],
    ['agent', eq(agent, dep.agent)],
    ['feeTo', eq(feeTo, dep.feeTo)],
    ['inferencePayee', eq(s.inferencePayee, dep.inferencePayee)],
    ['usdc', eq(usdc, dep.usdc)],
    ['feeBps', s.feeBps === 300n],
    ...labelled.map(([l, a]): [string, boolean] => [`vendorAllowed:${l}`, s.vendorAllowed[a.toLowerCase()] === true]),
    ['maxHold', s.maxHold === BigInt(dep.maxHold)],
    ['budget', s.budget === BigInt(dep.budget)],
    ['committed', s.committed === 0n],
    ['paused', !s.paused],
    ['deadline', s.deadline === BigInt(dep.deadline) && s.deadline > BigInt(now + (opts.relaxDeadline ? 0 : 7200))],
    ['founderEth', founderEth >= need],
    ['agentEth', agentEth >= need],
    ['rpcHead', now - Number(s.blockTs) < 30],
  ]
  return checks.filter(([, ok]) => !ok).map(([n]) => n)
}

if (import.meta.main) {
  try {
    const { values: a } = parseArgs({
      options: {
        chain: { type: 'string' }, rpc: { type: 'string' }, budget: { type: 'string', default: '20' },
        'max-hold': { type: 'string', default: '6' }, 'deadline-hours': { type: 'string', default: '36' }, label: { type: 'string', default: 'demo' },
      },
    })
    const chain = (a.chain ?? process.env.CHAIN ?? 'anvil') as ChainName
    if (!(chain in CHAINS)) throw new Error(`--chain must be anvil or base-sepolia, got ${chain}`)
    const rpc = a.rpc || process.env.RPC_URL || (chain === 'anvil' ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org')
    let pk = chain === 'anvil' ? ANVIL_FOUNDER_PK : process.env.FOUNDER_PK
    if (!pk) throw new Error('FOUNDER_PK is required for base-sepolia (put it in .env)')
    if (!pk.startsWith('0x')) pk = `0x${pk}`
    const hours = Number(a['deadline-hours'])
    if (!(hours > 0)) throw new Error('--deadline-hours must be > 0')
    const client = makePublicClient(chain, [rpc])
    const head = await client.getBlock()
    const dep = await deploy({
      chain, rpcUrls: [rpc], founderPk: pk as Hex, label: a.label!,
      budget: parseUnits(a.budget!, 6), maxHold: parseUnits(a['max-hold']!, 6),
      deadline: Number(head.timestamp) + Math.round(hours * 3600), log: (s) => console.log(s),
    })
    console.log(`vault ${dep.vault} usdc ${dep.usdc} agent ${dep.agent} deployBlock ${dep.deployBlock}`)
    console.log(`wrote deployments/${dep.chainId}-${dep.vault}.json and deployments/current.json; agent key -> ${agentKeyPath(dep.vault)}`)
    const fails = await preflight(dep, client, { relaxDeadline: hours < 2 })
    for (const f of fails) console.error(`PREFLIGHT FAIL ${f}`)
    if (fails.length) process.exit(1)
    console.log('preflight PASS')
  } catch (e) {
    console.error(`deploy failed: ${errText(e)}`)
    process.exit(1)
  }
}
