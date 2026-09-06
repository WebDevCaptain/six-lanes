import { BENCH } from '../config.js';
import { median, percentile95, timed } from '../bench/measure.js';
import { normalizeRows } from '../bench/normalize.js';
import { getQuery, type QueryId } from '../queries/index.js';
import type { QueryParams, QueryValue, SqlTarget } from '../queries/types.js';
import type { Lane, LaneId, LaneResult, QueryMetrics } from '../types.js';

/** Everything about a lane except how it is measured. */
export interface LaneSpec {
  readonly id: LaneId;
  readonly label: string;
  /** Disclosed on screen next to this lane's numbers. */
  readonly handicaps: readonly string[];
  readonly target: SqlTarget;
  available(): Promise<boolean>;
  /** Runs the query for real. Called once to warm, then once per timed run. */
  execute(sql: string, params: readonly QueryValue[]): Promise<readonly Record<string, unknown>[]>;
  /**
   * A second, instrumented pass. Deliberately outside the timed loop: asking an
   * engine to account for itself changes what it costs, and a number that includes
   * its own measurement overhead is not the number anyone wants.
   */
  measure(sql: string, params: readonly QueryValue[]): Promise<Omit<QueryMetrics, 'rowsReturned'>>;
  close(): Promise<void>;
}

/**
 * Wraps a lane in the measurement protocol.
 *
 * Every lane goes through this function, and that is the point. If each lane timed
 * itself, the six numbers on screen would be six slightly different definitions of
 * "how long it took", and the comparison they are supposed to support would be
 * worthless. Warm-up count, run count, median, p95 and normalisation are decided
 * here, once, for all of them.
 */
export function createLane(spec: LaneSpec): Lane {
  return {
    id: spec.id,
    label: spec.label,
    available: spec.available,
    close: spec.close,

    async run(queryId: QueryId, params: QueryParams): Promise<LaneResult> {
      const query = getQuery(queryId);
      const sql = query.build(spec.target);
      const values = query.bind(params);

      for (let i = 0; i < BENCH.warmupRuns; i++) await spec.execute(sql, values);

      const durations: number[] = [];
      let raw: readonly Record<string, unknown>[] = [];
      for (let i = 0; i < BENCH.timedRuns; i++) {
        const run = await timed(() => spec.execute(sql, values));
        durations.push(run.ms);
        raw = run.value;
      }

      const rows = normalizeRows(query.columns, raw);

      return {
        laneId: spec.id,
        queryId,
        rows,
        sql,
        params: values,
        timings: {
          warmMs: median(durations),
          p95Ms: percentile95(durations),
          runs: durations.length,
        },
        metrics: { ...(await spec.measure(sql, values)), rowsReturned: rows.length },
        handicaps: spec.handicaps,
      };
    },
  };
}
