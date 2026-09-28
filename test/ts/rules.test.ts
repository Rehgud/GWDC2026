// B1 rules.check table, B2 gross/maxNet property test, R3-11 / R3-13 examples.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  check,
  chainRules,
  decide,
  feeOf,
  formatUsd,
  gross,
  GateInputError,
  isLossPlateau,
  hasNaN,
  maxNet,
  parseUsd,
  realSeconds,
  specGross,
  type GateInput,
  type ChainRuleInput,
} from '../../backend/rules.ts';
import { GATE_ORDER, NO_JOB } from '../../backend/codes.ts';
import { buildFeeCasesFixture } from '../../backend/fixtures.ts';

const T = 1_800_000_000n;
const A = '0x000000000000000000000000000000000000000a' as const;
const B = '0x000000000000000000000000000000000000000b' as const;
const C = '0x000000000000000000000000000000000000000c' as const;
const INF = '0x00000000000000000000000000000000000000f1' as const;
const BAD = '0xbad0000000000000000000000000000000000bad' as const;

type Mut = (x: GateInput) => void;

function base(): GateInput {
  return {
    v: 1,
    request: { kind: 'open', vendor: B, vendorLabel: 'B', gpu: 'H100', amount: '2560000', jobId: null },
    chain: {
      blockNumber: '100',
      blockTimestamp: T.toString(),
      paused: false,
      deadline: (T + 7200n).toString(),
      budget: '100000000',
      committed: '0',
      maxHold: '6000000',
      feeBps: '300',
      inferencePayee: INF,
      vendorAllowed: true,
      job: null,
    },
    spec: { spec_id: 'spec-1', allowed_gpu_types: ['H100'], job_cap: '12000000', deadline: (T + 3600n).toString() },
    ledger: { spec_gross: '0' },
    market: { vendor: B, gpu: 'H100', price: '2560000', capacity: 4 },
    progress: { losses: [2.0, 1.8, 1.6] },
    clockMult: 60,
  };
}

function withMut(...muts: Mut[]): GateInput {
  const x = base();
  for (const m of muts) m(x);
  return x;
}

const topUpOf = (vendor: `0x${string}`): Mut => (x) => {
  x.request.kind = 'topUp';
  x.request.jobId = '7';
  x.chain.job = { id: '7', vendor, held: '2636800', paid: '1318400', closed: false };
};

