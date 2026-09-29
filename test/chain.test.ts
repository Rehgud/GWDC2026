// anvil integration: deploy + preflight, Committer outcomes (I4, I8), snapshot pinning, chunked getLogs.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestClient, createWalletClient, custom, encodeAbiParameters, encodeEventTopics, http, keccak256, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { usdcAbi, vaultAbi } from '../src/abi.ts'
import { Committer, classify, makeWallet, type Intent } from '../src/chain.ts'
import { CHAINS, ReadFailed, decodeVaultLogs, getLogsChunked, makePublicClient, snapshot, untilLatest } from '../src/chainread.ts'
import { toBytes32 } from '../src/codes.ts'
import { RecordChain, ZERO_HASH, readChain, verifyChain } from '../src/record.ts'
import { ANVIL_FOUNDER_PK, PAYEES, agentKeyPath, deploy, loadAgentKey, payee, preflight } from '../src/deploy.ts'
import type { Deployment } from '../src/types.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const STRANGER_PK: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // anvil #2
const NO_JOB = 2n ** 256n - 1n

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => res(port))
    })
  })

// ---- pure / stubbed: run without anvil ----
const V: Hex = '0x00000000000000000000000000000000000000aa'
const vlog = (eventName: string, args: Record<string, unknown>, data: Hex, address: Hex = V) =>
  ({ address, topics: encodeEventTopics({ abi: vaultAbi, eventName, args } as any), data, logIndex: 0, blockNumber: 1n, transactionHash: ZERO_HASH }) as any
const denied = (enforced: boolean, jobId = 5n) => vlog('Denied', { jobId, code: toBytes32('OVER_MAX_HOLD'), rec: ZERO_HASH }, encodeAbiParameters([{ type: 'bool' }], [enforced]))
const u256 = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const ok = (logs: any[]) => ({ status: 'success' as const, logs })

test('classify: pure verdicts (vault logs only, enforced Denied always DENIED, jobId only from HoldOpened)', () => {
  assert.deepEqual(classify({ status: 'reverted', logs: [] }, V, ['Closed']), { status: 'HALT', reason: 'REVERTED', events: [] })
  assert.deepEqual(classify(ok([]), V, ['Closed']), { status: 'HALT', reason: 'UNEXPECTED', events: [] })
  const d = classify(ok([denied(true)]), V, ['ToppedUp'])
  assert.equal(d.status, 'DENIED')
  assert.equal((d as { code: string }).code, 'OVER_MAX_HOLD')
  assert.ok(!('jobId' in d)) // Denied.jobId is never a new job
  // an enforced Denied is a contract refusal even when the caller listed 'Denied' as expected
  assert.equal(classify(ok([denied(true)]), V, ['Denied']).status, 'DENIED')
  assert.equal(classify(ok([denied(false)]), V, ['Denied']).status, 'OK') // recordDecision
  assert.equal(classify(ok([denied(false)]), V, ['ToppedUp']).status, 'HALT')
  // HoldOpened from another contract (spoof) is ignored
  const opened = (id: bigint, address?: Hex) => vlog('HoldOpened', { jobId: id, vendor: V, rec: ZERO_HASH }, u256(1n), address)
  assert.deepEqual(classify(ok([opened(9n, '0x00000000000000000000000000000000000000bb')]), V, ['HoldOpened']), { status: 'HALT', reason: 'UNEXPECTED', events: [] })
  const o = classify(ok([opened(7n)]), V, ['HoldOpened'])
  assert.equal(o.status, 'OK')
  assert.equal((o as { jobId?: bigint }).jobId, 7n)
  const t = classify(ok([vlog('ToppedUp', { jobId: 3n, rec: ZERO_HASH }, u256(1n))]), V, ['ToppedUp'])
  assert.equal(t.status, 'OK')
  assert.ok(!('jobId' in t))
})

