import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import type { DuckDBConnection } from '@duckdb/node-api';

import { formatBytes, formatCount } from './bench/table';
import { PATHS, SLICE } from './config';
import { DEFAULT_PARAMS } from './queries/index';
import { connectDuckDB, scalar } from './duckdb/connect';
import { discoverParquetFiles, totalBytes } from './lake/raw-lake';
import { TABLES } from './queries/dialect';
import { readSqlFile } from './sql-files';

/**
 * `pnpm slice` - builds what the browser downloads into public/slice: partitioned
 * Parquet for lane D, a Postgres data directory for lane E, and a manifest of both.
 *
 * The two hold identical rows, which is what makes lanes D and E a controlled
 * comparison. The row count is not a constant here; it is whatever fits the download
 * budget, found by building and measuring.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

const PARQUET_DIR = join(PATHS.slice, 'parquet');
const PGLITE_FILE = join(PATHS.slice, 'pglite.tar.gz');
const MANIFEST_FILE = join(PATHS.slice, 'manifest.json');

/** Enough attempts to converge from a wild first guess; it normally takes two. */
const MAX_ATTEMPTS = 5;

interface SliceWindow {
  readonly fromDateKey: number;
  readonly toDateKey: number;
}

interface SliceBuild extends SliceWindow {
  readonly rows: Record<string, number>;
  readonly parquetBytes: number;
  readonly pgliteBytes: number;
  readonly files: readonly string[];
}

const duck = await connectDuckDB({ path: PATHS.database });

let targetRows = SLICE.maxRows;
let build: SliceBuild | undefined;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`\nattempt ${attempt}: targeting ${formatCount(targetRows)} fact rows`);
  build = await buildSlice(targetRows);

  const largest = Math.max(build.parquetBytes, build.pgliteBytes);
  console.log(
    `  ${build.fromDateKey} to ${build.toDateKey}: ${formatCount(build.rows[TABLES.fact] ?? 0)} rows` +
      ` -> Parquet ${formatBytes(build.parquetBytes)}, PGlite ${formatBytes(build.pgliteBytes)}`,
  );
  if (largest <= SLICE.budgetBytes) break;

  /*
   * Both artefacts scale close to linearly in rows, so one measurement is enough to
   * aim the next attempt. The 10% of headroom absorbs the part that does not.
   */
  targetRows = Math.floor(targetRows * (SLICE.budgetBytes / largest) * 0.9);
  console.log(`  over the ${formatBytes(SLICE.budgetBytes)} budget, retrying smaller`);
}

if (!build || Math.max(build.parquetBytes, build.pgliteBytes) > SLICE.budgetBytes) {
  throw new Error(`could not fit the slice into ${formatBytes(SLICE.budgetBytes)} in ${MAX_ATTEMPTS} attempts`);
}

/**
 * Fail rather than ship a slice missing the order Q7 asks for: lanes D and E would
 * return nothing, the reference would too, and the page would report agreement on a
 * question neither engine answered.
 */
const q7Rows = Number(
  await scalar(
    duck,
    `SELECT count(*) FROM ${TABLES.fact}
     WHERE date_key BETWEEN ${build.fromDateKey} AND ${build.toDateKey}
       AND order_id = ${DEFAULT_PARAMS.orderId}`,
  ),
);
if (q7Rows === 0) {
  throw new Error(
    `the slice does not contain order ${DEFAULT_PARAMS.orderId}, so the point lookup would be vacuous in the browser`,
  );
}
console.log(`  order ${DEFAULT_PARAMS.orderId} is in the slice (${q7Rows} line items), so Q7 is answerable`);

