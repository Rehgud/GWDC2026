// T12: token + energy report for one run bundle runs/<vault>/ (kiln.jsonl, records/, events.jsonl, run.json, nothink.jsonl).
// nothink.jsonl is read from the bundle, else from runs/eval/ where scripts/nothink-compare.ts writes it.
// Every table comes from the same files. A missing or partial file renders "no data"; it never throws.
// CLI: node src/report.ts runs/<vault>   -> prints the markdown and writes runs/<vault>/report.md
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fromBytes32 } from './codes.ts'
import { costToMicro } from './kiln.ts'
import { hashBytes, type Decision, type Rec } from './record.ts'

/** Joules per completion token (section 6 states the sources and assumptions). */
export const J = { rngd: 1.63, rtx: 4.02, upper: 11.9 } as const

type Usage = { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; cost?: number | null }
/** One kiln.jsonl line = one HTTP attempt (failed ones included). */
type KilnLine = {
  ts?: number; flow: 'F1' | 'F2' | 'F3'; req_id: string | null; job_id: string | null; attempt: number
  http: number | null; latency_ms: number; gen_id: string | null; usage: Usage | null
  cost_known?: boolean; finish_reason?: string | null; llm_mode?: string
}
type Settle = { job: string; vendor: string | null; amount: bigint; fee: bigint; tx: string | null }

// ---------- reading (tolerant) ----------

const text = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const big = (x: unknown) => { try { return BigInt(x as string) } catch { return null } }
const str = (x: unknown) => (x == null ? null : String(x))
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : [])
/** Same rule as kiln.costToMicro: a cost is known only if it is a finite number >= 0. */
const knownCost = (l: { usage?: Usage | null; cost_known?: boolean }) =>
  l.cost_known !== false && typeof l.usage?.cost === 'number' && Number.isFinite(l.usage.cost) && l.usage.cost >= 0 ? l.usage.cost : null

function jsonl(p: string) {
  const t = text(p), rows: any[] = []
  let bad = 0
  for (const l of t?.split('\n') ?? []) {
    if (!l.trim()) continue
    try { rows.push(JSON.parse(l)) } catch { bad++ }
  }
  return { found: t !== null, rows, bad }
}

/** Like record.readChain, but a truncated file is counted instead of thrown. Hash = keccak of the bytes. */
function readRecords(dir: string) {
  let files: string[] | null = null
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch {}
  const recs: { rec: Rec; hash: string }[] = []
  let bad = 0
  for (const f of files ?? []) {
    try { const b = readFileSync(join(dir, f)); recs.push({ rec: JSON.parse(b.toString('utf8')), hash: hashBytes(b) }) } catch { bad++ }
  }
  return { found: files !== null, recs, bad }
}

const isStub = (c: { gen_id?: string | null; llm_mode?: string }) => c.llm_mode === 'stub' || !!c.gen_id?.startsWith('stub-')

// ---------- aggregation ----------

/** Nearest-rank percentile, p in whole percent (integer math: 0.95 * 60 is 57.00000000000001 in floats). */
export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(1, Math.ceil((p * s.length) / 100)) - 1]
}

/** Token/cost sums. Cost is summed exactly in pico-USD. Unknown = no reported cost (timeout may still be billed): counted, not guessed. */
function sum(ls: { usage?: Usage | null; cost_known?: boolean; latency_ms?: number; http?: number | null }[]) {
  const s = { n: ls.length, withUsage: 0, prompt: 0, completion: 0, reasoning: 0, pico: 0n, costN: 0, unknown: 0, lat: [] as number[], latOk: [] as number[] }
  for (const l of ls) {
    const u = l.usage
    if (u) {
      s.withUsage++
      s.prompt += Number(u.prompt_tokens) || 0
      s.completion += Number(u.completion_tokens) || 0
      s.reasoning += Number(u.reasoning_tokens) || 0
    }
    const c = knownCost(l)
    if (c === null) s.unknown++
    else { s.pico += BigInt(Math.round(c * 1e12)); s.costN++ }
    if (typeof l.latency_ms === 'number') { s.lat.push(l.latency_ms); if (l.http === 200) s.latOk.push(l.latency_ms) }
  }
  return s
}
type Sum = ReturnType<typeof sum>

