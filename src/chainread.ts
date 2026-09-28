// Chain READ side: clients, the pinned-block snapshot, chunked getLogs, vault log decoding.
// No signing, no writes: the auditor imports this file.
import { BaseError, createPublicClient, decodeEventLog, fallback, http, type Hex, type Log, type PublicClient } from 'viem'
import { anvil, baseSepolia } from 'viem/chains'
import { vaultAbi } from './abi.ts'
import type { ChainName, ChainSnapshot, DecodedEvent } from './types.ts'

export const CHAINS = { anvil, 'base-sepolia': baseSepolia } as const

/** fallback([...rpcUrls]) so a dead provider RPC falls through to the next (doc diagram 1). */
export function makePublicClient(chain: ChainName, rpcUrls: string[]): PublicClient {
  if (!CHAINS[chain]) throw new Error(`unknown chain ${chain}`)
  if (!rpcUrls.length) throw new Error('no RPC URL')
  return createPublicClient({
    chain: CHAINS[chain],
    transport: fallback(rpcUrls.map((u) => http(u))),
    pollingInterval: chain === 'anvil' ? 100 : 1000,
  }) as PublicClient
}

/** Name + short message only: viem's full message can carry the RPC URL (and an API key in it). */
export const errText = (e: unknown): string =>
  e instanceof BaseError ? `${e.name}: ${e.shortMessage}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e)

/** Caller maps this to READ_FAILED (fail-closed, no tx). */
export class ReadFailed extends Error {
  name = 'ReadFailed'
}

/** Every read pinned to ONE block number (anvil has no Multicall3, so plain eth_calls with blockNumber). Retries once. */
export async function snapshot(client: PublicClient, vault: Hex, opts: { vendors: Hex[]; block?: bigint }): Promise<ChainSnapshot> {
  const read = async (): Promise<ChainSnapshot> => {
    const b = opts.block === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: opts.block })
    const blockNumber = b.number
    const r = (functionName: string, args: unknown[] = []): Promise<any> =>
      client.readContract({ address: vault, abi: vaultAbi, functionName, args, blockNumber } as any)
    const [paused, deadline, budget, committed, maxHold, feeBps, inferencePayee, jobCount, allowed] = await Promise.all([
      r('paused'), r('deadline'), r('budget'), r('committed'), r('maxHold'), r('feeBps'), r('inferencePayee'), r('jobCount'),
      Promise.all(opts.vendors.map((v) => r('vendorAllowed', [v]))),
    ])
    const jobs = await Promise.all(Array.from({ length: Number(jobCount) }, (_, i) => r('jobs', [BigInt(i)])))
    return {
      block: blockNumber,
      blockTs: b.timestamp,
      readAt: Date.now(),
      paused,
      deadline: BigInt(deadline),
      budget,
      committed,
      maxHold,
      feeBps,
      inferencePayee,
      vendorAllowed: Object.fromEntries(opts.vendors.map((v, i) => [v.toLowerCase(), allowed[i] as boolean])),
      jobs: jobs.map(([vendor, held, paid, closed]) => ({ vendor, held, paid, closed })),
    }
  }
  try {
    return await read()
  } catch {
    try {
      return await read()
    } catch (e) {
      throw new ReadFailed(errText(e))
    }
  }
}

export type VaultLog = DecodedEvent & { blockNumber: bigint; txHash: Hex }

/** Only logs emitted by the vault, decoded with vaultAbi (a MockUSDC Transfer or anything else is dropped). */
export function decodeVaultLogs(receiptOrLogs: { logs: readonly Log[] } | readonly Log[], vault: Hex): VaultLog[] {
  const logs = 'logs' in receiptOrLogs ? receiptOrLogs.logs : receiptOrLogs
  const v = vault.toLowerCase()
  return logs
    .filter((l) => l.address.toLowerCase() === v)
    .map((l) => {
      const d = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as any })
      return { name: d.eventName as string, args: (d.args ?? {}) as Record<string, unknown>, logIndex: Number(l.logIndex), blockNumber: l.blockNumber!, txHash: l.transactionHash! }
    })
}

/** getLogs in [from, to] windows of `chunk` blocks (sepolia.base.org caps at 1,000). Retries a chunk once on 429/limit, then throws. */
export async function getLogsChunked(client: PublicClient, vault: Hex, fromBlock: bigint, toBlock: bigint, chunk = 1000n): Promise<VaultLog[]> {
  const out: VaultLog[] = []
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock
    const get = () => client.getLogs({ address: vault, fromBlock: from, toBlock: to })
    let logs: Log[]
    try {
      logs = await get()
    } catch (e) {
      const t = e instanceof BaseError ? `${e.shortMessage} ${e.details}` : String(e)
      if (!/429|limit|rate|too many/i.test(t)) throw e
      await new Promise((r) => setTimeout(r, 1000))
      logs = await get()
    }
    out.push(...decodeVaultLogs(logs, vault))
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
}
