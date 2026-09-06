import type { QueryId } from './queries/index.js';
import type { QueryParams, QueryValue } from './queries/types.js';

/**
 * One cell of a result, after normalisation. Money arrives as a fixed-2 string so
 * that comparing two engines never goes through a float.
 */
export type Cell = string | number | null;
export type Row = Readonly<Record<string, Cell>>;

export const LANE_IDS = [
  'postgres',
  'duckdb-postgres',
  'duckdb-lake',
  'duckdb-wasm',
  'pglite',
  'pg-duckdb',
] as const;

export type LaneId = (typeof LANE_IDS)[number];

/** Plan section 9 rule 4-5: bytes and rows, not just milliseconds. */
export interface QueryMetrics {
  /** Reported by the engine. Absent when the engine cannot report it honestly. */
  readonly bytesRead?: number | undefined;
  readonly rowsScanned?: number | undefined;
  readonly rowsReturned: number;
  /** Files the scan opened after partition pruning. Lake lanes only. */
  readonly filesRead?: number | undefined;
  /** Columns the scan read after column pruning. Lake lanes only. */
  readonly columnsRead?: readonly string[] | undefined;
  /**
   * What the engine says it spent on itself, excluding the client round trip.
   *
   * The headline timing is deliberately end-to-end, because that is what an
   * application experiences. But an in-process engine pays no round trip and a
   * networked one does, and on a query that finishes in a quarter of a millisecond
   * the round trip is most of the number. Reporting both keeps a point lookup from
   * looking like a network benchmark.
   *
   * Set only when the engine can report it under the same conditions as the timed
   * runs. An in-process engine leaves it unset, because there its wall time and its
   * engine time are the same measurement twice.
   */
  readonly engineMs?: number | undefined;
}

/**
 * Plan section 9 rules 2-3 and 9: median and p95 of repeated warm runs, never a
 * mean; cold kept as its own number and never averaged in.
 */
export interface Timings {
  /**
   * First run against an engine that was genuinely idle - a Neon compute waking
   * from zero. Absent for a local engine, where "cold" would mean nothing more
   * than the state of the OS page cache.
   */
  readonly coldMs?: number | undefined;
  readonly warmMs: number;
  readonly p95Ms: number;
  readonly runs: number;
}

export interface LaneResult {
  readonly laneId: LaneId;
  readonly queryId: QueryId;
  readonly rows: readonly Row[];
  /** Exactly what was executed, parameters and all. Rendered in the UI verbatim. */
  readonly sql: string;
  readonly params: readonly QueryValue[];
  readonly timings: Timings;
  readonly metrics: QueryMetrics;
  /** Shown next to the numbers they qualify, never in a footnote. */
  readonly handicaps: readonly string[];
}

export interface Lane {
  readonly id: LaneId;
  readonly label: string;
  available(): Promise<boolean>;
  run(queryId: QueryId, params: QueryParams): Promise<LaneResult>;
  close(): Promise<void>;
}
