import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { DATASET, PATHS } from './config.js';
import { contentFingerprint } from './data/fingerprint.js';
import { generateDataset } from './data/generator.js';
import { ingestOrders } from './data/ingest.js';
import { connectDuckDB } from './duckdb/connect.js';
import { readSqlFile } from './sql-files.js';

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
console.log(`\nwrote ${PATHS.database}`);

function elapsed(): string {
  return `${((performance.now() - started) / 1000).toFixed(2)}s`;
}
