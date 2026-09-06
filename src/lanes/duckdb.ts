import type { DuckDBConnection } from '@duckdb/node-api';

import { connectDuckDB } from '../duckdb/connect.js';
import { bindAll, createProfiler } from '../duckdb/profile.js';
import { TABLES } from '../queries/dialect.js';
import type { QueryValue } from '../queries/types.js';
import type { Lane, LaneId } from '../types.js';
import { createLane, type LaneSpec } from './create-lane.js';

/**
 * Every server-side DuckDB lane. Lane B reads Postgres over the wire, lane C reads
 * Parquet over HTTP, and the difference between them is three fields of
 * configuration - which is the honest way to put it, because DuckDB is the same
 * engine in both cases and only the storage changed.
 */
export interface DuckDBLaneOptions {
  readonly id: LaneId;
  readonly label: string;
  readonly handicaps: readonly string[];
  readonly extensions: readonly string[];
  /** Run on every connection before it serves anything, e.g. an ATTACH. */
  readonly setup?: readonly string[];
  /** Prefix qualifying the star tables, e.g. `lake.` or `pg.`. */
  readonly schema: string;
  readonly partitioned: boolean;
  /**
   * Take metrics from a second connection with the caches turned off.
   *
   * Wanted for file-backed reads, where a warm re-read reports zero bytes. Pointless
   * for a lane whose data arrives over a database connection, which is never cached
   * in the first place.
   */
  readonly uncachedMetrics: boolean;
}

export async function createDuckDBLane(options: DuckDBLaneOptions): Promise<Lane> {
  const query = await open(options, false);
  const metrics = options.uncachedMetrics ? await open(options, true) : query;
  const profiler = await createProfiler(metrics);
  const factTable = `${options.schema}${TABLES.fact}`;

  const spec: LaneSpec = {
    id: options.id,
    label: options.label,
    handicaps: options.handicaps,
    target: { dialect: 'duckdb', schema: options.schema, partitioned: options.partitioned },

    available: async () => {
      try {
        await query.run(`SELECT 1 FROM ${factTable} LIMIT 1`);
        return true;
      } catch {
        return false;
      }
    },

    execute: (sql, params) => runRows(query, sql, params),

    measure: async (sql, params) => {
      const summary = await profiler.measure(sql, params);
      return {
        // Zero means "not instrumented for this transport", not "read nothing".
        // DuckDB counts bytes through its HTTP file system and nowhere else, so a
        // lane reading over the Postgres wire protocol reports no byte count rather
        // than a misleading one.
        bytesRead: summary.bytesRead > 0 ? summary.bytesRead : undefined,
        rowsScanned: summary.rowsScanned,
        columnsProjected: summary.columnsProjected,
        ...(options.partitioned ? { filesRead: summary.filesRead } : {}),
        ...(summary.filtersPushed ? { filtersPushed: summary.filtersPushed } : {}),
      };
    },

    close: async () => {
      query.disconnectSync();
      if (metrics !== query) metrics.disconnectSync();
    },
  };

  return createLane(spec);
}

async function open(options: DuckDBLaneOptions, forMetrics: boolean): Promise<DuckDBConnection> {
  const connection = await connectDuckDB({
    extensions: options.extensions,
    disableCaches: forMetrics,
  });
  for (const statement of options.setup ?? []) await connection.run(statement);
  return connection;
}

export async function runRows(
  connection: DuckDBConnection,
  sql: string,
  params: readonly QueryValue[],
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await connection.prepare(sql);
  bindAll(prepared, params);
  return (await prepared.runAndReadAll()).getRowObjectsJson();
}