/** Groups attempts into logical calls: attempt 1 starts a call, later attempts join the open call with the same flow/req/job. */
function calls(ls: KilnLine[]) {
  const out: KilnLine[][] = [], open = new Map<string, KilnLine[]>()
  for (const l of ls) {
    const k = `${l.flow}|${l.req_id}|${l.job_id}`
    let c = open.get(k)
    if (!c || !(l.attempt > 1)) { c = []; out.push(c); open.set(k, c) }
    c.push(l)
  }
  return out
}

function flowStats(ls: KilnLine[]) {
  const cs = calls(ls)
  return {
    ...sum(ls),
    calls: cs.length,
    retried: cs.filter((c) => c.length > 1).length,
    failedCalls: cs.filter((c) => !c.some((l) => l.http === 200)).length,
    failed: ls.filter((l) => l.http !== 200).length,
    r429: ls.filter((l) => l.http === 429).length,
    timeout: ls.filter((l) => l.http == null).length,
    r5xx: ls.filter((l) => (l.http ?? 0) >= 500).length,
    truncated: ls.filter((l) => l.finish_reason === 'length').length,
    stub: ls.filter(isStub).length,
  }
}

type ReqOutcome = 'APPROVED_ONCHAIN' | 'GATE_DENIED' | 'QWEN_DENIED' | 'QWEN_NOT_A_JUDGEMENT' | 'CHAIN_DENIED' | 'OPS_DENIED' | 'TX_ERROR' | 'APPROVED_NO_TX' | 'NO_RECORD'

const chainCode = (x: unknown) => (typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x) ? fromBytes32(x as `0x${string}`) : str(x))

/** APPROVED_ONCHAIN needs verdict.approve === true, a mined OK commit and no Denied event in that tx. */
function classify(d: Decision, c: any, chainDenied: Rec | undefined): [ReqOutcome, string] {
  if (d.verdict?.approve === true) {
    const denied = arr(c?.events).find((e) => e?.name === 'Denied')
    if (chainDenied || c?.status === 'DENIED' || denied) return ['CHAIN_DENIED', chainCode(chainDenied?.body?.code ?? c?.code ?? denied?.args?.code) ?? '?']
    if (c?.status === 'OK') return ['APPROVED_ONCHAIN', '']
    return c ? ['TX_ERROR', String(c.status ?? 'UNCONFIRMED')] : ['APPROVED_NO_TX', '']
  }
  const code = String((d.verdict as { code?: string } | undefined)?.code ?? '?')
  const gate = arr(d.gate?.codes)
  if (gate.length) return ['GATE_DENIED', gate.join('+')]
  if (code === 'QWEN_DENIED') return ['QWEN_DENIED', code]
  if (code === 'QWEN_UNAVAILABLE' || code === 'QWEN_UNPARSEABLE') return ['QWEN_NOT_A_JUDGEMENT', code]
  return ['OPS_DENIED', code] // READ_FAILED, TOPUP_TIMEOUT, LLM_CALL_CAP
}

const opened = (c: any) => arr(c?.events).find((e) => e?.name === 'HoldOpened')?.args
const openedJob = (c: any) => (c?.status === 'OK' ? str(c.jobId ?? opened(c)?.jobId) : null)

// ---------- analysis ----------

