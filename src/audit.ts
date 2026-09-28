// Third-party auditor (T9). A judge runs it on a committed bundle with only a public RPC:
//   node src/audit.ts runs/<vault> [--rpc URL] [--submission] [--json]
// Exit 0 PASS (WARN/INFO allowed) / 1 FAIL / 2 CANNOT_VERIFY (RPC unreachable, chainId mismatch, head < lastBlock, getLogs limits).
// Past vault state is rebuilt by REPLAYING vault events from deployBlock to lastBlock, never by archive eth_call.
// Import boundary (grep-tested): rules, parse, record, chainread, codes, spec, abi, types, node, viem. Nothing that signs or calls Kiln.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isAddress, TransactionReceiptNotFoundError, type Hex, type PublicClient } from 'viem'
import { vaultAbi } from './abi.ts'
import { errText, getLogsChunked, makePublicClient, type VaultLog } from './chainread.ts'
import { fromBytes32 } from './codes.ts'
import { parseVerdictRaw } from './parse.ts'
import { hashBytes, verifyChain, type Rec, type StoredRecord } from './record.ts'
import { check, gateInputFromJson, gross } from './rules.ts'
import { parseSpecForGate, verifySpec } from './spec.ts'
import type { ChainName, EventLine } from './types.ts'

export type Level = 'PASS' | 'FAIL' | 'WARN' | 'INFO'
export type Finding = { level: Level; check: string; msg: string }
export type Attack = { txHash: Hex; sender: Hex; event: string; code: string | null; rec: Hex | null }
export type AuditResult = {
  verdict: 'PASS' | 'FAIL' | 'CANNOT_VERIFY'
  exitCode: 0 | 1 | 2
  reason: string | null // CANNOT_VERIFY cause
  findings: Finding[]
  attacks: Attack[] // agent-key txs the backend never sent (listed apart from the 1:1 ledger)
}
export type AuditOpts = { client?: PublicClient; rpc?: string; submission?: boolean }

export const CHECKS: [id: string, name: string][] = [
  ['bundle', 'bundle'], ['1', 'records'], ['2', 'spec'], ['3', 'gated spend'], ['4', 'gate rules'], ['5', 'payee'],
  ['6', 'budget+fee'], ['7', 'live window'], ['8', 'denials'], ['receipts', 'receipts'], ['submission', 'submission'],
]

class CannotVerify extends Error {}
const rpcCall = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
  try { return await f() } catch (e) { throw new CannotVerify(`${what}: ${errText(e)}`) }
}

const eq = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const short = (h: string) => `${h.slice(0, 10)}..`
const SPEND = new Set(['HoldOpened', 'ToppedUp', 'Settled'])
/** Which record type each rec-carrying event must name (the orchestrator's tx -> record mapping). */
const EXPECT: Record<string, string[]> = {
  HoldOpened: ['DECISION'], ToppedUp: ['DECISION'], Settled: ['CHECKPOINT'], Closed: ['CLOSE'],
  Refunded: ['SESSION_END'], PausedSet: ['STOP'], Denied: ['DECISION', 'CHECKPOINT', 'CLOSE'],
}
const recOf = (ev: VaultLog): string | null => {
  const r = (ev.args.rec ?? ev.args.reasonHash) as string | undefined
  return r ? r.toLowerCase() : null
}

type Job = { vendor: string; held: bigint; paid: bigint; closed: boolean }
type State = { paused: boolean; deadline: bigint; budget: bigint; committed: bigint; maxHold: bigint; allowed: Map<string, boolean>; jobs: Job[] }

/** Contract state transition for one decoded vault event (Denied moves nothing). */
function apply(s: State, ev: VaultLog) {
  const a = ev.args as any
  const job = a.jobId === undefined ? undefined : s.jobs[Number(a.jobId)]
  switch (ev.name) {
    case 'Funded': s.budget = a.budget; s.deadline = BigInt(a.deadline); break
    case 'VendorSet': s.allowed.set(a.vendor.toLowerCase(), a.allowed); break
    case 'MaxHoldSet': s.maxHold = a.maxHold; break
    case 'PausedSet': s.paused = a.paused; break
    case 'HoldOpened': s.jobs[Number(a.jobId)] = { vendor: a.vendor.toLowerCase(), held: a.gross, paid: 0n, closed: false }; s.committed += a.gross; break
    case 'ToppedUp': if (job) job.held += a.gross; s.committed += a.gross; break
    case 'Settled': if (job) { job.held -= a.amount + a.fee; job.paid += a.amount + a.fee } break
    case 'Closed': if (job) { job.held = 0n; job.closed = true } s.committed -= a.released; break
    case 'Refunded': s.budget -= a.amount; break
  }
}

