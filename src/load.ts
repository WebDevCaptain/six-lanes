import { existsSync, rmSync } from 'node:fs';

import { formatBytes, formatMs } from './bench/table';
import { LAKE_DIRS, PATHS, PGDUCKDB_URL, POSTGRES_URL } from './config';
import { connectDuckDB } from './duckdb/connect';
import { discoverParquetFiles, totalBytes } from './lake/raw-lake';
import { describeLoad, isReachable, loadStar } from './postgres/load-star';

/**
 * `pnpm load` - projects data/olap.duckdb into the stores the lanes read.
 *
 *   Postgres        the star schema: lane A, and the host of DuckLake's catalog
 *   pg_duckdb       the same star again, for lane F, when that container is running
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

console.log('loading the star into Postgres (lane A)...');
console.log(describeLoad(await loadStar(duck, POSTGRES_URL, 'pg')));

// Lane F is optional: it needs a container that cannot be deployed anywhere, so the
// rest of the project has to work without it. Loading it here rather than in a
// separate script is what guarantees both instances hold byte-identical rows.
if (await isReachable(PGDUCKDB_URL)) {
  console.log('\nloading the same star into pg_duckdb (lane F)...');
  console.log(describeLoad(await loadStar(duck, PGDUCKDB_URL, 'pgd')));
} else {
  console.log('\nlane F skipped: pg_duckdb is not running (`pnpm up:pgduckdb`)');
}

duck.disconnectSync();

console.log('\nnext: `pnpm ducklake` to build generation 2, then `pnpm compare`');

async function time(fn: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  await fn();
  return formatMs(performance.now() - started);
}