export function analyze(dir: string) {
  const kiln = jsonl(join(dir, 'kiln.jsonl'))
  const lines: KilnLine[] = kiln.rows.filter((l) => l && ['F1', 'F2', 'F3'].includes(l.flow))
  const events = jsonl(join(dir, 'events.jsonl'))
  const records = readRecords(join(dir, 'records'))
  let nothinkPath = join(dir, 'nothink.jsonl')
  let nothink = jsonl(nothinkPath)
  if (!nothink.found) nothink = jsonl((nothinkPath = join(dir, '..', 'eval', 'nothink.jsonl')))
  const runText = text(join(dir, 'run.json'))
  let run: any = null
  try { run = runText === null ? null : JSON.parse(runText) } catch {}

  // commit() lines (intent/sent/mined...) merged per recHash; the last value of each field wins. windDown also sends txs.
  const commits = new Map<string, any>()
  for (const e of events.rows) {
    if ((e?.src !== 'commit' && e?.src !== 'windDown') || typeof e.recHash !== 'string') continue
    const k = e.recHash.toLowerCase()
    commits.set(k, { ...commits.get(k), ...e })
  }

  const decisions = records.recs.filter((r) => r.rec?.type === 'DECISION')
  const chainDenied = new Map<string, Rec>()
  for (const r of records.recs) if (r.rec?.type === 'CHAIN_DENIED') chainDenied.set(String(r.rec.prev).toLowerCase(), r.rec)

  // ---- per request (F1 -> gate -> F2 -> tx) ----
  const reqLines = new Map<string, KilnLine[]>()
  for (const l of lines) if (l.flow !== 'F3' && l.req_id != null) reqLines.set(l.req_id, [...(reqLines.get(l.req_id) ?? []), l])
  const requests = decisions.map(({ rec, hash }) => {
    const d = (rec.body ?? {}) as unknown as Decision
    const c = commits.get(hash)
    const [outcome, code] = classify(d, c, chainDenied.get(hash))
    return {
      req_id: String(d.req_id), action: String(d.action), job: str(d.job_id) ?? openedJob(c), outcome, code,
      recHash: hash as string | null, tx: str(c?.txHash), recAttempts: [arr(d.f1).length, arr(d.f2).length],
      inferenceHold: d.action === 'inference' ? big((d.gate?.input as any)?.request?.amount) : null,
    }
  })
  const recorded = new Set(requests.map((r) => r.req_id))
  for (const [id, ls] of reqLines) {
    if (!recorded.has(id)) requests.push({ req_id: id, action: '?', job: ls.find((l) => l.job_id)?.job_id ?? null, outcome: 'NO_RECORD', code: '', recHash: null, tx: null, recAttempts: [0, 0], inferenceHold: null })
  }
  const claimed = new Set<string>() // a req_id shared by two records gets its lines once (the later row shows "(rec n)")
  const reqs = requests.map((r) => {
    const ls = claimed.has(r.req_id) ? [] : reqLines.get(r.req_id) ?? []
    claimed.add(r.req_id)
    return { ...r, ...sum(ls), f1: ls.filter((l) => l.flow === 'F1').length, f2: ls.filter((l) => l.flow === 'F2').length }
  })
  const reqJob = new Map(reqs.map((r) => [r.req_id, r.job]))

  // ---- on-chain spend: only decoded Settled events on successful commits count (a requested amount is not spend) ----
  const settles: Settle[] = []
  for (const c of commits.values()) {
    if (c.status !== 'OK') continue
    for (const e of arr(c.events)) {
      if (e?.name !== 'Settled') continue
      const amount = big(e.args?.amount), fee = big(e.args?.fee)
      if (amount !== null && fee !== null) settles.push({ job: String(e.args.jobId), vendor: str(e.args.vendor), amount, fee, tx: str(c.txHash) })
    }
  }
  // INFERENCE job = the inference DECISION's job, or any job paid to run.json inferencePayee (the fee-exempt payee on-chain).
  const payee = str(run?.inferencePayee)?.toLowerCase()
  const infJobs = new Set(reqs.filter((r) => r.action === 'inference' && r.job != null).map((r) => r.job as string))
  for (const s of settles) if (payee && s.vendor?.toLowerCase() === payee) infJobs.add(s.job)

  // ---- per GPU job (vendor jobs; the INFERENCE job is the LLM bill itself, see session totals) ----
  const jobs = new Map<string, { lines: KilnLine[]; reqs: number; settles: Settle[]; vendor: string | null }>()
  const job = (id: string) => {
    if (!jobs.has(id)) jobs.set(id, { lines: [], reqs: 0, settles: [], vendor: null })
    return jobs.get(id)!
  }
  for (const l of lines) job(l.job_id ?? (l.req_id != null ? reqJob.get(l.req_id) : null) ?? '-').lines.push(l)
  for (const r of reqs) if (r.action !== 'inference') job(r.job ?? '-').reqs++
  for (const s of settles) {
    if (infJobs.has(s.job)) continue
    const j = job(s.job)
    j.settles.push(s)
    j.vendor ??= s.vendor
  }
  for (const c of commits.values()) {
    const id = openedJob(c), v = opened(c)?.vendor
    if (id && jobs.has(id) && v) jobs.get(id)!.vendor = String(v)
  }
  const jobRows = [...jobs].sort(([a], [b]) => (a === '-' ? 1 : b === '-' ? -1 : Number(a) - Number(b))).map(([id, j]) => {
    const net = j.settles.reduce((a, s) => a + s.amount, 0n), fee = j.settles.reduce((a, s) => a + s.fee, 0n)
    return { id, vendor: j.vendor, reqs: j.reqs, ...sum(j.lines), settles: j.settles.length, net, fee, gross: net + fee }
  })

  // ---- session ----
  const all = flowStats(lines)
  const inf = settles.filter((s) => infJobs.has(s.job))
  const onchain = inf.length ? inf.reduce((a, s) => a + s.amount, 0n) : null
  const computed = costToMicro(lines.map(knownCost)).micro // ceil(Σcost × 1e6), as settled

  // ---- savings: requests the gate denied before F2 ----
  const f2 = sum(lines.filter((l) => l.flow === 'F2'))
  const avoided = reqs.filter((r) => r.outcome === 'GATE_DENIED' && r.action !== 'inference' && r.f2 === 0).length
  const mean = (x: number) => (f2.withUsage ? x / f2.withUsage : null)

  const recStub = decisions.reduce((n, { rec }) => {
    const d = (rec.body ?? {}) as unknown as Decision
    return n + [...arr(d.f1), ...arr(d.f2)].filter((c) => c && isStub(c)).length
  }, 0)

  return {
    dir, run,
    sources: {
      kiln: { found: kiln.found, lines: kiln.rows.length + kiln.bad, bad: kiln.bad + kiln.rows.length - lines.length },
      records: { found: records.found, files: records.recs.length + records.bad, bad: records.bad },
      events: { found: events.found, lines: events.rows.length + events.bad, bad: events.bad },
      run: runText !== null, nothink: { found: nothink.found, path: relative(dir, nothinkPath), lines: nothink.rows.length, bad: nothink.bad },
    },
    runId: str(run?.run_id) ?? str(records.recs[0]?.rec?.run_id),
    stub: { kiln: all.stub, records: recStub, nothink: nothink.rows.filter((r) => r && isStub(r)).length, run: run?.flags?.LLM_MODE === 'stub' },
    genIdMissing: lines.filter((l) => l.http === 200 && !l.gen_id).length,
    ok200: lines.filter((l) => l.http === 200).length,
    flows: { F1: flowStats(lines.filter((l) => l.flow === 'F1')), F2: flowStats(lines.filter((l) => l.flow === 'F2')), F3: flowStats(lines.filter((l) => l.flow === 'F3')), all },
    reqs, jobs: jobRows,
    session: {
      first: lines.reduce((m, l) => (typeof l.ts === 'number' && l.ts < m ? l.ts : m), Infinity),
      last: lines.reduce((m, l) => (typeof l.ts === 'number' && l.ts > m ? l.ts : m), -Infinity),
      computed, onchain, infJobs: [...infJobs], infTx: inf.map((s) => s.tx),
      infHold: reqs.find((r) => r.inferenceHold != null)?.inferenceHold ?? null,
      gpuNet: jobRows.reduce((a, j) => a + j.net, 0n), gpuFee: jobRows.reduce((a, j) => a + j.fee, 0n),
    },
    savings: { avoided, n: f2.withUsage, prompt: mean(f2.prompt), completion: mean(f2.completion), pico: f2.costN ? f2.pico / BigInt(f2.costN) : null },
    nothink: {
      found: nothink.found,
      think: { ...sum(nothink.rows.filter((r) => r?.mode === 'think')), truncated: nothink.rows.filter((r) => r?.mode === 'think' && r.finish_reason === 'length').length },
      no_think: { ...sum(nothink.rows.filter((r) => r?.mode === 'no_think')), truncated: nothink.rows.filter((r) => r?.mode === 'no_think' && r.finish_reason === 'length').length },
    },
  }
}