test('snapshot: RPC error twice -> ReadFailed (one retry)', async () => {
  let n = 0
  const dead = { getBlock: async () => { n++; throw new Error('ECONNREFUSED') } } as any
  await assert.rejects(snapshot(dead, V, { vendors: [] }), (e: Error) => e instanceof ReadFailed && e.name === 'ReadFailed')
  assert.equal(n, 2)
})

test('untilLatest: waits until latest reaches the receipt block (flashblock receipts arrive a block early); bounded', async () => {
  const seq = [5n, 5n, 6n]
  let n = 0
  await untilLatest(async () => seq[Math.min(n++, seq.length - 1)], 6n, 5_000, 1)
  assert.equal(n, 3)
  let m = 0
  await untilLatest(async () => { m++; return 5n }, 6n, 30, 5) // never catches up: returns after the timeout, no throw
  assert.ok(m >= 2)
})

test('getLogsChunked: a 429 chunk is retried once; twice -> throws; other errors are not retried', async () => {
  const stub = (fail: (n: number) => string | null) => {
    const s = { n: 0, getLogs: async () => { const m = fail(++s.n); if (m) throw new Error(m); return [] } }
    return s
  }
  const once = stub((n) => (n === 1 ? 'HTTP 429 Too Many Requests' : null))
  const always = stub(() => 'query exceeds block range limit')
  const other = stub(() => 'execution reverted')
  const [r] = await Promise.all([
    getLogsChunked(once as any, V, 0n, 10n),
    assert.rejects(getLogsChunked(always as any, V, 0n, 10n), /limit/),
    assert.rejects(getLogsChunked(other as any, V, 0n, 10n), /reverted/),
  ])
  assert.deepEqual(r, [])
  assert.deepEqual([once.n, always.n, other.n], [2, 2, 1])
})

