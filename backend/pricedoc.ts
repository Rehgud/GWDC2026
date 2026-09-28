// pricedoc.ts — pure parsing/validation of an Akash GPU price document (no I/O).
// Shared by akash.ts (session start) and the auditor (re-checks the market inputs of every gate
// decision against the exact price bytes in the bundle).
import type { Hex } from 'viem';
import { MICRO } from './rules.ts';

export type PinnedVendor = { label: string; address: Hex; hostUri: string };

export type PriceEntry = {
  label: string;
  address: Hex;
  host_uri: string;
  provider: string;
  gpu: string;
  /** NET micro-USD per GPU-hour (the vendor's price; the vault adds the 3% fee on top) */
  price: bigint;
  /** allocatable - allocated at fetch time */
  capacity: number;
  best_bid_tx: string | null;
  best_bid_at: string | null;
};

export class PriceError extends Error {
  override name = 'PriceError';
}

type Provider = { owner?: string; hostUri?: string; allocated?: number; allocatable?: number };
type BestBid = { provider?: Provider; bestBid?: { hourlyPrice?: unknown; txHash?: string; datetime?: string } };
type Model = { vendor?: string; model?: string; providersWithBestBid?: BestBid[] };

/** USD float from the feed -> micro-USD bigint, rejecting null / NaN / out-of-range values. */
export function priceMicro(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PriceError(`price not a finite number: ${JSON.stringify(v)}`);
  if (v < 0.5 || v > 20) throw new PriceError(`price ${v} outside $0.5..$20`);
  return BigInt(Math.round(v * Number(MICRO)));
}

/** Validate a price document and map the pinned vendors. Throws PriceError. */
export function parsePriceDoc(doc: unknown, pinned: readonly PinnedVendor[], gpu = 'H100'): PriceEntry[] {
  const models = (doc as { models?: Model[] })?.models;
  if (!Array.isArray(models)) throw new PriceError('schema: no models[]');
  const m = models.find((x) => String(x?.model ?? '').toLowerCase() === gpu.toLowerCase() && String(x?.vendor ?? 'nvidia').toLowerCase() === 'nvidia');
  if (!m) throw new PriceError(`schema: no ${gpu} model`);
  const bids = m.providersWithBestBid;
  if (!Array.isArray(bids) || bids.length < 3) throw new PriceError(`schema: fewer than 3 providersWithBestBid for ${gpu}`);
  return pinned.map((p) => {
    const b = bids.find((x) => x?.provider?.hostUri === p.hostUri);
    if (!b) throw new PriceError(`vendor ${p.label}: provider ${p.hostUri} missing from the feed`);
    const alloc = Number(b.provider?.allocated ?? NaN);
    const allocatable = Number(b.provider?.allocatable ?? NaN);
    if (!Number.isFinite(alloc) || !Number.isFinite(allocatable)) throw new PriceError(`vendor ${p.label}: capacity missing`);
    return {
      label: p.label,
      address: p.address,
      host_uri: p.hostUri,
      provider: String(b.provider?.owner ?? ''),
      gpu: gpu.toUpperCase(),
      price: priceMicro(b.bestBid?.hourlyPrice),
      capacity: Math.max(0, allocatable - alloc),
      best_bid_tx: b.bestBid?.txHash ?? null,
      best_bid_at: b.bestBid?.datetime ?? null,
    };
  });
}