// ---------- rendering ----------

const usd = (pico: bigint) => `$${(Number(pico) / 1e12).toFixed(8)}`
const usdc = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(6)}`
const cost = (s: Sum) => `${usd(s.pico)}${s.unknown ? ` + ${s.unknown} unknown` : ''}`
const joules = (x: number) => `${x.toFixed(1)} J`
const wh = (x: number) => `${(x / 3600).toFixed(4)} Wh`
const ms = (x: number | null) => (x == null ? '-' : `${x} ms`)
const short = (h: string | null) => (h ? `\`${h.slice(0, 6)}…${h.slice(-4)}\`` : '-')
const f1 = (x: number | null) => (x == null ? '-' : x.toFixed(1))
const ratio = (pico: bigint, micro: bigint) => {
  if (micro <= 0n) return '-'
  const r = Number(pico) / (Number(micro) * 1e6)
  return r > 0 ? `${(r * 100).toFixed(4)}% (1 : ${Math.round(1 / r)})` : '0%'
}

/** run.json flags are copied from the environment and include RPC URLs (often carrying an API key): redact before printing. */
const safeFlags = (f: unknown) =>
  f && typeof f === 'object'
    ? JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) =>
      [k, /key|pk|secret|password|token|mnemonic|rpc|url/i.test(k) || (typeof v === 'string' && /:\/\/|^0x[0-9a-f]{64}$/i.test(v)) ? '[redacted]' : v])))
    : 'no data'

