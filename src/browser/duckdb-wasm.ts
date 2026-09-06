import * as duckdb from '@duckdb/duckdb-wasm';

import { createLane, type LaneSpec } from '../lanes/create-lane';
import { LANE_META } from '../lanes/meta';
import type { Lane } from '../types';
import { arrowRows } from './arrow';
import { SLICE_BASE, transferred, type Preparation, type SliceManifest } from './slice';

/**
 * Lane D - DuckDB compiled to WebAssembly, reading Parquet over HTTP range requests.
 *
 * No server is involved in answering the query. The page fetches byte ranges out of
 * Parquet files on a static host and aggregates them in the tab. That is the whole
 * lakehouse read path, minus the lakehouse: DuckLake's catalog lives in Postgres and
 * a browser cannot reach it, so the file list is resolved server-side and handed
 * over in the manifest.
 */

export interface BrowserLane extends Lane {
  readonly preparation: Preparation;
}

export async function createDuckDBWasmLane(manifest: SliceManifest): Promise<BrowserLane> {
  const startedAt = performance.now();

  // The MVP bundle unless the browser has exception handling and threads; the
  // selector probes for both and picks what will actually run here.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  );

  const worker = new Worker(workerUrl);
  const database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const connection = await database.connect();
  // The same invariant as every other lane. Without it a February evening order is
  // reported as March on any machine east of Greenwich.
  await connection.query(`SET TimeZone='UTC'`);
  const initialiseMs = performance.now() - startedAt;

  const downloadStartedAt = performance.now();
  await registerSlice(connection, manifest);
  const downloadMs = performance.now() - downloadStartedAt;

  const version = await connection.query(`SELECT version() AS v`);
  const slice = transferred((url) => url.includes(SLICE_BASE));
  const preparation: Preparation = {
    bytesDownloaded: slice?.bytes ?? manifest.parquet.bytes,
    fromCache: slice?.fromCache ?? false,
    downloadMs,
    initialiseMs,
    rows: manifest.rows['fact_order_item'] ?? 0,
    engineVersion: `DuckDB-WASM ${String(version.get(0)?.['v'] ?? '')}`,
  };

  const spec: LaneSpec = {
    id: 'duckdb-wasm',
    label: LANE_META['duckdb-wasm'].label,
    handicaps: LANE_META['duckdb-wasm'].handicaps,
    target: { dialect: 'duckdb', schema: '', partitioned: true },

    available: async () => true,

    execute: async (sql, params) => {
      const prepared = await connection.prepare(sql);
      try {
        return arrowRows(await prepared.query(...params));
      } finally {
        await prepared.close();
      }
    },

    /**
     * Lane D reports what the network moved, not what the engine claims.
     *
     * DuckDB-WASM does not expose the JSON query profile the native build does, and
     * Resource Timing is the better source anyway: it counts bytes that actually
     * crossed the wire, which is exactly the quantity plan section 9 rule 4 asks for.
     */
    measure: async (sql, params) => {
      const before = transferred((url) => url.includes(SLICE_BASE))?.bytes ?? 0;
      const prepared = await connection.prepare(sql);
      try {
        await prepared.query(...params);
      } finally {
        await prepared.close();
      }
      const after = transferred((url) => url.includes(SLICE_BASE))?.bytes ?? 0;

      // Warm runs re-read from DuckDB-WASM's own buffer and move nothing, which is
      // true and useless; the honest per-query figure is the first fetch, already
      // counted in `preparation.bytesDownloaded`.
      return after > before ? { bytesRead: after - before } : {};
    },

    close: async () => {
      await connection.close();
      await database.terminate();
      await worker.terminate();
    },
  };

  return { ...createLane(spec), preparation };
}

/**
 * Views over the slice, one per star table.
 *
 * `httpfs` cannot list a remote directory, so the fact table's partition files are
 * named explicitly from the manifest. The Hive `month=` in each path still drives
 * partition pruning - the same mechanism lane C used before it moved to DuckLake.
 */
async function registerSlice(
  connection: duckdb.AsyncDuckDBConnection,
  manifest: SliceManifest,
): Promise<void> {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const url = (file: string): string => `'${origin}${SLICE_BASE}/parquet/${file}'`;

  const factFiles = manifest.parquet.files.filter((file) => file.startsWith('fact_order_item/'));
  const dimensions = manifest.parquet.files.filter((file) => !file.includes('/'));

  await connection.query(`
    CREATE OR REPLACE VIEW fact_order_item AS
    SELECT * FROM read_parquet([${factFiles.map(url).join(', ')}], hive_partitioning = true)
  `);

  for (const file of dimensions) {
    const table = file.replace(/\.parquet$/, '');
    await connection.query(
      `CREATE OR REPLACE VIEW ${table} AS SELECT * FROM read_parquet([${url(file)}])`,
    );
  }
}
