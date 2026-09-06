import { POSTGRES_URL } from '../config';
import { toLibpqConnectionString } from '../postgres/connection';

/**
 * Generation 2 of the lake: metadata in Postgres, data in Parquet.
 *
 * Iceberg and Delta put metadata in files on the object store and then need a catalog
 * service in front of it anyway; DuckLake starts from the observation that a catalog
 * is a database. Here that also answers a question generation 1 could not: `httpfs`
 * cannot list a remote directory, and this returns the file list in one query.
 */

/**
 * One name for the lake everywhere.
 *
 * The alias and the metadata schema both appear in fully qualified identifiers, so
 * they are fixed here rather than passed around and eventually mistyped.
 */
export const DUCKLAKE = {
  alias: 'lake',
  /** Postgres schema for the metadata tables, kept out of `public`. */
  metadataSchema: 'ducklake',
} as const;

/**
 * A DuckLake metadata table, fully qualified.
 *
 * Two levels of surprise here. It is not `lake.ducklake_data_file`: the metadata is
 * a separate attached database called `__ducklake_metadata_<alias>`. And because we
 * set METADATA_SCHEMA, the tables sit in a schema of that name inside it - so the
 * real path has three parts, not two.
 */
export const metadataTable = (
  table: string,
  alias: string = DUCKLAKE.alias,
  schema: string = DUCKLAKE.metadataSchema,
): string => `__ducklake_metadata_${alias}.${schema}.${table}`;

export interface DuckLakeOptions {
  /** Catalog alias. Tables are addressed as `<alias>.orders`. */
  readonly alias: string;
  /** Where the Parquet lives: a local directory, or an HTTPS base when re-pointing. */
  readonly dataPath: string;
  /**
   * Reads the lake from somewhere other than where it was written.
   *
   * Load bearing for deployment: DuckLake stores data file paths **relative** to
   * DATA_PATH, so the same catalog can serve a local directory in CI and a CDN in
   * production. Nothing is rewritten, only re-pointed.
   */
  readonly overrideDataPath?: boolean;
  readonly readOnly?: boolean;
  /** Postgres schema for the metadata tables. Keeps them out of `public`. */
  readonly metadataSchema?: string;
  readonly postgresUrl?: string;
}

/** DuckDB extensions any DuckLake connection needs. */
export const DUCKLAKE_EXTENSIONS = ['ducklake', 'postgres', 'httpfs'] as const;

export function attachDuckLakeSql(options: DuckLakeOptions): string {
  const catalog = `ducklake:postgres:${toLibpqConnectionString(options.postgresUrl ?? POSTGRES_URL)}`;

  const settings = [
    `DATA_PATH '${withTrailingSlash(options.dataPath)}'`,
    ...(options.metadataSchema ? [`METADATA_SCHEMA '${options.metadataSchema}'`] : []),
    // Space separated, not `=>`. `OVERRIDE_DATA_PATH => true` is a parser error.
    ...(options.overrideDataPath ? ['OVERRIDE_DATA_PATH true'] : []),
    ...(options.readOnly ? ['READ_ONLY'] : []),
  ];

  return `ATTACH '${catalog}' AS ${options.alias} (${settings.join(', ')})`;
}

const withTrailingSlash = (path: string): string => (path.endsWith('/') ? path : `${path}/`);