/** Every file in records/, hash recomputed from bytes. Tolerates unparseable files (they FAIL check 1). */
function loadRecords(dir: string, add: (l: Level, c: string, m: string) => void): StoredRecord[] {
  let files: string[] = []
  try { files = readdirSync(join(dir, 'records')).sort() } catch { add('FAIL', '1', 'no records/ directory') }
  const out: StoredRecord[] = []
  for (const file of files) {
    if (!/^\d{6}-0x[0-9a-f]{64}\.json$/.test(file)) { add('WARN', '1', `ignored non-record file records/${file}`); continue }
    const bytes = readFileSync(join(dir, 'records', file))
    const hash = hashBytes(bytes)
    let rec: Rec
    try { rec = JSON.parse(bytes.toString('utf8')) } catch { rec = null as unknown as Rec }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { // a tampered file must FAIL, never crash the auditor (exit 2)
      add('FAIL', '1', `${file}: not a JSON record object`)
      rec = { seq: -1, prev: '0x', type: 'DECISION', body: {} } as unknown as Rec
    }
    if (!rec.body || typeof rec.body !== 'object') rec.body = {}
    if (!file.includes(hash) && bytes.includes('\r\n')) {
      const lf = hashBytes(Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'))
      add('FAIL', '1', `${file}: contains CRLF${file.includes(lf) ? ' and matches its name after CRLF->LF' : ''}. ` +
        'Hint: this looks like a core.autocrlf checkout; re-clone with `git -c core.autocrlf=false clone` (runs/** is -text)')
    }
    out.push({ rec, hash, bytes, file })
  }
  return out
}

/** Walks a record body for KilnCall-shaped objects made in stub mode. */
function stubCalls(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + stubCalls(x), 0)
  if (!v || typeof v !== 'object') return 0
  const o = v as Record<string, unknown>
  const self = o.llm_mode === 'stub' || (typeof o.gen_id === 'string' && o.gen_id.startsWith('stub-')) ? 1 : 0
  return self + Object.values(o).reduce((n: number, x) => n + stubCalls(x), 0)
}

export async function audit(dir: string, o: AuditOpts = {}): Promise<AuditResult> {
  const findings: Finding[] = []
  const add = (level: Level, check: string, msg: string) => { findings.push({ level, check, msg }) }
  const attacks: Attack[] = []
  const pass: Record<string, string> = {}
  let reason: string | null = null
  try {
    await run(dir, o, add, attacks, pass)
  } catch (e) {
    if (!(e instanceof CannotVerify)) throw e
    reason = e.message
  }
  const failed = findings.some((f) => f.level === 'FAIL')
  if (!reason) for (const [id] of CHECKS) if (pass[id] && !findings.some((f) => f.check === id && f.level === 'FAIL')) add('PASS', id, pass[id])
  const order = (c: string) => CHECKS.findIndex(([id]) => id === c)
  findings.sort((a, b) => order(a.check) - order(b.check)) // stable: keeps insertion order inside a check
  const verdict = failed ? 'FAIL' : reason ? 'CANNOT_VERIFY' : 'PASS'
  return { verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2, reason, findings, attacks }
}

