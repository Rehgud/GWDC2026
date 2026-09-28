// Emergency wind-down (runbook "make wind-down"): the founder's escape hatch when the backend crashed mid-session and
// holds are still locked. No running backend, no executor state: vault state from chain, the record chain from
// records/, the founder key only. Every tx goes through the Committer on a RecordChain continuing the bundle's
// seq/prev; its lines are appended to the bundle's events.jsonl.
//   node --env-file-if-exists=.env scripts/wind-down.ts runs/<vault> [--rpc URL] [--chain anvil|base-sepolia] [--pay-last-checkpoint] [--dry-run]
// Steps: setPaused(true) (STOP 'MANUAL') -> close every open job (CLOSE 'emergency-wind-down') -> refund(budget - committed)
// (SESSION_END, anchors the tail). Usage metered after a job's last Settled is NOT paid: the executor that metered it died.
// --pay-last-checkpoint first settles the exact amount of a job's LAST CHECKPOINT record whose settle never landed
// (crash between record write and receipt, or an agent settle Denied), if it fits the hold, under a new founder CHECKPOINT.
// Idempotent: a finished bundle (all jobs closed, nothing refundable, tail SESSION_END anchored by Refunded) sends nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { formatUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { vaultAbi } from '../src/abi.ts'
import { Committer, makeWallet, type Intent } from '../src/chain.ts'
import { CHAINS, errText, getLogsChunked, makePublicClient, snapshot } from '../src/chainread.ts'
import { ANVIL_FOUNDER_PK } from '../src/deploy.ts'
import { costToMicro } from '../src/kiln.ts'
import { readChain, RecordChain, verifyChain } from '../src/record.ts'
import { gross } from '../src/rules.ts'
import type { ChainName, Outcome } from '../src/types.ts'

export type WindDownOpts = { rpc?: string; chain?: ChainName; payLastCheckpoint?: boolean; dryRun?: boolean; log?: (s: string) => void }

const usd = (m: bigint) => `$${formatUnits(m, 6)}`

