import pg from 'pg';

import type { DuckDBConnection } from '@duckdb/node-api';

import { formatMs } from '../bench/table';
import { readSqlFile } from '../sql-files';
import { toLibpqConnectionString } from './connection';

/**
 * Loads the star into a Postgres, whichever Postgres that is.
 *
 * Both lane A and lane F read a Postgres, and pg_duckdb's whole claim is that it is
 * faster than plain Postgres on the same rows. "The same rows" has to be literally
 * true for that comparison to mean anything, so both instances are loaded by this
 * one function from the same DuckDB file in the same run.
 */

/** Dimensions before the fact: the fact's foreign keys point at them. */
const DIMENSIONS = ['dim_date', 'dim_customer', 'dim_product'] as const;

export interface LoadReport {
  readonly insertMs: number;
  readonly tuneMs: number;
  readonly tables: readonly { table: string; rows: string; size: string }[];
}

export async function loadStar(
  duck: DuckDBConnection,
  connectionString: string,
  alias: string,
): Promise<LoadReport> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(`SET TimeZone = 'UTC'`);

  // DDL through the Postgres client, not through DuckDB's ATTACH: the schema is
  // Postgres' own - PRIMARY KEY, REFERENCES, NUMERIC(12,2) - and running it verbatim
  // keeps it out of a type translation layer.
  await client.query(readSqlFile('03_star.postgres.sql'));

  const insertStarted = performance.now();
  await duck.run(`ATTACH '${toLibpqConnectionString(connectionString)}' AS ${alias} (TYPE postgres)`);
  try {
    for (const table of DIMENSIONS) {
      await duck.run(`INSERT INTO ${alias}.${table} SELECT * FROM ${table}`);
    }
    // `month` exists only in the lake copy, as its Hive partition key. The heap has
    // no partitions, so storing it would be megabytes of redundant text.
    await duck.run(`INSERT INTO ${alias}.fact_order_item SELECT * EXCLUDE (month) FROM fact_order_item`);
    await duck.run(`INSERT INTO ${alias}.fact_inventory_snapshot SELECT * FROM fact_inventory_snapshot`);
  } finally {
    await duck.run(`DETACH ${alias}`);
  }
  const insertMs = performance.now() - insertStarted;

  const tuneStarted = performance.now();
  await client.query(readSqlFile('04_tune_star.postgres.sql'));
  const tuneMs = performance.now() - tuneStarted;

  const sizes = await client.query<{ table: string; rows: string; size: string }>(`
    SELECT c.relname                                     AS table,
           to_char(c.reltuples, 'FM999,999,999')         AS rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);

  await client.end();
  return { insertMs, tuneMs, tables: sizes.rows };
}

/** True when something is listening and speaking Postgres. Lane F is optional. */
export async function isReachable(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export function describeLoad(report: LoadReport): string {
  const lines = [
    `  rows inserted, ${formatMs(report.insertMs)}`,
    `  indexes, statistics and ANALYZE, ${formatMs(report.tuneMs)}`,
  ];
  for (const row of report.tables) {
    lines.push(`  ${row.table.padEnd(18)}${row.rows.padStart(12)} rows   ${row.size}`);
  }
  return lines.join('\n');
}
