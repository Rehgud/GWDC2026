// scripts/wind-down.ts on a self-spawned anvil, stub LLM: a real Session runs a few loop steps and "crashes" (the loop
// just stops, no windDown), a CHECKPOINT record is left whose settle never went out (crash between record write and
// broadcast), then the emergency CLI must leave the vault paused, every job closed, committed == Σpaid, the vault
// token balance 0, the record chain intact with SESSION_END as the Refunded rec, and an auditor PASS. Re-runs send 0 txs.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex, PublicClient } from 'viem'
import { usdcAbi } from '../src/abi.ts'
import { audit, formatResult } from '../src/audit.ts'
import { getLogsChunked, makePublicClient, snapshot } from '../src/chainread.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from '../src/deploy.ts'
import { readChain, verifyChain } from '../src/record.ts'
import { scenario } from '../src/scenarios.ts'
import { Session } from '../src/session.ts'
import { emergencyWindDown } from '../scripts/wind-down.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failFetch = (async () => { throw new Error('no network in tests') }) as unknown as typeof fetch
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)) }) })

let anvil: ChildProcess | undefined
let url: string
let client: PublicClient
let root: string

before(async () => {
  if (!ANVIL) return
  const port = await freePort()
  url = `http://127.0.0.1:${port}`
  anvil = spawn(ANVIL, ['--port', String(port)], { stdio: 'ignore' })
  client = makePublicClient('anvil', [url])
  for (let t = 0; ; t++) { try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await sleep(100) } }
  root = mkdtempSync(join(tmpdir(), 'wind-down-'))
})
after(() => { anvil?.kill(); if (root) rmSync(root, { recursive: true, force: true }) })

test('emergency wind-down after a backend crash: paused, all closed, refunded, chain anchored, audit PASS, idempotent', { skip: ANVIL ? false : 'anvil binary not found' }, async () => {
  const sc = scenario('normal')
  const keysDir = join(root, 'keys')
  const dep = await Session.deployFor(sc, { chain: 'anvil', rpcUrls: [url], keysDir, outDir: join(root, 'deployments') })
  const session = new Session({
    chain: 'anvil', rpcUrls: [url], publicRpc: url, deployment: dep, agentPk: loadAgentKey(dep.vault, keysDir), founderPk: ANVIL_FOUNDER_PK,
    runsDir: join(root, 'runs'), scenario: sc, llm: { mode: 'stub', stub: sc.stub, cap: 100_000 }, speed: 60, priceFetch: failFetch,
  })
  // The "crash": start + ~1 s of loop steps (two checkpoints at speed 60), then the process is gone: no windDown ever runs.
  await session.start()
  for (const t0 = Date.now(); Date.now() - t0 < 1000;) { await (session as any).loopStep(); await sleep(16) }
  await (session as any).drain() // what the dead process already queued lands (or not) before the founder steps in
  const dir = session.dir

  const s0 = await snapshot(client, dep.vault, { vendors: [] })
  const open = s0.jobs.flatMap((j, i) => (j.closed ? [] : [i]))
  const vendorJob = open.filter((i) => s0.jobs[i].vendor.toLowerCase() !== dep.inferencePayee.toLowerCase()).sort((a, b) => Number(s0.jobs[b].held - s0.jobs[a].held))[0]
  assert.ok(open.length >= 2 && vendorJob !== undefined && !s0.paused, `crashed mid-run with the INFERENCE hold and a vendor job open (open: ${open})`)
  assert.ok(s0.jobs[vendorJob].paid > 0n && s0.jobs[vendorJob].held > 10_300n, 'the vendor job was settled at least once and still holds money')
  // A CHECKPOINT written just before the crash: its settle never reached the chain.
  const orphan = session.records.append('CHECKPOINT', { job_id: String(vendorJob), amount: '10000', signer: 'agent', reason: 'periodic', accrued: '0', settledNet: '0', runningMs: '0', loss: 'none' })
  const nRecs = readChain(join(dir, 'records')).length
  const block0 = await client.getBlockNumber({ cacheTime: 0 })
  const quiet = { log: () => {} }

  // --dry-run: the whole plan, nothing sent, nothing written
  const dry = await emergencyWindDown(dir, { ...quiet, dryRun: true, payLastCheckpoint: true })
  assert.equal(dry.sent, 0)
  assert.equal(dry.steps.length, 1 + 1 + open.length + 1, `pause + orphan settle + ${open.length} closes + refund: ${dry.steps.join(' | ')}`)
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), block0, 'dry run mined nothing')
  assert.equal(readChain(join(dir, 'records')).length, nRecs, 'dry run wrote no record')

  // the real run
  const r = await emergencyWindDown(dir, { ...quiet, payLastCheckpoint: true })
  assert.equal(r.sent, r.steps.length, 'every planned step is one tx')
  const s = await snapshot(client, dep.vault, { vendors: [] })
  assert.equal(s.paused, true, 'vault paused')
  assert.ok(s.jobs.every((j) => j.closed && j.held === 0n), 'every job closed, no hold left')
  assert.equal(s.committed, s.jobs.reduce((a, j) => a + j.paid, 0n), 'committed == Σpaid')
  assert.equal(await client.readContract({ address: dep.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [dep.vault] }), 0n, 'vault token balance 0 after the refund')

  const chain = readChain(join(dir, 'records'))
  assert.deepEqual(verifyChain(chain), [], 'record chain continues seq/prev intact')
  const added = chain.slice(nRecs).map((x) => x.rec)
  assert.deepEqual(added.map((x) => x.type), ['STOP', ...open.flatMap((i) => (i === vendorJob ? ['CHECKPOINT', 'CLOSE'] : ['CLOSE'])), 'SESSION_END'])
  assert.equal(added[0].body.reason, 'MANUAL')
  assert.equal(added.filter((x) => x.type === 'CLOSE' && x.body.reason === 'emergency-wind-down' && x.body.signer === 'founder').length, open.length)
  const logs = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), await client.getBlockNumber({ cacheTime: 0 }))
  const paidCp = chain.find((x) => x.rec.type === 'CHECKPOINT' && x.rec.body.of === orphan.hash)
  assert.ok(paidCp && paidCp.rec.body.signer === 'founder' && paidCp.rec.body.amount === '10000', 'the orphan checkpoint was paid under a new founder CHECKPOINT')
  assert.ok(logs.some((l) => l.name === 'Settled' && l.args.jobId === BigInt(vendorJob) && l.args.amount === 10_000n && l.args.rec === paidCp!.hash), 'its Settled names that record')
  assert.equal(chain.at(-1)!.rec.type, 'SESSION_END', 'last record is SESSION_END')
  assert.equal(logs.filter((l) => l.name === 'Refunded').at(-1)!.args.rec, chain.at(-1)!.hash, 'SESSION_END is the rec of the Refunded event')

  const a = await audit(dir, { client })
  assert.equal(a.exitCode, 0, formatResult(a))

  // idempotent: a second run (and a second dry run) sends nothing
  const blockEnd = await client.getBlockNumber({ cacheTime: 0 })
  assert.deepEqual(await emergencyWindDown(dir, { ...quiet, payLastCheckpoint: true }), { sent: 0, steps: [] })
  assert.deepEqual(await emergencyWindDown(dir, { ...quiet, dryRun: true }), { sent: 0, steps: [] })
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), blockEnd, 're-runs mined nothing')
  assert.equal(readChain(join(dir, 'records')).length, chain.length)
})