/** Returns the txs broadcast and the steps planned (a dry run plans the same steps and sends nothing). */
export async function emergencyWindDown(dir: string, o: WindDownOpts = {}): Promise<{ sent: number; steps: string[] }> {
  const log = o.log ?? console.log
  const dry = o.dryRun === true
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  const vault = run.vault as Hex
  const chain = (o.chain ?? run.chain) as ChainName
  if (!(chain in CHAINS) || CHAINS[chain].id !== run.chainId) throw new Error(`--chain ${chain} does not match run.json chainId ${run.chainId}`)
  const rpc: string = o.rpc ?? run.rpc
  const client = makePublicClient(chain, [rpc])
  const gotId = await client.getChainId()
  if (gotId !== run.chainId) throw new Error(`RPC chainId ${gotId} != run.json chainId ${run.chainId}: refusing to send`)

  let pk = chain === 'anvil' ? ANVIL_FOUNDER_PK : process.env.FOUNDER_PK
  if (!pk) throw new Error('FOUNDER_PK is required for base-sepolia (put it in .env)')
  if (!pk.startsWith('0x')) pk = `0x${pk}`
  const me = privateKeyToAccount(pk as Hex).address
  const founder = (await client.readContract({ address: vault, abi: vaultAbi, functionName: 'founder' })) as Hex
  if (me.toLowerCase() !== founder.toLowerCase()) throw new Error(`key ${me} is not vault.founder() ${founder}: refusing`)
  // A founder tx the dead backend left in the mempool (e.g. its windDown settle) would land before ours and the plan
  // below, read without it, could pay that span twice.
  const [latest, pending] = await Promise.all(['latest', 'pending'].map((blockTag) => client.getTransactionCount({ address: me, blockTag: blockTag as 'latest' })))
  if (pending !== latest) throw new Error(`the founder has ${pending - latest} pending tx(s): wait for them to mine (or replace them) and re-run`)

  const recsDir = join(dir, 'records')
  const recs = readChain(recsDir)
  const broken = verifyChain(recs)
  if (broken.length) log(`WARN record chain broken (${broken[0]}): continuing from the last file; the audit will FAIL check 1`)
  const w = makeWallet(chain, [rpc], pk as Hex)
  // Every intent here is founder-signed: the agent key is never loaded, its slot gets the founder wallet.
  const committer = new Committer({ client, vault, records: new RecordChain(recsDir, run.run_id), eventsPath: join(dir, 'events.jsonl'), wallets: { agent: w, founder: w } })

  let s = await snapshot(client, vault, { vendors: [] })
  let logs = await getLogsChunked(client, vault, BigInt(run.deployBlock), s.block)
  const tail = recs.at(-1)
  const endAnchored = tail?.rec.type === 'SESSION_END' && logs.some((l) => l.name === 'Refunded' && String(l.args.rec).toLowerCase() === tail.hash)
  log(`emergency wind-down${dry ? ' (DRY RUN)' : ''}: vault ${vault} on ${chain}, run ${run.run_id}, ${recs.length} records, block ${s.block}`)
  if (s.jobs.every((j) => j.closed) && s.budget === s.committed && endAnchored) {
    log(`nothing to do: every job closed, nothing refundable, tail #${tail!.rec.seq} SESSION_END anchored by Refunded`)
    log(`audit: node src/audit.ts ${dir}`)
    return { sent: 0, steps: [] }
  }

  const steps: string[] = []
  let sent = 0
  let lastBlock = 0n
  const send = async (what: string, i: Omit<Intent, 'signer' | 'req_id' | 'job_id'> & { job_id?: string }): Promise<Outcome | null> => {
    steps.push(what)
    log(`${dry ? 'would send' : 'send'}  ${what}`)
    if (dry) return null
    const out = await committer.commit({ signer: 'founder', req_id: null, job_id: null, ...i })
    if ('txHash' in out && out.txHash) sent++
    if ('block' in out && out.block > lastBlock) lastBlock = out.block
    if (out.status === 'HALT') throw new Error(`${what}: HALT ${out.reason}${out.txHash ? ` (tx ${out.txHash})` : ''}; re-run: it re-plans from chain`)
    log(`  -> ${out.status}${'txHash' in out ? ` ${out.txHash}` : ''}${'code' in out ? ` ${out.code}` : ''}`)
    return out
  }

  if (!s.paused) {
    await send('setPaused(true)  STOP reason MANUAL', { fn: 'setPaused', args: [true], expect: ['PausedSet'], record: { type: 'STOP', body: { reason: 'MANUAL', by: 'founder' } } })
    // Re-read AFTER the pause: an agent tx still in flight either landed before it (visible now) or is Denied(PAUSED).
    if (!dry) { s = await snapshot(client, vault, { vendors: [] }); logs = await getLogsChunked(client, vault, BigInt(run.deployBlock), s.block) }
  }

  const inf = s.inferencePayee.toLowerCase()
  const labelOf = (v: string) => v.toLowerCase() === inf ? 'INFERENCE'
    : Object.entries(run.vendors ?? {}).find(([, a]) => String(a).toLowerCase() === v.toLowerCase())?.[0] ?? v
  const settled = logs.filter((l) => l.name === 'Settled')
  const landed = new Set(settled.map((l) => String(l.args.rec).toLowerCase()))
  let kiln: any[] = []
  try { kiln = readFileSync(join(dir, 'kiln.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {} // no file = 0 calls
  const kilnCost = costToMicro(kiln.map((l) => l.usage?.cost ?? null))
  const unpaid: string[] = []
  let committed = s.committed

  for (const [i, j] of s.jobs.entries()) {
    if (j.closed) continue
    const id = BigInt(i), jid = String(i), label = labelOf(j.vendor), exempt = label === 'INFERENCE'
    const mine = settled.filter((l) => l.args.jobId === id)
    let net = mine.reduce((a, l) => a + (l.args.amount as bigint), 0n)
    let pay = 0n
    const cp = o.payLastCheckpoint ? recs.findLast((r) => r.rec.type === 'CHECKPOINT' && r.rec.body.job_id === jid) : undefined
    if (cp && BigInt(cp.rec.body.amount as string) > 0n && !landed.has(cp.hash)) {
      const amount = BigInt(cp.rec.body.amount as string)
      if (gross(amount, exempt) > j.held) log(`skip  CHECKPOINT #${cp.rec.seq} of job ${jid}: ${usd(amount)} + fee does not fit the hold ${usd(j.held)}`)
      else {
        const out = await send(`settle(job ${jid} ${label}, ${usd(amount)})  CHECKPOINT: pays #${cp.rec.seq} ${cp.hash.slice(0, 10)}.. whose settle never landed`, {
          fn: 'settle', args: [id, amount], expect: ['Settled'], job_id: jid,
          record: { type: 'CHECKPOINT', body: { ...cp.rec.body, signer: 'founder', reason: 'windDown', of: cp.hash } },
        })
        if (dry || out?.status === 'OK') pay = amount
      }
    }
    net += pay
    const release = j.held - gross(pay, exempt)
    await send(`close(job ${jid} ${label})  CLOSE emergency-wind-down, releases ${usd(release)}`, {
      fn: 'close', args: [id], expect: ['Closed'], job_id: jid,
      record: { type: 'CLOSE', body: { job_id: jid, signer: 'founder', reason: 'emergency-wind-down', accrued: 'unknown', settledNet: String(net) } },
    })
    committed -= release
    const last = mine.at(-1)
    unpaid.push(`UNPAID USAGE job ${jid} (${label}): usage after its last Settled (${last ? `block ${last.blockNumber}` : 'none'}${pay ? ' + the checkpoint paid above' : ''}) is NOT paid on chain` +
      (exempt ? `; kiln.jsonl says Kiln cost ${usd(kilnCost.micro)}${kilnCost.unknown ? ` (+${kilnCost.unknown} unknown)` : ''}, ${usd(j.paid + gross(pay, true))} reimbursed` : '; settle it with the vendor off-chain'))
  }

  // Every job is closed on chain now, so budget - committed never over-asks (OverBudget would HALT before any record).
  if (!dry) s = await snapshot(client, vault, { vendors: [] })
  const refund = s.budget - (dry ? committed : s.committed)
  await send(`refund(${usd(refund)})  SESSION_END anchors the tail`, {
    fn: 'refund', args: [refund], expect: ['Refunded'],
    record: { type: 'SESSION_END', body: {
      refund: String(refund), inference_usage: String(kilnCost.micro), kiln_calls: kiln.length, kiln_cost_unknown: kilnCost.unknown,
      jobs: s.jobs.flatMap((j, i) => (j.vendor.toLowerCase() === inf ? [] : [String(i)])),
    } },
  })

  if (!dry) {
    // run.json lastBlock: the auditor's replay must cover these txs (never below our own last mined block).
    const head = await client.getBlockNumber({ cacheTime: 0 })
    run.lastBlock = Number(head > lastBlock ? head : lastBlock)
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n')
  }
  log('')
  for (const u of unpaid) log(`!!! ${u}`)
  log(dry ? `DRY RUN: ${steps.length} step(s) planned, nothing sent` : `sent ${sent} tx(s); refunded ${usd(refund)} to the founder; run.json lastBlock ${run.lastBlock}`)
  log(`audit: node src/audit.ts ${dir}   (add --rpc URL if run.json's rpc is unreachable)`)
  return { sent, steps }
}

if (import.meta.main) {
  try {
    const { values: a, positionals } = parseArgs({
      allowPositionals: true,
      options: { rpc: { type: 'string' }, chain: { type: 'string' }, 'pay-last-checkpoint': { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    })
    if (positionals.length !== 1) throw new Error('usage: scripts/wind-down.ts runs/<vault> [--rpc URL] [--chain anvil|base-sepolia] [--pay-last-checkpoint] [--dry-run]')
    await emergencyWindDown(positionals[0], { rpc: a.rpc, chain: a.chain as ChainName | undefined, payLastCheckpoint: a['pay-last-checkpoint'], dryRun: a['dry-run'] })
  } catch (e) {
    console.error(`wind-down failed: ${errText(e)}`)
    process.exit(1)
  }
}