async function run(dir: string, o: AuditOpts, add: (l: Level, c: string, m: string) => void, attacks: Attack[], pass: Record<string, string>) {
  // ---------- local: bundle, records, spec bytes ----------
  let runJson: any
  try { runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) } catch (e) { add('FAIL', 'bundle', `run.json unreadable: ${(e as Error).message}`); return }
  const uint = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0
  if (!runJson || !isAddress(String(runJson.vault)) || !uint(runJson.chainId) || !uint(runJson.deployBlock) || !(runJson.lastBlock == null || uint(runJson.lastBlock))) {
    add('FAIL', 'bundle', 'run.json needs vault (address), chainId, deployBlock and lastBlock (integers, lastBlock may be null)')
    return
  }
  const vault = runJson.vault as Hex
  const chainId = Number(runJson.chainId)

  const recs = loadRecords(dir, add)
  for (const err of verifyChain(recs)) add('FAIL', '1', err)
  const byHash = new Map<string, StoredRecord>()
  for (const r of recs) if (r.rec.seq >= 0) byHash.set(r.hash.toLowerCase(), r)
  if (!recs.length) add('FAIL', '1', 'no records')

  const backend = new Set<string>() // tx hashes the backend's commit() queue signed
  const broadcast = new Set<string>() // ... and sent: each must still have a receipt
  if (existsSync(join(dir, 'events.jsonl'))) {
    for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let ev: EventLine
      try { ev = JSON.parse(line) } catch { add('WARN', 'receipts', 'events.jsonl: unparseable line skipped'); continue }
      if (ev.src !== 'commit' || typeof ev.txHash !== 'string') continue
      backend.add(ev.txHash.toLowerCase())
      if (ev.ev === 'sent' || ev.ev === 'mined') broadcast.add(ev.txHash.toLowerCase())
    }
  } else add('WARN', 'receipts', 'no events.jsonl: every agent tx is treated as outside the backend')

  // check 2 (local half)
  const ss = recs[0]
  let specBytes: Buffer | null = null
  let sig: Hex | null = null
  let spec: any = null
  try { specBytes = readFileSync(join(dir, 'spec.json')); sig = readFileSync(join(dir, 'spec.sig'), 'utf8').trim() as Hex } catch { add('FAIL', '2', 'spec.json or spec.sig missing') }
  if (!ss || ss.rec.type !== 'SESSION_START') add('FAIL', '2', 'records[0] is not SESSION_START')
  else if (specBytes && sig) {
    const b = ss.rec.body as any
    if (typeof b.spec_raw !== 'string' || !Buffer.from(b.spec_raw, 'utf8').equals(specBytes)) add('FAIL', '2', 'SESSION_START.spec_raw != spec.json bytes')
    if (!eq(b.spec_sig, sig)) add('FAIL', '2', 'SESSION_START.spec_sig != spec.sig')
    // deployBlock too: the anchored record pins where the replay must start (run.json is not anchored)
    if (!eq(b.vault, vault) || Number(b.chainId) !== chainId || Number(b.deployBlock) !== runJson.deployBlock) {
      add('FAIL', '2', `SESSION_START is for ${b.vault} on ${b.chainId} from block ${b.deployBlock}, run.json says ${vault} on ${chainId} from block ${runJson.deployBlock}`)
    }
  }
  if (specBytes) {
    try { spec = JSON.parse(specBytes.toString('utf8')) } catch { add('FAIL', '2', 'spec.json is not JSON') }
    if (spec) {
      if (!eq(spec.vault, vault)) add('FAIL', '2', `spec is for vault ${spec.vault}, the run is vault ${vault}`)
      if (spec.chain_id !== chainId) add('FAIL', '2', `spec.chain_id ${spec.chain_id} != chainId ${chainId}`)
      for (const r of recs) if (r.rec.type === 'DECISION' && (r.rec.body as any).spec_id !== spec.spec_id) add('FAIL', '2', `${r.file}: spec_id ${(r.rec.body as any).spec_id} != ${spec.spec_id}`)
    }
  }
  // check 2: the price book is the anchored one. keccak(prices/akash.json) == SESSION_START.prices.snapshotHash, and the
  // vendors the gate read (SESSION_START.prices, check 4) are the ones in that file.
  if (ss?.rec.type === 'SESSION_START') {
    const p = (ss.rec.body as any).prices
    let bytes: Buffer | null = null
    try { bytes = readFileSync(join(dir, 'prices', 'akash.json')) } catch { add('FAIL', '2', 'prices/akash.json missing') }
    if (bytes && !eq(hashBytes(bytes), p?.snapshotHash)) add('FAIL', '2', `keccak(prices/akash.json) ${short(hashBytes(bytes))} != SESSION_START.prices.snapshotHash ${short(String(p?.snapshotHash))}`)
    else if (bytes) {
      let f: any = null
      try { f = JSON.parse(bytes.toString('utf8')) } catch {}
      if (f?.source !== p?.source || JSON.stringify(f?.vendors) !== JSON.stringify(p?.vendors)) add('FAIL', '2', 'prices/akash.json source/vendors != SESSION_START.prices')
    }
  }
  let specGate: ReturnType<typeof parseSpecForGate> | null = null
  try { if (specBytes) specGate = parseSpecForGate(specBytes) } catch (e) { add('FAIL', '2', `spec.json: ${(e as Error).message}`) }

  if (o.submission) {
    const stubs = recs.filter((r) => stubCalls(r.rec.body) > 0)
    if (stubs.length) add('FAIL', 'submission', `stub Kiln calls in ${stubs.length} record(s) (first ${stubs[0].file}): a submission bundle must be LLM_MODE=kiln`)
    else if ((ss?.rec.body as any)?.flags?.LLM_MODE === 'stub') add('FAIL', 'submission', 'SESSION_START flags say LLM_MODE=stub')
    else pass.submission = 'no stub Kiln calls in any record'
  }

  // ---------- chain: connectivity, immutables, logs ----------
  let client = o.client
  if (!client) {
    const url = o.rpc ?? runJson.rpc
    client = await rpcCall('RPC client', async () => makePublicClient(runJson.chain as ChainName, [url]))
  }
  const c = client
  const gotId = await rpcCall('RPC unreachable', () => c.getChainId())
  if (gotId !== chainId) throw new CannotVerify(`RPC chainId ${gotId} != run.json chainId ${chainId}`)
  const head = await rpcCall('getBlockNumber', () => c.getBlockNumber({ cacheTime: 0 }))
  if (runJson.lastBlock == null) add('WARN', 'bundle', `run.json lastBlock is null (session did not finish): auditing up to head ${head}`)
  const last = runJson.lastBlock == null ? head : BigInt(runJson.lastBlock)
  if (head < last) throw new CannotVerify(`RPC head ${head} < run.json lastBlock ${last}`)
  const read = (functionName: string) => rpcCall(`vault.${functionName}()`, () => c.readContract({ address: vault, abi: vaultAbi, functionName } as any) as Promise<Hex>)
  const founder = await read('founder')
  const agent = await read('agent')
  const infPayee = await read('inferencePayee')
  const logs = await rpcCall('getLogs', () => getLogsChunked(c, vault, BigInt(runJson.deployBlock), last))

  const sender = new Map<string, Hex>()
  for (const h of new Set(logs.map((l) => l.txHash.toLowerCase()))) sender.set(h, (await rpcCall('getTransaction', () => c.getTransaction({ hash: h as Hex }))).from)
  const decisions = recs.filter((r) => r.rec.type === 'DECISION' && (r.rec.body as any).gate?.input != null)
  const giBlock = (r: StoredRecord): bigint | null => { try { const b = BigInt((r.rec.body as any).gate.input.chain.block); return b <= last ? b : null } catch { return null } }
  const blockTs = new Map<bigint, bigint>()
  for (const b of new Set([...logs.map((l) => l.blockNumber), ...decisions.map(giBlock).filter((b) => b !== null)])) {
    blockTs.set(b, (await rpcCall('getBlock', () => c.getBlock({ blockNumber: b }))).timestamp)
  }

  // check 2 (chain half): signer == vault.founder()
  if (specBytes && sig) {
    let signer: Hex | null = null
    try { signer = await verifySpec(specBytes, sig) } catch (e) { add('FAIL', '2', `spec.sig does not verify: ${(e as Error).message}`) }
    if (signer && !eq(signer, founder)) add('FAIL', '2', `spec signed by ${signer}, vault.founder() is ${founder}`)
    pass['2'] = `spec ${spec?.spec_id} for this vault/chain, signed by vault.founder() ${founder}; prices/akash.json matches the anchored snapshotHash`
  }

  // ---------- replay ----------
  const recCount = new Map<string, VaultLog[]>()
  for (const ev of logs) { const r = recOf(ev); if (r) recCount.set(r, [...(recCount.get(r) ?? []), ev]) }
  const initial: State = { paused: false, deadline: 0n, budget: 0n, committed: 0n, maxHold: 0n, allowed: new Map(), jobs: [] }
  const s = structuredClone(initial)
  const states: { block: bigint; st: State }[] = []
  const seen = new Set<string>()
  const overridden = new Set<string>() // enforced Denied tx hashes whose rec is an approving DECISION
  let lastAnchor: VaultLog | null = null
  const gatedGross: { block: bigint; gross: bigint }[] = []
  const n = { spend: 0, settle: 0, agentSpend: 0, denied: 0, deniedRecorded: 0 }

  for (const ev of logs) {
    const a = ev.args as any
    const tx = ev.txHash.toLowerCase()
    const from = sender.get(tx)!
    const isAgent = eq(from, agent)
    const isFounder = eq(from, founder)
    const attack = isAgent && !backend.has(tx) // agent key used outside the backend's commit() queue
    const rec = recOf(ev)
    const r = rec ? byHash.get(rec) : undefined
    const b = (r?.rec.body ?? {}) as any
    const ts = blockTs.get(ev.blockNumber)!
    const where = `${ev.name} (block ${ev.blockNumber}, tx ${short(tx)})`
    const job = a.jobId === undefined ? undefined : s.jobs[Number(a.jobId)]
    const code = ev.name === 'Denied' ? fromBytes32(a.code) : null
    if (attack) attacks.push({ txHash: tx as Hex, sender: from, event: ev.name, code, rec: (rec as Hex) ?? null })
    if (rec && !attack) lastAnchor = ev

    try {
      // check 1: rec names a record of the right kind (backend/founder txs); unknown recs elsewhere
      if (rec && !r) {
        if (SPEND.has(ev.name)) add('FAIL', '3', `UNGATED_SPEND: ${where} rec ${short(rec)} names no record (sender ${from})`)
        else if (attack) add('WARN', '8', `UNRECORDED_ATTEMPT: ${where} sender ${from}${code ? ` code ${code}` : ''} rec ${short(rec)}`)
        else add('FAIL', '1', `${where} from ${isFounder ? 'founder' : 'backend'} carries rec ${short(rec)} that names no record`)
      } else if (r && !attack && !EXPECT[ev.name].includes(r.rec.type)) add('FAIL', '1', `${where} rec names a ${r.rec.type} record (${r.file}), expected ${EXPECT[ev.name].join('/')}`)

      // check 3: every spend is gated by its own record
      if (SPEND.has(ev.name) && r) {
        n.spend++
        const bad: string[] = []
        if (seen.has(rec!)) bad.push('its rec was already used by an earlier event')
        if (ev.name === 'Settled') {
          if (r.rec.type !== 'CHECKPOINT') bad.push(`rec is ${r.rec.type}, not CHECKPOINT`)
          else if (b.job_id !== String(a.jobId) || b.amount !== String(a.amount)) bad.push(`CHECKPOINT says job ${b.job_id} amount ${b.amount}, event job ${a.jobId} amount ${a.amount}`)
        } else {
          const vendor = ev.name === 'HoldOpened' ? a.vendor : job?.vendor
          const inference = eq(vendor, infPayee)
          if (r.rec.type !== 'DECISION') bad.push(`rec is ${r.rec.type}, not DECISION`)
          else {
            const action = ev.name === 'ToppedUp' ? 'topUp' : inference ? 'inference' : 'open'
            if (b.action !== action) bad.push(`DECISION action ${b.action}, expected ${action}`)
            if (!Array.isArray(b.gate?.codes) || b.gate.codes.length) bad.push(`gate.codes ${JSON.stringify(b.gate?.codes)} not []`)
            if (b.verdict?.approve !== true) bad.push('verdict is not approve')
            // a null gate.input would skip check 4 entirely: a spend must carry the gate input it was judged on,
            // read at a block mined BEFORE the spend (a later "read" could be fitted to the result)
            if (b.gate?.input == null) bad.push('gate.input is null (the gate cannot be re-run)')
            else { let blk: bigint | null = null; try { blk = BigInt(b.gate.input.chain.block) } catch {} if (blk !== null && blk >= ev.blockNumber) bad.push(`gate read at block ${blk}, not before the spend`) }
            if (!inference) { // D2: the inference hold needs only the gate record
              const f2 = Array.isArray(b.f2) ? b.f2.at(-1) : undefined
              if (!f2) bad.push('no F2 call recorded')
              else if (!parseVerdictRaw(f2.raw, f2.finish_reason).approve) bad.push('last F2 raw does not parse to approve')
            }
            if (!eq(b.request?.vendor, vendor)) bad.push(`request.vendor ${b.request?.vendor} != paid vendor ${vendor}`)
            if (gross(BigInt(b.request?.amount), inference) !== a.gross) bad.push(`gross(request.amount ${b.request?.amount}) != event gross ${a.gross}`)
            if (ev.name === 'ToppedUp' && b.job_id !== String(a.jobId)) bad.push(`DECISION job ${b.job_id} != event job ${a.jobId}`)
          }
        }
        if (bad.length) add('FAIL', '3', `${bad[0].startsWith('its rec') ? 'UNGATED_SPEND: ' : ''}${where} (${r.file}): ${bad.join('; ')}`)
      }

      // check 5: pays job.vendor; an agent settle also needs the vendor allowlisted now
      if (ev.name === 'Settled') {
        n.settle++
        if (!job) add('FAIL', '5', `${where} settles unknown job ${a.jobId}`)
        else {
          if (!eq(a.vendor, job.vendor)) add('FAIL', '5', `${where} pays ${a.vendor}, job ${a.jobId} vendor is ${job.vendor}`)
          if (isAgent && !s.allowed.get(job.vendor)) add('FAIL', '5', `${where} agent settle to ${a.vendor}, not allowlisted at that point`)
          // check 6: per-settle fee floor, 0 for the inference payee
          const fee = eq(job.vendor, infPayee) ? 0n : (a.amount * 300n) / 10_000n
          if (a.fee !== fee) add('FAIL', '6', `${where} fee ${a.fee} != floor(${a.amount}*300/10000) = ${fee}`)
          if (a.amount + a.fee > job.held) add('FAIL', '6', `${where} pays ${a.amount + a.fee} gross from a hold of ${job.held}`)
        }
      }
      if (ev.name === 'Closed' && job && a.released !== job.held) add('FAIL', '6', `${where} released ${a.released} but the replayed hold is ${job.held} (replay diverges)`)

      // check 7: agent spends inside the live window (state before this event)
      if (SPEND.has(ev.name) && isAgent) {
        n.agentSpend++
        if (s.paused) add('FAIL', '7', `${where} agent spend while paused`)
        if (ts >= s.deadline) add('FAIL', '7', `${where} agent spend at ${ts} >= deadline ${s.deadline}`)
      }

      // check 8: denials
      if (ev.name === 'Denied') {
        n.denied++
        if (r) {
          n.deniedRecorded++
          if (!attack && a.enforced === false && (r.rec.type !== 'DECISION' || b.verdict?.approve !== false || b.verdict.code !== code)) {
            add('FAIL', '8', `${where} recordDecision(${code}) but ${r.file} is not a DECISION denying with ${code}`)
          }
          if (a.enforced && r.rec.type === 'DECISION' && b.verdict?.approve === true) overridden.add(tx)
        }
      }
      // an attacker replaying (or front-running) a backend rec in a Denied must not turn the real spend into a FAIL
      if (rec && (!attack || SPEND.has(ev.name))) seen.add(rec)
      // Σ gross of gated vendor spends: the recorded gate specGross may not be below it (OVER_JOB_CAP)
      if ((ev.name === 'HoldOpened' || ev.name === 'ToppedUp') && r?.rec.type === 'DECISION' && !eq(ev.name === 'HoldOpened' ? a.vendor : job?.vendor, infPayee)) {
        gatedGross.push({ block: ev.blockNumber, gross: a.gross })
      }
    } catch (e) {
      add('FAIL', r ? '3' : '1', `${where}: malformed record ${r?.file ?? ''}: ${(e as Error).message}`)
    }

    apply(s, ev)
    if (s.committed > s.budget) add('FAIL', '6', `after ${where}: committed ${s.committed} > budget ${s.budget}`)
    if (job && job.held < 0n) add('FAIL', '6', `after ${where}: job ${a.jobId} hold negative (${job.held})`)
    states.push({ block: ev.blockNumber, st: structuredClone(s) })
  }

  // check 8: CHAIN_DENIED records (INFO), then any unrecorded override, then duplicate refs
  for (const r of recs.filter((x) => x.rec.type === 'CHAIN_DENIED')) {
    const b = r.rec.body as any
    const ev = logs.find((l) => l.name === 'Denied' && l.args.enforced && eq(l.txHash, b.txHash) && recOf(l) === String(b.approval).toLowerCase())
    if (!ev) add('FAIL', '8', `${r.file}: CHAIN_DENIED names no enforced Denied for approval ${short(String(b.approval))} in tx ${short(String(b.txHash))}`)
    else {
      overridden.delete(ev.txHash.toLowerCase())
      add('INFO', '8', `CHAIN_OVERRIDE: job ${b.job_id} approval ${short(b.approval)} was answered Denied(${fromBytes32(ev.args.code as Hex)}) by the contract (tx ${short(ev.txHash)})`)
    }
  }
  for (const tx of overridden) add('INFO', '8', `CHAIN_OVERRIDE: approved DECISION denied on-chain in tx ${short(tx)} (no CHAIN_DENIED record)`)
  for (const [rec, evs] of recCount) {
    if (evs.length > 1) add('WARN', '8', `DUPLICATE_REC_REF: rec ${short(rec)} on ${evs.length} events: ${evs.map((e) => `${e.name}@${e.blockNumber} from ${sender.get(e.txHash.toLowerCase())}`).join(', ')}`)
  }

  // bundle: the replay must cover everything the vault ever did. A late deployBlock or an early lastBlock would hide
  // spends from every check, so the replayed end state must equal the vault's state now (plain reads, not archive).
  if (runJson.lastBlock != null) {
    const [jobs, committed, budget] = [await read('jobCount'), await read('committed'), await read('budget')] as unknown as bigint[]
    if (jobs !== BigInt(s.jobs.length) || committed !== s.committed || budget !== s.budget) {
      add('FAIL', 'bundle', `vault now has ${jobs} jobs, committed ${committed}, budget ${budget}; the replay of blocks ${runJson.deployBlock}..${last} ends at ` +
        `${s.jobs.length} jobs, committed ${s.committed}, budget ${s.budget}: vault activity outside the audited range (deployBlock too late, lastBlock too early, or txs after the session)`)
    }
  }

  // check 1: the tail is anchored by the last non-attack rec-carrying event
  const lastRec = recs.at(-1)
  const anchoredSeqs = recs.filter((r) => recCount.has(r.hash.toLowerCase())).map((r) => r.rec.seq)
  const upTo = anchoredSeqs.length ? Math.max(...anchoredSeqs) : -1
  if (lastRec && (!lastAnchor || recOf(lastAnchor) !== lastRec.hash.toLowerCase())) {
    add('FAIL', '1', `UNANCHORED_TAIL: last record #${lastRec.rec.seq} (${short(lastRec.hash)}) is not the rec of the last on-chain event ` +
      `${lastAnchor ? `${lastAnchor.name}@${lastAnchor.blockNumber} rec ${short(recOf(lastAnchor)!)}` : '(none)'}; anchored up to #${upTo} / ${recs.length}`)
  }
  pass['1'] = `${recs.length} records, hashes and prev chain intact, anchored up to #${upTo} / ${recs.length}`

  // check 4: re-run the gate on every recorded input; chain fields must equal the replay at that block
  const stateAtEnd = (blk: bigint): State | null => {
    if (blk < BigInt(runJson.deployBlock) || blk > last) return null
    let st = initial
    for (const x of states) if (x.block <= blk) st = x.st
    return st
  }
  const ssBody = (ss?.rec.type === 'SESSION_START' ? ss.rec.body : {}) as any
  const overrides = recs.flatMap((r) => (r.rec.type === 'DECISION' && Array.isArray((r.rec.body as any).overrides) ? (r.rec.body as any).overrides : []))
  const marketValues = (label: string, f: 'pricePerHour' | 'available') => [
    String(ssBody.prices?.vendors?.[label]?.[f] ?? 0), // session.market(): an unknown label reads { 0, 0 }
    ...overrides.filter((o: any) => o?.field === `market.${label}.${f}`).map((o: any) => String(o.to)),
  ]
  for (const r of decisions) {
    const b = r.rec.body as any
    try {
      const gi = gateInputFromJson(b.gate.input)
      const codes = check(gi)
      if (JSON.stringify(codes) !== JSON.stringify(b.gate.codes)) add('FAIL', '4', `${r.file}: rules.check = ${JSON.stringify(codes)}, record says ${JSON.stringify(b.gate.codes)}`)
      if (codes.length && (b.verdict?.approve !== false || b.verdict.code !== codes[0])) add('FAIL', '4', `${r.file}: gate denied ${codes[0]} but verdict is ${JSON.stringify(b.verdict)}`)
      if (gi.kind !== b.action) add('FAIL', '4', `${r.file}: gate.input.kind ${gi.kind} != action ${b.action}`)
      if (!eq(gi.request.vendor, b.request?.vendor) || gi.request.gpu !== b.request?.gpu || String(gi.request.amount) !== b.request?.amount) add('FAIL', '4', `${r.file}: gate.input.request != the frozen request`)
      if (specGate && (gi.spec.job_cap !== specGate.job_cap || gi.spec.deadline !== specGate.deadline || JSON.stringify(gi.spec.allowed_gpu_types) !== JSON.stringify(specGate.allowed_gpu_types))) {
        add('FAIL', '4', `${r.file}: gate.input.spec differs from the signed spec`)
      }
      const blk = gi.chain.block
      if (gi.kind !== 'inference') {
        // market: the anchored SESSION_START price snapshot for this vendor, or a value a recorded scenario Override set
        const label = Object.entries(ssBody.vendors ?? {}).find(([, v]) => eq(v, gi.request.vendor))?.[0] ?? '?'
        const bad = (['pricePerHour', 'available'] as const).filter((f) => !marketValues(label, f).includes(String(gi.market[f])))
        if (bad.length) add('FAIL', '4', `${r.file}: gate.input.market ${bad.map((f) => `${f} ${gi.market[f]}`).join(', ')} is neither SESSION_START.prices ${label} nor a recorded override`)
        const spent = gatedGross.filter((x) => x.block <= blk).reduce((t, x) => t + x.gross, 0n)
        if (gi.specGross < spent) add('FAIL', '4', `${r.file}: gate.input.specGross ${gi.specGross} < ${spent} gross already reserved by gated spends up to block ${blk} (hides OVER_JOB_CAP)`)
      }
      const st = stateAtEnd(blk)
      if (!st) { add('FAIL', '4', `${r.file}: gate read at block ${blk}, outside the replayed range`); continue }
      const want: [string, unknown, unknown][] = [
        ['paused', gi.chain.paused, st.paused], ['deadline', gi.chain.deadline, st.deadline], ['budget', gi.chain.budget, st.budget],
        ['committed', gi.chain.committed, st.committed], ['maxHold', gi.chain.maxHold, st.maxHold],
        ['vendorAllowed', gi.chain.vendorAllowed, st.allowed.get(gi.request.vendor.toLowerCase()) ?? false],
        ['blockTs', gi.chain.blockTs, blockTs.get(blk)], ['inferencePayee', gi.chain.inferencePayee.toLowerCase(), infPayee.toLowerCase()],
      ]
      const diff = want.filter(([, got, exp]) => got !== exp)
      if (diff.length) add('FAIL', '4', `${r.file}: chain read != replay at end of block ${blk}: ${diff.map(([k, got, exp]) => `${k} recorded ${got}, replay ${exp}`).join('; ')}`)
    } catch (e) {
      add('FAIL', '4', `${r.file}: gate.input malformed: ${(e as Error).message}`)
    }
  }

  // receipts: every tx the backend broadcast is still on chain, inside the audited range
  for (const h of broadcast) {
    try {
      const rc = await c.getTransactionReceipt({ hash: h as Hex })
      if (rc.blockNumber > last) add('FAIL', 'receipts', `tx ${short(h)} mined at ${rc.blockNumber} > lastBlock ${last}`)
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) add('FAIL', 'receipts', `no receipt for backend tx ${h} (reorged or never mined)`)
      else throw new CannotVerify(`getTransactionReceipt: ${errText(e)}`)
    }
  }

  pass['3'] = `${n.spend} spend events, each gated by its own record`
  pass['4'] = `${decisions.length} recorded gate inputs re-checked against the replay`
  pass['5'] = `${n.settle} settles paid job.vendor`
  pass['6'] = `committed <= budget over ${logs.length} events, per-settle fees exact`
  pass['7'] = `${n.agentSpend} agent spends while unpaused and before the deadline`
  pass['8'] = `${n.denied} Denied events, ${n.deniedRecorded} with a record`
  pass.receipts = `${broadcast.size} backend tx receipts present`
  pass.bundle = `vault ${vault} chain ${chainId}, blocks ${runJson.deployBlock}..${last}, ${attacks.length} tx(s) outside the backend`
}