writeFileSync(
  MANIFEST_FILE,
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      fromDateKey: build.fromDateKey,
      toDateKey: build.toDateKey,
      rows: build.rows,
      parquet: { bytes: build.parquetBytes, files: build.files },
      pglite: { bytes: build.pgliteBytes, file: 'pglite.tar.gz' },
      budgetBytes: SLICE.budgetBytes,
    },
    null,
    2,
  )}\n`,
);

duck.disconnectSync();

console.log('\nrows in the slice');
for (const [table, rows] of Object.entries(build.rows)) {
  console.log(`  ${table.padEnd(18)}${formatCount(rows).padStart(10)}`);
}

console.log('\ndownload per engine, for identical rows');
report('lane D, Parquet', build.parquetBytes);
report('lane E, PGlite', build.pgliteBytes);
console.log(
  `\n  the row store costs ${(build.pgliteBytes / build.parquetBytes).toFixed(1)}x more to ship than the column store,`,
);
console.log(`  before either engine has answered anything.`);
console.log(`\nwrote ${PATHS.slice}`);

// ---------------------------------------------------------------------------

async function buildSlice(maxRows: number): Promise<SliceBuild> {
  rmSync(PATHS.slice, { recursive: true, force: true });
  mkdirSync(PARQUET_DIR, { recursive: true });

  const window = await chooseWindow(duck, maxRows);
  const sources = sliceSources(window);

  await writeParquet(sources);
  await writePgliteDatadir(sources);

  const parquetFiles = discoverParquetFiles(PATHS.slice, 'parquet');
  const rows = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([table, source]) => [
        table,
        Number(await scalar(duck, `SELECT count(*) FROM (${source})`)),
      ]),
    ),
  ) as Record<string, number>;

  return {
    ...window,
    rows,
    parquetBytes: totalBytes(parquetFiles),
    pgliteBytes: statSync(PGLITE_FILE).size,
    files: parquetFiles.map((file) => file.path.replace(/^parquet\//, '')),
  };
}

/**
 * Dimensions are filtered to what the sliced facts reference. Shipping all 240,096
 * customer versions would spend most of the budget on rows no query can reach.
 */
function sliceSources({ fromDateKey, toDateKey }: SliceWindow): Record<string, string> {
  const within = `date_key BETWEEN ${fromDateKey} AND ${toDateKey}`;
  return {
    [TABLES.fact]: `SELECT * FROM ${TABLES.fact} WHERE ${within}`,
    [TABLES.customer]: `SELECT d.* FROM ${TABLES.customer} d
      WHERE d.customer_key IN (SELECT customer_key FROM ${TABLES.fact} WHERE ${within})`,
    [TABLES.product]: `SELECT * FROM ${TABLES.product}`,
    [TABLES.date]: `SELECT * FROM ${TABLES.date} WHERE ${within}`,
  };
}

/**
 * The earliest day, inside the window the questions ask about, that fits the row
 * target.
 *
 * Inside the window because a slice cut from the end of the dataset held no rows for
 * the default range, so lanes D and E agreed perfectly while both returned nothing.
 * Whole days rather than whole months because a month is 40,000 rows at 1M and
 * 400,000 at 10M, which would blow the budget as the dataset grows.
 */
async function chooseWindow(connection: DuckDBConnection, maxRows: number): Promise<SliceWindow> {
  const inWindow = `order_ts >= TIMESTAMPTZ '${DEFAULT_PARAMS.from}'
                AND order_ts <  TIMESTAMPTZ '${DEFAULT_PARAMS.to}'`;

  const toDateKey = Number(
    await scalar(connection, `SELECT max(date_key) FROM ${TABLES.fact} WHERE ${inWindow}`),
  );

  const cutoff = await scalar<string | null>(connection, `
    WITH daily AS (
      SELECT date_key, count(*) AS rows FROM ${TABLES.fact} WHERE ${inWindow} GROUP BY date_key
    ),
    running AS (
      SELECT date_key, sum(rows) OVER (ORDER BY date_key DESC) AS total FROM daily
    )
    SELECT min(date_key) FROM running WHERE total <= ${maxRows}
  `);

  /*
   * A single day over the target leaves nothing selectable; take the last day of the
   * window anyway and let the budget check decide whether the result is publishable.
   */
  return { fromDateKey: cutoff === null ? toDateKey : Number(cutoff), toDateKey };
}

async function writeParquet(sources: Record<string, string>): Promise<void> {
  for (const [table, source] of Object.entries(sources)) {
    if (table === TABLES.fact) {
      // Monthly partitions kept so lane D prunes in the browser as lane C does.
      await duck.run(
        `COPY (${source}) TO '${join(PARQUET_DIR, table)}'
         (FORMAT parquet, PARTITION_BY month, COMPRESSION zstd, OVERWRITE_OR_IGNORE)`,
      );
    } else {
      await duck.run(
        `COPY (${source}) TO '${join(PARQUET_DIR, `${table}.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`,
      );
    }
  }
}

/**
 * A ready-to-load Postgres data directory, built here because `COPY` inside PGlite
 * over a quarter of a million rows takes minutes.
 *
 * Lane E gets lane A's indexes and statistics. They cost download size, and dropping
 * them to save it would make lane E a straw man rather than a baseline.
 */
async function writePgliteDatadir(sources: Record<string, string>): Promise<void> {
  const pglite = new PGlite();
  await pglite.exec(readSqlFile('03_star.postgres.sql'));

  // Dimensions before the fact: the fact's REFERENCES constraints point at them.
  for (const table of [TABLES.date, TABLES.customer, TABLES.product, TABLES.fact]) {
    // `month` lives only in the lake copy; the Postgres schema derives it.
    const columns = table === TABLES.fact ? 'SELECT * EXCLUDE (month)' : 'SELECT *';
    await copyIntoPglite(pglite, table, `${columns} FROM (${sources[table]})`);
  }

  await pglite.exec(readSqlFile('04_tune_star.postgres.sql'));

  const dump = await pglite.dumpDataDir('gzip');
  writeFileSync(PGLITE_FILE, Buffer.from(await dump.arrayBuffer()));
  await pglite.close();
}

/** Streams one table through CSV, the fastest bulk path PGlite offers. */
async function copyIntoPglite(pglite: PGlite, table: string, select: string): Promise<void> {
  const csvPath = join(PATHS.slice, `${table}.csv`);
  await duck.run(`COPY (${select}) TO '${csvPath}' (FORMAT csv, HEADER false)`);

  const blob = new Blob([readFileSync(csvPath)]);
  await pglite.query(`COPY ${table} FROM '/dev/blob' WITH (FORMAT csv)`, [], { blob });
  rmSync(csvPath);
}

function report(label: string, bytes: number): void {
  const share = ((bytes / SLICE.budgetBytes) * 100).toFixed(0);
  console.log(`  ${label.padEnd(18)}${formatBytes(bytes).padStart(10)}  ${share.padStart(3)}% of the 25 MB budget`);
}
