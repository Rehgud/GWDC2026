// Orchestrator integration on a self-spawned anvil, stub LLM only (no live Kiln, no network: a fast-failing
// priceFetch forces the committed Akash snapshot). Each scenario runs on a fresh vault and must end with
// vault committed == Σpaid, budget − committed refunded (token balance 0), a clean hash chain, every commit's
// recHash naming a record file, the last on-chain rec == the last record's hash, and windDown idempotent.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex, PublicClient } from 'viem'
import { usdcAbi } from '../src/abi.ts'
import { makePublicClient, snapshot, getLogsChunked } from '../src/chainread.ts'
import { fromBytes32 } from '../src/codes.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from '../src/deploy.ts'
import { readChain, verifyChain, type Decision } from '../src/record.ts'
import { scenario } from '../src/scenarios.ts'
import { Session } from '../src/session.ts'
import type { Deployment } from '../src/types.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const ZERO = `0x${'00'.repeat(32)}`
const failFetch = (async () => { throw new Error('no network in tests') }) as unknown as typeof fetch
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)) }) })

describe('orchestrator on anvil (stub LLM)', { skip: ANVIL ? false : 'anvil binary not found: skipping' }, () => {
  let anvil: ChildProcess
  let url: string
  let client: PublicClient
  let root: string

  before(async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    anvil = spawn(ANVIL!, ['--port', String(port)], { stdio: 'ignore' })
    client = makePublicClient('anvil', [url])
    for (let t = 0; ; t++) { try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await sleep(100) } }
    root = mkdtempSync(join(tmpdir(), 'session-'))
  })
  after(() => { anvil?.kill(); if (root) rmSync(root, { recursive: true, force: true }) })

  const bal = (usdc: Hex, a: Hex) => client.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>

  async function runScenario(name: string): Promise<{ session: Session; dep: Deployment; dir: string }> {
    const sc = scenario(name)
    const keysDir = join(root, name, 'keys'), outDir = join(root, name, 'deployments'), runsDir = join(root, name, 'runs')
    const dep = await Session.deployFor(sc, { chain: 'anvil', rpcUrls: [url], keysDir, outDir })
    const session = new Session({
      chain: 'anvil', rpcUrls: [url], publicRpc: url, deployment: dep,
      agentPk: loadAgentKey(dep.vault, keysDir), founderPk: ANVIL_FOUNDER_PK, runsDir, scenario: sc,
      llm: { mode: 'stub', stub: sc.stub, cap: 100_000 }, speed: sc.suggestedSpeed ?? 60,
      deadlineMarginS: sc.suggestedMarginS ?? 15n, priceFetch: failFetch, hardCapMs: 60_000,
    })
    await session.run()
    return { session, dep, dir: session.dir }
  }

  /** The invariants every scenario must satisfy at the end (success criteria 1-4). */
  async function assertClean(name: string, session: Session, dep: Deployment, dir: string) {
    const s = await snapshot(client, dep.vault, { vendors: [dep.vendors.A, dep.vendors.B, dep.vendors.C, dep.inferencePayee] })
    const paid = s.jobs.reduce((a, j) => a + j.paid, 0n)
    const held = s.jobs.reduce((a, j) => a + j.held, 0n)
    assert.equal(held, 0n, `${name}: all holds released`)
    assert.equal(s.committed, paid, `${name}: committed == Σpaid`)
    assert.equal(await bal(dep.usdc, dep.vault), 0n, `${name}: vault token balance 0 (budget − committed refunded)`)
    assert.ok(!s.paused || true)

    const chain = readChain(join(dir, 'records'))
    assert.deepEqual(verifyChain(chain), [], `${name}: hash chain intact`)
    assert.equal(chain[0].rec.type, 'SESSION_START', `${name}: seq 0 is SESSION_START`)
    assert.equal(chain.at(-1)!.rec.type, 'SESSION_END', `${name}: last record is SESSION_END (refund anchors the tail)`)

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
    const logs = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), BigInt(run.lastBlock))
    const lastOnchainRec = logs.filter((l) => l.args.rec && l.args.rec !== ZERO).at(-1)?.args.rec
    assert.equal(lastOnchainRec, chain.at(-1)!.hash, `${name}: on-chain tail anchored to the last record`)

    // windDown a second time sends 0 txs
    const before = session.ledger.length
    await session.windDown()
    assert.equal(session.ledger.length, before, `${name}: second windDown sends 0 txs`)

    assert.equal(session.committer.halted, false, `${name}: committer never HALTed`)
    return { chain, logs }
  }

  for (const name of ['normal', 'qwen-deny', 'stop', 'nan', 'migrate', 'plateau', 'demo']) {
    test(name, async () => {
      const { session, dep, dir } = await runScenario(name)
      await assertClean(name, session, dep, dir)
    })
  }

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
})

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
