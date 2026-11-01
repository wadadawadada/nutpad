// Integer bonding curve. All math is BigInt; no floating point anywhere.
//
// p(q) = a + b*q,  a = 0.001 sat/token,  b = 2(R - aS)/S^2
// F(q) = a*q + b*q^2/2 = q/1000 + (R - aS) * q^2 / S^2
// C(q) = floor(F(q)) computed over the common denominator 1000*S^2, so
// C(0) = 0 and C(S) = R exactly.

export const SUPPLY = 21_000_000n;
export const RESERVE_TOTAL = 1_000_000n;
export const LAUNCH_FEE_SATS = 1_000n;
export const MIN_FIRST_BUY_SATS = 100n;
export const MAX_FIRST_BUY_UNITS = SUPPLY / 10n; // 2_100_000

const A_DEN = 1000n; // a = 1/1000
const K = RESERVE_TOTAL * A_DEN - SUPPLY; // (R - aS) * 1000 = 979_000_000
const DEN = A_DEN * SUPPLY * SUPPLY;

/** Cumulative cost in sats of the first q units (floor). */
export function C(q: bigint): bigint {
  if (q < 0n || q > SUPPLY) throw new RangeError('q out of range');
  return (q * SUPPLY * SUPPLY + K * q * q) / DEN;
}

export function buyGross(q: bigint, delta: bigint): bigint {
  return C(q + delta) - C(q);
}

export function sellGross(q: bigint, delta: bigint): bigint {
  return C(q) - C(q - delta);
}

/** Fee = ceil(1% of gross). */
export function feeOf(gross: bigint): bigint {
  return (gross + 99n) / 100n;
}

export interface FeeSplit {
  platform: bigint;
  creatorPool: bigint;
}

/** Normative split: creatorPool = ceil(30% of fee); platform = fee - creatorPool. */
export function splitFee(fee: bigint): FeeSplit {
  const creatorPool = (fee * 30n + 99n) / 100n;
  return { platform: fee - creatorPool, creatorPool };
}

/**
 * Distribute `total` among weights (basis points, sum 10000) by largest
 * remainder; ties broken by lowest index. Always sums to `total`.
 */
export function distribute(total: bigint, weightsBps: number[]): bigint[] {
  const sum = weightsBps.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new Error('weights must sum to 10000');
  const base = weightsBps.map((w) => (total * BigInt(w)) / 10000n);
  const rem = weightsBps.map((w, i) => ({ i, r: (total * BigInt(w)) % 10000n }));
  let left = total - base.reduce((a, b) => a + b, 0n);
  rem.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of rem) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base;
}

export interface BuyQuote {
  delta: bigint;
  gross: bigint;
  fee: bigint;
  total: bigint;
}

export function quoteBuyUnits(q: bigint, delta: bigint): BuyQuote {
  if (delta <= 0n || q + delta > SUPPLY) throw new RangeError('invalid delta');
  const gross = buyGross(q, delta);
  if (gross < 1n) throw new RangeError('trade too small');
  const fee = feeOf(gross);
  return { delta, gross, fee, total: gross + fee };
}

/** Largest delta whose total (gross+fee) fits within `budget` sats. */
export function quoteBuyBudget(q: bigint, budget: bigint, maxDelta = SUPPLY - q): BuyQuote | null {
  let lo = 0n;
  let hi = maxDelta < SUPPLY - q ? maxDelta : SUPPLY - q;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const g = buyGross(q, mid);
    if (g + feeOf(g) <= budget) lo = mid;
    else hi = mid - 1n;
  }
  if (lo === 0n) return null;
  const gross = buyGross(q, lo);
  if (gross < 1n) return null;
  const fee = feeOf(gross);
  return { delta: lo, gross, fee, total: gross + fee };
}

export interface SellQuote {
  delta: bigint;
  gross: bigint;
  fee: bigint;
  payout: bigint;
}

export function quoteSellUnits(q: bigint, delta: bigint): SellQuote {
  if (delta <= 0n || delta > q) throw new RangeError('invalid delta');
  const gross = sellGross(q, delta);
  const fee = feeOf(gross);
  if (gross <= fee) throw new RangeError('trade too small');
  return { delta, gross, fee, payout: gross - fee };
}

/** Spot price scaled by 1e9 (sats per token * 1e9), display only. */
export function spotPriceNano(q: bigint): bigint {
  return 1_000_000n + (2n * (K / A_DEN) * 1_000_000_000n * q) / (SUPPLY * SUPPLY);
}
