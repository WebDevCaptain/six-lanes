import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { DATASET, PATHS } from './config';
import { contentFingerprint } from './data/fingerprint';
import { generateDataset } from './data/generator';
import { ingestOrders } from './data/ingest';
import { buildStar } from './data/star';
import { connectDuckDB } from './duckdb/connect';
import { readSqlFile } from './sql-files';

/**
 * `pnpm generate` - builds the canonical dataset at data/olap.duckdb.
 *
 * The DuckDB file is the single source of truth for every downstream artefact: the
 * Parquet lake, the Postgres heap and the browser slice are all projections of it.
 * Generating once and projecting many times is what makes the lanes comparable;
 * six engines loaded from six generator runs would be six different datasets.
 */
const started = performance.now();

rmSync(PATHS.database, { force: true });
rmSync(`${PATHS.database}.wal`, { force: true });
mkdirSync(dirname(PATHS.database), { recursive: true });

const connection = await connectDuckDB({ path: PATHS.database });
await connection.run(readSqlFile('01_schema.duckdb.sql'));

const rows = await ingestOrders(connection, generateDataset(DATASET), (soFar) => {
  process.stdout.write(`\r  generating ${soFar.toLocaleString()} rows...`);
});
process.stdout.write(`\r${' '.repeat(40)}\r`);

const fingerprint = await contentFingerprint(connection);

process.stdout.write('  building the star...');
const star = await buildStar(connection, DATASET);
process.stdout.write(`\r${' '.repeat(40)}\r`);

connection.disconnectSync();

console.log(`generated ${rows.toLocaleString()} line items in ${elapsed()}`);
console.log(`  seed         ${DATASET.seed}`);
console.log(`  span         ${DATASET.startDate} to ${DATASET.endDate} (exclusive)`);
console.log(`  orders       ${fingerprint.orders.toLocaleString()}`);
console.log(`  customers    ${fingerprint.customers.toLocaleString()} of ${DATASET.customers.toLocaleString()}`);
console.log(`  products     ${fingerprint.products.toLocaleString()} of ${DATASET.products.toLocaleString()}`);
console.log(`  revenue      ${fingerprint.revenue}`);
console.log(`  returns      ${(fingerprint.returnRate * 100).toFixed(2)}% of line items`);
console.log(`  fingerprint  ${fingerprint.checksum}`);
console.log(`\nstar schema`);
console.log(`  dim_date      ${star.dates.toLocaleString()} days`);
console.log(`  dim_customer  ${star.customerVersions.toLocaleString()} versions of ${star.customers.toLocaleString()} customers (SCD2)`);
console.log(`  dim_product   ${star.products.toLocaleString()} products`);
console.log(`  fact          ${star.facts.toLocaleString()} line items`);
console.log(`\nwrote ${PATHS.database}`);

function elapsed(): string {
  return `${((performance.now() - started) / 1000).toFixed(2)}s`;
}
