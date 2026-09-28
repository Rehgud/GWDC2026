// fixtures.ts — builders for the cross-language fixtures (C12). Pure; used by
// scripts/gen-fixtures.ts to write them and by tests to prove the committed files match.
import { DENY_CODES, codeToBytes32 } from './codes.ts';
import { feeOf, gross } from './rules.ts';

/** { "PAUSED": "0x5041...00", ... } — forge reads each key with vm.parseJsonBytes32. */
export function buildDenyCodesFixture(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const c of DENY_CODES) o[c] = codeToBytes32(c);
  return o;
}

/** Deterministic PRNG (mulberry32) so the fixture is reproducible byte-for-byte. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FEE_BPS = 300n;

/**
 * Structure-of-arrays so forge can read each column with vm.parseJson*Array.
 * Values are decimal strings (exact beyond 2^53 on the TS side).
 */
export function buildFeeCasesFixture(): {
  feeBps: string;
  net: string[];
  exempt: boolean[];
  gross: string[];
  fee: string[];
} {
  const nets: bigint[] = [
    0n, 1n, 2n, 33n, 34n, 66n, 67n, 99n, 100n, 333n, 334n, 3333n, 3334n, 9999n, 10000n, 10001n,
    33333n, 33334n, 50_000n, 1_000_000n, 2_040_000n, 2_560_000n, 3_160_000n, 5_120_000n,
    5_825_242n, 5_825_243n, 6_000_000n, 1_000_000_000_000n, (1n << 64n) - 1n, (1n << 128n) - 1n,
  ];
  const rnd = mulberry32(0xcf0a9e17);
  for (let i = 0; i < 40; i++) {
    // mix of small, demo-sized and large amounts
    const scale = [100, 10_000_000, 1_000_000_000_000][i % 3]!;
    nets.push(BigInt(Math.floor(rnd() * scale)));
  }
  const out = { feeBps: FEE_BPS.toString(), net: [] as string[], exempt: [] as boolean[], gross: [] as string[], fee: [] as string[] };
  for (const n of nets) {
    for (const ex of [false, true]) {
      out.net.push(n.toString());
      out.exempt.push(ex);
      out.gross.push(gross(n, FEE_BPS, ex).toString());
      out.fee.push(feeOf(n, FEE_BPS, ex).toString());
    }
  }
  return out;
}
