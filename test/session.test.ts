// Orchestrator integration on a self-spawned anvil, stub LLM only (no live Kiln, no network: a fast-failing
// priceFetch forces the committed Akash snapshot). Each scenario runs on a fresh vault and must end with
// vault committed == Σpaid, budget − committed refunded (token balance 0), a clean hash chain, every commit's
// recHash naming a record file, the last on-chain rec == the last record's hash, and windDown idempotent.
// The money-safety regressions below each drive one race or failure into the session (a pause landing under windDown,
// a lagging chain clock, a throwing LLM wrapper, a HALT) and demand the same clean end.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, http, type Hex, type PublicClient } from 'viem'
import { usdcAbi, vaultAbi } from '../src/abi.ts'
import { makeWallet } from '../src/chain.ts'
import { CHAINS, makePublicClient, snapshot, getLogsChunked } from '../src/chainread.ts'
import { fromBytes32 } from '../src/codes.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from '../src/deploy.ts'
import { gross } from '../src/rules.ts'
import { readChain, verifyChain, type Decision } from '../src/record.ts'
import { scenario, sharedStub, type ScenarioDef } from '../src/scenarios.ts'
import { Session } from '../src/session.ts'
import type { Deployment, StateView, StopStage } from '../src/types.ts'
import { bootSession, summarize } from '../src/run.ts'
import { AKASH_URL } from '../src/akash.ts'
import { stolenKeyAttack } from '../scripts/stolen-key.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const ZERO = `0x${'00'.repeat(32)}`
const failFetch = (async () => { throw new Error('no network in tests') }) as unknown as typeof fetch
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)) }) })
async function startAnvil(extra: string[] = []) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const proc = spawn(ANVIL!, ['--port', String(port), ...extra], { stdio: 'ignore' })
  const client = makePublicClient('anvil', [url])
  for (let t = 0; ; t++) { try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await sleep(100) } }
  return { url, proc, client }
}

