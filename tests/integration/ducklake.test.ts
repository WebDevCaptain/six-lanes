import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';

import { LAKE_BASE_URL, LAKE_DIRS, PATHS } from '../../src/config';
import { connectDuckDB, scalar } from '../../src/duckdb/connect';
import { createProfiler, type DuckDBProfiler } from '../../src/duckdb/profile';
import {
  DUCKLAKE,
  DUCKLAKE_EXTENSIONS,
  attachDuckLakeSql,
  metadataTable,
} from '../../src/lake/ducklake';
import { TABLES } from '../../src/queries/dialect';
import { discoverParquetFiles } from '../../src/lake/raw-lake';

const FACT = `${DUCKLAKE.alias}.${TABLES.fact}`;
const PRODUCT = `${DUCKLAKE.alias}.${TABLES.product}`;

/**
 * What the catalog buys, asserted.
 *
 * Needs `pnpm ducklake` to have run. The portability test is the important one: the
 * entire deployment story is that a lake written to a local directory can be read
 * from a URL without rewriting anything, and if that is not true the project has no
 * hosting plan.
 */
let local: DuckDBConnection;
let remote: DuckDBConnection;
let profiler: DuckDBProfiler;

beforeAll(async () => {
  local = await connectDuckDB({ extensions: [...DUCKLAKE_EXTENSIONS] });
  await local.run(
    attachDuckLakeSql({
      alias: DUCKLAKE.alias,
      dataPath: PATHS.duckLake,
      metadataSchema: DUCKLAKE.metadataSchema,
    }),
  );

  remote = await connectDuckDB({ extensions: [...DUCKLAKE_EXTENSIONS], disableCaches: true });
  await remote.run(
    attachDuckLakeSql({
      alias: DUCKLAKE.alias,
      dataPath: `${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}`,
      metadataSchema: DUCKLAKE.metadataSchema,
      overrideDataPath: true,
      readOnly: true,
    }),
  );
  profiler = await createProfiler(remote);
});

afterAll(() => {
  local.disconnectSync();
  remote.disconnectSync();
});

describe('the catalog', () => {
  it('knows every file in the table', async () => {
    const onDisk = discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.duckLake).length;
    const inCatalog = await scalar<string>(
      local,
      `SELECT count(*) FROM ${metadataTable('ducklake_data_file')} WHERE end_snapshot IS NULL`,
    );
    expect(Number(inCatalog)).toBe(onDisk);
  });

  it('stores every path relative to DATA_PATH, which is what makes the lake portable', async () => {
    const absolute = await scalar<string>(
      local,
      `SELECT count(*) FROM ${metadataTable('ducklake_data_file')} WHERE NOT path_is_relative`,
    );
    expect(absolute).toBe('0');
  });

  it('holds min/max statistics per column per file', async () => {
    const stats = await scalar<string>(
      local,
      `SELECT count(*) FROM ${metadataTable('ducklake_file_column_stats')}
       WHERE min_value IS NOT NULL AND max_value IS NOT NULL`,
    );
    expect(Number(stats)).toBeGreaterThan(0);
  });
});

describe('reading the lake from somewhere it was never written', () => {
  it('answers the same question over HTTP as it does on disk', async () => {
    const query = `SELECT p.category, sum(f.revenue) AS revenue
                   FROM ${FACT} f JOIN ${PRODUCT} p ON p.product_key = f.product_key
                   GROUP BY 1 ORDER BY 1`;
    const fromDisk = (await local.runAndReadAll(query)).getRowObjectsJson();
    const fromHttp = (await remote.runAndReadAll(query)).getRowObjectsJson();

    expect(fromHttp).toEqual(fromDisk);
    expect(fromHttp.length).toBe(8);
  });

  it('prunes to one file for one month, using catalog statistics', async () => {
    const summary = await profiler.measure(
      `SELECT sum(revenue) FROM ${FACT} WHERE month = '2025-03'`,
      [],
    );
    expect(summary.filesRead).toBe(1);
  });

  it('prunes on a clustered column the lake is not partitioned by', async () => {
    // order_id is not the partition key. The catalog's per-file min/max on it still
    // eliminates 23 of 24 files, and does so before opening a single Parquet footer.
    const summary = await profiler.measure(
      `SELECT count(*) FROM ${FACT} WHERE order_id = 250000`,
      [],
    );
    expect(summary.filesRead).toBe(1);
  });
});

describe('time travel', () => {
  it('answers as of an older snapshot', async () => {
    const snapshots = await local.runAndReadAll(
      `SELECT snapshot_id FROM ${DUCKLAKE.alias}.snapshots() ORDER BY snapshot_id`,
    );
    const ids = snapshots.getRowsJson().map(([id]) => Number(id));
    expect(ids.length).toBeGreaterThan(1);

    const current = await scalar<string>(local, `SELECT count(*) FROM ${FACT}`);
    const empty = await scalar<string>(
      local,
      // Snapshot N is the state *after* operation N. The table is created empty and
      // filled by a later insert, so an early version has no rows in it.
      `SELECT count(*) FROM ${FACT} AT (VERSION => ${ids[1]})`,
    );

    expect(Number(current)).toBeGreaterThan(0);
    expect(Number(empty)).toBeLessThan(Number(current));
  });
});
