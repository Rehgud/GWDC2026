// Chain WRITE side. Committer.commit() is the ONLY way anything is sent; classify() is the only place a receipt is judged.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BaseError, ContractFunctionRevertedError, createWalletClient, encodeFunctionData, fallback, http, keccak256,
  type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from './abi.ts'
import { CHAINS, decodeVaultLogs, errText } from './chainread.ts'
import { fromBytes32 } from './codes.ts'
import { ZERO_HASH, serialize, type RecordChain, type RecordType } from './record.ts'
import type { ChainName, DecodedEvent, EventLine, Outcome } from './types.ts'

export function makeWallet(chain: ChainName, rpcUrls: string[], pk: Hex): WalletClient {
  return createWalletClient({ account: privateKeyToAccount(pk), chain: CHAINS[chain], transport: fallback(rpcUrls.map((u) => http(u))) })
}

export type Verdict =
  | { status: 'OK'; jobId?: bigint; events: DecodedEvent[] }
  | { status: 'DENIED'; code: string; events: DecodedEvent[] }
  | { status: 'HALT'; reason: 'REVERTED' | 'UNEXPECTED'; events: DecodedEvent[] }

/** Pure. Vault logs only. reverted -> HALT; an enforced Denied -> DENIED (whatever `expected` says);
 *  expected (recordDecision: its own Denied(enforced=false)) -> OK; else HALT. */
export function classify(receipt: Pick<TransactionReceipt, 'status' | 'logs'>, vault: Hex, expected: string[]): Verdict {
  if (receipt.status !== 'success') return { status: 'HALT', reason: 'REVERTED', events: [] }
  const events = decodeVaultLogs(receipt, vault).map(({ name, args, logIndex }) => ({ name, args, logIndex }))
  const denied = events.find((e) => e.name === 'Denied' && e.args.enforced !== false)
  if (denied) return { status: 'DENIED', code: fromBytes32(denied.args.code as Hex), events }
  if (events.some((e) => expected.includes(e.name))) {
    const jobId = events.find((e) => e.name === 'HoldOpened')?.args.jobId as bigint | undefined
    return jobId === undefined ? { status: 'OK', events } : { status: 'OK', jobId, events }
  }
  return { status: 'HALT', reason: 'UNEXPECTED', events }
}

export type Intent = {
  signer: 'agent' | 'founder'
  fn: string
  args: readonly unknown[] // WITHOUT the trailing rec / reasonHash
  record?: { type: RecordType; body: Record<string, unknown> } | null // null for fund / setVendor / setMaxHold
  expect: string[]
  req_id: string | null
  job_id: string | null
  stillValid?: () => boolean // epoch check: false -> CANCELLED, no record, no tx
}

export type CommitterOpts = {
  client: PublicClient
  wallets: { agent: WalletClient; founder: WalletClient }
  vault: Hex
  records: RecordChain
  eventsPath: string // runs/<vault>/events.jsonl
  receiptTimeoutMs?: number // default 60s
}

/** Custom error name of a revert (Unauthorized, JobClosed, Panic...), else the viem error name. */
function revertName(e: unknown): string {
  if (!(e instanceof BaseError)) return e instanceof Error ? e.name : 'Error'
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
  return r ? (r.data?.errorName ?? r.reason ?? 'Reverted') : e.name
}

/** Vault functions whose last argument is the record hash (rec / reasonHash): these MUST carry a record, the rest must not. */
const REC_FNS = new Set(
  (vaultAbi as readonly any[]).filter((x) => x.type === 'function' && ['rec', 'reasonHash'].includes(x.inputs.at(-1)?.name)).map((x) => x.name as string),
)

/** One per process. Serialized Promise-chain queue; every tx waits for its receipt, so nonces stay sequential. HALT is sticky. */
export class Committer {
  #halted = false
  #haltReason: string | null = null
  #pending = 0 // queued + in flight
  #jobs = new Map<string, number>()
  #tail: Promise<unknown> = Promise.resolve()
  #o: CommitterOpts

  constructor(o: CommitterOpts) {
    this.#o = o
    mkdirSync(dirname(o.eventsPath), { recursive: true })
  }

