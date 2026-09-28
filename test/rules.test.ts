import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { check, gateInputFromJson, gross, lossPlateau, maxNet, requestSeconds, type GateInput } from '../src/rules.ts'
import { serialize } from '../src/record.ts'

const V = '0x000000000000000000000000000000000000000A' as const
const INF = '0x00000000000000000000000000000000000000fF' as const
const T0 = 1_000_000n
const USD = (x: number) => BigInt(Math.round(x * 1e6))

type Over = { kind?: GateInput['kind']; chain?: Partial<GateInput['chain']>; spec?: Partial<GateInput['spec']>;
  request?: Partial<GateInput['request']>; market?: Partial<GateInput['market']>; specGross?: bigint; losses?: number[] }

function input(o: Over = {}): GateInput {
  return {
    kind: o.kind ?? 'open',
    chain: { block: 100n, blockTs: T0, paused: false, deadline: T0 + 3600n, budget: USD(20), committed: 0n,
      maxHold: USD(6), inferencePayee: INF, vendorAllowed: true, ...o.chain },
    spec: { allowed_gpu_types: ['h100'], job_cap: USD(12), deadline: T0 + 3600n, ...o.spec },
    request: { vendor: V, gpu: 'h100', amount: USD(2.56), ...o.request },
    market: { pricePerHour: USD(2.56), available: 3, ...o.market },
    specGross: o.specGross ?? 0n,
    losses: o.losses ?? [],
  }
}