describe('chain layer on anvil', { skip: ANVIL ? false : 'anvil binary not found ($HOME/.foundry/bin/anvil or PATH): skipping chain tests' }, () => {
  let anvil: ChildProcess
  let url: string
  let client: PublicClient
  let tc: ReturnType<typeof createTestClient>
  let dir: string
  let dep: Deployment
  let records: RecordChain
  let c: Committer
  let jobId: bigint

  const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const nonce = (address: Hex, blockTag: 'latest' | 'pending' = 'latest') => client.getTransactionCount({ address, blockTag })
  const bal = (a: Hex) => client.readContract({ address: dep.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] })
  const committer = (o: { agentPk?: Hex; records?: RecordChain; receiptTimeoutMs?: number } = {}) =>
    new Committer({
      client, vault: dep.vault, records: o.records ?? records, eventsPath: join(dir, 'events.jsonl'), receiptTimeoutMs: o.receiptTimeoutMs,
      wallets: { agent: makeWallet('anvil', [url], o.agentPk ?? loadAgentKey(dep.vault, join(dir, 'keys'))), founder: makeWallet('anvil', [url], ANVIL_FOUNDER_PK) },
    })
  const intent = (i: Partial<Intent> & Pick<Intent, 'fn' | 'args' | 'expect'>): Intent => ({ signer: 'agent', req_id: null, job_id: null, record: null, ...i })
  const decision = (i: number | string) => intent({ fn: 'recordDecision', args: [NO_JOB, toBytes32('QWEN_DENIED')], expect: ['Denied'], record: { type: 'DECISION', body: { i } }, req_id: `rd-${i}` })

  before(async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    anvil = spawn(ANVIL!, ['--port', String(port)], { stdio: 'ignore' })
    client = makePublicClient('anvil', [url])
    tc = createTestClient({ mode: 'anvil', transport: http(url) })
    for (let t = 0; ; t++) {
      try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)) }
    }
    dir = mkdtempSync(join(tmpdir(), 'chain-'))
    const now = Number((await client.getBlock()).timestamp)
    dep = await deploy({
      chain: 'anvil', rpcUrls: [url], founderPk: ANVIL_FOUNDER_PK, budget: 20_000_000n, maxHold: 6_000_000n,
      deadline: now + 36 * 3600, label: 'test', outDir: join(dir, 'deployments'), keysDir: join(dir, 'keys'),
    })
    records = new RecordChain(join(dir, 'records'), 'run-test')
    c = committer()
  })

  after(() => {
    anvil?.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('deploy + preflight pass; key file 600 and never in the deployment json', async () => {
    assert.deepEqual(await preflight(dep, client), [])
    assert.deepEqual(await preflight({ ...dep, maxHold: '1' }, client), ['maxHold'])
    assert.deepEqual(await preflight(dep, client, { now: dep.deadline - 60 }), ['deadline', 'rpcHead'])
    assert.deepEqual(await preflight(dep, client, { now: dep.deadline - 60, relaxDeadline: true }), ['rpcHead'])
    const keyFile = agentKeyPath(dep.vault, join(dir, 'keys'))
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
    const pk = readFileSync(keyFile, 'utf8').trim()
    const json = readFileSync(join(dir, 'deployments', `31337-${dep.vault}.json`), 'utf8')
    assert.ok(!json.toLowerCase().includes(pk.slice(2).toLowerCase()))
    assert.equal(readFileSync(join(dir, 'deployments', 'current.json'), 'utf8'), json)
    assert.equal(dep.vendors.A, payee('vendor/A'))
    assert.equal(dep.inferencePayee, PAYEES.inferencePayee)
    assert.equal(dep.setupTxs.length, 11) // MockUSDC, mint, vault, setVendor x4, setMaxHold, agent ETH, approve, fund
  })

  test('open -> OK with jobId; HoldOpened rec == keccak of the record file bytes', async () => {
    const o = await c.commit(intent({ fn: 'open', args: [dep.vendors.A, 2_560_000n], expect: ['HoldOpened'], record: { type: 'DECISION', body: { action: 'open' } }, req_id: 'r-open' }))
    assert.equal(o.status, 'OK')
    if (o.status !== 'OK') return
    assert.equal(o.jobId, 0n)
    jobId = o.jobId!
    const stored = readChain(join(dir, 'records')).at(-1)!
    assert.equal(keccak256(readFileSync(join(dir, 'records', stored.file))), o.recHash)
    const ev = o.events.find((e) => e.name === 'HoldOpened')!
    assert.equal(ev.args.rec, o.recHash)
    assert.equal(ev.args.gross, 2_636_800n)
    const lines = events().filter((l) => l.req_id === 'r-open')
    assert.deepEqual(lines.map((l) => l.ev), ['intent', 'signed', 'sent', 'mined'])
    assert.equal(lines[1].txHash, o.txHash) // hash on disk before the broadcast
    assert.equal(lines[3].jobId, '0')
    assert.ok(lines.every((l) => l.src === 'commit' && l.schema_version === 1 && l.run_id === 'run-test'))
  })

  test('topUp above maxHold -> DENIED(OVER_MAX_HOLD), Denied.rec anchors the record, 0 token movement', async () => {
    const before = await snapshot(client, dep.vault, { vendors: [] })
    const balBefore = await Promise.all([dep.vault, dep.vendors.A, dep.feeTo].map(bal))
    const o = await c.commit(intent({ fn: 'topUp', args: [jobId, 6_000_001n], expect: ['ToppedUp'], record: { type: 'DECISION', body: { action: 'topUp' } }, job_id: '0' }))
    assert.equal(o.status, 'DENIED')
    if (o.status !== 'DENIED') return
    assert.equal(o.code, 'OVER_MAX_HOLD')
    const d = o.events.find((e) => e.name === 'Denied')!
    assert.equal(d.args.rec, o.recHash)
    assert.equal(d.args.rec, readChain(join(dir, 'records')).at(-1)!.hash)
    assert.equal(d.args.enforced, true)
    const afterS = await snapshot(client, dep.vault, { vendors: [] })
    assert.deepEqual(await Promise.all([dep.vault, dep.vendors.A, dep.feeTo].map(bal)), balBefore)
    assert.equal(afterS.committed, before.committed)
    assert.deepEqual(afterS.jobs, before.jobs)
    assert.equal(c.halted, false)
  })

  test('recordDecision -> OK with Denied(enforced=false)', async () => {
    const o = await c.commit(decision('rd'))
    assert.equal(o.status, 'OK')
    if (o.status !== 'OK') return
    const d = o.events.find((e) => e.name === 'Denied')!
    assert.equal(d.args.enforced, false)
    assert.equal(d.args.jobId, NO_JOB)
    assert.equal(d.args.rec, o.recHash)
  })

  test('founder setPaused: the STOP record hash is the reasonHash', async () => {
    const o = await c.commit(intent({ signer: 'founder', fn: 'setPaused', args: [false], expect: ['PausedSet'], record: { type: 'STOP', body: { reason: 'test' } } }))
    assert.equal(o.status, 'OK')
    if (o.status !== 'OK') return
    assert.equal(o.events[0].args.reasonHash, o.recHash)
    assert.equal(o.recHash, readChain(join(dir, 'records')).at(-1)!.hash)
  })

  test('snapshot at a pinned block is internally consistent and repeatable', async () => {
    const s1 = await snapshot(client, dep.vault, { vendors: [dep.vendors.A, dep.vendors.B, dep.inferencePayee, payee('not-allowed')] })
    const o = await c.commit(intent({ fn: 'open', args: [dep.inferencePayee, 50_000n], expect: ['HoldOpened'], record: { type: 'DECISION', body: { action: 'inference' } } }))
    assert.equal(o.status, 'OK')
    const again = await snapshot(client, dep.vault, { vendors: Object.keys(s1.vendorAllowed) as Hex[], block: s1.block })
    assert.deepEqual({ ...again, readAt: 0 }, { ...s1, readAt: 0 })
    assert.equal(s1.blockTs, (await client.getBlock({ blockNumber: s1.block })).timestamp)
    assert.equal(Object.values(s1.vendorAllowed).filter(Boolean).length, 3)
    const s2 = await snapshot(client, dep.vault, { vendors: [] })
    assert.equal(s2.jobs.length, s1.jobs.length + 1)
    for (const s of [s1, s2]) assert.equal(s.committed, s.jobs.reduce((a, j) => a + j.held + j.paid, 0n))
    assert.equal(s2.committed - s1.committed, 50_000n) // INFERENCE: fee-exempt
    assert.equal(s2.feeBps, 300n)
  })

  test('close then close again -> ALREADY_CLOSED, no tx the second time', async () => {
    const close = () => c.commit(intent({ fn: 'close', args: [jobId], expect: ['Closed'], record: { type: 'CLOSE', body: {} }, job_id: '0' }))
    const o1 = await close()
    assert.equal(o1.status, 'OK')
    const n = await nonce(dep.agent, 'pending')
    const seq = records.seq
    const o2 = await close()
    assert.deepEqual(o2, { status: 'ALREADY_CLOSED' })
    assert.equal(await nonce(dep.agent, 'pending'), n)
    assert.equal(records.seq, seq) // simulated before the record: no unanchored CLOSE left behind
    assert.equal(c.halted, false)
  })

  test('stillValid() false -> CANCELLED: no record, no tx', async () => {
    const seq = records.seq
    const n = await nonce(dep.agent, 'pending')
    const o = await c.commit({ ...decision('stale'), stillValid: () => false })
    assert.deepEqual(o, { status: 'CANCELLED', reason: 'stale' })
    assert.equal(records.seq, seq)
    assert.equal(readChain(join(dir, 'records')).length, seq)
    assert.equal(await nonce(dep.agent, 'pending'), n)
  })

  test('I8: 20 intents via Promise.all -> linear prev chain, consecutive nonces in intent order', async () => {
    const seq0 = records.seq
    const n0 = await nonce(dep.agent)
    const p = Promise.all(Array.from({ length: 20 }, (_, i) => c.commit({ ...decision(i), job_id: 'burst' })))
    assert.equal(c.pending, 20)
    assert.equal(c.pendingFor('burst'), 20)
    const outs = await p
    assert.equal(c.pending, 0)
    assert.equal(c.pendingFor('burst'), 0)
    assert.ok(outs.every((o) => o.status === 'OK'))
    const txs = await Promise.all(outs.map((o) => client.getTransaction({ hash: (o as { txHash: Hex }).txHash })))
    assert.deepEqual(txs.map((t) => t.nonce), Array.from({ length: 20 }, (_, i) => n0 + i))
    const chain = readChain(join(dir, 'records'))
    assert.deepEqual(verifyChain(chain), [])
    assert.deepEqual(chain.slice(seq0).map((r) => r.rec.body.i), Array.from({ length: 20 }, (_, i) => i))
    assert.deepEqual(chain.slice(seq0).map((r) => r.hash), outs.map((o) => (o as { recHash: Hex }).recHash))
  })

  test('getLogsChunked over > 1000 blocks returns every vault event, sorted', async () => {
    const first = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), await client.getBlockNumber({ cacheTime: 0 }))
    await tc.mine({ blocks: 1500 })
    const o = await c.commit(decision('after-gap'))
    assert.equal(o.status, 'OK')
    const head = await client.getBlockNumber({ cacheTime: 0 })
    const all = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), head)
    const raw = decodeVaultLogs(await client.getLogs({ address: dep.vault, fromBlock: BigInt(dep.deployBlock), toBlock: head }), dep.vault)
    assert.equal(all.length, first.length + 1)
    assert.deepEqual(all, raw)
    assert.deepEqual(await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), head, 7n), all)
    assert.equal(all.at(-1)!.args.rec, (o as { recHash: Hex }).recHash)
    assert.ok(head - BigInt(dep.deployBlock) > 1000n)
    assert.deepEqual([...new Set(all.map((e) => e.name))].sort(), ['Closed', 'Denied', 'Funded', 'HoldOpened', 'MaxHoldSet', 'PausedSet', 'VendorSet'])
  })

  test('record write failure -> HALT RECORD_WRITE, no tx; JobClosed on an unknown id -> HALT, not ALREADY_CLOSED', async () => {
    const n = await nonce(dep.agent, 'pending')
    const broken = { runId: 'run-broken', append: () => { throw new Error('ENOSPC: no space left on device') } } as unknown as RecordChain
    const w = committer({ records: broken })
    assert.deepEqual(await w.commit(decision('enospc')), { status: 'HALT', reason: 'RECORD_WRITE' })
    assert.equal(w.halted, true)
    assert.equal(await nonce(dep.agent, 'pending'), n)
    const u = committer({ records: new RecordChain(join(dir, 'records-unknown'), 'run-unknown') })
    const o = await u.commit(intent({ fn: 'close', args: [999n], expect: ['Closed'], record: { type: 'CLOSE', body: {} } }))
    assert.deepEqual(o, { status: 'HALT', reason: 'PRESEND_REVERT:JobClosed' })
    assert.equal(await nonce(dep.agent, 'pending'), n)
    assert.equal(readChain(join(dir, 'records-unknown')).length, 0)
  })

  test('stillValid() is asked when the intent reaches the head of the queue, not when it is enqueued', async () => {
    let valid = true
    const first = c.commit(decision('q1'))
    const second = c.commit({ ...decision('q2'), stillValid: () => valid })
    valid = false // flips while `second` waits behind `first`
    assert.deepEqual(await second, { status: 'CANCELLED', reason: 'stale' })
    assert.equal((await first).status, 'OK')
  })

  test('record guard: a rec-carrying call without a record (caller-supplied rec) or a record on fund -> HALT, no record, no tx', async () => {
    const recDir = join(dir, 'records-guard')
    const n = await nonce(dep.agent, 'pending')
    const g = committer({ records: new RecordChain(recDir, 'run-guard') })
    const o = await g.commit(intent({ fn: 'open', args: [dep.vendors.A, 1_000_000n, ZERO_HASH], expect: ['HoldOpened'] }))
    assert.deepEqual(o, { status: 'HALT', reason: 'RECORD_MISMATCH:open' })
    assert.equal(g.halted, true)
    const g2 = committer({ records: new RecordChain(recDir, 'run-guard') })
    const o2 = await g2.commit(intent({ signer: 'founder', fn: 'fund', args: [0n, BigInt(dep.deadline)], expect: ['Funded'], record: { type: 'DECISION', body: {} } }))
    assert.deepEqual(o2, { status: 'HALT', reason: 'RECORD_MISMATCH:fund' })
    assert.equal(readChain(recDir).length, 0)
    assert.equal(await nonce(dep.agent, 'pending'), n)
  })

  test('broadcast: lost RPC answer -> same hash re-queried, OK, one tx; refused -> HALT SEND_FAILED with the hash logged, no tx', async () => {
    const agentPk = loadAgentKey(dep.vault, join(dir, 'keys'))
    const flaky = (forward: boolean) => {
      const base = http(url, { retryCount: 0 })({ chain: CHAINS.anvil })
      const request = async (a: any) => {
        if (a.method === 'eth_sendRawTransaction') {
          if (forward) await base.request(a)
          throw new Error('socket hang up')
        }
        return base.request(a)
      }
      return createWalletClient({ account: privateKeyToAccount(agentPk), chain: CHAINS.anvil, transport: custom({ request }, { retryCount: 0 }) })
    }
    const founder = makeWallet('anvil', [url], ANVIL_FOUNDER_PK)
    const mk = (forward: boolean) => new Committer({ client, vault: dep.vault, records, eventsPath: join(dir, 'events.jsonl'), wallets: { agent: flaky(forward), founder } })

    const n = await nonce(dep.agent)
    const lost = await mk(true).commit(decision('lost'))
    assert.equal(lost.status, 'OK')
    assert.equal(await nonce(dep.agent), n + 1)
    assert.deepEqual(events().filter((l) => l.req_id === 'rd-lost').map((l) => l.ev), ['intent', 'signed', 'sent', 'mined'])

    const r = mk(false)
    const refused = await r.commit(decision('refused'))
    assert.equal(refused.status, 'HALT')
    if (refused.status !== 'HALT') return
    assert.match(refused.reason, /^SEND_FAILED:/)
    const lines = events().filter((l) => l.req_id === 'rd-refused')
    assert.deepEqual(lines.map((l) => l.ev), ['intent', 'signed', 'halt'])
    assert.ok(refused.txHash && lines[1].txHash === refused.txHash && lines[2].txHash === refused.txHash)
    assert.equal(r.halted, true)
    assert.equal(await nonce(dep.agent, 'pending'), n + 1)
  })

  test('same-nonce replacement (cast / stolen agent key) -> HALT REPLACED, never judged as ours', async () => {
    const recDir = join(dir, 'records-replaced')
    const s = committer({ records: new RecordChain(recDir, 'run-replaced'), receiptTimeoutMs: 5000 })
    await tc.setAutomine(false)
    try {
      const p = s.commit(intent({ fn: 'open', args: [dep.vendors.A, 1_000_000n], expect: ['HoldOpened'], record: { type: 'DECISION', body: {} }, req_id: 'r-replaced' }))
      while (!events().some((l) => l.req_id === 'r-replaced' && l.ev === 'sent')) await new Promise((r) => setTimeout(r, 20))
      await new Promise((r) => setTimeout(r, 400)) // viem's watcher has fetched our pending tx
      const attacker = makeWallet('anvil', [url], loadAgentKey(dep.vault, join(dir, 'keys')))
      const gp = await client.getGasPrice()
      const theirs = await attacker.writeContract({
        address: dep.vault, abi: vaultAbi, functionName: 'open', args: [dep.vendors.B, 2_000_000n, ZERO_HASH], account: attacker.account!, chain: CHAINS.anvil,
        nonce: await nonce(dep.agent), gas: 400_000n, maxFeePerGas: gp * 10n, maxPriorityFeePerGas: gp * 5n,
      } as any)
      await tc.mine({ blocks: 1 })
      const o = await p
      assert.equal((await client.getTransactionReceipt({ hash: theirs })).status, 'success') // their open DID create a job
      assert.equal(o.status, 'HALT')
      if (o.status !== 'HALT') return
      assert.equal(o.reason, 'REPLACED')
      assert.notEqual(o.txHash, theirs)
      assert.ok(!('jobId' in o))
      assert.equal(s.halted, true)
      const lines = events().filter((l) => l.req_id === 'r-replaced')
      assert.deepEqual(lines.map((l) => l.ev), ['intent', 'signed', 'sent', 'halt'])
      assert.equal(lines[3].replacedBy, theirs)
    } finally {
      await tc.setAutomine(true)
    }
  })

  test('unauthorized pre-send revert -> HALT, no record, no tx, committer stays halted', async () => {
    const s = committer({ agentPk: STRANGER_PK, records: new RecordChain(join(dir, 'records-stranger'), 'run-stranger') })
    const stranger = makeWallet('anvil', [url], STRANGER_PK).account!.address
    const n = await nonce(stranger, 'pending')
    const o = await s.commit(intent({ fn: 'open', args: [dep.vendors.A, 1_000_000n], expect: ['HoldOpened'], record: { type: 'DECISION', body: {} }, req_id: 'r-stranger' }))
    assert.deepEqual(o, { status: 'HALT', reason: 'PRESEND_REVERT:Unauthorized' })
    // simulated before the record is written: nothing unanchored for the auditor to report as UNANCHORED_TAIL
    assert.equal(readChain(join(dir, 'records-stranger')).length, 0)
    assert.deepEqual(events().filter((l) => l.req_id === 'r-stranger').map((l) => l.ev), ['halt'])
    assert.equal(s.halted, true)
    assert.deepEqual(await s.commit(decision('x')), { status: 'HALT', reason: 'halted' })
    assert.equal(await nonce(stranger, 'pending'), n)
    const halt = events().filter((l) => l.ev === 'halt').at(-1)
    assert.equal(halt.reason, 'PRESEND_REVERT:Unauthorized')
    assert.ok(!JSON.stringify(halt).includes(url)) // no raw error objects / RPC URLs in the log
  })

  test('I4: receipt timeout -> HALT UNCONFIRMED, exactly one tx sent (no re-sign)', async () => {
    const s = committer({ receiptTimeoutMs: 800 })
    const n = await nonce(dep.agent)
    await tc.setAutomine(false)
    try {
      const o = await s.commit(decision('stuck'))
      assert.equal(o.status, 'HALT')
      if (o.status !== 'HALT') return
      assert.equal(o.reason, 'UNCONFIRMED')
      assert.ok(o.txHash && o.recHash)
      assert.equal(s.halted, true)
      assert.equal(await nonce(dep.agent, 'pending'), n + 1)
      assert.equal((await s.commit(decision('after'))).status, 'HALT')
      assert.equal(await nonce(dep.agent, 'pending'), n + 1)
      await tc.mine({ blocks: 1 })
      assert.equal((await client.getTransactionReceipt({ hash: o.txHash! })).status, 'success')
      assert.equal(await nonce(dep.agent), n + 1)
      assert.deepEqual(events().filter((l) => l.req_id === 'rd-stuck').map((l) => l.ev), ['intent', 'signed', 'sent', 'halt'])
    } finally {
      await tc.setAutomine(true)
    }
  })

  test('no private key in anything written outside keys/ (events, records, deployments)', () => {
    const secrets = [loadAgentKey(dep.vault, join(dir, 'keys')), ANVIL_FOUNDER_PK, STRANGER_PK].map((k) => k.slice(2).toLowerCase())
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => !f.startsWith('keys') && statSync(join(dir, f)).isFile())
    assert.ok(files.includes('events.jsonl') && files.some((f) => f.startsWith('deployments')) && files.some((f) => f.startsWith('records')))
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8').toLowerCase()
      for (const k of secrets) assert.ok(!t.includes(k), `private key found in ${f}`)
    }
  })
})