describe('orchestrator on anvil (stub LLM)', { skip: ANVIL ? false : 'anvil binary not found: skipping' }, () => {
  let anvil: ChildProcess
  let url: string
  let client: PublicClient
  let root: string

  before(async () => {
    ;({ url, proc: anvil, client } = await startAnvil())
    root = mkdtempSync(join(tmpdir(), 'session-'))
  })
  after(() => { anvil?.kill(); if (root) rmSync(root, { recursive: true, force: true }) })

  const bal = (usdc: Hex, a: Hex, c = client) => c.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>

  let seq = 0
  /** A fresh vault + Session for a scenario (by name or a custom def), not started. */
  async function build(scn: string | ScenarioDef, o: { url?: string; hardCapMs?: number; speed?: number } = {}): Promise<{ session: Session; dep: Deployment; keysDir: string }> {
    const sc = typeof scn === 'string' ? scenario(scn) : scn
    const u = o.url ?? url
    const base = join(root, `${sc.name}-${++seq}`)
    const keysDir = join(base, 'keys'), outDir = join(base, 'deployments'), runsDir = join(base, 'runs')
    const dep = await Session.deployFor(sc, { chain: 'anvil', rpcUrls: [u], keysDir, outDir })
    const session = new Session({
      chain: 'anvil', rpcUrls: [u], publicRpc: u, deployment: dep,
      agentPk: loadAgentKey(dep.vault, keysDir), founderPk: ANVIL_FOUNDER_PK, runsDir, scenario: sc,
      llm: { mode: 'stub', stub: sc.stub, cap: 100_000 }, speed: o.speed ?? sc.suggestedSpeed ?? 60,
      deadlineMarginS: sc.suggestedMarginS ?? 15n, priceFetch: failFetch, hardCapMs: o.hardCapMs ?? 60_000,
    })
    return { session, dep, keysDir }
  }

  async function runScenario(scn: string | ScenarioDef, o: { url?: string } = {}): Promise<{ session: Session; dep: Deployment; dir: string; keysDir: string }> {
    const { session, dep, keysDir } = await build(scn, o)
    await session.run()
    return { session, dep, dir: session.dir, keysDir }
  }

  /** The founder pauses the vault directly (cast-style, no STOP record) while the Committer queue is idle. */
  async function pauseVault(dep: Deployment) {
    const w = makeWallet('anvil', [url], ANVIL_FOUNDER_PK)
    const hash = await w.writeContract({ address: dep.vault, abi: vaultAbi, functionName: 'setPaused', args: [true, ZERO as Hex], account: w.account!, chain: CHAINS.anvil })
    await client.waitForTransactionReceipt({ hash })
  }

  /** The invariants every scenario must satisfy at the end (success criteria 1-4). */
  async function assertClean(name: string, session: Session, dep: Deployment, dir: string, c = client) {
    const s = await snapshot(c, dep.vault, { vendors: [dep.vendors.A, dep.vendors.B, dep.vendors.C, dep.inferencePayee] })
    const paid = s.jobs.reduce((a, j) => a + j.paid, 0n)
    const held = s.jobs.reduce((a, j) => a + j.held, 0n)
    assert.equal(held, 0n, `${name}: all holds released`)
    assert.equal(s.committed, paid, `${name}: committed == Σpaid`)
    assert.equal(await bal(dep.usdc, dep.vault, c), 0n, `${name}: vault token balance 0 (budget − committed refunded)`)

    const chain = readChain(join(dir, 'records'))
    assert.deepEqual(verifyChain(chain), [], `${name}: hash chain intact`)
    assert.equal(chain[0].rec.type, 'SESSION_START', `${name}: seq 0 is SESSION_START`)
    assert.equal(chain.at(-1)!.rec.type, 'SESSION_END', `${name}: last record is SESSION_END (refund anchors the tail)`)
    assert.equal(chain.filter((r) => r.rec.type === 'SESSION_END').length, 1, `${name}: one SESSION_END, however often windDown ran`)

    // every commit line's recHash names an existing record file
    const recs = new Set(chain.map((r) => r.hash))
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const e of events) {
      if ((e.src === 'commit' || e.src === 'windDown') && e.ev === 'mined' && e.recHash && e.recHash !== ZERO) {
        assert.ok(recs.has(e.recHash), `${name}: commit recHash ${e.recHash} has a record file`)
      }
    }
    // anchored tail: the last on-chain rec == the last record's hash
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    const refundMined = events.filter((e) => e.src === 'commit' && e.ev === 'mined' && e.fn === 'refund')
    assert.equal(refundMined.length, 1, `${name}: exactly one refund tx`)
    assert.ok(run.lastBlock >= Number(refundMined[0].block), `${name}: run.json lastBlock ${run.lastBlock} >= the refund's block ${refundMined[0].block}`)
    const logs = await getLogsChunked(c, dep.vault, BigInt(dep.deployBlock), BigInt(run.lastBlock))
    const lastOnchainRec = logs.filter((l) => l.args.rec && l.args.rec !== ZERO).at(-1)?.args.rec
    assert.equal(lastOnchainRec, chain.at(-1)!.hash, `${name}: on-chain tail anchored to the last record`)
    // the honest path never overdraws a hold
    assert.ok(!logs.some((l) => l.name === 'Denied' && fromBytes32(l.args.code as Hex) === 'OVER_HOLD'), `${name}: no Denied(OVER_HOLD)`)
    // SESSION_END counts THIS session's Kiln attempts (tests run many sessions in one process)
    let kilnLines = 0
    try { kilnLines = readFileSync(join(dir, 'kiln.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length } catch {} // no file = 0 calls
    assert.equal(chain.at(-1)!.rec.body.kiln_calls, kilnLines, `${name}: SESSION_END.kiln_calls == this bundle's kiln.jsonl lines`)
    // an attempt that threw (llm_error) counts against the cap but writes no kiln.jsonl line
    const thrown = events.filter((e) => e.src === 'kiln' && e.ev === 'llm_error').length
    assert.equal(session.llmCtx.counter!.calls, kilnLines + thrown, `${name}: LLM_CALL_CAP counts this session's attempts, not the process's`)

    const st = session.state()
    assert.equal(st.jobs.find((j) => j.inference)?.state, 'CLOSED', `${name}: the INFERENCE row shows CLOSED`)
    assert.equal(st.can.windDown, false, `${name}: no wind-down button once the session ended`)
    assert.deepEqual(await session.action({ type: 'WIND_DOWN', stateVersion: st.version }), { ok: false, status: 400, reason: 'not all jobs stopped/exhausted or a tx is pending' })

    // windDown a second time sends 0 txs
    const before = session.ledger.length
    await session.windDown()
    assert.equal(session.ledger.length, before, `${name}: second windDown sends 0 txs`)

    assert.equal(session.committer.halted, false, `${name}: committer never HALTed`)
    return { chain, logs }
  }

  for (const name of ['normal', 'qwen-deny', 'nan', 'migrate', 'plateau']) {
    test(name, async () => {
      const { session, dep, dir } = await runScenario(name)
      await assertClean(name, session, dep, dir)
    })
  }

  // ---- design conformance and demo readiness ----

  /** Emulates live Kiln: every llm() call takes `ms` of wall clock (stub answers, no network). */
  function slowLlm(session: Session, ms: number) {
    const s = session as any, orig = s.callLlm.bind(s)
    s.callLlm = async (req: unknown) => { await sleep(ms); return orig(req) }
  }
  const denials = (logs: any[]) => logs.filter((l) => l.name === 'Denied').map((l) => ({ code: fromBytes32(l.args.code as Hex), enforced: l.args.enforced as boolean, rec: l.args.rec as Hex }))

  test('demo at recording scale (speed 3 + 2.5 s Kiln = speed 30 + 250 ms): storyboard scenes in order, StateView filled with real values', async () => {
    const { session, dep } = await build('demo', { speed: 30 })
    slowLlm(session, 250)
    const states: StateView[] = []
    const iv = setInterval(() => { try { states.push(session.state()) } catch {} }, 20)
    try { await session.run() } finally { clearInterval(iv) }
    states.push(session.state())
    const { chain, logs } = await assertClean('demo', session, dep, session.dir)
    const byHash = new Map(chain.map((r) => [r.hash, r.rec]))

    // doc diagram 5, in chain order: top-up APPROVE -> climax (gate PASS, Qwen DENY) -> injection (gate, 0 F2) ->
    // stolen key (contract Denied, no record) -> a running job -> STOP -> agent settle Denied(PAUSED) -> refund
    const scene = (l: any): string | null => {
      const r = l.args.rec ? byHash.get(l.args.rec as Hex) : undefined
      const b = r?.body as any, code = l.name === 'Denied' ? fromBytes32(l.args.code as Hex) : null
      if (l.name === 'ToppedUp') return 'topup'
      if (code === 'QWEN_DENIED' && b?.gate.codes.length === 0 && b.overrides.some((o: any) => o.field === 'f1.rationale')) return 'climax'
      if (code === 'VENDOR_NOT_ALLOWED' && !l.args.enforced && b?.f2.length === 0 && b.overrides.some((o: any) => o.field === 'executor_log')) return 'injection'
      if (l.name === 'Denied' && l.args.enforced && !r) return 'stolen'
      if (l.name === 'HoldOpened' && l.args.jobId === 3n) return 'job3'
      if (l.name === 'PausedSet') return 'stop'
      if (code === 'PAUSED' && l.args.enforced && r?.type === 'CHECKPOINT' && b.signer === 'agent' && b.reason === 'stop') return 'denied-paused'
      if (l.name === 'Refunded') return 'refund'
      return null
    }
    const order = logs.map(scene).filter((x) => x !== null).filter((x, i, a) => x !== a[i - 1])
    assert.deepEqual(order, ['topup', 'climax', 'injection', 'stolen', 'job3', 'stop', 'denied-paused', 'refund'], `scene order: ${order.join(' > ')}`)
    const decisions = chain.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision)
    assert.equal(decisions.filter((d) => /0xbad/i.test(d.request.vendorLabel)).length, 1, 'the poisoned line reached exactly one F1')
    assert.ok(decisions.filter((d) => d.action === 'topUp' && d.job_id === '1')[0].overrides.length === 0, "an override firing mid-F1 is the NEXT request's")

    // StateView (types.ts): real values, not placeholders
    const end = states.at(-1)!, g = end.grant
    const bar = (x: StateView['grant']) => BigInt(x.paid) + BigInt(x.fees) + BigInt(x.inference_paid) + BigInt(x.open_holds) + BigInt(x.refundable)
    assert.equal(bar(g), BigInt(g.budget), 'the budget bar adds up')
    for (const st of states) assert.equal(bar(st.grant), BigInt(st.grant.budget), `v${st.version}: the budget bar adds up on every poll`)
    // Regression: a dashboard poll between a Settled receipt and the next chain read (snapshot older than the receipt)
    // counted the settle as paid AND still held (sum $21.03 of $20). Every part now comes from the one snapshot.
    const firstSettle = logs.find((l) => l.name === 'Settled')!
    ;(session as any).lastSnapshot = await snapshot(client, dep.vault, { vendors: [], block: firstSettle.blockNumber - 1n })
    const old = session.state().grant
    assert.equal(bar(old), BigInt(old.budget), 'a snapshot older than the Settled receipts still adds up')
    assert.deepEqual([old.paid, old.fees, old.inference_paid], ['0', '0', '0'], 'nothing paid before the first Settled block')
    ;(session as any).lastSnapshot = null
    const settled = logs.filter((l) => l.name === 'Settled')
    assert.equal(BigInt(g.fees), settled.reduce((a, l) => a + (l.args.fee as bigint), 0n), 'fees = Σ decoded Settled.fee')
    assert.ok(BigInt(g.fees) > 0n && states.some((st) => st.jobs.some((j) => j.state === 'RUNNING') && BigInt(st.grant.fees) > 0n))
    assert.equal(g.deadline, Math.min(dep.deadline, JSON.parse(readFileSync(join(session.dir, 'spec.json'), 'utf8')).deadline), 'binding deadline = min(spec, vault)')
    assert.equal(end.receipts.length, 3)
    for (const r of end.receipts) {
      const mine = settled.filter((l) => String(l.args.jobId) === r.job_id)
      assert.ok(/^\d+$/.test(r.amount) && /^\d+$/.test(r.fee) && /^\d+$/.test(r.gross), 'receipt amounts are micro-USDC strings')
      assert.equal(BigInt(r.fee), mine.reduce((a, l) => a + (l.args.fee as bigint), 0n), `receipt ${r.job_id}: fee = the chain's per-settle fees`)
      assert.ok(r.txHashes.length >= 3 && mine.every((l) => r.txHashes.includes(l.txHash)), `receipt ${r.job_id} lists its txs`)
      assert.ok(r.f3 && r.f3 === r.f3.trim())
    }
    assert.match(end.receipts[0].qwenReason ?? '', /scope creep/, "job 1's receipt carries the Qwen deny reason")
    assert.ok(end.health.kiln.lastLatencyMs !== null && end.health.kiln.errors === 0)
    assert.ok(Number(end.health.ethAgent) > 0 && Number(end.health.ethFounder) > 0, `ETH ${end.health.ethAgent} / ${end.health.ethFounder}`)
    assert.match(end.health.ethAgent, /^\d+(\.\d+)?$/, 'ETH as a decimal string')
    // evidence feed: signer per line, the stolen key's two txs as 'attacker' lines (no record), recordDecision with its code
    const lines = states.flatMap((st) => st.ledger)
    const attacker = [...new Map(lines.filter((l) => l.signer === 'attacker').map((l) => [l.txHash, l])).values()]
    assert.deepEqual(attacker.map((l) => [l.fn, l.status, l.code, l.recHash]), [['open', 'DENIED', 'VENDOR_NOT_ALLOWED', null], ['topUp', 'DENIED', 'OVER_MAX_HOLD', null]])
    for (const code of ['QWEN_DENIED', 'VENDOR_NOT_ALLOWED']) assert.ok(lines.some((l) => l.fn === 'recordDecision' && l.status === 'OK' && l.code === code && l.signer === 'agent'), `recordDecision ${code} line`)
    assert.ok(lines.some((l) => l.fn === 'setPaused' && l.signer === 'founder'))
    assert.ok(end.topups.every((t) => t.stage === 'DONE' && (t.result !== null || t.code === 'CANCELLED')), 'every top-up card reached a terminal state')
    assert.ok(end.topups.some((t) => t.result === 'APPROVED_ONCHAIN') && end.topups.some((t) => t.result === 'DENIED_RECORDED'))
    const stages = states.map((st) => st.stop).filter((x, i, a) => x !== a[i - 1])
    const rank = (x: StopStage) => ['RUNNING', 'SENDING', 'PAUSED_ON_CHAIN', 'HALTING', 'HALTED'].indexOf(x)
    assert.ok(stages.every((x, i) => i === 0 || rank(x) > rank(stages[i - 1])) && stages.at(-1) === 'HALTED', `stop stages ${stages.join(' > ')}`)
    assert.equal(end.can.stop, false)

    // run.ts summary + criterion 1's setup txs in the bundle
    const sum = summarize(session.dir, end).join('\n')
    assert.match(sum, /stolen key {3}open:VENDOR_NOT_ALLOWED, topUp:OVER_MAX_HOLD/)
    assert.match(sum, /chain Denied settle:PAUSED/)
    assert.deepEqual(JSON.parse(readFileSync(join(session.dir, 'run.json'), 'utf8')).setupTxs, dep.setupTxs)
  })

  test('stop: the founder STOP leaves an enforced Denied(PAUSED) and its agent CHECKPOINT record (criterion 2); windDown pays the delta', async () => {
    const { session, dep, dir } = await runScenario('stop')
    const { chain, logs } = await assertClean('stop', session, dep, dir)
    const byHash = new Map(chain.map((r) => [r.hash, r.rec]))
    const d = denials(logs).find((x) => x.code === 'PAUSED' && x.enforced)
    assert.ok(d, 'the paused contract refused an agent tx')
    const cp = byHash.get(d!.rec)!
    assert.equal(cp.type, 'CHECKPOINT')
    assert.ok(cp.body.signer === 'agent' && cp.body.reason === 'stop')
    assert.ok(chain.some((r) => r.rec.type === 'STOP') && chain.some((r) => r.rec.type === 'CHECKPOINT' && r.rec.body.signer === 'founder' && r.rec.body.amount === cp.body.amount))
  })

  test('budget: a top-up that fits net but not net + 3% fee is gate-denied OVER_BUDGET_WITH_FEE, 0 F2 calls, anchored (criterion 2)', async () => {
    const { session, dep, dir } = await runScenario('budget')
    const { chain, logs } = await assertClean('budget', session, dep, dir)
    const rec = chain.find((r) => r.rec.type === 'DECISION' && (r.rec.body as any).verdict.code === 'OVER_BUDGET_WITH_FEE')!
    assert.ok(rec, 'a DECISION denied OVER_BUDGET_WITH_FEE')
    const b = rec.rec.body as unknown as Decision, gi = b.gate.input as any
    const room = BigInt(gi.chain.budget) - BigInt(gi.chain.committed)
    assert.ok(BigInt(b.request.amount) <= room && gross(BigInt(b.request.amount), false) > room, 'the net fits, the fee does not')
    assert.deepEqual(b.gate.codes, ['OVER_BUDGET_WITH_FEE'])
    assert.equal(b.f2.length, 0)
    assert.ok(denials(logs).some((x) => x.code === 'OVER_BUDGET_WITH_FEE' && !x.enforced && x.rec === rec.hash))
  })

  test('an intervention that fires while an F1 is in flight belongs to the NEXT request (its Override too)', async () => {
    // qwen-deny rewrites F1's rationale at sim minute 40; job 1's first top-up F1 starts ~36 and is held until it fires
    const { session, dep } = await build('qwen-deny')
    const s = session as any, orig = s.callLlm.bind(s)
    let held = false
    s.callLlm = async (req: any) => {
      if (!held && req.flow === 'F1' && /action: topUp/.test(req.messages.map((m: any) => m.content).join('\n'))) {
        held = true
        while (!s.firedSteps.has(0)) await sleep(5)
      }
      return orig(req)
    }
    await session.run()
    const { chain } = await assertClean('override-mid-f1', session, dep, session.dir)
    const topups = chain.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision).filter((d) => d.action === 'topUp')
    assert.ok(held && topups.length >= 2)
    assert.ok(topups[0].verdict.approve && topups[0].overrides.length === 0, 'the in-flight request is untouched')
    assert.ok(!topups[1].verdict.approve && topups[1].verdict.code === 'QWEN_DENIED' && topups[1].overrides.some((o) => o.field === 'f1.rationale'), 'the next one carries it')
  })

  test('live Kiln latency: the scenario clock starts after the opening F1/F2, and TOPUP_TIMEOUT is 60 s of real time at any speed', async () => {
    // 700 ms per call at speed 60: the opening F1+F2 is 84 sim minutes and a top-up flow 1.4 s, more than the old
    // 60 virtual seconds (1 real second). The job must still run its 150 minutes and the top-up must land.
    const { session, dep } = await build({ ...scenario('normal'), name: 'latency', endAtSimMinute: 150 })
    slowLlm(session, 700)
    await session.run()
    const { chain, logs } = await assertClean('latency', session, dep, session.dir)
    assert.ok(logs.some((l) => l.name === 'ToppedUp'), 'the slow top-up still landed')
    assert.ok(!chain.some((r) => r.rec.type === 'DECISION' && (r.rec.body as any).verdict.code === 'TOPUP_TIMEOUT'), 'no TOPUP_TIMEOUT')
    assert.ok((session as any).slots[0].job.runningMs >= 80_000n, `ran ${(session as any).slots[0].job.runningMs} ms of sim time`)
  })

  test('a top-up that times out: its card ends DENIED_RECORDED(TOPUP_TIMEOUT) with the anchored record; the late answer is CANCELLED', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'timeout-card', endAtSimMinute: 150 })
    slowLlm(session, 300)
    const s = session as any, handle = s.handleAction.bind(s)
    let aged = false
    s.handleAction = async (slot: any, a: any) => { await handle(slot, a); if (a.type === 'REQUEST_TOPUP' && !aged) { aged = true; slot.topupRealAt -= 61_000 } } // the flow "started" 61 s ago
    await session.run()
    const { chain } = await assertClean('timeout-card', session, dep, session.dir)
    const rec = chain.find((r) => r.rec.type === 'DECISION' && (r.rec.body as any).verdict.code === 'TOPUP_TIMEOUT')
    assert.ok(rec, 'the timeout was recorded')
    const card = session.state().topups.find((t) => t.code === 'TOPUP_TIMEOUT')
    assert.ok(card && card.stage === 'DONE' && card.result === 'DENIED_RECORDED' && card.recHash === rec!.hash, JSON.stringify(card))
    assert.ok(session.state().topups.every((t) => t.stage === 'DONE'))
  })

  test('STOP banner only moves forward when the executor sees the pause before the setPaused receipt returns', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'stop-stages', endAtSimMinute: 100_000 })
    const cm = (session as any).committer, commit = cm.commit.bind(cm)
    cm.commit = async (i: any) => { const o = await commit(i); if (i.fn === 'setPaused') await sleep(1000); return o } // Base Sepolia polls receipts at 1 s
    const seen: StopStage[] = []
    const iv = setInterval(() => { const st = session.state().stop; if (seen.at(-1) !== st) seen.push(st) }, 2)
    const runP = session.run()
    await sleep(800)
    await session.action({ type: 'STOP', reason: 'MANUAL', stateVersion: 0 })
    await runP
    clearInterval(iv)
    const rank = (x: StopStage) => ['RUNNING', 'SENDING', 'PAUSED_ON_CHAIN', 'HALTING', 'HALTED'].indexOf(x)
    assert.ok(seen.every((x, i) => i === 0 || rank(x) > rank(seen[i - 1])), `stages ${seen.join(' > ')}`)
    assert.equal(session.state().stop, 'HALTED')
    await assertClean('stop-stages', session, dep, session.dir)
  })

  test('the chain watcher reads the vault once per block, not once per loop step (RPC load at demo speed)', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'per-block' })
    const s = session as any
    assert.equal(session.state().can.windDown, false, 'nothing to wind down before start')
    slowLlm(session, 200)
    const started = session.start()
    while (!s.inference) await sleep(5)
    assert.equal(s.slots.length, 0)
    assert.equal(session.state().can.windDown, false, 'INFERENCE is open but no vendor job exists yet')
    await started
    await s.freshSnapshot() // the head moved past start()'s last read (the open tx): one full read
    let full = 0
    const getBlock = s.client.getBlock.bind(s.client)
    s.client.getBlock = (...a: unknown[]) => { full++; return getBlock(...a) }
    await sleep(50)
    for (let i = 0; i < 5; i++) assert.ok(await s.freshSnapshot())
    assert.equal(full, 0, 'same head block: the snapshot is reused')
    assert.ok(session.state().syncAgeMs < 50, 'a reused snapshot still counts as synced')
    await client.request({ method: 'evm_mine' } as any)
    const snap = await s.freshSnapshot()
    assert.equal(full, 1, 'a new block: one full read')
    assert.equal(snap.block, await client.getBlockNumber({ cacheTime: 0 }))
    s.client.getBlock = getBlock
    await session.windDown()
    await assertClean('per-block', session, dep, session.dir)
  })

  test('an open CANCELLED by a STOP is not re-proposed to another vendor (no wasted F1/F2)', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'stop-open', endAtSimMinute: undefined, interventions: [{ kind: 'openJob', atSimMinute: 20, label: 'A', note: 'second job' }] })
    const s = session as any, orig = s.callLlm.bind(s)
    let opens = 0
    s.callLlm = async (req: any) => {
      if (req.flow === 'F1' && /action: open/.test(req.messages.map((m: any) => m.content).join('\n')) && ++opens === 2) {
        assert.deepEqual(await session.action({ type: 'STOP', reason: 'MANUAL', stateVersion: 0 }), { ok: true }) // lands while this F1 is in flight
      }
      return orig(req)
    }
    await session.run()
    assert.equal(opens, 2, 'the cancelled open was not re-proposed')
    await assertClean('stop-open', session, dep, session.dir)
  })

  test('the loop hard cap scales with the scenario length at the chosen speed', async () => {
    const s = (await build('demo', { speed: 2 })).session as any
    s.o = { ...s.o, hardCapMs: undefined } // the CLI / server pass none
    assert.ok(s.hardCapMs >= 300 * 1000 / 2 + 60_000, `demo at speed 2 (150 s of script) is not cut at 150 s: cap ${s.hardCapMs}`)
  })

  test('bootSession (run.ts CLI and the dashboard CLI): Akash warm-up + a fresh vault + createSession; --vault reuses the deployment', async () => {
    const base = join(root, 'boot')
    const o = { scenario: scenario('normal'), chain: 'anvil' as const, rpc: url, keysDir: join(base, 'keys'), outDir: join(base, 'deployments'), runsDir: join(base, 'runs') }
    const warmed: string[] = []
    const prev = process.env.LLM_MODE
    process.env.LLM_MODE = 'stub'
    try {
      const session = await bootSession({ ...o, fetch: (async (u: string) => { warmed.push(u); throw new Error('offline') }) as unknown as typeof fetch })
      assert.deepEqual(warmed, [AKASH_URL])
      assert.ok(session.dir.startsWith(o.runsDir) && session.records.seq === 0, 'a fresh, unstarted session')
      assert.equal(await client.getBytecode({ address: session.dep.vault }).then((b) => (b?.length ?? 0) > 2), true, 'the vault was deployed')
      const again = await bootSession({ ...o, vault: session.dep.vault, fetch: failFetch })
      assert.deepEqual(again.dep, session.dep)
    } finally {
      if (prev === undefined) delete process.env.LLM_MODE
      else process.env.LLM_MODE = prev
    }
  })

  test('injection: F2 called 0 times for the fooled request; stolen key -> on-chain Denied with no matching record', async () => {
    const { session, dep, dir } = await runScenario('injection')
    const { chain, logs } = await assertClean('injection', session, dep, dir)

    const decisions = chain.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision)
    const fooled = decisions.find((d) => d.gate.codes.includes('VENDOR_NOT_ALLOWED') && d.action === 'topUp')
    assert.ok(fooled, 'a topUp was gate-denied VENDOR_NOT_ALLOWED')
    assert.equal(fooled!.f2.length, 0, 'F2 was NOT called for the gate-denied request (the measured saving)')
    assert.ok(fooled!.overrides.some((o) => o.field === 'executor_log' && o.by.startsWith('scenario:')), 'the injected log line is recorded as an Override')

    // stolen key: an enforced Denied whose rec is NOT in the record chain (UNRECORDED_ATTEMPT)
    const recs = new Set(chain.map((r) => r.hash))
    const unrecorded = logs.filter((l) => l.name === 'Denied' && l.args.enforced === true && !recs.has(l.args.rec as Hex))
    assert.ok(unrecorded.length >= 1, 'the stolen key produced at least one enforced on-chain Denied with no record')
    assert.ok(unrecorded.some((l) => fromBytes32(l.args.code as Hex) === 'VENDOR_NOT_ALLOWED' || fromBytes32(l.args.code as Hex) === 'OVER_MAX_HOLD'))
  })

  test('deadline: an agent tx is Denied(PAST_DEADLINE) on chain', async () => {
    const { session, dep, dir } = await runScenario('deadline')
    const { logs } = await assertClean('deadline', session, dep, dir)
    const enforced = logs.filter((l) => l.name === 'Denied' && l.args.enforced === true && fromBytes32(l.args.code as Hex) === 'PAST_DEADLINE')
    assert.ok(enforced.length >= 1, 'the contract answered an agent call with an enforced Denied(PAST_DEADLINE)')
  })

  // ---- money-safety regressions ----

  test('deadline with the default 15 s margin: the executor stop sends no agent settle (it would land and pay); windDown pays the delta', async () => {
    // Blocks every 500 ms (like a live chain) so the executor sees blockTs reach deadline-15 while the job still has
    // unsettled usage; the vault deadline is then 15 s away, so an agent settle would succeed outside the ledger.
    const base = scenario('deadline')
    const sc: ScenarioDef = {
      ...base, name: 'deadline-margin15', suggestedSpeed: 1, suggestedMarginS: 15n,
      vault: { ...base.vault, deadlineHours: 20 / 3600 }, spec: (i) => ({ ...base.spec(i), deadline: i.now + 20 }),
      stub: (req, n) => (req.flow === 'F1' ? { toolName: 'request_gpu_hold', toolArgs: { vendor_label: 'B', gpu: 'h100', amount_usd: '0.5', rationale: 'continue the approved fine-tune' } } : sharedStub(req, n)),
    }
    const mine = setInterval(() => client.request({ method: 'evm_mine' } as any).catch(() => {}), 500)
    try {
      const { session, dep, dir } = await runScenario(sc)
      const slot = (session as any).slots[0]
      assert.equal(slot.job.stopReason, 'PAST_DEADLINE', 'the executor stopped the job at deadline-15')
      const { chain } = await assertClean('deadline-margin15', session, dep, dir)
      const s = await snapshot(client, dep.vault, { vendors: [] })
      assert.equal(s.jobs[Number(slot.job.id)].paid <= gross(slot.job.accrued, false), true, 'vendor paid at most gross(accrued usage)')
      assert.ok(chain.some((r) => r.rec.type === 'CHECKPOINT' && r.rec.body.signer === 'founder' && r.rec.body.reason === 'windDown'), 'founder windDown settle paid the delta')
    } finally { clearInterval(mine) }
  })

  test('founder STOP and a migration at the same minute: the Denied(PAUSED) migrate settle is not a crash; windDown pays it', async () => {
    const sc: ScenarioDef = { ...scenario('migrate'), name: 'stop-migrate', interventions: [
      { kind: 'founderStop', atSimMinute: 50, reason: 'MANUAL', note: 'STOP lands first' },
      { kind: 'capacityZero', atSimMinute: 50, from: 'B', to: 'A', note: 'then the scripted migration' },
    ] }
    const { session, dep, dir } = await runScenario(sc)
    await assertClean('stop-migrate', session, dep, dir)
  })

  /** Pauses the vault right after the first windDown intent matching `when` (by fn/signer/reason) is sent. */
  function pauseAfterSend(session: Session, dep: Deployment, when: (i: any, out: any) => boolean) {
    const s = session as any, send = s.send.bind(s)
    const st = { fired: false }
    s.send = async (i: any) => { const out = await send(i); if (!st.fired && s.windDownP && when(i, out)) { st.fired = true; await pauseVault(dep) } return out }
    return st
  }

  test('windDown re-plans with the live ledger when a close is Denied under it (no stale job objects, no double settle)', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'pause-after-settle', endAtSimMinute: 50 })
    // the agent-signed windDown settle lands, then the vault is paused: its agent close is Denied(PAUSED)
    const st = pauseAfterSend(session, dep, (i, out) => i.fn === 'settle' && i.record?.body.reason === 'windDown' && out.status === 'OK')
    await session.run()
    assert.ok(st.fired, 'the pause landed between the windDown settle and its close')
    await assertClean('pause-after-settle', session, dep, session.dir)
  })

  test('windDown never refunds over a close that was Denied (no OverBudget HALT, SESSION_END anchored)', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'pause-before-inference', endAtSimMinute: 40 })
    // vendor jobs closed + receipts written; pause right after the snapshot the INFERENCE close is planned on
    const s = session as any, fresh = s.freshSnapshot.bind(s)
    const st = { fired: false }
    s.freshSnapshot = async (...a: unknown[]) => {
      const snap = await fresh(...a)
      if (!st.fired && s.windDownP && s.slots.every((x: any) => x.job.state === 'CLOSED' && x.f3Done)) { st.fired = true; await pauseVault(dep) }
      return snap
    }
    await session.run()
    assert.ok(st.fired)
    await assertClean('pause-before-inference', session, dep, session.dir)
  })

  test('founder STOP: a stale stateVersion never blocks the kill switch; STOP during windDown is refused', async () => {
    // (a) the loop bumps the version every step, so the dashboard's polled version is always stale by the click
    const a = await build({ ...scenario('normal'), name: 'stop-stale', endAtSimMinute: 100_000 })
    const runA = a.session.run()
    await sleep(800)
    const v = a.session.state().version
    await sleep(300)
    assert.notEqual(a.session.state().version, v, 'the loop bumped the version meanwhile')
    assert.deepEqual(await a.session.action({ type: 'STOP', reason: 'MANUAL', stateVersion: v }), { ok: true })
    await runA
    await assertClean('stop-stale', a.session, a.dep, a.session.dir)

    // (b) once windDown began, STOP is refused and can.stop is false (a pause under windDown's plan is the race above)
    const b = await build({ ...scenario('normal'), name: 'stop-during-wind', endAtSimMinute: 40 })
    const s = b.session as any, doWind = s.doWindDown.bind(s)
    let during: unknown = null
    s.doWindDown = () => {
      const p = doWind()
      during = { can: b.session.state().can.stop, res: b.session.action({ type: 'STOP', reason: 'MANUAL', stateVersion: b.session.state().version }) }
      return p
    }
    await b.session.run()
    const d = during as { can: boolean; res: Promise<unknown> }
    assert.equal(d.can, false)
    assert.equal(((await d.res) as { status: number }).status, 409)
    await assertClean('stop-during-wind', b.session, b.dep, b.session.dir)
  })

  test('an llm() throw is a fail-closed QWEN_UNAVAILABLE deny and a clean session end, not a crash with holds locked', async () => {
    const { session, dep, dir } = await runScenario({ ...scenario('normal'), name: 'llm-throws', stub: () => { throw new Error('LLM_MODE=kiln needs KILN_API_KEY') } })
    const { chain } = await assertClean('llm-throws', session, dep, dir)
    const decisions = chain.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision).filter((d) => d.action !== 'inference')
    assert.ok(decisions.length >= 1 && decisions.every((d) => !d.verdict.approve && d.verdict.code === 'QWEN_UNAVAILABLE'))
    assert.ok(session.state().health.kiln.errors >= decisions.length, 'every failed Kiln call is counted in health')
  })

  test('a HALTed Committer: run() fails loudly with the HALT reason instead of a ledger error', async () => {
    const { session } = await build({ ...scenario('normal'), name: 'halt', endAtSimMinute: 100_000 })
    const s = session as any
    const runP = session.run()
    await sleep(700)
    // a pre-send revert (the agent may not refund) HALTs the Committer for good
    await s.send({ signer: 'agent', fn: 'refund', args: [1n], expect: ['Refunded'], req_id: null, job_id: null, record: { type: 'SESSION_END', body: {} } })
    await assert.rejects(runP, /HALTED \(PRESEND_REVERT:Unauthorized\)/)
  })

  test('dashboard sync age is real time: it grows (and rpcOk drops) while the RPC is down, at any speed', async () => {
    const { session, dep } = await build({ ...scenario('normal'), name: 'stale', endAtSimMinute: 180 })
    const s = session as any
    const runP = session.run()
    await sleep(500)
    const live = s.client
    s.client = createPublicClient({ chain: CHAINS.anvil, transport: http('http://127.0.0.1:1', { retryCount: 0 }) }) // reads fail fast from here; the Committer keeps its own client
    await sleep(1500)
    const st = session.state()
    s.client = live
    assert.ok(st.syncAgeMs >= 1000, `syncAgeMs ${st.syncAgeMs} >= 1000`)
    assert.equal(st.health.rpcOk, false)
    await runP
    await assertClean('stale', session, dep, session.dir)
  })

  test('F1 names another vendor: the open bills at the APPROVED vendor; a topUp for a different vendor is gate-denied', async () => {
    // open targets B but F1 picks A (approved: A is allowlisted) -> the slot must be A (A's address and A's price);
    // every topUp then names B, which is not this job's vendor -> VENDOR_NOT_ALLOWED with 0 F2 calls, never a ToppedUp.
    const sc: ScenarioDef = { ...scenario('normal'), name: 'vendor-label', endAtSimMinute: 120,
      stub: (req, n) => (req.flow === 'F1'
        ? { toolName: 'request_gpu_hold', toolArgs: { vendor_label: /- action: open/.test(req.messages.map((m) => m.content).join('\n')) ? 'A' : 'B', gpu: 'h100', amount_usd: '2', rationale: 'continue the approved fine-tune' } }
        : sharedStub(req, n)) }
    const { session, dep, dir } = await runScenario(sc)
    const { chain, logs } = await assertClean('vendor-label', session, dep, dir)
    const slot = (session as any).slots[0]
    assert.equal(slot.label, 'A')
    assert.equal(slot.job.pricePerHour, (session as any).prices.vendors.A.pricePerHour, "billed at A's price")
    assert.equal(logs.find((l) => l.name === 'HoldOpened' && l.args.jobId === slot.job.id)!.args.vendor, dep.vendors.A)
    const topups = chain.filter((r) => r.rec.type === 'DECISION').map((r) => r.rec.body as unknown as Decision).filter((d) => d.action === 'topUp')
    assert.ok(topups.length >= 1 && topups.every((d) => !d.verdict.approve && d.verdict.code === 'VENDOR_NOT_ALLOWED' && d.f2.length === 0))
    assert.ok(!logs.some((l) => l.name === 'ToppedUp'))
    assert.equal(session.receipts[0].vendorLabel, 'A')
  })

  test('stolen-key script: an attempt that only reverts (job 0 already closed) is not Denied evidence -> ok false', async () => {
    const { dep, keysDir } = await runScenario('nan')
    const r = await stolenKeyAttack({ dep, chain: 'anvil', rpcUrls: [url], keysDir, log: () => {} })
    assert.equal(r.moved, false)
    assert.equal(r.results[0].code, 'VENDOR_NOT_ALLOWED')
    assert.equal(r.results[1].code, null)
    assert.equal(r.ok, false)
  })
})

