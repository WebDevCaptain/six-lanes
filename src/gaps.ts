import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

import { formatMs } from './bench/table';
import { PATHS, POSTGRES_URL } from './config';
import { connectDuckDB, scalar } from './duckdb/connect';
import { attachDuckLakeSql, metadataTable } from './lake/ducklake';
import { discoverParquetFiles } from './lake/raw-lake';

/**
 * `pnpm gaps` - the six things raw Parquet cannot do, demonstrated, then done.
 *
 * Plan section 6 lists them in a table. A table is easy to nod along to and hard to
 * believe, so this script reproduces each one against a real lake and prints what
 * actually happened, then does the same six things through DuckLake and prints that.
 *
 * Everything runs against a scratch lake under lake/gaps/ and a scratch catalog
 * schema, so it never touches the lake the lanes read.
 */

const SCRATCH = join(PATHS.lakeRoot, 'gaps');
const RAW_DIR = join(SCRATCH, 'raw');
const LAKE_DIR = join(SCRATCH, 'ducklake');
const ALIAS = 'gaps';
const SCHEMA = 'ducklake_gaps';
const MONTHS = ['2025-01', '2025-02', '2025-03'] as const;

if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(RAW_DIR, { recursive: true });

const admin = new pg.Client({ connectionString: POSTGRES_URL });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.end();

// Caches off throughout: these demonstrations change files on disk between queries,
// and a cached read would show the old bytes and hide the very thing being shown.
const duck = await connectDuckDB({
  path: PATHS.database,
  extensions: ['ducklake', 'postgres'],
  disableCaches: true,
});

const RAW = `read_parquet('${RAW_DIR}/**/*.parquet', hive_partitioning = true)`;
const sourceFor = (month: string): string =>
  `SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders WHERE strftime(order_ts, '%Y-%m') = '${month}'`;

/** The same three months, as one relation. */
const monthsSource = `SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders
  WHERE strftime(order_ts, '%Y-%m') IN (${MONTHS.map((m) => `'${m}'`).join(', ')})`;

await writeRawMonths();

section('Generation 1: raw Hive-partitioned Parquet');
console.log(`  ${MONTHS.length} monthly partitions at lake/gaps/raw, ${await rawState()}`);

section('Gap 1 - no ACID: a reader sees a state that never existed');

const partition = discoverParquetFiles(PATHS.lakeRoot, 'gaps/raw')[1]!;
const partitionPath = join(PATHS.lakeRoot, partition.path);
const parked = `${partitionPath}.writing`;

console.log(`  before                    ${await rawState()}`);
renameSync(partitionPath, parked);
console.log(`  writer has the file open  ${await rawState()}   <- no error, just a wrong answer`);
renameSync(parked, partitionPath);
console.log(`  after                     ${await rawState()}`);
console.log(`
  Replacing a partition is delete-then-write, and a reader that arrives in between
  gets a smaller number with no indication anything is wrong. There is no isolation
  because there is nothing to isolate with: the filesystem is the only source of
  truth and it has no notion of a transaction.`);

section('Gap 2 - no atomic multi-partition change: a backfill is visible in stages');

console.log(`  before the backfill       ${await rawState()}`);
for (const month of MONTHS) {
  await writeRawMonth(month, `SELECT * REPLACE (revenue * 1.10 AS revenue) FROM (${sourceFor(month)})`);
  console.log(`  after rewriting ${month}   ${await rawState()}`);
}
console.log(`
  Four totals, and the three in the middle are answers to a question nobody asked:
  some months repriced, some not. A backfill that spans partitions cannot be made
  atomic when each partition is an independent file.`);

section('Gap 3 - no schema evolution: adding a column breaks nothing, which is worse');

