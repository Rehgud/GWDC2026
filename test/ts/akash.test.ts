// B8: Akash live / timeout / malformed / provider missing / price null -> SNAPSHOT, never $0.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256 } from 'viem';
import { loadPrices, marketFor, parsePriceDoc, priceMicro, PriceError, SNAPSHOT_FILE, type PinnedVendor } from '../../backend/akash.ts';

const cfg = JSON.parse(readFileSync('config/demo.json', 'utf8'));
const PINNED: PinnedVendor[] = (['A', 'B', 'C'] as const).map((l) => ({ label: l, address: cfg.vendors[l], hostUri: cfg.akash_hosts[l] }));
const SNAP = readFileSync(SNAPSHOT_FILE, 'utf8');

const fakeFetch = (body: string | (() => never), status = 200, delayMs = 0): typeof fetch =>
  (async (_u: unknown, init?: RequestInit) => {
    if (delayMs) {
      await new Promise((r, rej) => {
        const t = setTimeout(r, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        });
      });
    }
    if (typeof body === 'function') body();
    return new Response(body as string, { status });
  }) as typeof fetch;

describe('B8 Akash prices', () => {
  test('committed snapshot maps A/B/C to the real H100 best bids ($2.04 / $2.56 / $3.16)', () => {
    const e = parsePriceDoc(JSON.parse(SNAP), PINNED);
    assert.deepEqual(e.map((x) => [x.label, x.price, x.gpu]), [
      ['A', 2_040_000n, 'H100'],
      ['B', 2_560_000n, 'H100'],
      ['C', 3_160_000n, 'H100'],
    ]);
    for (const x of e) assert.ok(x.capacity >= 0 && x.host_uri.startsWith('https://'));
  });

  test('LIVE: valid feed is used as-is, hash is keccak of the exact bytes', async () => {
    const t = await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch(SNAP) });
    assert.equal(t.source, 'LIVE');
    assert.equal(t.hash, keccak256(new TextEncoder().encode(SNAP)));
    assert.equal(marketFor(t, PINNED[1]!.address, 'h100')?.price, 2_560_000n);
    assert.equal(marketFor(t, '0xBAd0000000000000000000000000000000000Bad', 'H100'), null);
    assert.equal(marketFor(t, PINNED[1]!.address, 'H200'), null);
  });

  test('timeout -> SNAPSHOT:timeout', async () => {
    const t = await loadPrices({ pinned: PINNED, mode: 'live', timeoutMs: 50, fetchImpl: fakeFetch(SNAP, 200, 5_000) });
    assert.equal(t.source, 'SNAPSHOT:timeout');
    assert.equal(t.entries.length, 3);
  });

  test('HTTP 500 -> SNAPSHOT', async () => {
    const t = await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch('oops', 500) });
    assert.equal(t.source, 'SNAPSHOT:http_500');
  });

  test('malformed JSON -> SNAPSHOT:malformed_JSON', async () => {
    const t = await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch('{not json') });
    assert.equal(t.source, 'SNAPSHOT:malformed_JSON');
  });

  test('pinned provider missing from the live feed -> SNAPSHOT', async () => {
    const doc = JSON.parse(SNAP);
    doc.models[0].providersWithBestBid = doc.models[0].providersWithBestBid.filter((b: { provider: { hostUri: string } }) => b.provider.hostUri !== cfg.akash_hosts.B);
    doc.models[0].providersWithBestBid.push(doc.models[0].providersWithBestBid[0]); // keep >= 3 entries
    const t = await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch(JSON.stringify(doc)) });
    assert.match(t.source, /^SNAPSHOT:vendor_B:_provider/);
  });

  test('price null -> SNAPSHOT (never $0)', async () => {
    const doc = JSON.parse(SNAP);
    for (const b of doc.models[0].providersWithBestBid) b.bestBid.hourlyPrice = null;
    const t = await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch(JSON.stringify(doc)) });
    assert.match(t.source, /^SNAPSHOT:price_not_a_finite_number/);
    assert.ok(t.entries.every((e) => e.price > 0n));
  });

  test('no H100 / fewer than 3 providers -> SNAPSHOT', async () => {
    const d1 = JSON.parse(SNAP);
    d1.models[0].model = 'a100';
    assert.match((await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch(JSON.stringify(d1)) })).source, /no_H100_model/);
    const d2 = JSON.parse(SNAP);
    d2.models[0].providersWithBestBid = d2.models[0].providersWithBestBid.slice(0, 2);
    assert.match((await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: fakeFetch(JSON.stringify(d2)) })).source, /fewer_than_3/);
  });

  test('network error -> SNAPSHOT:network; PRICE_SOURCE=snapshot -> SNAPSHOT:forced', async () => {
    const boom = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal((await loadPrices({ pinned: PINNED, mode: 'live', fetchImpl: boom })).source, 'SNAPSHOT:network');
    assert.equal((await loadPrices({ pinned: PINNED, mode: 'snapshot' })).source, 'SNAPSHOT:forced');
  });

  test('priceMicro rejects null, NaN, 0, absurd values', () => {
    for (const v of [null, undefined, Number.NaN, 0, 0.4, 25, '2.56']) assert.throws(() => priceMicro(v), PriceError);
    assert.equal(priceMicro(2.04), 2_040_000n);
  });
});
