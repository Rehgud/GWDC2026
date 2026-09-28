// cost.ts — exact decimal Kiln cost accounting (pure; shared by kiln.ts and the auditor).
// Costs are summed at 1e-24 USD and converted to micro-USDC with ONE ceil at the end (B6).

const COST_SCALE = 24;

/** Parse a decimal (incl. exponent, e.g. "1.4e-4") into integer units of 1e-24 USD. null if invalid. */
export function costUnits(c: string | number | null | undefined): bigint | null {
  if (c === null || c === undefined) return null;
  const s = typeof c === 'number' ? (Number.isFinite(c) ? c.toString() : '') : c.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const digits = BigInt(m[1]! + (m[2] ?? ''));
  const exp = Number(m[3] ?? '0') - (m[2]?.length ?? 0) + COST_SCALE;
  if (exp < 0) {
    const d = 10n ** BigInt(-exp);
    return (digits + d - 1n) / d; // round up: never under-count cost
  }
  return digits * 10n ** BigInt(exp);
}

/** Sum known costs, then ceil(sum * 1e6) ONCE. Unknown costs are counted, never treated as $0. */
export function costToMicro(costs: readonly (string | number | null | undefined)[]): { micro: bigint; unknown: number } {
  let sum = 0n;
  let unknown = 0;
  for (const c of costs) {
    const u = costUnits(c);
    if (u === null) unknown++;
    else sum += u;
  }
  const d = 10n ** BigInt(COST_SCALE - 6);
  return { micro: (sum + d - 1n) / d, unknown };
}

export const COST_UNITS_SCALE = COST_SCALE;