await writeRawMonth(
  MONTHS[0],
  `SELECT *, (revenue - cost) AS margin FROM (${sourceFor(MONTHS[0])})`,
);
console.log(`  added a margin column to ${MONTHS[0]} only - the other two are unchanged`);
console.log(`  querying the old columns  ${await attempt(() => rawState())}`);
console.log(
  `  querying the new column   ${await attempt(async () =>
    scalar(duck, `SELECT count(margin) || ' rows have a margin' FROM ${RAW}`),
  )}`,
);
console.log(
  `  with union_by_name=true   ${await attempt(async () =>
    scalar(duck, `SELECT count(*) || ' rows, ' || count(margin) || ' with a margin'
                  FROM read_parquet('${RAW_DIR}/**/*.parquet', union_by_name = true)`),
  )}`,
);
console.log(`
  Worse than an outage: nothing breaks. Queries that touch only the old columns keep
  working, because column pruning means they never look at the part of the schema
  that disagrees. The lake is inconsistent and every dashboard says it is fine.

  The failure only surfaces when someone asks for the new column, which will be days
  later and in a query nobody connects to the write that caused it. union_by_name
  papers over it by filling NULL for the files that predate the column - so now the
  new column silently reads as "no margin" for two thirds of the data, and you cannot
  tell that apart from a real NULL.`);

section('Gap 4 - no history: the previous version is bytes that no longer exist');

console.log(`  current                   ${await attempt(() => rawState())}`);
console.log(`  as of before the backfill  no such thing`);
console.log(`
  The backfill in gap 2 overwrote three files. The rows that were in them are gone -
  not archived, not superseded, gone. "What did this table say yesterday" is not a
  hard question here, it is an unanswerable one.`);

section('Gap 5 - no catalog: something has to know which files there are');

const walkStart = performance.now();
const discovered = discoverParquetFiles(PATHS.lakeRoot, 'gaps/raw');
console.log(`  directory walk found ${discovered.length} files in ${formatMs(performance.now() - walkStart)}`);
console.log(
  `  the same over HTTP        ${await attempt(async () =>
    scalar(duck, `SELECT count(*) FROM read_parquet('http://localhost:8080/gaps/raw/**/*.parquet')`),
  )}`,
);
console.log(`
  httpfs cannot list a remote directory, so a lake on object storage cannot even be
  globbed. The file list has to be produced somewhere with a filesystem and carried
  to the reader - which is a catalog, just a hand-rolled one that is stale the moment
  a writer starts.`);

// ---------------------------------------------------------------------------

section('Generation 2: the same six situations, through DuckLake');

rmSync(RAW_DIR, { recursive: true, force: true });
mkdirSync(LAKE_DIR, { recursive: true });

await duck.run(
  attachDuckLakeSql({ alias: ALIAS, dataPath: LAKE_DIR, metadataSchema: SCHEMA }),
);
await duck.run(`CALL ducklake_set_option('${ALIAS}', 'parquet_compression', 'zstd')`);
await duck.run(`CREATE TABLE ${ALIAS}.orders AS ${monthsSource} LIMIT 0`);
await duck.run(`ALTER TABLE ${ALIAS}.orders SET PARTITIONED BY (month)`);
await duck.run(`INSERT INTO ${ALIAS}.orders ${monthsSource}`);

function lakeState(): Promise<string> {
  return state(`${ALIAS}.orders`);
}
console.log(`  loaded                    ${await lakeState()}`);

section('Gap 1 closed - ACID: a rolled back change was never visible');

await duck.run('BEGIN TRANSACTION');
await duck.run(`DELETE FROM ${ALIAS}.orders WHERE month = '${MONTHS[1]}'`);
console.log(`  inside the transaction    ${await lakeState()}`);
await duck.run('ROLLBACK');
console.log(`  after rollback            ${await lakeState()}`);

section('Gap 2 closed - one atomic commit across three partitions');

const beforeBackfill = await snapshotId();
await duck.run('BEGIN TRANSACTION');
for (const month of MONTHS) {
  await duck.run(`UPDATE ${ALIAS}.orders SET revenue = revenue * 1.10 WHERE month = '${month}'`);
}
await duck.run('COMMIT');
console.log(`  after the backfill        ${await lakeState()}`);
console.log(`  snapshots created         1 (was ${beforeBackfill}, now ${await snapshotId()})`);
console.log(`
  Three partitions rewritten, one snapshot. There is no moment at which a reader
  could see two of the three repriced.`);

section('Gap 3 closed - schema evolution, without touching the old files');

await duck.run(`ALTER TABLE ${ALIAS}.orders ADD COLUMN margin DECIMAL(12,2)`);
await duck.run(`UPDATE ${ALIAS}.orders SET margin = revenue - cost WHERE month = '${MONTHS[0]}'`);
console.log(`  after ADD COLUMN          ${await lakeState()}`);
console.log(
  `  margin populated          ${await scalar(duck, `SELECT count(margin) FROM ${ALIAS}.orders`)} rows`,
);
console.log(`
  Every reader keeps working. The catalog records which columns existed at which
  schema version, so a file written before the column was added is read as NULL for
  it without anyone reconciling schemas at query time.`);

