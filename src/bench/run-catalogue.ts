import { QUERY_IDS, type QueryId } from '../queries/index';
import type { QueryParams } from '../queries/types';
import type { Lane, LaneResult } from '../types';
import { findMismatches } from './compare';
import { BASELINE_LANE } from '../lanes/meta';

/**
 * Running the catalogue across lanes and applying the correctness gate, in one place.
 *
 * `pnpm compare`, `pnpm bench` and the app all need this, and when each had its own
 * copy they drifted: two withheld the timing of a lane that disagreed and the third
 * printed it. Whether a number may be published is the project's first rule, so it is
 * decided once here rather than three times.
 */
export interface MeasuredRow {
  readonly queryId: QueryId;
  readonly result: LaneResult;
  /** False when this lane's rows differ from the baseline's. Timings are then void. */
  readonly agrees: boolean;
  readonly disagreement?: string | undefined;
}

export async function runCatalogue(
  lanes: readonly Lane[],
  params: QueryParams,
  queryIds: readonly QueryId[] = QUERY_IDS,
): Promise<MeasuredRow[]> {
  const rows: MeasuredRow[] = [];

  for (const queryId of queryIds) {
    // Sequential on purpose: lanes share a machine, and running them concurrently
    // would have them competing for the CPU whose speed is being measured.
    const results: LaneResult[] = [];
    for (const lane of lanes) results.push(await lane.run(queryId, params));

    const baseline = results.find((result) => result.laneId === BASELINE_LANE);
    const mismatches = baseline
      ? findMismatches(baseline, results.filter((result) => result !== baseline))
      : [];
    const byLane = new Map(mismatches.map((mismatch) => [mismatch.laneId, mismatch.detail]));

    for (const result of results) {
      const disagreement = byLane.get(result.laneId);
      rows.push({ queryId, result, agrees: disagreement === undefined, disagreement });
    }
  }

  return rows;
}

/** The rows whose timings must not be published. */
export const disagreements = (rows: readonly MeasuredRow[]): MeasuredRow[] =>
  rows.filter((row) => !row.agrees);
