import { existsSync, rmSync } from 'node:fs';

import pg from 'pg';

import { formatBytes, formatCount, formatMs } from './bench/table';
import { LAKE_BASE_URL, LAKE_DIRS, PATHS, POSTGRES_URL } from './config';
import { connectDuckDB, scalar } from './duckdb/connect';
import { createProfiler } from './duckdb/profile';
import { DUCKLAKE, DUCKLAKE_EXTENSIONS, attachDuckLakeSql, metadataTable } from './lake/ducklake';
import { discoverParquetFiles, totalBytes, waitForLakeFiles } from './lake/raw-lake';
import { TABLES } from './queries/dialect';

/**
 * `pnpm ducklake` - builds generation 2 of the lake and proves it is portable.
 *
 * Same Parquet, same partitioning, same compression as generation 1. The only thing
 * that changes is that a Postgres table now knows which files make up each table, and
 * that turns out to change what is possible: transactions across tables, history,
 * schema evolution, and reading the lake from a URL it was never written to.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

// A clean rebuild. Dropping the metadata schema orphans the old Parquet, so the data
// directory goes with it - leaving files behind that no catalog references is the
// exact failure a catalog exists to prevent.
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

// DuckLake writes snappy unless told otherwise. The first build of this lake came out
// at 25.30 MB against generation 1's 14.95 MB - which is exactly the snappy figure
// from the Day 2 layout study. A lakehouse layer does not inherit the compression
// choice, it has its own default, and the difference is 69%.
await duck.run(`CALL ducklake_set_option('${DUCKLAKE.alias}', 'parquet_compression', 'zstd')`);

console.log('building the DuckLake star...');
const buildMs = await time(async () => {
  for (const table of Object.values(TABLES)) {
    await duck.run(`CREATE TABLE ${DUCKLAKE.alias}.${table} AS SELECT * FROM ${table} LIMIT 0`);
  }
  // Partitioning must be declared before the rows arrive: SET PARTITIONED BY governs
  // future writes, so partitioning a full table would leave every existing row in one
  // unpartitioned file. Only the fact is partitioned; the dimensions are small enough
  // that splitting them would cost more in footers than it saves in pruning.
  await duck.run(`ALTER TABLE ${DUCKLAKE.alias}.${TABLES.fact} SET PARTITIONED BY (month)`);

  // One transaction for all four tables. A warehouse where the fact can be visible
  // before its dimensions is a warehouse that serves NULL category names for a few
  // seconds every night.
  await duck.run('BEGIN TRANSACTION');
  for (const table of Object.values(TABLES)) {
    await duck.run(`INSERT INTO ${DUCKLAKE.alias}.${table} SELECT * FROM ${table}`);
  }
  await duck.run('COMMIT');
});

const perTable = await duck.runAndReadAll(`
  SELECT t.table_name                    AS name,
         count(*)::BIGINT                AS files,
         sum(f.record_count)::BIGINT     AS records,
         sum(f.file_size_bytes)::BIGINT  AS bytes
  FROM ${metadataTable('ducklake_data_file')} f
  JOIN ${metadataTable('ducklake_table')} t ON t.table_id = f.table_id
  WHERE f.end_snapshot IS NULL
  GROUP BY t.table_name
  ORDER BY 4 DESC
`);

console.log(`  built in ${buildMs}`);
for (const row of perTable.getRowObjectsJson() as Record<string, string>[]) {
  console.log(
    `  ${String(row['name']).padEnd(18)}${formatCount(Number(row['files'])).padStart(4)} files  ${formatCount(Number(row['records'])).padStart(11)} rows  ${formatBytes(Number(row['bytes'])).padStart(10)}`,
  );
}
console.log(`  catalog           ${await catalogTableCount()} tables in the "${DUCKLAKE.metadataSchema}" schema in Postgres`);
console.log(`  snapshots         ${await scalar(duck, `SELECT count(*) FROM ${DUCKLAKE.alias}.snapshots()`)}`);

// The property the whole deployment story rests on.
const absolute = await scalar<string>(
  duck,
  `SELECT count(*) FROM ${metadataTable('ducklake_data_file')} WHERE NOT path_is_relative`,
);
console.log(`  paths relative to DATA_PATH: ${absolute === '0' ? 'all of them' : `NO - ${absolute} absolute`}`);

console.log('\nre-attaching the same catalog against an HTTP data path...');
const files = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.duckLake);
await waitForLakeFiles(LAKE_BASE_URL, files);

const overHttp = await connectDuckDB({ extensions: [...DUCKLAKE_EXTENSIONS], disableCaches: true });
await overHttp.run(
  attachDuckLakeSql({
    alias: DUCKLAKE.alias,
    // The same catalog, pointed somewhere else entirely. Nothing was rewritten.
    dataPath: `${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}`,
    metadataSchema: DUCKLAKE.metadataSchema,
    overrideDataPath: true,
    readOnly: true,
  }),
);

const profiler = await createProfiler(overHttp);
const fact = `${DUCKLAKE.alias}.${TABLES.fact}`;
const product = `${DUCKLAKE.alias}.${TABLES.product}`;

console.log(`  DATA_PATH  ${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}/`);
console.log(`  on disk    ${formatBytes(totalBytes(files))} across ${files.length} files`);
console.log(`  star join, all history   ${describe(await profiler.measure(
  `SELECT p.category, sum(f.revenue) FROM ${fact} f JOIN ${product} p ON p.product_key = f.product_key GROUP BY 1`, []))}`);
console.log(`  one month, pruned        ${describe(await profiler.measure(
  `SELECT month, sum(revenue) FROM ${fact} WHERE month = '2025-03' GROUP BY 1`, []))}`);
console.log(`  point lookup by order_id ${describe(await profiler.measure(
  `SELECT count(*) FROM ${fact} WHERE order_id = 250000`, []))}`);

overHttp.disconnectSync();
duck.disconnectSync();

console.log('\nlane C reads this. `pnpm compare` to confirm it still agrees with lane A.');

function describe(summary: { bytesRead: number; filesRead: number; rowsScanned: number }): string {
  return `${formatBytes(summary.bytesRead).padStart(9)}  ${String(summary.filesRead).padStart(3)} files  ${formatCount(summary.rowsScanned).padStart(9)} rows`;
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