section('Gap 4 closed - time travel');

const now = await snapshotId();
console.log(`  current, snapshot ${now}      ${await lakeState()}`);
console.log(`  before the backfill       ${await state(`${ALIAS}.orders AT (VERSION => ${beforeBackfill})`)}`);
console.log(`
  Same table, two points in time, one query apart. Note that snapshot N is the state
  *after* operation N, so the state before a change is version N-1.`);

const snapshots = await duck.runAndReadAll(
  `SELECT snapshot_id, schema_version FROM ${ALIAS}.snapshots() ORDER BY snapshot_id`,
);
console.log(`  snapshots on record: ${snapshots.getRowsJson().map(([id, v]) => `${id}(schema ${v})`).join(' ')}`);

section('Gap 5 closed - the catalog answers "which files", with statistics');

const catalogStart = performance.now();
const files = await duck.runAndReadAll(`
  SELECT f.path, f.record_count, s.min_value, s.max_value
  FROM ${metadataTable('ducklake_data_file', ALIAS, SCHEMA)} f
  JOIN ${metadataTable('ducklake_file_column_stats', ALIAS, SCHEMA)} s
    ON s.data_file_id = f.data_file_id
  JOIN ${metadataTable('ducklake_column', ALIAS, SCHEMA)} c
    ON c.column_id = s.column_id AND c.table_id = f.table_id AND c.column_name = 'order_ts'
  WHERE f.end_snapshot IS NULL
  ORDER BY s.min_value
`);
const catalogMs = performance.now() - catalogStart;

console.log(`  one metadata query returned ${files.getRowObjectsJson().length} live files in ${formatMs(catalogMs)}`);
for (const row of files.getRowObjectsJson() as Record<string, string>[]) {
  console.log(
    `    ${String(row['path']).split('/').pop()!.slice(0, 28)}...  ${String(row['record_count']).padStart(6)} rows  order_ts ${row['min_value']} .. ${row['max_value']}`,
  );
}
console.log(`
  Min and max per column per file, in Postgres, queryable before a single byte of
  Parquet is touched. That is how lane C answers a point lookup by opening one file
  of twenty-four instead of reading twenty-four footers to find out.`);

section('Gap 6 closed - planning does not walk anything');

console.log(`  generation 1: a directory walk, O(files), impossible over HTTP`);
console.log(`  generation 2: one indexed query against Postgres, ${formatMs(catalogMs)} here`);
console.log(`
  The difference is not the milliseconds at three files, it is the shape. A walk grows
  with the number of files and needs a filesystem; a catalog query grows with the
  number of files that *match* and needs a network socket.`);

duck.disconnectSync();
rmSync(SCRATCH, { recursive: true, force: true });

const cleanup = new pg.Client({ connectionString: POSTGRES_URL });
await cleanup.connect();
await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await cleanup.end();

console.log('\nscratch lake and scratch catalog removed.');

// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log(`\n${'-'.repeat(78)}\n${title}\n`);
}

async function writeRawMonths(): Promise<void> {
  for (const month of MONTHS) await writeRawMonth(month, sourceFor(month));
}

async function writeRawMonth(month: string, source: string): Promise<void> {
  const directory = join(RAW_DIR, `month=${month}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  await duck.run(
    `COPY (SELECT * EXCLUDE (month) FROM (${source})) TO '${join(directory, 'data.parquet')}' (FORMAT parquet, COMPRESSION zstd)`,
  );
}

function rawState(): Promise<string> {
  return state(RAW);
}

async function state(relation: string): Promise<string> {
  const value = await scalar<string>(
    duck,
    `SELECT count(*) || ' rows, revenue ' || round(sum(revenue), 2) FROM ${relation}`,
  );
  return value;
}

async function snapshotId(): Promise<number> {
  return Number(await scalar(duck, `SELECT max(snapshot_id) FROM ${ALIAS}.snapshots()`));
}

/** Runs something that is expected to fail, and reports how. */
async function attempt(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (error) {
    return `FAILED: ${(error as Error).message.split('\n')[0]}`;
  }
}
