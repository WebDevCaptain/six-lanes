import type { LaneResult, Row } from '../types.js';

/**
 * Plan section 9 rule 1: correctness gates publication.
 *
 * A lane that disagrees with lane A does not get a slower or faster label, it gets
 * no label at all. A benchmark between engines that are computing different things
 * is not a benchmark, and the only defence against that is to check every row of
 * every result on every run rather than to trust that six SQL dialects mean the
 * same thing.
 */

export interface Mismatch {
  readonly laneId: string;
  readonly detail: string;
}

/** Compares against the baseline lane, ignoring row order. */
export function findMismatches(
  baseline: LaneResult,
  candidates: readonly LaneResult[],
): Mismatch[] {
  const expected = canonicalize(baseline.rows);

  return candidates.flatMap((candidate) => {
    const detail = describeDifference(expected, canonicalize(candidate.rows));
    return detail === null ? [] : [{ laneId: candidate.laneId, detail }];
  });
}

/**
 * Rows sorted by their own serialised form.
 *
 * Sorting by content rather than by a declared key means the comparison never
 * depends on a query happening to have a total ORDER BY, and two engines that
 * return the same set in a different order are correctly treated as agreeing.
 */
function canonicalize(rows: readonly Row[]): string[] {
  return rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
}

function describeDifference(expected: readonly string[], actual: readonly string[]): string | null {
  if (expected.length !== actual.length) {
    return `row count ${actual.length}, expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return `row ${i + 1} differs\n    expected ${expected[i]}\n    actual   ${actual[i]}`;
    }
  }
  return null;
}
