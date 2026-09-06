import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import pg from 'pg';

import { POSTGRES_URL } from '../../src/config';
import { connectDuckDB } from '../../src/duckdb/connect';

/**
 * Postgres and DuckDB must agree which month a row belongs to. They do not by
 * default: DuckDB takes its timezone from the host, so east of Greenwich an evening
 * order in February is reported as March.
 *
 * Worth testing because the failure is silent, machine-dependent, and touches only
 * rows near a month boundary: it passes review and passes on a CI runner in UTC.
 */
const LATE_FEBRUARY = `TIMESTAMPTZ '2025-02-28 19:00:00+00'`;

let duck: DuckDBConnection;
let client: pg.Client;

beforeAll(async () => {
  duck = await connectDuckDB({});
  client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();
  await client.query(`SET TimeZone = 'UTC'`);
});

afterAll(async () => {
  duck.disconnectSync();
  await client.end();
});

describe('connectDuckDB', () => {
  it('reports UTC as the session timezone', async () => {
    const result = await duck.runAndReadAll(`SELECT current_setting('TimeZone') AS tz`);
    expect(result.getRowsJson()[0]![0]).toBe('UTC');
  });

  it('puts a 19:00 UTC order on 28 February into February', async () => {
    const result = await duck.runAndReadAll(`SELECT strftime(${LATE_FEBRUARY}, '%Y-%m') AS month`);
    expect(result.getRowsJson()[0]![0]).toBe('2025-02');
  });

  it('truncates to the UTC month boundary', async () => {
    const result = await duck.runAndReadAll(
      `SELECT date_trunc('month', ${LATE_FEBRUARY}) = TIMESTAMPTZ '2025-02-01 00:00:00+00' AS ok`,
    );
    expect(result.getRowsJson()[0]![0]).toBe(true);
  });
});

describe('an unconfigured DuckDB', () => {
  it('is what this guards against: it may disagree, depending on the host', async () => {
    // Not that the bare connection is wrong; in UTC it is right. That ours is not.
    const bare = await (await DuckDBInstance.create(':memory:')).connect();
    const naive = (await bare.runAndReadAll(`SELECT strftime(${LATE_FEBRUARY}, '%Y-%m') AS m`)).getRowsJson()[0]![0];
    const configured = (await duck.runAndReadAll(`SELECT strftime(${LATE_FEBRUARY}, '%Y-%m') AS m`)).getRowsJson()[0]![0];

    expect(configured).toBe('2025-02');
    if (naive !== '2025-02') {
      expect(process.env['TZ']).not.toBe('UTC');
    }
    bare.disconnectSync();
  });
});

describe('Postgres and DuckDB', () => {
  it('agree on the month of every row in the dataset', async () => {
    // Every month boundary in 24 months of real data, counted both ways.
    const fromPostgres = await client.query<{ month: string; n: string }>(`
      SELECT to_char(order_ts AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*)::text AS n
      FROM fact_order_item GROUP BY 1 ORDER BY 1
    `);
    const fromDuckDB = await duck.runAndReadAll(`
      SELECT strftime(order_ts, '%Y-%m') AS month, count(*)::VARCHAR AS n
      FROM read_parquet('${process.cwd()}/lake/raw/**/*.parquet') GROUP BY 1 ORDER BY 1
    `);

    expect(fromDuckDB.getRowObjectsJson()).toEqual(
      fromPostgres.rows.map((row) => ({ month: row.month, n: row.n })),
    );
  });

  it('agree on the Hive partition each row was written to', async () => {
    // The computed month must match the path, or pruning skips matching rows.
    const mismatches = await duck.runAndReadAll(`
      SELECT count(*) AS n
      FROM read_parquet('${process.cwd()}/lake/raw/**/*.parquet', hive_partitioning = true)
      WHERE month <> strftime(order_ts, '%Y-%m')
    `);
    expect(mismatches.getRowsJson()[0]![0]).toBe('0');
  });
});
