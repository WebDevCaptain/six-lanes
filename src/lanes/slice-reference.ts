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
 * The oracle for lanes D and E.
 *
 * Lane A answers over the whole dataset; the browser lanes answer over a slice of it,
 * so their rows cannot be compared with lane A's directly. They are compared with
 * this instead: the same query, the same catalogue definition, the same normaliser,
 * run server-side against the very Parquet files the browser downloads.
 *
 * That keeps the correctness gate intact end to end. Lane A checks lane C over the
 * full lake; this checks lanes D and E over the slice; and `pnpm slice` writes both
 * artefacts from one source, so agreement here means all five agree about the data.
 */
export interface Reference {
  run(queryId: QueryId, params: QueryParams): Promise<Row[]>;
}

/**
 * Cached per slice build, not forever.
 *
 * The connection holds views over specific Parquet files by path. Rebuilding the
 * slice replaces those files, and a connection cached across the rebuild answers
 * every query with "No files found that match the pattern" until the server is
 * restarted. The manifest's build timestamp is the cache key, so a rebuild
 * invalidates it on the next request.
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
    // Best effort: a leaked DuckDB connection is not fatal, but leaking one per
    // rebuild during a long dev session would be.
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