// [name, overrides, expected codes]
const ROWS: [string, Over, string[]][] = [
  ['clean open passes', {}, []],
  ['clean topUp passes', { kind: 'topUp', losses: [2.0, 1.8, 1.6, 1.4] }, []],
  ['paused', { chain: { paused: true } }, ['PAUSED']],
  ['block time == vault deadline', { chain: { blockTs: T0 + 3600n } }, ['PAST_DEADLINE']],
  // R3-13 example: $5.12 at $2.56/h = 2 sim h = 120 real s
  ['request ends exactly at deadline', { request: { amount: USD(5.12) }, chain: { deadline: T0 + 120n }, spec: { deadline: T0 + 120n } }, []],
  ['request ends 1s after deadline', { request: { amount: USD(5.12) }, chain: { deadline: T0 + 119n }, spec: { deadline: T0 + 119n } }, ['PAST_DEADLINE']],
  ['spec deadline earlier than vault deadline wins', { request: { amount: USD(5.12) }, spec: { deadline: T0 + 100n } }, ['PAST_DEADLINE']],
  ['vault deadline earlier than spec deadline wins', { request: { amount: USD(5.12) }, chain: { deadline: T0 + 100n } }, ['PAST_DEADLINE']],
  ['vendor not allowlisted', { chain: { vendorAllowed: false } }, ['VENDOR_NOT_ALLOWED']],
  ['gpu not in signed spec', { request: { gpu: 'h200' } }, ['GPU_TYPE_NOT_ALLOWED']],
  ['no Akash capacity', { market: { available: 0 } }, ['NO_CAPACITY']],
  ['amount == maxHold passes', { request: { amount: USD(6) } }, []],
  ['amount == maxHold + 1', { request: { amount: USD(6) + 1n } }, ['OVER_MAX_HOLD']],
  ['committed + gross == budget passes', { chain: { committed: USD(20) - gross(USD(2.56), false) } }, []],
  ['committed + gross == budget + 1', { chain: { committed: USD(20) - gross(USD(2.56), false) + 1n } }, ['OVER_BUDGET_WITH_FEE']],
  ['fee is what tips it over budget', { chain: { budget: USD(2.56) } }, ['OVER_BUDGET_WITH_FEE']],
  ['spec gross + gross == job cap passes', { specGross: USD(12) - gross(USD(2.56), false) }, []],
  ['spec gross accumulates across jobs (R3-11)', { specGross: USD(10) }, ['OVER_JOB_CAP']],
  ['NaN on topUp', { kind: 'topUp', losses: [2.0, NaN] }, ['NAN_DETECTED']],
  ['NaN ignored on open', { losses: [NaN] }, []],
  ['plateau on topUp', { kind: 'topUp', losses: [1.0, 0.999, 0.998, 0.997] }, ['LOSS_PLATEAU']],
  ['plateau ignored on open', { losses: [1.0, 0.999, 0.998, 0.997] }, []],
  ['one real improvement breaks plateau', { kind: 'topUp', losses: [1.0, 0.99, 0.989, 0.988] }, []],
  ['only 3 checkpoints is never plateau', { kind: 'topUp', losses: [1.0, 0.999, 0.998] }, []],
  ['inference skips gpu/capacity/job cap/deadline length', {
    kind: 'inference', request: { vendor: INF, gpu: '', amount: USD(0.05) }, market: { available: 0, pricePerHour: 0n }, specGross: USD(99),
  }, []],
  ['inference is fee-exempt: exact fit', { kind: 'inference', request: { vendor: INF, amount: USD(0.05) }, chain: { budget: USD(0.05) } }, []],
  ['inference still obeys chain rules', { kind: 'inference', request: { vendor: INF }, chain: { paused: true, vendorAllowed: false } }, ['PAUSED', 'VENDOR_NOT_ALLOWED']],
  ['inference payee match is case-insensitive', { kind: 'inference', request: { vendor: INF.toLowerCase() as `0x${string}`, amount: USD(1) }, chain: { budget: USD(1) } }, []],
  ['uint256 max amount does not throw', { request: { amount: 2n ** 256n - 1n } }, ['PAST_DEADLINE', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE', 'OVER_JOB_CAP']],
  ['multi-violation keeps chain order first', {
    chain: { paused: true, vendorAllowed: false, committed: USD(19) }, request: { gpu: 'a100' },
  }, ['PAUSED', 'VENDOR_NOT_ALLOWED', 'GPU_TYPE_NOT_ALLOWED', 'OVER_BUDGET_WITH_FEE']],
  ['everything wrong at once', {
    kind: 'topUp', chain: { paused: true, blockTs: T0 + 3600n, vendorAllowed: false, committed: USD(20) },
    request: { gpu: 'a100', amount: USD(7) }, market: { available: 0 }, specGross: USD(12), losses: [1, NaN],
  }, ['PAUSED', 'PAST_DEADLINE', 'VENDOR_NOT_ALLOWED', 'GPU_TYPE_NOT_ALLOWED', 'NO_CAPACITY', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE', 'OVER_JOB_CAP', 'NAN_DETECTED']],
]

for (const [name, o, want] of ROWS) {
  test(`check: ${name}`, () => assert.deepEqual(check(input(o)), want))
}

test('check survives the record JSON round-trip (auditor path)', () => {
  for (const [, o] of ROWS) {
    const i = input(o)
    const back = gateInputFromJson(JSON.parse(serialize(i).toString()))
    assert.deepEqual(check(back), check(i))
    assert.deepEqual({ ...back, losses: back.losses.map(String) }, { ...i, losses: i.losses.map(String) })
  }
})

test('lossPlateau edges', () => {
  assert.equal(lossPlateau([1, 0.995, 0.990025, 0.98507475]), false) // exactly 0.5% each step is NOT a plateau
  assert.equal(lossPlateau([0, 0, 0, 0]), false) // prev <= 0
  assert.equal(lossPlateau([5, 4, 1.0, 0.9999, 0.9998, 0.9997]), true) // only the last 3 pairs count
})

test('requestSeconds rounds up and handles zero price', () => {
  assert.equal(requestSeconds(USD(2.56), USD(2.56)), 60n)
  assert.equal(requestSeconds(1n, USD(2.56)), 1n)
  assert.equal(requestSeconds(USD(1), 0n), 0n)
})

test('fee cases shared with forge (C12)', () => {
  const cases = JSON.parse(readFileSync('test/fixtures/fee-cases.json', 'utf8'))
  for (const c of cases) assert.equal(gross(BigInt(c.net), c.exempt), BigInt(c.gross), JSON.stringify(c))
})

test('maxNet is the largest net whose gross fits (10,000 holds)', () => {
  let x = 12345n
  const next = () => (x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n)
  for (let i = 0; i < 10_000; i++) {
    const h = next() % 10n ** BigInt(1 + (i % 13))
    for (const exempt of [false, true]) {
      const n = maxNet(h, exempt)
      assert.ok(gross(n, exempt) <= h, `gross(maxNet(${h})) > h`)
      assert.ok(gross(n + 1n, exempt) > h, `maxNet(${h}) not maximal`)
    }
  }
  assert.equal(maxNet(0n, false), 0n)
  assert.equal(maxNet(1_030_000n, false), 1_000_000n)
})
