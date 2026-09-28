// Shared shapes between modules. Changing one of these is an [IFACE] change: update every importer.
import type { Hex } from 'viem'
import type { Code } from './codes.ts'

export type ChainName = 'anvil' | 'base-sepolia'

/** deployments/<chainId>-<vault>.json (committed; no secrets). The agent key lives in keys/<vault>.agent (gitignored). */
export type Deployment = {
  label: string
  chain: ChainName
  chainId: number
  vault: Hex
  usdc: Hex
  founder: Hex
  agent: Hex
  feeTo: Hex
  inferencePayee: Hex
  vendors: Record<VendorLabel, Hex> // deterministic payee addresses, labelled with Akash providers
  budget: string // micro-USDC, decimal string
  maxHold: string
  deadline: number // unix seconds
  deployBlock: number
  setupTxs: Hex[]
  gitSha: string
  retired?: string
}

export type VendorLabel = 'A' | 'B' | 'C'

/** One multicall at a pinned block. Every consumer (gate, executor, dashboard) shares the same snapshot. */
export type ChainSnapshot = {
  block: bigint
  blockTs: bigint
  readAt: number // local ms when read; > 10s old => STALE_CHAIN
  paused: boolean
  deadline: bigint
  budget: bigint
  committed: bigint
  maxHold: bigint
  feeBps: bigint
  inferencePayee: Hex
  vendorAllowed: Record<string, boolean> // lowercased address -> allowed
  jobs: { vendor: Hex; held: bigint; paid: bigint; closed: boolean }[]
}

/** Akash price book, fetched once per session and frozen. */
export type PriceBook = {
  source: 'LIVE' | `SNAPSHOT:${string}`
  fetchedAt: string // ISO time of the underlying data
  snapshotHash: Hex // keccak of the canonical JSON bytes stored in runs/<vault>/prices/akash.json
  gpu: string // 'h100'
  vendors: Record<VendorLabel, { provider: string; hostUri: string; pricePerHour: bigint; available: number }>
}

/** What a single tx attempt through commit() ended as. */
export type Outcome =
  | { status: 'OK'; txHash: Hex; recHash: Hex; block: bigint; jobId?: bigint; events: DecodedEvent[] }
  | { status: 'DENIED'; code: string; txHash: Hex; recHash: Hex; block: bigint; events: DecodedEvent[] }
  | { status: 'ALREADY_CLOSED'; recHash: Hex }
  | { status: 'CANCELLED'; reason: string } // epoch changed before send; no record, no tx
  | { status: 'HALT'; reason: string; txHash?: Hex; recHash?: Hex } // REVERTED, UNEXPECTED, UNCONFIRMED, record write failure

export type DecodedEvent = { name: string; args: Record<string, unknown>; logIndex: number }

/** One line of runs/<vault>/events.jsonl. */
export type EventLine = {
  ts: number
  run_id: string
  req_id: string | null
  job_id: string | null
  src: 'commit' | 'executor' | 'gate' | 'kiln' | 'akash' | 'watcher' | 'scenario' | 'server' | 'windDown'
  ev: string
  schema_version: 1
  [k: string]: unknown
}

/** Structured request produced by F1 and frozen (Object.freeze) before the gate. tx args come only from this. */
export type WorkRequest = {
  req_id: string
  action: 'open' | 'topUp'
  job_id: string | null
  vendorLabel: string // unknown labels are passed through and fail VENDOR_NOT_ALLOWED at the gate
  vendor: Hex // resolved address, or 0x0 for unknown label
  gpu: string
  amount: bigint // net micro-USDC
  rationale: string // <= 300 chars, untrusted
}

export type TopupResult = 'APPROVED_ONCHAIN' | 'DENIED_RECORDED' | 'APPROVED_BUT_DENIED_ONCHAIN' | 'QWEN_NOT_A_JUDGEMENT' | 'TX_ERROR'
export type DenyCode = Code
