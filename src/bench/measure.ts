/**
 * Plan section 9 rule 2: median and p95 of repeated runs, never a mean.
 *
 * A mean lets one scheduler hiccup move a published number. The median cannot be
 * moved by a single sample, and p95 says what the bad case looks like, which is the
 * pair a reader can actually act on.
 */

/** Median. Even-sized samples take the mean of the middle two. */
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
