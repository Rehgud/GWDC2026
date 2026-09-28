// akash.ts — real Akash GPU prices for the mock vendors A/B/C (T8).
//
// Fetched ONCE at session start from the Akash Console API (/v1/gpu-prices?debug=true, no auth,
// 5 s timeout). Validated: the H100 model exists, >= 3 providersWithBestBid, and every pinned
// vendor's price is finite and within $0.5..$20 per GPU-hour. On ANY failure the committed
// snapshot prices/akash-gpu-prices.snapshot.json is used and the reason is recorded
// (price_source = LIVE | SNAPSHOT:<reason>). A missing/null price is never treated as $0.
// Prices and capacities stay fixed for the session; vendors A/B/C are pinned by hostUri.
// The exact bytes of the price document used go into the bundle (prices/) and its keccak into
// SESSION_START, so NO_CAPACITY / PAST_DEADLINE inputs can be re-checked by the auditor.
import { readFile } from 'node:fs/promises';
import { keccak256, type Hex } from 'viem';
import { parsePriceDoc, PriceError, type PinnedVendor, type PriceEntry } from './pricedoc.ts';

export { parsePriceDoc, priceMicro, PriceError, type PinnedVendor, type PriceEntry } from './pricedoc.ts';

export const AKASH_URL = 'https://console-api.akash.network/v1/gpu-prices?debug=true';
export const SNAPSHOT_FILE = 'prices/akash-gpu-prices.snapshot.json';

export type PriceTable = {
  source: 'LIVE' | `SNAPSHOT:${string}`;
  fetched_at: string;
  /** exact bytes of the price document used (goes to the bundle as prices/<hash>.json) */
  bytes: Uint8Array;
  hash: Hex;
  entries: PriceEntry[];
};

export type LoadOpts = {
  pinned: readonly PinnedVendor[];
  mode: 'live' | 'snapshot';
  gpu?: string;
  url?: string;
  timeoutMs?: number;
  snapshotFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** Session-start price load: LIVE if valid, else the committed snapshot with the reason. */
export async function loadPrices(o: LoadOpts): Promise<PriceTable> {
  const now = () => (o.now ? o.now() : new Date());
  const gpu = o.gpu ?? 'H100';
  let reason = 'forced';
  if (o.mode === 'live') {
    try {
      const f = o.fetchImpl ?? fetch;
      const res = await f(o.url ?? AKASH_URL, { signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
      if (!res.ok) throw new PriceError(`http ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let doc: unknown;
      try {
        doc = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new PriceError('malformed JSON');
      }
      const entries = parsePriceDoc(doc, o.pinned, gpu);
      return { source: 'LIVE', fetched_at: now().toISOString(), bytes, hash: keccak256(bytes), entries };
    } catch (e) {
      const n = (e as Error).name;
      reason = n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : e instanceof PriceError ? e.message : 'network';
    }
  }
  const bytes = new Uint8Array(await readFile(o.snapshotFile ?? SNAPSHOT_FILE));
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  const entries = parsePriceDoc(doc, o.pinned, gpu); // a broken committed snapshot is fatal
  return { source: `SNAPSHOT:${reason.replace(/\s+/g, '_').slice(0, 80)}`, fetched_at: String(doc.fetched_at ?? ''), bytes, hash: keccak256(bytes), entries };
}

/** Market lookup for the gate: exactly (vendor address, gpu), or null. */
export function marketFor(t: PriceTable, vendor: string | null, gpu: string): PriceEntry | null {
  if (!vendor) return null;
  const g = gpu.trim().toUpperCase();
  return t.entries.find((e) => e.address.toLowerCase() === vendor.toLowerCase() && e.gpu === g) ?? null;
}
