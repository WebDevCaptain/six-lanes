import { existsSync, rmSync } from 'node:fs';

import pg from 'pg';

import { formatBytes, formatMs } from './bench/table.js';
import { LAKE_DIRS, PATHS, POSTGRES_URL } from './config.js';
import { connectDuckDB } from './duckdb/connect.js';
import { discoverParquetFiles, totalBytes } from './lake/raw-lake.js';
import { toLibpqConnectionString } from './postgres/connection.js';
import { readSqlFile } from './sql-files.js';

/**
 * `pnpm load` - projects data/olap.duckdb into the stores the lanes read.
 *
 *   Postgres        the star schema: lane A, and the host of DuckLake's catalog
 *   lake/raw/       generation 1 of the lake, written from the flat `orders` table
 *
 * Generation 2 is built separately by `pnpm ducklake`, because its catalog lives in
 * Postgres and so Postgres has to exist first.
 *
 * The raw lake is still written from `orders` rather than from the fact table, on
 * purpose: it is the Day 1 and Day 2 artefact, and rewriting it against the star
 * would invalidate every layout-study number in docs/results.md.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

/** Dimensions before the fact: the fact's foreign keys point at them. */
const DIMENSIONS = ['dim_date', 'dim_customer', 'dim_product'] as const;

const duck = await connectDuckDB({ path: PATHS.database, extensions: ['postgres'] });

console.log('writing the raw Parquet lake (generation 1)...');
const lakeMs = await time(async () => {
  // Removed rather than overwritten: OVERWRITE_OR_IGNORE replaces the partitions it
  // is given and silently leaves behind any it is not, so a smaller regeneration
  // would be read as the union of two datasets.
  rmSync(PATHS.rawLake, { recursive: true, force: true });
  await duck.run(`
    COPY (SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders)
    TO '${PATHS.rawLake}' (FORMAT parquet, PARTITION_BY month, COMPRESSION zstd, OVERWRITE_OR_IGNORE)
  `);
});

const partitions = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw);
console.log(`  ${partitions.length} partitions, ${formatBytes(totalBytes(partitions))}, ${lakeMs}\n`);

console.log('loading the star into Postgres...');
const client = new pg.Client({ connectionString: POSTGRES_URL });
await client.connect();
await client.query(`SET TimeZone = 'UTC'`);

// DDL through the Postgres client, not through DuckDB's ATTACH: the schema is
// Postgres' own - PRIMARY KEY, REFERENCES, NUMERIC(12,2) - and running it verbatim
// keeps it out of a type translation layer.
await client.query(readSqlFile('03_star.postgres.sql'));

const insertMs = await time(async () => {
  await duck.run(`ATTACH '${toLibpqConnectionString(POSTGRES_URL)}' AS pg (TYPE postgres)`);
  for (const table of DIMENSIONS) await duck.run(`INSERT INTO pg.${table} SELECT * FROM ${table}`);
  // `month` exists only in the lake copy, as its Hive partition key. The heap has no
  // partitions, so storing it would be megabytes of redundant text.
  await duck.run(`INSERT INTO pg.fact_order_item SELECT * EXCLUDE (month) FROM fact_order_item`);
  await duck.run(`DETACH pg`);
});
console.log(`  rows inserted, ${insertMs}`);

const tuneMs = await time(() => client.query(readSqlFile('04_tune_star.postgres.sql')));
console.log(`  indexes, statistics and ANALYZE, ${tuneMs}\n`);

const sizes = await client.query<{ table: string; rows: string; total: string }>(`
  SELECT c.relname                                     AS table,
         to_char(c.reltuples, 'FM999,999,999')         AS rows,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC
`);
for (const row of sizes.rows) {
  console.log(`  ${row.table.padEnd(18)}${row.rows.padStart(12)} rows   ${row.total}`);
}

await client.end();
duck.disconnectSync();

console.log('\nnext: `pnpm ducklake` to build generation 2, then `pnpm compare`');

async function time(fn: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  await fn();
  return formatMs(performance.now() - started);
}
