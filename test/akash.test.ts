import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { AKASH_URL, PINNED, loadPrices, pickVendors } from '../src/akash.ts'

const FIXTURE = readFileSync(new URL('./fixtures/akash/gpu-prices-debug.json', import.meta.url), 'utf8')
const SNAP = JSON.parse(readFileSync(new URL('../prices/akash-snapshot.json', import.meta.url), 'utf8'))

const respond = (body: string, status = 200): typeof fetch => async (url) => {
  assert.equal(url, AKASH_URL)
  return new Response(body, { status })
}
// Mutate a copy of the recorded response.
const edited = (f: (h100: any) => void) => {
  const j = JSON.parse(FIXTURE)
  f(j.models.find((m: any) => m.model === 'h100'))
  return respond(JSON.stringify(j))
}
const bidOf = (h: any, label: 'A' | 'B' | 'C') => h.providersWithBestBid.find((b: any) => b.provider.hostUri === PINNED[label])

test('live: pinned H100 providers, bigint micro-USDC, hash over bytes', async () => {
  const { book, bytes } = await loadPrices({ fetch: respond(FIXTURE) })
  assert.equal(book.source, 'LIVE')
  assert.equal(book.gpu, 'h100')
  assert.deepEqual(
    Object.fromEntries(Object.entries(book.vendors).map(([l, v]) => [l, [v.hostUri, v.pricePerHour, v.available]])),
    { A: [PINNED.A, 2_040_000n, 1], B: [PINNED.B, 2_560_000n, 4], C: [PINNED.C, 3_160_000n, 10] },
  )
  assert.match(book.vendors.A.provider, /^akash1/)
  assert.equal(book.snapshotHash, keccak256(bytes))
  const stored = JSON.parse(bytes.toString())
  assert.equal(stored.source, 'LIVE')
  assert.equal(stored.vendors.B.pricePerHour, '2560000')
  assert.ok(Object.isFrozen(book) && Object.isFrozen(book.vendors.A))
})

async function fallsBack(f: typeof fetch, reason: string, timeoutMs?: number) {
  const { book, bytes } = await loadPrices({ fetch: f, timeoutMs })
  assert.equal(book.source, `SNAPSHOT:${reason}`)
  assert.equal(book.fetchedAt, SNAP.fetchedAt)
  assert.deepEqual(book.vendors, pickVendors(SNAP))
  assert.equal(book.snapshotHash, keccak256(bytes))
  assert.deepEqual(bytes, (await loadPrices({ fetch: f, timeoutMs })).bytes) // deterministic
  for (const v of Object.values(book.vendors)) {
    assert.equal(typeof v.pricePerHour, 'bigint')
    assert.ok(v.pricePerHour >= 500_000n && v.pricePerHour <= 20_000_000n)
  }
}

test('timeout -> SNAPSHOT:timeout', async () => {
  const hang: typeof fetch = (_u, init) => new Promise((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))
  await fallsBack(hang, 'timeout', 20)
})
test('body stalls after headers (real fetch, local server) -> SNAPSHOT:timeout', async (t) => {
  const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"models":[') }).listen(0)
  t.after(() => { srv.closeAllConnections(); srv.close() })
  const port = (srv.address() as { port: number }).port
  await fallsBack((_u, init) => fetch(`http://127.0.0.1:${port}/`, init), 'timeout', 100)
})
test('network error -> SNAPSHOT:network', () => fallsBack(async () => { throw new TypeError('fetch failed') }, 'network'))
test('HTTP 503 -> SNAPSHOT:http_503', () => fallsBack(respond('oops', 503), 'http_503'))
test('malformed JSON -> SNAPSHOT:malformed', () => fallsBack(respond(FIXTURE.slice(0, 500)), 'malformed'))
test('no h100 -> SNAPSHOT:no_h100', () => fallsBack(respond('{"models":[]}'), 'no_h100'))
test('fewer than 3 best bids -> SNAPSHOT:few_providers', () =>
  fallsBack(edited((h) => { h.providersWithBestBid = h.providersWithBestBid.slice(0, 2) }), 'few_providers'))
test('pinned provider missing -> SNAPSHOT:missing:C', () =>
  fallsBack(edited((h) => { h.providersWithBestBid = h.providersWithBestBid.filter((b: any) => b !== bidOf(h, 'C')) }), 'missing:C'))

for (const [name, price] of [['null', null], ['zero', 0], ['below 0.5', 0.49], ['above 20', 20.5], ['string', '2.56']] as const) {
  test(`price ${name} -> SNAPSHOT:price:B`, () => fallsBack(edited((h) => { bidOf(h, 'B').bestBid.hourlyPrice = price }), 'price:B'))
}
test('pinned hostUri listed twice (ambiguous) -> SNAPSHOT:dup:A', () =>
  fallsBack(edited((h) => { h.providersWithBestBid.push({ ...bidOf(h, 'A'), bestBid: { ...bidOf(h, 'A').bestBid, hourlyPrice: 9 } }) }), 'dup:A'))
test('negative allocation count -> SNAPSHOT:schema:C', () =>
  fallsBack(edited((h) => { bidOf(h, 'C').provider.allocated = -1 }), 'schema:C'))
test('missing allocation counts -> SNAPSHOT:schema:A', () =>
  fallsBack(edited((h) => { delete bidOf(h, 'A').provider.allocatable }), 'schema:A'))

test('live and snapshot both bad -> throws instead of pricing at $0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'akash-'))
  const zero = JSON.parse(JSON.stringify(SNAP))
  bidOf(zero.models[0], 'A').bestBid.hourlyPrice = 0
  const { fetchedAt: _, ...undated } = SNAP
  for (const [name, content, err] of [
    ['zero', JSON.stringify(zero), /snapshot is unusable: price:A/],
    ['undated', JSON.stringify(undated), /snapshot is unusable: fetchedAt/],
    ['truncated', JSON.stringify(SNAP).slice(0, 100), /snapshot is unusable/],
    ['absent', null, /snapshot is unusable/],
  ] as const) {
    const path = join(dir, `${name}.json`)
    if (content !== null) writeFileSync(path, content)
    await assert.rejects(loadPrices({ fetch: respond('', 500), snapshotPath: path }), err, name)
  }
})

test('edges stay LIVE: exactly 3 bids, prices 0.5 / 20 inclusive, float-safe micro rounding, over-allocated -> 0 free', async () => {
  const { book } = await loadPrices({
    fetch: edited((h) => {
      h.providersWithBestBid = (['A', 'B', 'C'] as const).map((l) => bidOf(h, l))
      bidOf(h, 'A').bestBid.hourlyPrice = 0.5
      bidOf(h, 'B').bestBid.hourlyPrice = 1.005 // 1.005 * 1e6 = 1004999.9999999999 in float
      bidOf(h, 'C').bestBid.hourlyPrice = 20
      bidOf(h, 'C').provider.allocated = bidOf(h, 'C').provider.allocatable + 3
    }),
  })
  assert.equal(book.source, 'LIVE')
  assert.deepEqual([book.vendors.A.pricePerHour, book.vendors.B.pricePerHour, book.vendors.C.pricePerHour], [500_000n, 1_005_000n, 20_000_000n])
  assert.equal(book.vendors.C.available, 0)
})

test('PINNED cannot be repointed at runtime', () => {
  assert.throws(() => { (PINNED as Record<string, string>).A = 'https://evil:8443' }, TypeError)
})
