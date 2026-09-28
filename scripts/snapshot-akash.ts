// Refresh prices/akash-snapshot.json from live data: node scripts/snapshot-akash.ts
// Keeps only the h100 models, in the same shape pickVendors reads, so the fallback runs the same validation.
import { writeFileSync } from 'node:fs'
import { AKASH_URL, SNAPSHOT_PATH, fetchJson, pickVendors } from '../src/akash.ts'

const json: any = await fetchJson(fetch, 60_000) // a Cloudflare cache miss can take ~16s
const fetchedAt = new Date().toISOString()
const vendors = pickVendors(json) // refuse to commit a snapshot the fallback would reject
writeFileSync(SNAPSHOT_PATH, JSON.stringify({ fetchedAt, url: AKASH_URL, models: json.models.filter((m: any) => m?.model === 'h100') }, null, 2) + '\n')
for (const [label, v] of Object.entries(vendors)) console.log(label, v.hostUri, `$${Number(v.pricePerHour) / 1e6}/h`, `available ${v.available}`)
console.log(`wrote ${SNAPSHOT_PATH.pathname} at ${fetchedAt}`)