function table(head: string[], rows: unknown[][], empty = '_no data_') {
  if (!rows.length) return empty
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
}

export function report(dir: string): string {
  const a = analyze(dir)
  const { F1, F2, F3, all } = a.flows
  const tx = (h: string | null) => (h && Number(a.run?.chainId) === 84532 ? `[${h.slice(0, 6)}…${h.slice(-4)}](https://sepolia.basescan.org/tx/${h})` : short(h))
  const vendor = (v: string | null) => {
    const label = Object.entries(a.run?.vendors ?? {}).find(([, x]) => String(x).toLowerCase() === v?.toLowerCase())?.[0]
    return label ? `${label} ${short(v)}` : short(v)
  }
  const src = (name: string, s: { found: boolean; bad: number }, n: number, unit: string) =>
    s.found ? `${name} ${n} ${unit}${s.bad ? ` (${s.bad} malformed, skipped)` : ''}` : `${name} MISSING`
  const noKiln = '_no data (kiln.jsonl missing or empty)_'
  const o: string[] = []

  o.push(`# Kiln token & energy report${a.runId ? ` — ${a.runId}` : ''}`, '')
  if (a.stub.kiln || a.stub.records || a.stub.nothink || a.stub.run) {
    o.push(`> **WARNING: STUB LLM DATA.** ${a.stub.run ? 'run.json flags LLM_MODE=stub. ' : ''}${a.stub.kiln} of ${all.n} kiln.jsonl attempts, ${a.stub.records} record KilnCalls and ${a.stub.nothink} nothink.jsonl rows are stubs (llm_mode=stub or gen_id "stub-…").`,
      '> These numbers are NOT Kiln evidence, and `audit --submission` fails this bundle.', '')
  }
  o.push(
    `- Bundle: \`${basename(resolve(a.dir))}\` · vault \`${a.run?.vault ?? '?'}\` · chainId ${a.run?.chainId ?? '?'}`,
    `- Flags: \`${safeFlags(a.run?.flags)}\``,
    `- Sources: ${src('kiln.jsonl', a.sources.kiln, a.sources.kiln.lines, 'lines')} · ${src('records/', a.sources.records, a.sources.records.files, 'files')} · ${src('events.jsonl', a.sources.events, a.sources.events.lines, 'lines')} · run.json ${a.sources.run ? 'yes' : 'MISSING'} · ${a.sources.nothink.found ? `\`${a.sources.nothink.path}\` ${a.sources.nothink.lines} lines` : 'nothink.jsonl not found'}`,
    `- LLM mode: ${all.n - all.stub} kiln / ${all.stub} stub attempts · gen_id present on ${a.ok200 - a.genIdMissing}/${a.ok200} HTTP 200 attempts`,
    '- Conventions: 1 kiln.jsonl line = 1 HTTP attempt; a call = attempt 1 plus its retries. Cost = Kiln `usage.cost` (USD) summed exactly;',
    '  "unknown" = attempt with no reported cost (cost_known=false: timeout, 429, 5xx); counted, never guessed. Energy = completion tokens × 1.63 J (section 6).',
    '  Latency = nearest-rank p50/p95 over all attempts; "ok" = HTTP 200 attempts only.',
    '',
  )

  const flowRows = (fn: (name: string, s: typeof all) => unknown[]) => [...(['F1', 'F2', 'F3'] as const).map((k) => fn(k, a.flows[k])), fn('**total**', all)]
  o.push('## 1. By call type (F1 work_request / F2 cfo_review / F3 receipt_explain)', '', '### 1a. Volume and failures', '')
  o.push(all.n ? table(['flow', 'calls', 'attempts', 'retried calls', 'failed calls', 'failed attempts', '429', 'no HTTP (timeout/network)', '5xx', 'truncated (length)', 'stub'],
    flowRows((k, s) => [k, s.calls, s.n, s.retried, s.failedCalls, s.failed, s.r429, s.timeout, s.r5xx, s.truncated, s.stub])) : noKiln, '')
  o.push('### 1b. Tokens, cost, energy, latency', '')
  o.push(all.n ? table(['flow', 'prompt', 'completion', 'reasoning', 'cost (known)', 'cost-unknown attempts', 'energy @1.63 J', 'completion / call', 'p50', 'p95', 'p50 ok', 'p95 ok'],
    flowRows((k, s) => [k, s.prompt, s.completion, s.reasoning, usd(s.pico), s.unknown, joules(s.completion * J.rngd), f1(s.calls ? s.completion / s.calls : null),
      ms(pct(s.lat, 50)), ms(pct(s.lat, 95)), ms(pct(s.latOk, 50)), ms(pct(s.latOk, 95))])) : noKiln, '')

  o.push('## 2. By decision flow (one request = F1 → gate → F2 → tx)', '')
  o.push(table(['req_id', 'action', 'job', 'F1 att', 'F2 att', 'prompt', 'completion', 'reasoning', 'cost', 'energy', 'outcome', 'code(s)', 'recHash', 'tx'],
    a.reqs.map((r) => {
      const att = (n: number, rec: number) => (r.recHash && n !== rec ? `${n} (rec ${rec})` : n)
      return [r.req_id, r.action, r.job ?? '-', att(r.f1, r.recAttempts[0]), att(r.f2, r.recAttempts[1]), r.prompt, r.completion, r.reasoning,
        cost(r), joules(r.completion * J.rngd), r.outcome, r.code || '-', short(r.recHash), tx(r.tx)]
    }), '_no data (no DECISION records and no F1/F2 lines)_'), '')
  o.push('"F1/F2 att" count kiln.jsonl attempts; "(rec n)" marks a mismatch with the record\'s f1/f2 arrays. QWEN_NOT_A_JUDGEMENT = timeout, 429 or unparseable (fail-closed, not a Qwen decision).', '')

  o.push('## 3. By GPU job: AI cost to govern compute', '')
  const jr = a.jobs
  const jt = jr.reduce((t, j) => ({ pico: t.pico + j.pico, gross: t.gross + j.gross }), { pico: 0n, gross: 0n })
  o.push(table(['job', 'vendor', 'requests', 'Kiln attempts', 'prompt', 'completion', 'LLM cost', 'energy', 'settles', 'GPU net', 'fee', 'GPU gross', 'AI cost / GPU spend'],
    [...jr.map((j) => [j.id === '-' ? 'no job (e.g. denied open)' : j.id, vendor(j.vendor), j.reqs, j.n, j.prompt, j.completion, cost(j), joules(j.completion * J.rngd),
      j.settles, usdc(j.net), usdc(j.fee), usdc(j.gross), ratio(j.pico, j.gross)]),
    ...(jr.length ? [['**total**', '', '', '', '', '', usd(jt.pico), '', '', usdc(a.session.gpuNet), usdc(a.session.gpuFee), usdc(jt.gross), ratio(jt.pico, jt.gross)]] : [])]), '')
  for (const j of jr) if (j.gross > 0n) o.push(`- Job ${j.id}: AI cost to govern ${usdc(j.gross)} of compute = ${cost(j)}.`)
  o.push('- GPU spend = decoded `Settled` (net `amount` + `fee`) on successful commits. INFERENCE job(s) excluded here; see section 4.', '')

  o.push('## 4. Session totals and INFERENCE reconciliation', '')
  const s = a.session
  // MATCH only when the computed side is complete: a missing or partly malformed kiln.jsonl can't confirm the settle.
  const status = s.onchain == null ? 'NOT SETTLED (no INFERENCE `Settled` found)'
    : !a.sources.kiln.found ? 'CANNOT CHECK (kiln.jsonl missing)'
    : a.sources.kiln.bad ? `CANNOT CHECK (kiln.jsonl has ${a.sources.kiln.bad} malformed lines; on-chain − computed = ${s.onchain - s.computed} micro-USDC)`
    : s.onchain === s.computed ? 'MATCH' : `MISMATCH (on-chain − computed = ${s.onchain - s.computed} micro-USDC)`
  o.push(table(['item', 'value'], [
    ['run_id', a.runId ?? 'no data'],
    ['Kiln window', Number.isFinite(s.first) ? `${new Date(s.first).toISOString()} → ${new Date(s.last).toISOString()} (${((s.last - s.first) / 1000).toFixed(1)} s)` : 'no data'],
    ['calls / attempts', `${all.calls} / ${all.n}`],
    ['tokens prompt / completion / reasoning', `${all.prompt} / ${all.completion} / ${all.reasoning}`],
    ['LLM cost (known)', usd(all.pico)],
    ['cost-unknown attempts (not in the settle)', all.unknown],
    ['computed INFERENCE settle = ceil(Σcost × 1e6)', `${s.computed} micro-USDC (${usdc(s.computed)})`],
    ['on-chain INFERENCE `Settled`', s.onchain == null ? 'no data' : `${s.onchain} micro-USDC on job ${s.infJobs.join(', ')} · tx ${s.infTx.map(tx).join(', ')}`],
    ['reconciliation', status],
    ['INFERENCE hold (inference DECISION)', s.infHold == null ? 'no data' : `${usdc(s.infHold)} · computed spend uses ${(Number(s.computed) / Number(s.infHold) * 100).toFixed(2)}%`],
    ['GPU spend net / fee / gross', `${usdc(s.gpuNet)} / ${usdc(s.gpuFee)} / ${usdc(s.gpuNet + s.gpuFee)}`],
    ['AI cost / GPU spend', ratio(all.pico, s.gpuNet + s.gpuFee)],
    ['energy (completion × 1.63 J)', `${joules(all.completion * J.rngd)} = ${wh(all.completion * J.rngd)}`],
  ]), '')

  o.push('## 5. By outcome, and savings', '', '### 5a. Requests by outcome', '')
  const outcomes = [...new Set(a.reqs.map((r) => r.outcome))]
  o.push(table(['outcome', 'requests', 'F1 att', 'F2 att', 'prompt', 'completion', 'cost', 'energy'], outcomes.map((oc) => {
    const rs = a.reqs.filter((r) => r.outcome === oc)
    const t = (k: 'f1' | 'f2' | 'prompt' | 'completion' | 'unknown') => rs.reduce((n, r) => n + r[k], 0)
    const pico = rs.reduce((n, r) => n + r.pico, 0n), completion = t('completion'), unknown = t('unknown')
    return [oc, rs.length, t('f1'), t('f2'), t('prompt'), completion, `${usd(pico)}${unknown ? ` + ${unknown} unknown` : ''}`, joules(completion * J.rngd)]
  })), '')
  const codes = new Map<string, number>()
  for (const r of a.reqs) if (r.code && r.outcome !== 'TX_ERROR') codes.set(`${r.outcome} · ${r.code}`, (codes.get(`${r.outcome} · ${r.code}`) ?? 0) + 1)
  o.push(table(['layer · deny code(s)', 'requests'], [...codes]), '')

  o.push('### 5b. Gate denied before F2 (the saving)', '')
  const sv = a.savings
  if (sv.prompt == null || sv.completion == null) {
    o.push(`- F2 calls avoided: ${sv.avoided}. Tokens saved: no data (no F2 attempt with usage in this run to estimate from).`, '')
  } else {
    const c = sv.avoided * sv.completion
    o.push(table(['F2 calls avoided', 'mean F2 prompt / completion', 'prompt saved', 'completion saved', 'cost saved', 'energy saved @1.63 J'],
      [[sv.avoided, `${f1(sv.prompt)} / ${f1(sv.completion)}`, f1(sv.avoided * sv.prompt), f1(c), sv.pico == null ? 'no data' : usd(sv.pico * BigInt(sv.avoided)), `${joules(c * J.rngd)} = ${wh(c * J.rngd)}`]]), '',
      `- Estimate: avoided calls × mean over the ${sv.n} F2 attempts with usage in this run. The gate is deterministic code: 0 tokens.`, '')
  }

  o.push('### 5c. /no_think on vs off (offline comparison, nothink.jsonl)', '')
  const nt = a.nothink
  if (!nt.think.n && !nt.no_think.n) o.push(nt.found ? '_no data (nothink.jsonl has no think/no_think rows)_' : '_no data (nothink.jsonl not found)_', '')
  else {
    const avg = (x: Sum, v: number) => (x.withUsage ? v / x.withUsage : null)
    const row = (m: string, x: Sum & { truncated: number }) => [m, x.n, f1(avg(x, x.prompt)), f1(avg(x, x.completion)), f1(avg(x, x.reasoning)),
      x.costN ? usd(x.pico / BigInt(x.costN)) : '-', x.withUsage ? joules(avg(x, x.completion)! * J.rngd) : '-', ms(pct(x.lat, 50)), ms(pct(x.lat, 95)), x.truncated]
    o.push(table(['mode', 'runs', 'mean prompt', 'mean completion', 'mean reasoning', 'mean cost', 'energy / call', 'p50', 'p95', 'truncated (length)'],
      [row('think', nt.think), row('no_think', nt.no_think)]), '')
    if (nt.no_think.withUsage && nt.think.completion) {
      const t = avg(nt.think, nt.think.completion)!, n = avg(nt.no_think, nt.no_think.completion)!
      o.push(`- /no_think cuts completion tokens per call by ${((1 - n / t) * 100).toFixed(1)}% (${f1(t)} → ${f1(n)}), energy per call ${joules(t * J.rngd)} → ${joules(n * J.rngd)}.`, '')
    }
  }

  o.push('## 6. Energy estimate (range, stated assumptions)', '')
  const e = (label: string, c: number) => [label, c, joules(c * J.rngd), wh(c * J.rngd), joules(c * J.rtx), wh(c * J.rtx), joules(c * J.upper), wh(c * J.upper)]
  const saved = sv.completion == null ? null : sv.avoided * sv.completion
  o.push(all.n ? table(['scope', 'completion tokens', 'RNGD 1.63 J', 'Wh', 'RTX Pro 6000 4.02 J', 'Wh', 'upper 11.9 J', 'Wh'],
    [e('F1', F1.completion), e('F2', F2.completion), e('F3', F3.completion), e('**total**', all.completion), ...(saved == null ? [] : [e('saved by gate (est.)', saved)])]) : noKiln, '')
  o.push(
    '- E = Σ completion tokens × J/token. Completion includes Qwen3 reasoning tokens. Prefill (prompt) tokens are excluded.',
    '- 1.63 J: FuriosaAI RNGD, Furiosa blog 2026-04-02: 8-card server 3 kW ÷ (46 users × 40 tok/s).',
    '- 4.02 J: RTX Pro 6000 under the same conditions (same Furiosa blog post). Comparison only.',
    '- 11.9 J: upper bound, no batching: 4 RNGD cards (4 × 180 W = 720 W) held by one request ÷ 60.6 tok/s (Kiln published speed).',
    '- Assumptions: rated power, full load, PUE excluded. Kiln\'s actual serving configuration is unknown.',
    '',
  )
  return o.join('\n')
}

if (import.meta.main) {
  const dir = process.argv[2]
  let isDir = false
  try { isDir = statSync(dir).isDirectory() } catch {}
  if (!isDir) { console.error(`usage: node src/report.ts runs/<vault>${dir ? ` (not a directory: ${dir})` : ''}`); process.exit(2) }
  const md = report(dir)
  process.stdout.write(md)
  writeFileSync(join(dir, 'report.md'), md)
}
