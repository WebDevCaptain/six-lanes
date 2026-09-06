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
 * UTC, set at the instance and again on the connection.
 *
 * This is not belt and braces, it is a correctness fix with a measured failure mode.
 * DuckDB defaults `TimeZone` to the host zone. On a machine in Asia/Kolkata, an order
 * placed at 19:00 UTC on 28 February is reported by `strftime(order_ts, '%Y-%m')` as
 * **March**, because +05:30 pushes it over midnight. Q2 would then disagree with
 * Postgres about which month a row belongs to, on some rows, on some machines - the
 * worst kind of bug, because it is invisible until someone runs it somewhere else.
 *
 * One quirk worth knowing: this fixes computation but not display. DuckDB 1.5.3 still
 * renders TIMESTAMPTZ with the host offset. That is harmless here because the offset
 * is always explicit in the rendered string and the normaliser reads it - see
 * tests/unit/normalize.test.ts - but it means "the timestamp looks wrong" is not by
 * itself evidence that anything is wrong.
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
