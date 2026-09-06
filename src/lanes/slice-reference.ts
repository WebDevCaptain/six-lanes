import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DuckDBConnection } from '@duckdb/node-api';

import { normalizeRows } from '../bench/normalize';
import type { SliceManifest } from '../browser/slice';
import { PATHS } from '../config';
import { connectDuckDB } from '../duckdb/connect';
import { getQuery, type QueryId } from '../queries/index';
import type { QueryParams, SqlTarget } from '../queries/types';
import type { Row } from '../types';
import { runRows } from './duckdb';

/**
 * The oracle for lanes D and E, which hold a slice and so cannot be compared with
 * lane A directly. Same query, same catalogue, same normaliser, run server-side
 * against the Parquet the browser downloaded.
 *
 * Lane A checks lane C over the full lake and this checks D and E over the slice, so
 * the correctness gate stays intact end to end.
 */
export interface Reference {
  run(queryId: QueryId, params: QueryParams): Promise<Row[]>;
}

/**
 * Cached per slice build, not forever. The connection holds views over Parquet files
 * by path, so a connection kept across a rebuild answers every query with "No files
 * found" until the server restarts. The manifest's timestamp is the cache key.
 */
interface Cached {
  readonly builtAt: string;
  readonly reference: Promise<Reference>;
  readonly connection: Promise<DuckDBConnection>;
}

const cache = globalThis as typeof globalThis & { olapSliceReference?: Cached };

export async function sliceReference(): Promise<Reference> {
  const manifest = readManifest();

  if (cache.olapSliceReference?.builtAt !== manifest.builtAt) {
    const stale = cache.olapSliceReference;
    const connection = connectDuckDB({});
    cache.olapSliceReference = {
      builtAt: manifest.builtAt,
      connection,
      reference: create(connection, manifest),
    };
    // Best effort: one leaked connection is survivable, one per rebuild is not.
    void stale?.connection.then((old) => old.disconnectSync()).catch(() => undefined);
  }

  return cache.olapSliceReference.reference;
}

const TARGET: SqlTarget = { dialect: 'duckdb', schema: '', partitioned: true };

function readManifest(): SliceManifest {
  return JSON.parse(readFileSync(join(PATHS.slice, 'manifest.json'), 'utf8')) as SliceManifest;
}

async function create(
  pending: Promise<DuckDBConnection>,
  manifest: SliceManifest,
): Promise<Reference> {
  const connection = await pending;
  const path = (file: string): string => `'${join(PATHS.slice, 'parquet', file)}'`;

  const factFiles = manifest.parquet.files.filter((file) => file.startsWith('fact_order_item/'));
  await connection.run(`
    CREATE OR REPLACE VIEW fact_order_item AS
    SELECT * FROM read_parquet([${factFiles.map(path).join(', ')}], hive_partitioning = true)
  `);
  for (const file of manifest.parquet.files.filter((file) => !file.includes('/'))) {
    await connection.run(
      `CREATE OR REPLACE VIEW ${file.replace(/\.parquet$/, '')} AS SELECT * FROM read_parquet([${path(file)}])`,
    );
  }

  return {
    async run(queryId, params) {
      const query = getQuery(queryId);
      const rows = await runRows(connection, query.build(TARGET), query.bind(params));
      return normalizeRows(query.columns, rows);
    },
  };
}
