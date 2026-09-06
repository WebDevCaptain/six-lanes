import { existsSync, rmSync } from 'node:fs';

import pg from 'pg';

import { formatBytes, formatCount, formatMs } from './bench/table.js';
import { LAKE_BASE_URL, LAKE_DIRS, PATHS, POSTGRES_URL } from './config.js';
import { connectDuckDB, scalar } from './duckdb/connect.js';
import { createProfiler } from './duckdb/profile.js';
import {
  DUCKLAKE,
  DUCKLAKE_EXTENSIONS,
  DUCKLAKE_RELATION,
  attachDuckLakeSql,
  metadataTable,
} from './lake/ducklake.js';
import { discoverParquetFiles, totalBytes, waitForLakeFiles } from './lake/raw-lake.js';

/**
 * `pnpm ducklake` - builds generation 2 of the lake and proves it is portable.
 *
 * Same Parquet, same partitioning, same compression as generation 1. The only thing
 * that changes is that a Postgres table now knows which files make up the table, and
 * that turns out to change what is possible: transactions, history, schema evolution,
 * and reading the lake from a URL it was never written to.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

// A clean rebuild. Dropping the metadata schema orphans the old Parquet, so the
// data directory goes with it - leaving one behind would leave files no catalog
// references, which is the exact failure mode a catalog exists to prevent.
const admin = new pg.Client({ connectionString: POSTGRES_URL });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${DUCKLAKE.metadataSchema} CASCADE`);
await admin.end();
rmSync(PATHS.duckLake, { recursive: true, force: true });

const duck = await connectDuckDB({ path: PATHS.database, extensions: [...DUCKLAKE_EXTENSIONS] });
await duck.run(
  attachDuckLakeSql({
    alias: DUCKLAKE.alias,
    dataPath: PATHS.duckLake,
    metadataSchema: DUCKLAKE.metadataSchema,
  }),
);

/** Every column plus the partition key, which is how generation 1 is written too. */
const projection = `SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders`;

// DuckLake writes snappy unless told otherwise, and the first build of this lake
// came out at 25.30 MB against generation 1's 14.95 MB - which is exactly the snappy
// figure from the Day 2 layout study. The lakehouse layer does not inherit the
// compression choice, it has its own default, and the difference is 69%.
await duck.run(`CALL ducklake_set_option('${DUCKLAKE.alias}', 'parquet_compression', 'zstd')`);

console.log('building the DuckLake table...');
const buildMs = await time(async () => {
  // Partitioning must be declared before the rows arrive: SET PARTITIONED BY governs
  // future writes, so creating the table full and partitioning it afterwards would
  // leave every existing row in one unpartitioned file.
  await duck.run(`CREATE TABLE ${DUCKLAKE_RELATION} AS ${projection} LIMIT 0`);
  await duck.run(`ALTER TABLE ${DUCKLAKE_RELATION} SET PARTITIONED BY (month)`);
  await duck.run(`INSERT INTO ${DUCKLAKE_RELATION} ${projection}`);
});

const catalog = await duck.runAndReadAll(`
  SELECT count(*)::BIGINT           AS files,
         sum(record_count)::BIGINT  AS records,
         sum(file_size_bytes)::BIGINT AS bytes
  FROM ${metadataTable('ducklake_data_file')}
`);
const summary = catalog.getRowObjectsJson()[0] as Record<string, string>;

console.log(`  ${formatCount(Number(summary['files']))} files, ${formatCount(Number(summary['records']))} rows, ${formatBytes(Number(summary['bytes']))}, ${buildMs}`);
console.log(`  catalog: ${DUCKLAKE.metadataSchema} schema in Postgres, ${await catalogTableCount()} tables`);
console.log(`  snapshots: ${await scalar(duck, `SELECT count(*) FROM ${DUCKLAKE.alias}.snapshots()`)}`);

// The property the whole deployment story rests on.
const relative = await scalar<string>(
  duck,
  `SELECT count(*) FROM ${metadataTable('ducklake_data_file')} WHERE NOT path_is_relative`,
);
console.log(`  paths stored relative to DATA_PATH: ${relative === '0' ? 'all of them' : `NO - ${relative} absolute`}`);

console.log('\ncomparing the two generations on the same question...');
const raw = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw);
const duckLakeFiles = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.duckLake);
await waitForLakeFiles(LAKE_BASE_URL, duckLakeFiles);

const overHttp = await connectDuckDB({ extensions: [...DUCKLAKE_EXTENSIONS], disableCaches: true });
await overHttp.run(
  attachDuckLakeSql({
    alias: DUCKLAKE.alias,
    // The same catalog, pointed somewhere else entirely. Nothing is rewritten.
    dataPath: `${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}`,
    metadataSchema: DUCKLAKE.metadataSchema,
    overrideDataPath: true,
    readOnly: true,
  }),
);

const profiler = await createProfiler(overHttp);
const q1 = `SELECT category, sum(revenue) FROM ${DUCKLAKE_RELATION} GROUP BY 1`;
const q2 = `SELECT month, sum(revenue) FROM ${DUCKLAKE_RELATION} WHERE month = '2025-03' GROUP BY 1`;

console.log(`  gen 1, raw Parquet:  ${formatCount(raw.length)} files, ${formatBytes(totalBytes(raw))} on disk`);
console.log(`  gen 2, DuckLake:     ${formatCount(duckLakeFiles.length)} files, ${formatBytes(totalBytes(duckLakeFiles))} on disk`);
console.log(`  read over HTTP with an overridden DATA_PATH:`);
console.log(`    revenue by category   ${describe(await profiler.measure(q1, []))}`);
console.log(`    one month, pruned     ${describe(await profiler.measure(q2, []))}`);

const rows = await overHttp.runAndReadAll(q1);
console.log(`\n  answer from the re-pointed lake: ${rows.getRowObjectsJson().length} categories`);
console.log(`  DATA_PATH used: ${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}/`);

overHttp.disconnectSync();
duck.disconnectSync();

console.log('\nlane C now reads lake.orders through the catalog. `pnpm compare` to confirm it still agrees with lane A.');

function describe(summary: { bytesRead: number; filesRead: number; rowsScanned: number }): string {
  return `${formatBytes(summary.bytesRead).padStart(9)}  ${formatCount(summary.filesRead)} files  ${formatCount(summary.rowsScanned)} rows`;
}

async function catalogTableCount(): Promise<number> {
  const client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();
  const result = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1`,
    [DUCKLAKE.metadataSchema],
  );
  await client.end();
  return Number(result.rows[0]!.n);
}

async function time(fn: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  await fn();
  return formatMs(performance.now() - started);
}