  // Read-only from outside: nothing but a process restart clears a HALT.
  get halted() { return this.#halted }
  get haltReason() { return this.#haltReason }
  get pending() { return this.#pending }

  /** Queued + in-flight intents for one job (dashboard button guard). */
  pendingFor(jobId: string): number {
    return this.#jobs.get(jobId) ?? 0
  }

  commit(intent: Intent): Promise<Outcome> {
    const j = intent.job_id
    this.#pending++
    if (j !== null) this.#jobs.set(j, this.pendingFor(j) + 1)
    const p = this.#tail.then(() => this.#run(intent))
    this.#tail = p.catch(() => {})
    return p.finally(() => {
      this.#pending--
      if (j !== null) this.pendingFor(j) > 1 ? this.#jobs.set(j, this.pendingFor(j) - 1) : this.#jobs.delete(j)
    })
  }

  #log(i: Intent, ev: string, extra: Record<string, unknown>) {
    const line: EventLine = { ts: Date.now(), run_id: this.#o.records.runId, req_id: i.req_id, job_id: i.job_id, src: 'commit', ev, schema_version: 1, fn: i.fn, ...extra }
    appendFileSync(this.#o.eventsPath, serialize(line).toString('utf8') + '\n')
  }

  #halt(i: Intent, reason: string, e: unknown, ids: { txHash?: Hex; recHash?: Hex }, extra: Record<string, unknown> = {}): Outcome {
    this.#halted = true
    this.#haltReason = reason
    try { this.#log(i, 'halt', { reason, err: e === null ? null : errText(e), ...ids, ...extra }) } catch {}
    return { status: 'HALT', reason, ...ids }
  }

  async #run(i: Intent): Promise<Outcome> {
    if (this.#halted) return { status: 'HALT', reason: 'halted' }
    const { client, vault } = this.#o
    let recHash: Hex | undefined
    let txHash: Hex | undefined
    try {
      // A rec-carrying call without a record (caller-supplied rec) would be an unrecorded spend: refuse, no tx.
      if (REC_FNS.has(i.fn) !== Boolean(i.record)) return this.#halt(i, `RECORD_MISMATCH:${i.fn}`, null, {})
      if (i.stillValid && !i.stillValid()) {
        this.#log(i, 'cancelled', {})
        return { status: 'CANCELLED', reason: 'stale' }
      }
      if (i.record) {
        try {
          recHash = this.#o.records.append(i.record.type, i.record.body).hash
        } catch (e) {
          return this.#halt(i, 'RECORD_WRITE', e, {})
        }
      }
      const args = recHash ? [...i.args, recHash] : [...i.args]
      const account = this.#o.wallets[i.signer].account!
      this.#log(i, 'intent', { signer: i.signer, from: account.address, recHash, args })

      try {
        await client.simulateContract({ address: vault, abi: vaultAbi, functionName: i.fn, args, account } as any)
      } catch (e) {
        const name = revertName(e)
        if (name === 'JobClosed' && (await this.#isClosed(args[0]))) {
          this.#log(i, 'already_closed', { recHash })
          return { status: 'ALREADY_CLOSED', recHash: recHash ?? ZERO_HASH }
        }
        return this.#halt(i, `PRESEND_REVERT:${name}`, e, { recHash })
      }

      // Sign locally so the hash is on disk BEFORE anything is broadcast: a lost RPC answer is then re-queried, not re-sent.
      const w = this.#o.wallets[i.signer]
      let raw: Hex
      try {
        raw = await w.signTransaction((await w.prepareTransactionRequest({ account, to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: i.fn, args } as any) } as any)) as any)
      } catch (e) {
        return this.#halt(i, `SEND_FAILED:${revertName(e)}`, e, { recHash }) // nothing broadcast
      }
      txHash = keccak256(raw)
      this.#log(i, 'signed', { txHash, recHash })
      try {
        await w.sendRawTransaction({ serializedTransaction: raw })
      } catch (e) {
        if (!(await client.getTransaction({ hash: txHash }).catch(() => null))) return this.#halt(i, `SEND_FAILED:${revertName(e)}`, e, { txHash, recHash })
      }
      this.#log(i, 'sent', { txHash, recHash })

      // Never re-sign, never a new nonce, never a fee bump: wait, re-query the SAME hash once, else HALT.
      let receipt: TransactionReceipt | null
      try {
        receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: this.#o.receiptTimeoutMs ?? 60_000 })
      } catch (e) {
        receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null)
        if (!receipt) return this.#halt(i, 'UNCONFIRMED', e, { txHash, recHash })
      }
      // viem resolves with the REPLACEMENT's receipt when another tx (cast, a stolen key) took our nonce: never judge that one.
      if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
        return this.#halt(i, 'REPLACED', null, { txHash, recHash }, { replacedBy: receipt.transactionHash })
      }

      const v = classify(receipt, vault, i.expect)
      const block = receipt.blockNumber
      this.#log(i, 'mined', {
        txHash, recHash, block, status: v.status, events: v.events,
        ...(v.status === 'DENIED' ? { code: v.code } : {}),
        ...(v.status === 'HALT' ? { code: v.reason } : {}),
        ...(v.status === 'OK' && v.jobId !== undefined ? { jobId: v.jobId } : {}),
      })
      const r = recHash ?? ZERO_HASH
      if (v.status === 'HALT') return this.#halt(i, v.reason, null, { txHash, recHash })
      if (v.status === 'DENIED') return { status: 'DENIED', code: v.code, txHash, recHash: r, block, events: v.events }
      return v.jobId === undefined
        ? { status: 'OK', txHash, recHash: r, block, events: v.events }
        : { status: 'OK', txHash, recHash: r, block, jobId: v.jobId, events: v.events }
    } catch (e) {
      return this.#halt(i, `ERROR:${revertName(e)}`, e, { txHash, recHash })
    }
  }

  async #isClosed(id: unknown): Promise<boolean> {
    try {
      const j = (await this.#o.client.readContract({ address: this.#o.vault, abi: vaultAbi, functionName: 'jobs', args: [id as bigint] })) as readonly unknown[]
      return j[3] === true
    } catch {
      return false // unknown id: a real JobClosed-for-nonexistent-job, which HALTs
    }
  }
}
