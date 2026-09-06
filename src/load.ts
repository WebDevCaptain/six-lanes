import { existsSync, rmSync } from 'node:fs';

import pg from 'pg';

import { formatBytes } from './bench/table.js';
import { DATASET, LAKE_DIRS, PATHS, POSTGRES_URL } from './config.js';
import { connectDuckDB } from './duckdb/connect.js';
import { discoverParquetFiles, totalBytes } from './lake/raw-lake.js';
import { toLibpqConnectionString } from './postgres/connection.js';
import { readSqlFile } from './sql-files.js';

/**
 * `pnpm load` - projects data/olap.duckdb into the two stores the lanes read.
 *
 *   lake/raw/month=YYYY-MM/*.parquet   the column store
 *   Postgres `orders`                  the row store
 *
 * Both come from the same DuckDB file, in one process, so there is no window in
 * which the two disagree about what the dataset is.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

const duck = await connectDuckDB({ path: PATHS.database, extensions: ['postgres'] });

console.log('writing the Parquet lake...');
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
console.log(
  `  ${partitions.length} partitions, ${formatBytes(totalBytes(partitions))} on disk, ${lakeMs}\n`,
);

console.log('loading Postgres...');
const client = new pg.Client({ connectionString: POSTGRES_URL });
await client.connect();
await client.query(`SET TimeZone = 'UTC'`);

// DDL through the Postgres client, not through DuckDB's ATTACH: the schema is
// Postgres' own - PRIMARY KEY, NUMERIC(12,2), its index definitions - and running
// it verbatim keeps it out of a type translation layer.
await client.query(readSqlFile('01_schema.postgres.sql'));

const insertMs = await time(async () => {
  await duck.run(`ATTACH '${toLibpqConnectionString(POSTGRES_URL)}' AS pg (TYPE postgres)`);
  await duck.run(`INSERT INTO pg.orders SELECT * FROM orders`);
  await duck.run(`DETACH pg`);
});
console.log(`  ${(await countOrders(client)).toLocaleString()} rows inserted, ${insertMs}`);

const tuneMs = await time(() => client.query(readSqlFile('02_tune.postgres.sql')));
console.log(`  indexes, statistics and ANALYZE, ${tuneMs}`);

const sizes = await client.query<{ total: string; heap: string }>(`
  SELECT pg_size_pretty(pg_total_relation_size('orders')) AS total,
         pg_size_pretty(pg_table_size('orders'))          AS heap
`);
console.log(`  ${sizes.rows[0]!.total} total, ${sizes.rows[0]!.heap} heap\n`);

console.log(`lake  ${formatBytes(totalBytes(partitions))} across ${partitions.length} files`);
console.log(`heap  ${sizes.rows[0]!.heap}`);
console.log(`ratio ${(bytesOf(sizes.rows[0]!.heap) / totalBytes(partitions)).toFixed(1)}x`);
console.log(`\nserved at ${DATASET.orderItems.toLocaleString()} rows; run \`pnpm compare\` next`);

await client.end();
duck.disconnectSync();

async function countOrders(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>('SELECT count(*) AS count FROM orders');
  return Number(result.rows[0]!.count);
}

async function time(fn: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  await fn();
  return `${((performance.now() - started) / 1000).toFixed(2)}s`;
}

/** Parses `pg_size_pretty` output back to bytes, for the one ratio printed above. */
function bytesOf(pretty: string): number {
  const [value = '0', unit = 'bytes'] = pretty.split(' ');
  const scale: Record<string, number> = {
    bytes: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
  };
  return Number(value) * (scale[unit] ?? 1);
}
