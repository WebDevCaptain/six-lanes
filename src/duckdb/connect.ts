import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

export interface DuckDBOptions {
  /** Database file. Defaults to an in-memory database. */
  readonly path?: string;
  readonly extensions?: readonly string[];
  /**
   * Turns off DuckDB's external file cache and HTTP metadata cache.
   *
   * Only the metrics connection wants this. With the caches on, a repeated scan
   * reports zero bytes read - true, but useless as a measure of how much data the
   * query needs. With them off, every run pays the full transfer, which is the
   * number that answers "how much does this query cost to serve".
   */
  readonly disableCaches?: boolean;
}

const EXTENSION_NAME = /^[a-z_]+$/;

/**
 * UTC, set at the instance and again on the connection, because DuckDB defaults
 * `TimeZone` to the host zone. In Asia/Kolkata an order at 19:00 UTC on 28 February
 * is reported by `strftime` as March, so Q2 disagrees with Postgres on some rows, on
 * some machines.
 *
 * This fixes computation but not display: 1.5.3 still renders TIMESTAMPTZ with the
 * host offset. Harmless, since the offset is explicit and the normaliser reads it.
 */
const UTC_CONFIG = { TimeZone: 'UTC' } as const;

export async function connectDuckDB(options: DuckDBOptions = {}): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(options.path ?? ':memory:', { ...UTC_CONFIG });
  const connection = await instance.connect();
  await connection.run(`SET TimeZone='UTC'`);

  for (const extension of options.extensions ?? []) {
    if (!EXTENSION_NAME.test(extension)) throw new Error(`bad extension name: ${extension}`);
    await connection.run(`INSTALL ${extension}`);
    await connection.run(`LOAD ${extension}`);
  }

  if (options.disableCaches) {
    await connection.run(`SET enable_external_file_cache=false`);
    await connection.run(`SET enable_http_metadata_cache=false`);
  }

  return connection;
}

/** Convenience for the many places that need one scalar out of DuckDB. */
export async function scalar<T = unknown>(
  connection: DuckDBConnection,
  sql: string,
): Promise<T> {
  const result = await connection.runAndReadAll(sql);
  const rows = result.getRowsJson();
  if (rows.length === 0 || rows[0]!.length === 0) throw new Error(`no rows from: ${sql}`);
  return rows[0]![0] as T;
}