// [name, mutation, expected codes]
const ROWS: [string, Mut[], string[]][] = [
  ['base open passes', [], []],
  ['PAUSED', [(x) => (x.chain.paused = true)], ['PAUSED']],
  ['PAST_DEADLINE: now == vault deadline', [(x) => (x.chain.deadline = T.toString())], ['PAST_DEADLINE']],
  ['PAST_DEADLINE: now == spec deadline', [(x) => (x.spec.deadline = T.toString())], ['PAST_DEADLINE']],
  // R3-13 worked example: B $2.56/h, $5.12 -> 2 sim h -> 120 real s at CLOCK_MULT=60
  ['R3-13: ends exactly at deadline passes', [(x) => (x.request.amount = '5120000'), (x) => (x.spec.deadline = (T + 120n).toString())], []],
  ['R3-13: one second short -> PAST_DEADLINE', [(x) => (x.request.amount = '5120000'), (x) => (x.spec.deadline = (T + 119n).toString())], ['PAST_DEADLINE']],
  ['R3-13: min(spec, vault) uses the vault when earlier', [(x) => (x.request.amount = '5120000'), (x) => (x.spec.deadline = (T + 9999n).toString()), (x) => (x.chain.deadline = (T + 119n).toString())], ['PAST_DEADLINE']],
  ['CLOCK_MULT=600 shrinks real time 10x (12 s)', [(x) => (x.request.amount = '5120000'), (x) => (x.clockMult = 600), (x) => (x.spec.deadline = (T + 12n).toString())], []],
  ['CLOCK_MULT=600, 11 s left -> PAST_DEADLINE', [(x) => (x.request.amount = '5120000'), (x) => (x.clockMult = 600), (x) => (x.spec.deadline = (T + 11n).toString())], ['PAST_DEADLINE']],
  ['VENDOR_NOT_ALLOWED: disallowed on chain', [(x) => (x.chain.vendorAllowed = false)], ['VENDOR_NOT_ALLOWED']],
  ['VENDOR_NOT_ALLOWED: unknown label (vendor=null) also has no market entry', [(x) => (x.request.vendor = null), (x) => (x.request.vendorLabel = 'Z'), (x) => (x.chain.vendorAllowed = false), (x) => (x.market = null)], ['VENDOR_NOT_ALLOWED', 'NO_CAPACITY']],
  // D5 injection: F1 fooled into vendor 0xBAD..., H200
  ['D5 injection: 0xBAD vendor + H200', [(x) => (x.request.vendor = BAD), (x) => (x.request.vendorLabel = BAD), (x) => (x.request.gpu = 'H200'), (x) => (x.chain.vendorAllowed = false), (x) => (x.market = null)], ['VENDOR_NOT_ALLOWED', 'GPU_TYPE_NOT_ALLOWED', 'NO_CAPACITY']],
  ['topUp on own vendor passes', [topUpOf(B)], []],
  ['topUp naming a different allowed vendor -> VENDOR_NOT_ALLOWED', [topUpOf(A)], ['VENDOR_NOT_ALLOWED']],
  ['OVER_MAX_HOLD boundary: net == maxHold passes', [(x) => (x.request.amount = '6000000')], []],
  ['OVER_MAX_HOLD boundary: maxHold + 1', [(x) => (x.request.amount = '6000001')], ['OVER_MAX_HOLD']],
  ['OVER_MAX_HOLD compares NET: gross 6.18 > 6 still passes', [(x) => (x.request.amount = '6000000'), (x) => (x.chain.maxHold = '6000000')], []],
  // gross(2_560_000) = 2_636_800
  ['OVER_BUDGET boundary: committed + gross == budget passes', [(x) => (x.chain.committed = '97363200')], []],
  ['OVER_BUDGET boundary: +1 over', [(x) => (x.chain.committed = '97363201')], ['OVER_BUDGET_WITH_FEE']],
  ['OVER_BUDGET counts the fee (net fits, gross does not)', [(x) => (x.chain.budget = '2560000')], ['OVER_BUDGET_WITH_FEE']],
  ['GPU_TYPE_NOT_ALLOWED: H200 (no market entry either)', [(x) => (x.request.gpu = 'H200'), (x) => (x.market = null)], ['GPU_TYPE_NOT_ALLOWED', 'NO_CAPACITY']],
  ['GPU match is case/space-insensitive', [(x) => (x.request.gpu = ' h100 ')], []],
  ['OVER_JOB_CAP boundary: spec_gross + gross == cap passes', [(x) => (x.ledger.spec_gross = '9363200')], []],
  ['OVER_JOB_CAP boundary: +1', [(x) => (x.ledger.spec_gross = '9363201')], ['OVER_JOB_CAP']],
  ['NO_CAPACITY: capacity 0', [(x) => (x.market!.capacity = 0)], ['NO_CAPACITY']],
  ['NO_CAPACITY: market entry for another vendor', [(x) => (x.market!.vendor = A)], ['NO_CAPACITY']],
  ['NO_CAPACITY: price 0 is never treated as $0', [(x) => (x.market!.price = '0')], ['NO_CAPACITY']],
  ['NAN_DETECTED: "NaN" in losses', [(x) => (x.progress.losses = [2.0, 'NaN'])], ['NAN_DETECTED']],
  ['NAN_DETECTED: Infinity counts as diverged', [(x) => (x.progress.losses = [2.0, 'Infinity'])], ['NAN_DETECTED']],
  ['LOSS_PLATEAU: 3 pairs < 0.5%', [(x) => (x.progress.losses = [1.0, 0.996, 0.992, 0.988])], ['LOSS_PLATEAU']],
  ['LOSS_PLATEAU: rising loss counts as no improvement', [(x) => (x.progress.losses = [1.0, 1.01, 1.02, 1.03])], ['LOSS_PLATEAU']],
  ['no plateau with only 3 checkpoints', [(x) => (x.progress.losses = [1.0, 1.0, 1.0])], []],
  ['no plateau when one pair improves >= 0.5%', [(x) => (x.progress.losses = [1.0, 0.99, 0.989, 0.988])], []],
  ['C13 multi-violation: paused + budget + vendor -> PAUSED first', [(x) => (x.chain.paused = true), (x) => (x.chain.vendorAllowed = false), (x) => (x.chain.budget = '1')], ['PAUSED', 'VENDOR_NOT_ALLOWED', 'OVER_BUDGET_WITH_FEE']],
  [
    'all ten rules at once come back in GATE_ORDER',
    [
      (x) => (x.chain.paused = true),
      (x) => (x.chain.deadline = T.toString()),
      (x) => (x.chain.vendorAllowed = false),
      (x) => (x.request.amount = '7000000'),
      (x) => (x.chain.budget = '1'),
      (x) => (x.request.gpu = 'A100'),
      (x) => (x.ledger.spec_gross = '12000000'),
      (x) => (x.market = null),
      // NaN early in the task, then a flat window of 4: both signals fire
      (x) => (x.progress.losses = ['NaN', 1, 1, 1, 1]),
    ],
    [...GATE_ORDER],
  ],
  ['uint256.max amount: codes, no throw', [(x) => (x.request.amount = ((1n << 256n) - 1n).toString())], ['PAST_DEADLINE', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE', 'OVER_JOB_CAP']],
];

describe('B1 rules.check table', () => {
  for (const [name, muts, want] of ROWS) {
    test(name, () => {
      const got = check(withMut(...muts));
      assert.deepEqual(got, want);
      assert.equal(decide(got), want[0] ?? null);
    });
  }

  test('plateau + NaN together: NAN_DETECTED (plateau is false with a non-finite value)', () => {
    assert.deepEqual(check(withMut((x) => (x.progress.losses = [1, 1, 1, 1, 'NaN']))), ['NAN_DETECTED']);
  });

  test('check() does not mutate a deep-frozen input (R is frozen)', () => {
    const x = base();
    const freeze = (o: unknown): void => {
      if (o && typeof o === 'object') {
        Object.freeze(o);
        for (const v of Object.values(o)) freeze(v);
      }
    };
    freeze(x);
    const before = JSON.stringify(x);
    assert.deepEqual(check(x), []);
    assert.equal(JSON.stringify(x), before);
  });

  test('deterministic: same input -> same output across 100 calls', () => {
    const x = withMut((y) => (y.chain.paused = true), (y) => (y.request.gpu = 'H200'));
    const first = JSON.stringify(check(x));
    for (let i = 0; i < 100; i++) assert.equal(JSON.stringify(check(x)), first);
  });

  const BAD_INPUTS: [string, Mut][] = [
    ['amount with decimals', (x) => (x.request.amount = '1.5')],
    ['negative amount', (x) => (x.request.amount = '-1')],
    ['leading zero', (x) => (x.request.amount = '01')],
    ['jobId on open', (x) => (x.request.jobId = '1')],
    ['topUp without job', (x) => ((x.request.kind = 'topUp'), (x.request.jobId = '1'))],
    ['topUp job id mismatch', (x) => (topUpOf(B)(x), (x.chain.job!.id = '8'))],
    ['bad vendor address', (x) => (x.request.vendor = '0x123' as `0x${string}`)],
    ['clockMult 0', (x) => (x.clockMult = 0)],
    ['bad loss string', (x) => (x.progress.losses = ['nan' as 'NaN'])],
    ['version', (x) => ((x as { v: number }).v = 2)],
    ['excluded not an address list', (x) => (x.excluded = ['B'])],
  ];
  for (const [name, m] of BAD_INPUTS) {
    test(`malformed input throws GateInputError: ${name}`, () => {
      assert.throws(() => check(withMut(m)), GateInputError);
    });
  }
});

describe('D2 re-proposal: an open to a vendor denied earlier in the sequence', () => {
  test('open to an excluded vendor -> VENDOR_NOT_ALLOWED (address compared case-insensitively)', () => {
    assert.deepEqual(check(withMut((x) => (x.excluded = [B.toLowerCase()]))), ['VENDOR_NOT_ALLOWED']);
  });
  test('open to a different vendor passes; absent / empty excluded = none', () => {
    assert.deepEqual(check(withMut((x) => (x.excluded = [BAD]))), []);
    assert.deepEqual(check(withMut((x) => (x.excluded = []))), []);
    assert.deepEqual(check(base()), []);
  });
  test('a topUp is not affected by excluded (it pays its own job vendor)', () => {
    assert.deepEqual(check(withMut(topUpOf(B), (x) => (x.excluded = [B]))), []);
  });
});

describe('chainRules (INFERENCE open, D2)', () => {
  const inf = (): ChainRuleInput => {
    const g = base();
    return {
      v: 1,
      request: { kind: 'open', vendor: INF, vendorLabel: 'INFERENCE', gpu: '', amount: '50000', jobId: null },
      chain: g.chain,
    };
  };
  test('$0.05 inference hold passes with no spec/market/progress', () => {
    assert.deepEqual(chainRules(inf()), []);
  });
  test('INFERENCE is fee-exempt: committed + 50000 == budget passes', () => {
    const x = inf();
    x.chain.budget = '50000';
    assert.deepEqual(chainRules(x), []);
    x.chain.budget = '49999';
    assert.deepEqual(chainRules(x), ['OVER_BUDGET_WITH_FEE']);
  });
  test('contract deadline semantics: ts == deadline - 1 OK, ts == deadline Denied', () => {
    const x = inf();
    x.chain.deadline = (T + 1n).toString();
    assert.deepEqual(chainRules(x), []);
    x.chain.deadline = T.toString();
    assert.deepEqual(chainRules(x), ['PAST_DEADLINE']);
  });
  test('paused + disallowed -> PAUSED first', () => {
    const x = inf();
    x.chain.paused = true;
    x.chain.vendorAllowed = false;
    assert.deepEqual(chainRules(x), ['PAUSED', 'VENDOR_NOT_ALLOWED']);
  });
  test('chainRules order is the prefix of GATE_ORDER', () => {
    assert.deepEqual(GATE_ORDER.slice(0, 5), ['PAUSED', 'PAST_DEADLINE', 'VENDOR_NOT_ALLOWED', 'OVER_MAX_HOLD', 'OVER_BUDGET_WITH_FEE']);
  });
});

describe('B2 gross / maxNet', () => {
  // xorshift64* over bigint for 64-bit-ish holds, seeded
  let s = 0x9e3779b97f4a7c15n;
  const M64 = (1n << 64n) - 1n;
  const next = (): bigint => {
    s ^= s >> 12n;
    s ^= (s << 25n) & M64;
    s ^= s >> 27n;
    return (s * 0x2545f4914f6cdd1dn) & M64;
  };

  test('10,000 random holds: gross(maxNet(h)) <= h < gross(maxNet(h)+1)', () => {
    for (let i = 0; i < 10_000; i++) {
      const r = next();
      // spread over small (<1e4), demo-sized (<1e8) and huge values
      const h = [r % 10_000n, r % 100_000_000n, r][i % 3]!;
      const bps = i % 7 === 0 ? (r % 10_001n) : 300n;
      const n = maxNet(h, bps, false);
      assert.ok(gross(n, bps, false) <= h, `gross(maxNet(${h})) > h (bps ${bps})`);
      assert.ok(gross(n + 1n, bps, false) > h, `maxNet(${h}) not maximal (bps ${bps})`);
    }
  });

  test('INFERENCE (fee exempt): fee 0 and maxNet(h) == h', () => {
    for (const h of [0n, 1n, 50_000n, 2_636_800n, (1n << 200n) + 7n]) {
      assert.equal(maxNet(h, 300n, true), h);
      assert.equal(gross(h, 300n, true), h);
      assert.equal(feeOf(h, 300n, true), 0n);
    }
  });

  test('fee floor: 33 -> 0, 34 -> 1; demo hold 2.56 -> 2.6368', () => {
    assert.equal(feeOf(33n, 300n, false), 0n);
    assert.equal(feeOf(34n, 300n, false), 1n);
    assert.equal(gross(2_560_000n, 300n, false), 2_636_800n);
    assert.equal(maxNet(2_636_800n, 300n, false), 2_560_000n);
  });

  test('uint256-sized values: no overflow in TS', () => {
    const max = (1n << 256n) - 1n;
    assert.equal(gross(max, 300n, false), max + (max * 300n) / 10_000n);
    const n = maxNet(max, 300n, false);
    assert.ok(gross(n, 300n, false) <= max && gross(n + 1n, 300n, false) > max);
  });

  test('negative inputs are rejected', () => {
    assert.throws(() => gross(-1n, 300n, false), RangeError);
    assert.throws(() => maxNet(-1n, 300n, false), RangeError);
  });

  test('C12: committed fixtures/fee-cases.json equals the rules.ts source', () => {
    const file = JSON.parse(readFileSync('fixtures/fee-cases.json', 'utf8')) as ReturnType<typeof buildFeeCasesFixture>;
    assert.deepEqual(file, buildFeeCasesFixture());
    for (let i = 0; i < file.net.length; i++) {
      const n = BigInt(file.net[i]!);
      assert.equal(gross(n, 300n, file.exempt[i]!).toString(), file.gross[i]);
    }
  });
});

describe('R3-11 OVER_JOB_CAP accumulates per spec, not per job id', () => {
  test('migration does not reset the cap: closed A counts paid, open B counts held', () => {
    const a = { held: 5_273_600n, paid: 4_000_000n, closed: true }; // A closed after settling 4.00 gross
    const b = { held: 2_636_800n, paid: 0n, closed: false }; // B just opened
    const acc = specGross([a, b]);
    assert.equal(acc, 6_636_800n);
    // a new topUp on B of 2.56 net would bring the task to 9.2736 gross
    const x = withMut(topUpOf(B), (y) => (y.ledger.spec_gross = acc.toString()), (y) => (y.spec.job_cap = '9273599'));
    assert.deepEqual(check(x), ['OVER_JOB_CAP']);
    x.spec.job_cap = '9273600';
    assert.deepEqual(check(x), []);
  });
});

describe('time and money helpers', () => {
  test('R3-13 example: realSeconds($5.12, $2.56/h, 60) = 120', () => {
    assert.equal(realSeconds(5_120_000n, 2_560_000n, 60), 120n);
    assert.equal(realSeconds(5_120_000n, 2_560_000n, 600), 12n);
  });
  test('realSeconds rounds up (conservative)', () => {
    assert.equal(realSeconds(1n, 2_560_000n, 60), 1n);
    assert.equal(realSeconds(0n, 2_560_000n, 60), 0n);
    assert.throws(() => realSeconds(1n, 0n, 60), RangeError);
  });
  test('parseUsd strict', () => {
    assert.equal(parseUsd('5.12'), 5_120_000n);
    assert.equal(parseUsd('5'), 5_000_000n);
    assert.equal(parseUsd('0.000001'), 1n);
    assert.equal(parseUsd('12.00'), 12_000_000n);
    for (const bad of ['$3', '5.1234567', '-1', '1e3', '05', ' 5', '5.', '.5', '', '5,12']) {
      assert.throws(() => parseUsd(bad), RangeError, bad);
    }
  });
  test('formatUsd', () => {
    assert.equal(formatUsd(5_120_000n), '5.12');
    assert.equal(formatUsd(1n), '0.000001');
    assert.equal(formatUsd(2_636_800n), '2.6368');
    assert.equal(formatUsd(0n), '0.00');
  });
  test('hasNaN / isLossPlateau edge cases', () => {
    assert.equal(hasNaN([]), false);
    assert.equal(hasNaN([1, 2, '-Infinity']), true);
    assert.equal(isLossPlateau([0, 0, 0, 0]), false); // prev <= 0
    assert.equal(isLossPlateau([1.0, 0.995, 0.990025, 0.98507487]), false); // exactly-ish 0.5% is not < 0.5%
  });
  test('NO_JOB is uint256 max', () => {
    assert.equal(NO_JOB, 2n ** 256n - 1n);
  });
});
