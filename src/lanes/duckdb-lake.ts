import type { DuckDBConnection } from '@duckdb/node-api';

import { createLane, type LaneSpec } from './create-lane.js';
import { connectDuckDB } from '../duckdb/connect.js';
import { bindAll, createProfiler } from '../duckdb/profile.js';
import type { QueryValue } from '../queries/types.js';
import type { Lane } from '../types.js';

/**
 * Lane C - DuckDB reading the Parquet lake over HTTP.
 *
 * Two connections, on purpose.
 *
 * The query connection keeps DuckDB's caches on and answers the same question five
 * times. That is the warm number, and it is the only one comparable with lane A's
 * warm number, where Postgres is answering entirely out of shared buffers.
 *
 * The metrics connection has the caches off, so every read goes to the wire and
 * `total_bytes_read` reports what the query actually costs to serve rather than
 * zero. It runs once, outside the timed loop, exactly like lane A's EXPLAIN pass.
 *
 * Mixing the two would give a choice between a warm time and an honest byte count.
 * Separating them gives both, and section 9 rule 9 - never compare a warm lane to a
 * cold one - stays intact.
 */
export interface DuckDBLakeLaneOptions {
  readonly label: string;
  /** A `read_parquet(...)` call or an attached DuckLake table. */
  readonly relation: string;
  readonly partitioned: boolean;
  readonly handicaps?: readonly string[];
  /** Statements every connection runs before serving queries, e.g. an ATTACH. */
  readonly setup?: readonly string[];
}

/** The view name every lane query reads from, so the shown SQL stays legible. */
export const LAKE_VIEW = 'lake_orders';

export async function createDuckDBLakeLane(options: DuckDBLakeLaneOptions): Promise<Lane> {
  const query = await openLakeConnection(options, false);
  const metrics = await openLakeConnection(options, true);
  const profiler = await createProfiler(metrics);

  const spec: LaneSpec = {
    id: 'duckdb-lake',
    label: options.label,
    handicaps: [
      'Reads the lake over HTTP, the same path a CDN-hosted deployment uses.',
      'Byte counts come from an uncached pass: no client-side file cache, every run pays the full transfer.',
      ...(options.handicaps ?? []),
    ],
    target: { dialect: 'duckdb', relation: LAKE_VIEW, partitioned: options.partitioned },

    available: async () => {
      try {
        await query.run(`SELECT 1 FROM ${LAKE_VIEW} LIMIT 1`);
        return true;
      } catch {
        return false;
      }
    },

    execute: (sql, params) => runRows(query, sql, params),
    measure: (sql, params) => profiler.measure(sql, params),

    close: async () => {
      query.disconnectSync();
      metrics.disconnectSync();
    },
  };

  return createLane(spec);
}

async function openLakeConnection(
  options: DuckDBLakeLaneOptions,
  forMetrics: boolean,
): Promise<DuckDBConnection> {
  const connection = await connectDuckDB({
    extensions: ['httpfs'],
    disableCaches: forMetrics,
  });
  for (const statement of options.setup ?? []) await connection.run(statement);

  // A view rather than the raw relation, so the SQL shown in the UI reads
  // `FROM lake_orders` instead of twenty-four inlined URLs. DuckDB inlines views
  // before optimising, so projection and partition pruning are unaffected -
  // asserted by tests/lake-pruning.test.ts.
  await connection.run(`CREATE OR REPLACE VIEW ${LAKE_VIEW} AS SELECT * FROM ${options.relation}`);
  return connection;
}

export async function runRows(
  connection: DuckDBConnection,
  sql: string,
  params: readonly QueryValue[],
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await connection.prepare(sql);
  bindAll(prepared, params);
  const result = await prepared.runAndReadAll();
  return result.getRowObjectsJson();
}
