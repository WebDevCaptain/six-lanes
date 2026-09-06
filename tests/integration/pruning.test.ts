import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';

import { LAKE_BASE_URL, LAKE_DIRS, PATHS } from '../../src/config';
import { connectDuckDB } from '../../src/duckdb/connect';
import { createProfiler, type DuckDBProfiler } from '../../src/duckdb/profile';
import { discoverParquetFiles, parquetRelation, totalBytes } from '../../src/lake/raw-lake';

/**
 * The physics claims, measured against the real lake.
 *
 * Each of these is a sentence the README is allowed to say only because this file
 * checks it: pruning happens, it happens through a view, and the bytes move.
 */
let connection: DuckDBConnection;
let profiler: DuckDBProfiler;
let lakeBytes: number;
let partitionCount: number;

beforeAll(async () => {
  const partitions = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw);
  lakeBytes = totalBytes(partitions);
  partitionCount = partitions.length;

  connection = await connectDuckDB({ extensions: ['httpfs'], disableCaches: true });
  await connection.run(
    `CREATE OR REPLACE VIEW lake_orders AS SELECT * FROM ${parquetRelation(LAKE_BASE_URL, partitions)}`,
  );
  profiler = await createProfiler(connection);
});

afterAll(() => connection.disconnectSync());

describe('column pruning', () => {
  it('reads a small fraction of the lake for a two-column aggregate', async () => {
    const summary = await profiler.measure(
      'SELECT category, sum(revenue) FROM lake_orders GROUP BY 1',
      [],
    );
    expect(summary.columnsProjected).toEqual(['category', 'revenue']);
    expect(summary.bytesRead).toBeLessThan(lakeBytes * 0.35);
  });

  it('reads strictly more when the query asks for more columns', async () => {
    const two = await profiler.measure('SELECT category, sum(revenue) FROM lake_orders GROUP BY 1', []);
    const four = await profiler.measure(
      'SELECT category, sum(revenue), sum(cost), sum(quantity) FROM lake_orders GROUP BY 1',
      [],
    );
    expect(four.bytesRead).toBeGreaterThan(two.bytesRead);
    expect(four.columnsProjected).toEqual(['category', 'cost', 'quantity', 'revenue']);
  });
});

describe('partition pruning', () => {
  it('opens one file of twenty-four when the filter names one month', async () => {
    const summary = await profiler.measure(
      `SELECT month, sum(revenue) FROM lake_orders WHERE month = '2025-03' GROUP BY 1`,
      [],
    );
    expect(summary.filesRead).toBe(1);
    expect(partitionCount).toBeGreaterThan(20);
  });

  it('opens every file when the filter is on a column that is not the partition key', async () => {
    const summary = await profiler.measure(
      `SELECT count(*) FROM lake_orders WHERE channel = 'store'`,
      [],
    );
    expect(summary.filesRead).toBe(partitionCount);
  });

  it('reads far fewer bytes with the partition predicate than without it', async () => {
    const pruned = await profiler.measure(
      `SELECT sum(revenue) FROM lake_orders WHERE month = '2025-03'`,
      [],
    );
    const unpruned = await profiler.measure(`SELECT sum(revenue) FROM lake_orders`, []);
    expect(pruned.bytesRead * 5).toBeLessThan(unpruned.bytesRead);
  });
});

describe('the lake_orders view', () => {
  it('does not block pruning, which is the only reason it is allowed to exist', async () => {
    const throughView = await profiler.measure(
      `SELECT month, sum(revenue) FROM lake_orders WHERE month = '2025-03' GROUP BY 1`,
      [],
    );
    const direct = await profiler.measure(
      `SELECT month, sum(revenue) FROM ${parquetRelation(
        LAKE_BASE_URL,
        discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw),
      )} WHERE month = '2025-03' GROUP BY 1`,
      [],
    );
    expect(throughView.filesRead).toBe(direct.filesRead);
    expect(throughView.bytesRead).toBe(direct.bytesRead);
    expect(throughView.columnsProjected).toEqual(direct.columnsProjected);
  });
});

describe('row group statistics', () => {
  it('skips almost the whole lake for a point lookup on a clustered column', async () => {
    /*
     * order_id rises with order_ts and the lake is written in time order, so each row
     * group's min/max excludes almost every id. That is why lane C loses Q7 by a
     * factor of ten rather than a thousand.
     */
    const summary = await profiler.measure('SELECT * FROM lake_orders WHERE order_id = 250000', []);
    expect(summary.rowsScanned).toBeLessThan(1000);
    expect(summary.bytesRead).toBeLessThan(lakeBytes * 0.15);
  });
});

describe('the lake as served', () => {
  it('answers range requests with 206 and a Content-Range', async () => {
    const partitions = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw);
    const response = await fetch(`${LAKE_BASE_URL}/${partitions[0]!.path}`, {
      headers: { Range: 'bytes=0-127', Origin: 'https://example.com' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-127\//);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toBe('*');
  });
});
