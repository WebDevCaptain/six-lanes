import { existsSync, rmSync } from 'node:fs';

import { formatBytes, formatMs } from './bench/table';
import { DATASET, LAKE_DIRS, PATHS, PGDUCKDB_URL, POSTGRES_URL } from './config';
import { connectDuckDB } from './duckdb/connect';
import { discoverParquetFiles, totalBytes } from './lake/raw-lake';
import { describeLoad, isReachable, loadStar } from './postgres/load-star';
import { DEFAULT_PARAMS } from './queries/index';
import { scalar } from './duckdb/connect';

/**
 * `pnpm load` - projects data/olap.duckdb into the Postgres star (lane A, and the
 * host of DuckLake's catalog), into pg_duckdb when that container is up, and into
 * generation 1 of the lake. `pnpm ducklake` builds generation 2, which needs
 * Postgres to exist first.
 *
 * The raw lake is written from the flat `orders` table rather than the fact table:
 * it is the Day 1 and Day 2 artefact, and rewriting it would invalidate every
 * layout-study number in docs/results.md.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

const duck = await connectDuckDB({ path: PATHS.database, extensions: ['postgres'] });

/*
 * Q7 asks for one specific order id. Below roughly 430,000 line items that order does
 * not exist, every lane returns nothing, and they all agree on it - a pass that looks
 * exactly like success. Checked before anything is loaded rather than discovered in a
 * table of empty results.
 */
const q7Rows = Number(
  await scalar(duck, `SELECT count(*) FROM fact_order_item WHERE order_id = ${DEFAULT_PARAMS.orderId}`),
);
if (q7Rows === 0) {
  throw new Error(
    `order ${DEFAULT_PARAMS.orderId} does not exist at ${DATASET.orderItems.toLocaleString('en-US')} rows, ` +
      `so the point lookup would be vacuous. Raise OLAP_ROWS and regenerate.`,
  );
}

console.log('writing the raw Parquet lake (generation 1)...');
const lakeMs = await time(async () => {
  /*
   * Removed rather than overwritten: OVERWRITE_OR_IGNORE replaces the partitions it
   * is given and silently keeps any it is not, so a smaller regeneration would read
   * as the union of two datasets.
   */
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

/*
 * Lane F is optional; the rest of the project works without its container. Loading it
 * here rather than from a separate script is what guarantees both instances hold
 * byte-identical rows.
 */
if (await isReachable(PGDUCKDB_URL)) {
  console.log('\nloading the same star into pg_duckdb (lane F)...');
  console.log(describeLoad(await loadStar(duck, PGDUCKDB_URL, 'pgd')));
} else {
  console.log('\nlane F skipped: pg_duckdb is not running (`pnpm services:pgduckdb`)');
}

duck.disconnectSync();

console.log('\nnext: `pnpm ducklake` to build generation 2, then `pnpm compare`');

async function time(fn: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  await fn();
  return formatMs(performance.now() - started);
}