describe('deadline demo on a chain whose clock lags the local wall clock', { skip: ANVIL ? false : 'anvil binary not found: skipping' }, () => {
  test('the wall-clock demo settle pays nothing while the chain is early and retries until Denied(PAST_DEADLINE)', async () => {
    const { url, proc, client } = await startAnvil(['--timestamp', String(Math.floor(Date.now() / 1000) - 3)])
    const root = mkdtempSync(join(tmpdir(), 'session-lag-'))
    try {
      const sc = scenario('deadline')
      const keysDir = join(root, 'keys')
      const dep = await Session.deployFor(sc, { chain: 'anvil', rpcUrls: [url], keysDir, outDir: join(root, 'dep') })
      const session = new Session({
        chain: 'anvil', rpcUrls: [url], publicRpc: url, deployment: dep, agentPk: loadAgentKey(dep.vault, keysDir), founderPk: ANVIL_FOUNDER_PK,
        runsDir: join(root, 'runs'), scenario: sc, llm: { mode: 'stub', stub: sc.stub, cap: 100_000 }, speed: 1, deadlineMarginS: 0n,
        priceFetch: failFetch, hardCapMs: 60_000,
      })
      await session.run()
      const s = await snapshot(client, dep.vault, { vendors: [] })
      assert.equal(s.jobs[0].paid, 0n, 'INFERENCE paid nothing beyond its (zero, stub) usage')
      assert.equal(s.committed, s.jobs.reduce((a, j) => a + j.paid, 0n))
      assert.equal(s.jobs.every((j) => j.closed && j.held === 0n), true)
      const logs = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), await client.getBlockNumber())
      assert.ok(logs.some((l) => l.name === 'Denied' && l.args.enforced === true && fromBytes32(l.args.code as Hex) === 'PAST_DEADLINE'))
      const chain = readChain(join(session.dir, 'records'))
      assert.equal(chain.at(-1)!.rec.type, 'SESSION_END')
      assert.equal(logs.filter((l) => l.args.rec && l.args.rec !== ZERO).at(-1)?.args.rec, chain.at(-1)!.hash)
    } finally { proc.kill(); rmSync(root, { recursive: true, force: true }) }
  })
})

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
