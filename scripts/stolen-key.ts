// A standalone stolen-agent-key attack: it loads keys/<vault>.agent and hits the vault DIRECTLY, bypassing the
// backend and the record chain. Every attempt should be answered by the contract with Denied(enforced=true) and
// move no funds. This is success criterion 3(iii). Run it only while the backend is idle (no nonce collisions).
// Usage: node --env-file-if-exists=.env scripts/stolen-key.ts --vault 0x.. [--chain anvil|base-sepolia] [--rpc URL]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { getAddress, keccak256, type Hex } from 'viem'
import { usdcAbi, vaultAbi } from '../src/abi.ts'
import { makeWallet } from '../src/chain.ts'
import { CHAINS, makePublicClient, decodeVaultLogs } from '../src/chainread.ts'
import { fromBytes32 } from '../src/codes.ts'
import { loadAgentKey } from '../src/deploy.ts'
import type { ChainName, Deployment } from '../src/types.ts'

const BAD_VENDOR = getAddress('0xbad0000000000000000000000000000000000bad') // valid checksum so viem sends it; not allowlisted -> Denied

export async function stolenKeyAttack(o: { dep: Deployment; chain: ChainName; rpcUrls: string[]; keysDir?: string; log?: (s: string) => void }) {
  const log = o.log ?? console.log
  const client = makePublicClient(o.chain, o.rpcUrls)
  const attacker = makeWallet(o.chain, o.rpcUrls, loadAgentKey(o.dep.vault, o.keysDir))
  const rec = keccak256(Buffer.from('attacker'))
  const bal = (a: Hex) => client.readContract({ address: o.dep.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
  const before = { vault: await bal(o.dep.vault), bad: await bal(BAD_VENDOR), vendorA: await bal(o.dep.vendors.A) }
  const maxHold = BigInt(o.dep.maxHold)

  // 1) pay a NON-allowlisted vendor; 2) top up job 0 over maxHold. Both must be Denied.
  const attempts: { name: string; fn: string; args: unknown[] }[] = [
    { name: 'open -> unallowed vendor 0xBAD', fn: 'open', args: [BAD_VENDOR, 1_000_000n, rec] },
    { name: 'topUp job 0 over maxHold', fn: 'topUp', args: [0n, maxHold + 1_000_000n, rec] },
  ]
  const results: { name: string; code: string | null; status: string }[] = []
  for (const at of attempts) {
    try {
      const hash = await attacker.writeContract({ address: o.dep.vault, abi: vaultAbi, functionName: at.fn, args: at.args, account: attacker.account!, chain: CHAINS[o.chain] } as any)
      const r = await client.waitForTransactionReceipt({ hash })
      const denied = decodeVaultLogs(r, o.dep.vault).find((e) => e.name === 'Denied')
      const code = denied ? fromBytes32(denied.args.code as Hex) : null
      results.push({ name: at.name, code, status: r.status })
      log(`  ${at.name}: tx ${hash} status ${r.status} -> ${code ? `Denied(${code})` : 'NO Denied event!'}`)
    } catch (e) {
      results.push({ name: at.name, code: null, status: `revert:${(e as Error).name}` })
      log(`  ${at.name}: reverted (${(e as Error).name})`)
    }
  }
  const after = { vault: await bal(o.dep.vault), bad: await bal(BAD_VENDOR), vendorA: await bal(o.dep.vendors.A) }
  const moved = before.vault !== after.vault || after.bad !== before.bad
  log(`  balances moved: ${moved ? 'YES (BUG)' : 'no'} (vault ${before.vault} -> ${after.vault}, attacker payee ${before.bad} -> ${after.bad})`)
  return { results, moved, before, after }
}

if (import.meta.main) {
  const { values: a } = parseArgs({ options: { vault: { type: 'string' }, chain: { type: 'string' }, rpc: { type: 'string' } } })
  if (!a.vault) throw new Error('--vault 0x.. is required')
  const chain = (a.chain ?? process.env.CHAIN ?? 'anvil') as ChainName
  const rpc = a.rpc || process.env.RPC_URL || (chain === 'anvil' ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org')
  const dep: Deployment = JSON.parse(readFileSync(join('deployments', `${CHAINS[chain].id}-${a.vault}.json`), 'utf8'))
  console.log(`stolen-key attack on vault ${dep.vault} (${chain})`)
  const r = await stolenKeyAttack({ dep, chain, rpcUrls: [rpc] })
  process.exit(r.moved ? 1 : 0)
}
