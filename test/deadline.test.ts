// Own file so its ~27 s (11 setup blocks + a 12 s wall-clock deadline) runs in parallel with session.test.ts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { getLogsChunked, makePublicClient } from '../src/chainread.ts'
import { fromBytes32 } from '../src/codes.ts'
import { ANVIL_FOUNDER_PK, loadAgentKey } from '../src/deploy.ts'
import { readChain } from '../src/record.ts'
import { scenario } from '../src/scenarios.ts'
import { Session } from '../src/session.ts'

const ANVIL = [join(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => spawnSync(p, ['--version']).status === 0)
const failFetch = (async () => { throw new Error('no network in tests') }) as unknown as typeof fetch
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)) }) })
async function startAnvil(extra: string[] = []) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const proc = spawn(ANVIL!, ['--port', String(port), ...extra], { stdio: 'ignore' })
  const client = makePublicClient('anvil', [url])
  for (let t = 0; ; t++) { try { await client.getChainId(); break } catch { if (t > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)) } }
  return { url, proc, client }
}

describe('deadline demo on a 1 s-block chain (npm run anvil)', { skip: ANVIL ? false : 'anvil binary not found: skipping' }, () => {
  test('the 12 s deadline starts at fund, so a vendor job opens and an agent tx is then Denied(PAST_DEADLINE) on chain', async () => {
    // Regression: the deadline was taken before the ~11 setup blocks, so both opens were gate-denied PAST_DEADLINE and the
    // session wound down with no job and no on-chain Denied (the scenario's whole point).
    const { url, proc, client } = await startAnvil(['--block-time', '1'])
    const root = mkdtempSync(join(tmpdir(), 'session-1s-'))
    try {
      const sc = scenario('deadline')
      const keysDir = join(root, 'keys')
      const dep = await Session.deployFor(sc, { chain: 'anvil', rpcUrls: [url], keysDir, outDir: join(root, 'dep') })
      const setupEnd = await client.getTransactionReceipt({ hash: dep.setupTxs.at(-1)! })
      assert.ok(dep.deadline - Number((await client.getBlock({ blockNumber: setupEnd.blockNumber })).timestamp) >= 10, 'the deadline window is still ahead after deploy')
      const session = new Session({
        chain: 'anvil', rpcUrls: [url], publicRpc: url, deployment: dep, agentPk: loadAgentKey(dep.vault, keysDir), founderPk: ANVIL_FOUNDER_PK,
        runsDir: join(root, 'runs'), scenario: sc, llm: { mode: 'stub', stub: sc.stub, cap: 100_000 }, speed: 1, deadlineMarginS: 0n,
        priceFetch: failFetch, hardCapMs: 60_000,
      })
      await session.run()
      const logs = await getLogsChunked(client, dep.vault, BigInt(dep.deployBlock), await client.getBlockNumber())
      assert.ok(logs.some((l) => l.name === 'HoldOpened' && (l.args.vendor as string).toLowerCase() === dep.vendors.B.toLowerCase()), 'a vendor job opened')
      assert.ok(logs.some((l) => l.name === 'Denied' && l.args.enforced === true && fromBytes32(l.args.code as Hex) === 'PAST_DEADLINE'), 'enforced Denied(PAST_DEADLINE)')
      assert.equal(readChain(join(session.dir, 'records')).at(-1)!.rec.type, 'SESSION_END')
    } finally { proc.kill(); rmSync(root, { recursive: true, force: true }) }
  })
})
