/**
 * The measurement protocol, and nothing that needs a filesystem.
 *
 * This module is imported by the browser lanes as well as the server ones, so it
 * stays free of `node:` imports. That constraint is why the run counts live here
 * rather than in src/config.ts.
 */
export const BENCH = {
  warmupRuns: 1,
  /**
   * Five, per plan section 9 rule 2. Not configurable: it is the protocol every
   * published number in this repo was produced under, and a knob would let two runs
   * be compared that were not measured the same way.
   */
  timedRuns: 5,
} as const;

/**
 * Median. Even-sized samples take the mean of the middle two.
 *
 * A mean lets one scheduler hiccup move a published number. The median cannot be
 * moved by a single sample, and p95 says what the bad case looks like, which is the
 * pair a reader can actually act on.
 */
export function median(values: readonly number[]): number {
  const sorted = sortedCopy(values);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * 95th percentile, nearest-rank. With the default five runs this is the slowest
 * of them, which is the honest reading: five samples cannot resolve a tail, and
 * interpolating would dress up a number that is not there.
 */
export function percentile95(values: readonly number[]): number {
  const sorted = sortedCopy(values);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(rank, 1) - 1]!;
}

function sortedCopy(values: readonly number[]): number[] {
  if (values.length === 0) throw new Error('no samples');
  return [...values].sort((a, b) => a - b);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}
