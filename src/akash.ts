// Akash H100 price book: fetched once per session, frozen, with the committed snapshot as fallback.
//
// GET https://console-api.akash.network/v1/gpu-prices?debug=true (no auth; debug=true is undocumented) returns
//   { availability: {total, available},
//     models: [{ vendor, model: 'h100', ram: '80Gi', interface: 'SXM5', availability: {total, available},
//                providerAvailability: { total, available, providers: [{owner, hostUri, allocated, allocatable}] },
//                price: {currency: 'USD', min, max, avg, weightedAverage, med}, priceUakt, bidCount,
//                providersWithBestBid: [{ provider: {owner, hostUri, allocated, allocatable},
//                                         bestBid: {height, txHash, datetime, provider, hourlyPrice, ...} }] }] }
// hourlyPrice is USD per GPU-hour, derived from the last 31 days of on-chain bids.
// Per-provider free GPUs = allocatable - allocated (model-level availability.available is their sum).
// The plain endpoint (no debug) omits providersWithBestBid.
// Cloudflare caches the response 300s (+300s stale); a cold miss took ~16s, which exceeds the 5s budget.
import { readFileSync } from 'node:fs'
import type { PriceBook, VendorLabel } from './types.ts'
import { hashBytes, serialize } from './record.ts'

export const AKASH_URL = 'https://console-api.akash.network/v1/gpu-prices?debug=true'
export const SNAPSHOT_PATH = new URL('../prices/akash-snapshot.json', import.meta.url)

// Cheapest / middle / priciest H100 best bids on 2026-09-28 ($2.04 / $2.56 / $3.16).
export const PINNED: Readonly<Record<VendorLabel, string>> = Object.freeze({
  A: 'https://provider.h100.siamaidol.com:8443',
  B: 'https://provider.h100.ams.val.akash.pub:8443',
  C: 'https://provider.h100.wdc.hh.akash.pub:8443',
})

const MIN_USD = 0.5
const MAX_USD = 20

/** message is the fallback reason shown as SNAPSHOT:<reason>. */
export class PriceError extends Error {}

const isTimeout = (e: unknown) => (e as Error)?.name === 'TimeoutError'

export async function fetchJson(fetchFn: typeof fetch, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs) // also bounds the body read
  let res: Response
  try { res = await fetchFn(AKASH_URL, { signal }) } catch (e) { throw new PriceError(isTimeout(e) ? 'timeout' : 'network') }
  if (!res.ok) throw new PriceError(`http_${res.status}`)
  let text: string
  try { text = await res.text() } catch (e) { throw new PriceError(isTimeout(e) ? 'timeout' : 'network') }
  try { return JSON.parse(text) } catch { throw new PriceError('malformed') }
}

/** Pinned vendor rows from a gpu-prices response (or the snapshot, which keeps the same `models` shape). */
export function pickVendors(json: any): PriceBook['vendors'] {
  const models = Array.isArray(json?.models) ? json.models.filter((m: any) => m?.model === 'h100') : []
  if (!models.length) throw new PriceError('no_h100')
  const bids = models.flatMap((m: any) => (Array.isArray(m.providersWithBestBid) ? m.providersWithBestBid : []))
  if (bids.length < 3) throw new PriceError('few_providers')
  const out = {} as PriceBook['vendors']
  for (const [label, hostUri] of Object.entries(PINNED) as [VendorLabel, string][]) {
    // A hostUri listed twice (e.g. under two h100 variants) is ambiguous: refuse rather than pick one.
    const hits = bids.filter((x: any) => x?.provider?.hostUri === hostUri)
    if (hits.length !== 1) throw new PriceError(`${hits.length ? 'dup' : 'missing'}:${label}`)
    const b = hits[0]
    const usd = b.bestBid?.hourlyPrice
    if (typeof usd !== 'number' || !(usd >= MIN_USD && usd <= MAX_USD)) throw new PriceError(`price:${label}`)
    const { owner, allocated, allocatable } = b.provider
    if (typeof owner !== 'string' || !Number.isInteger(allocated) || !Number.isInteger(allocatable) || allocated < 0 || allocatable < 0) {
      throw new PriceError(`schema:${label}`)
    }
    // usd <= 20 so usd*1e6 is within float precision; round, not floor (1.005*1e6 = 1004999.999...).
    out[label] = { provider: owner, hostUri, pricePerHour: BigInt(Math.round(usd * 1e6)), available: Math.max(0, allocatable - allocated) }
  }
  return out
}

/**
 * Once per session. bytes is what goes to runs/<vault>/prices/akash.json; book.snapshotHash = keccak256(bytes).
 * Any live failure uses the committed snapshot. A bad snapshot throws: never a $0 or null price.
 */
export async function loadPrices(o: { fetch?: typeof fetch; timeoutMs?: number; snapshotPath?: string | URL } = {}): Promise<{ book: PriceBook; bytes: Buffer }> {
  let source: PriceBook['source'] = 'LIVE'
  let fetchedAt = new Date().toISOString()
  let vendors: PriceBook['vendors']
  try {
    vendors = pickVendors(await fetchJson(o.fetch ?? globalThis.fetch, o.timeoutMs ?? 5000))
  } catch (e) {
    source = `SNAPSHOT:${e instanceof PriceError ? e.message : 'schema'}`
    try {
      const snap = JSON.parse(readFileSync(o.snapshotPath ?? SNAPSHOT_PATH, 'utf8'))
      if (typeof snap.fetchedAt !== 'string') throw new PriceError('fetchedAt')
      vendors = pickVendors(snap)
      fetchedAt = snap.fetchedAt
    } catch (e2) {
      throw new Error(`akash: live failed (${source}) and snapshot is unusable: ${(e2 as Error).message}`)
    }
  }
  const body = { source, fetchedAt, gpu: 'h100', vendors }
  const bytes = serialize(body)
  for (const v of Object.values(vendors)) Object.freeze(v)
  Object.freeze(vendors)
  return { book: Object.freeze({ ...body, snapshotHash: hashBytes(bytes) }), bytes }
}
