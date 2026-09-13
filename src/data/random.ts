/**
 * Deterministic pseudo-randomness.
 *
 * Everything here is 32-bit integer arithmetic via `Math.imul` and `>>> 0`, so the
 * sequence is identical on every platform and every Node version. `Math.random`
 * appears nowhere in this repo.
 */

/** mulberry32. Small, fast, and good enough to shape a synthetic dataset. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    between: (min, maxExclusive) => min + Math.floor(next() * (maxExclusive - min)),
    chance: (probability) => next() < probability,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    pickWeighted: (cumulative) => sampleCumulative(cumulative, next()),
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, maxExclusive). */
  between(min: number, maxExclusive: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Index into a cumulative weight table from {@link cumulativeWeights}. */
  pickWeighted(cumulative: Float64Array): number;
}

/**
 * Derives an independent stream from a parent seed.
 *
 * Used to give each day of the calendar its own generator, so a day's rows depend
 * only on `(seed, day)` and not on how many rows every earlier day happened to
 * produce. That is what makes the generator resumable and its output stable when
 * the row count changes.
 */
export function deriveSeed(seed: number, stream: number): number {
  let h = (seed ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Normalised running totals, so a weighted pick is one binary search. */
export function cumulativeWeights(weights: readonly number[]): Float64Array {
  const cumulative = new Float64Array(weights.length);
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    total += weights[i]!;
    cumulative[i] = total;
  }
  if (total <= 0) throw new Error('weights must sum to a positive number');
  for (let i = 0; i < cumulative.length; i++) cumulative[i]! /= total;
  return cumulative;
}

/**
 * Zipf-ish weights: item of rank r gets weight 1/(r+1)^exponent.
 *
 * This is what gives products a long tail - a handful of bestsellers and thousands
 * of items that sell a few times a year - and customers a realistic repeat-purchase
 * distribution, which Q5's repeat rate depends on.
 */
export function zipfWeights(count: number, exponent: number): Float64Array {
  const weights = new Array<number>(count);
  for (let i = 0; i < count; i++) weights[i] = 1 / Math.pow(i + 1, exponent);
  return cumulativeWeights(weights);
}

function sampleCumulative(cumulative: Float64Array, u: number): number {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (u < cumulative[mid]!) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Splits `total` across `weights` so the parts are integers that sum to exactly
 * `total` (largest remainder method).
 *
 * Used to turn a daily demand curve into daily row counts. Naive rounding drifts,
 * and a dataset that is 999,987 rows when you asked for 1,000,000 quietly breaks
 * every "same seed, same bytes" claim.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must sum to a positive number');

  const counts = weights.map((w) => Math.floor((total * w) / sum));
  let remaining = total - counts.reduce((a, b) => a + b, 0);

  const byRemainder = weights
    .map((w, index) => ({ index, remainder: (total * w) / sum - counts[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; remaining > 0; i = (i + 1) % byRemainder.length, remaining--) {
    counts[byRemainder[i]!.index]! += 1;
  }
  return counts;
}
