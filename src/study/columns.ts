import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Per-column bytes, read straight out of the Parquet footers.
 *
 * This is the whole project in one artifact. It shows why column pruning is worth
 * anything - what a query skips is not a uniform slice of the file, it is whichever
 * columns happen to be expensive - and it shows why some columns are expensive:
 * cardinality, not row count, decides storage cost.
 */
export interface ColumnBytes {
  readonly column: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly shareOfFile: number;
  /** Distinct values across the whole dataset. */
  readonly distinctValues: number;
}

export async function perColumnBytes(
  connection: DuckDBConnection,
  parquetGlob: string,
  table: string,
): Promise<ColumnBytes[]> {
  const footer = await connection.runAndReadAll(`
    SELECT path_in_schema                    AS column,
           sum(total_compressed_size)::BIGINT   AS compressed,
           sum(total_uncompressed_size)::BIGINT AS uncompressed
    FROM parquet_metadata('${parquetGlob}')
    GROUP BY 1
  `);

  const distinct = await connection.runAndReadAll(`
    SELECT unnest([${(await columnNames(connection, table)).map((c) => `'${c}'`).join(', ')}]) AS column,
           unnest([${(await columnNames(connection, table)).map((c) => `count(DISTINCT ${c})`).join(', ')}]) AS n
    FROM ${table}
  `);

  const distinctByColumn = new Map(
    (distinct.getRowObjectsJson() as Record<string, string>[]).map((row) => [
      String(row['column']),
      Number(row['n']),
    ]),
  );

  const rows = footer.getRowObjectsJson() as Record<string, string>[];
  const total = rows.reduce((sum, row) => sum + Number(row['compressed']), 0);

  return rows
    .map((row) => ({
      column: String(row['column']),
      compressedBytes: Number(row['compressed']),
      uncompressedBytes: Number(row['uncompressed']),
      shareOfFile: Number(row['compressed']) / total,
      distinctValues: distinctByColumn.get(String(row['column'])) ?? 0,
    }))
    .sort((a, b) => b.compressedBytes - a.compressedBytes);
}

async function columnNames(connection: DuckDBConnection, table: string): Promise<string[]> {
  const result = await connection.runAndReadAll(`SELECT * FROM ${table} LIMIT 0`);
  return result.columnNames();
}