export function formatResult(r: AuditResult): string {
  const name = (id: string) => (/^\d$/.test(id) ? `check ${id} (${CHECKS.find(([c]) => c === id)![1]})` : id)
  const lines = r.findings.map((f) => `[${f.level}] ${name(f.check)}: ${f.msg}`)
  const count = (l: Level) => r.findings.filter((f) => f.level === l).length
  const tail = r.verdict === 'CANNOT_VERIFY' ? `: ${r.reason}`
    : ` (${count('FAIL')} FAIL, ${count('WARN')} WARN, ${count('INFO')} INFO)${r.reason ? `; chain checks incomplete: ${r.reason}` : ''}`
  return [...lines, `AUDIT ${r.verdict} (exit ${r.exitCode})${tail}`].join('\n')
}

if (import.meta.main) {
  let out: AuditResult
  let json = false
  try {
    const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { rpc: { type: 'string' }, submission: { type: 'boolean' }, json: { type: 'boolean' } } })
    json = a.json === true
    if (positionals.length !== 1) throw new Error('usage: node src/audit.ts runs/<vault> [--rpc URL] [--submission] [--json]')
    out = await audit(positionals[0], { rpc: a.rpc, submission: a.submission })
  } catch (e) {
    console.error(`audit error: ${errText(e)}`)
    process.exit(2) // the auditor itself failed: nothing was verified, so never report it as a bundle FAIL
  }
  console.log(json ? JSON.stringify(out, null, 2) : formatResult(out))
  process.exit(out.exitCode)
}
