import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Reading DuckDB's own accounting out of its JSON query profile.
 *
 * What was verified on DuckDB 1.5.3 before this was written (see docs/results.md,
 * "How bytes read is measured"):
 *
 *   - `total_bytes_read` at the root is exact for reads that go through httpfs, and
 *     tracks column pruning byte for byte. For local file reads it counts only the
 *     footer, so lane C reads the lake over HTTP and never off the disk.
 *   - `operator_rows_scanned` is not rows scanned; it over-reports by an order of
 *     magnitude. The scan operator's `operator_cardinality` is the real figure.
 *   - `extra_info` on a scan carries `Total Files Read` and `Projections`, which is
 *     how partition pruning and column pruning are counted rather than asserted.
 */

const METRICS = {
  TOTAL_BYTES_READ: 'true',
  OPERATOR_TYPE: 'true',
  OPERATOR_NAME: 'true',
  OPERATOR_CARDINALITY: 'true',
  EXTRA_INFO: 'true',
} as const;

export interface ProfileSummary {
  readonly bytesRead: number;
  readonly rowsScanned: number;
  /** Files the scan actually opened, after partition pruning. */
  readonly filesRead: number;
  /**
   * Columns the scan hands to the operator above it, after column pruning.
   *
   * Not quite the same as "columns read": a column used only to evaluate a pushed
   * filter is read off disk and then dropped, so it never appears here. Q2 on the
   * lake projects `month` and `revenue` while also reading `order_ts` for the range
   * predicate, and the byte count reflects all three.
   */
  readonly columnsProjected: readonly string[];
  /**
   * Predicates the scan pushed into the storage layer, as DuckDB rendered them.
   *
   * For lane B this is the whole story: it says exactly which parts of the WHERE
   * clause Postgres got to evaluate for itself, and by omission which parts were
   * paid for by dragging rows across the wire.
   */
  readonly filtersPushed?: string | undefined;
}

export interface DuckDBProfiler {
  /** Runs `sql`, then returns what the engine reported about the scan. */
  measure(sql: string, params: readonly unknown[]): Promise<ProfileSummary>;
}

/**
 * Turns on JSON profiling for a connection and hands back a reader for it.
 *
 * DuckDB only exposes the profile by writing it to a file, so each profiler gets a
 * private temp directory. The connection must be dedicated to measurement: the file
 * holds the profile of the most recent statement, whatever that was.
 */
export async function createProfiler(connection: DuckDBConnection): Promise<DuckDBProfiler> {
  const outputPath = join(mkdtempSync(join(tmpdir(), 'olap-profile-')), 'profile.json');

  await connection.run(`SET enable_profiling='json'`);
  await connection.run(`SET profiling_output='${outputPath}'`);
  await connection.run(`SET custom_profiling_settings='${JSON.stringify(METRICS)}'`);

  return {
    async measure(sql, params) {
      const prepared = await connection.prepare(sql);
      bindAll(prepared, params);
      await prepared.run();
      return summarize(JSON.parse(await readFile(outputPath, 'utf8')) as ProfileNode);
    },
  };
}

interface ProfileNode {
  readonly operator_type?: string;
  readonly operator_cardinality?: number;
  readonly total_bytes_read?: number;
  readonly extra_info?: {
    readonly Projections?: readonly string[];
    readonly 'Total Files Read'?: string;
    readonly Filters?: string;
  };
  readonly children?: readonly ProfileNode[];
}

function summarize(root: ProfileNode): ProfileSummary {
  let rowsScanned = 0;
  let filesRead = 0;
  const columnsProjected = new Set<string>();
  const filters: string[] = [];

  const walk = (node: ProfileNode): void => {
    if (node.operator_type === 'TABLE_SCAN') {
      rowsScanned += node.operator_cardinality ?? 0;
      filesRead += Number(node.extra_info?.['Total Files Read'] ?? 0);
      for (const column of node.extra_info?.Projections ?? []) columnsProjected.add(column);
      if (node.extra_info?.Filters) filters.push(node.extra_info.Filters);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);

  return {
    bytesRead: root.total_bytes_read ?? 0,
    rowsScanned,
    filesRead,
    columnsProjected: [...columnsProjected].sort(),
    filtersPushed: filters.length > 0 ? filters.join(' AND ') : undefined,
  };
}

/**
 * DuckDB's prepared statements bind by position and by type. Only the two types
 * the query catalogue actually uses are supported, so an unexpected value fails
 * loudly instead of being coerced into something that silently changes a result.
 */
export function bindAll(
  prepared: { bindVarchar(i: number, v: string): void; bindBigInt(i: number, v: bigint): void },
  params: readonly unknown[],
): void {
  params.forEach((value, index) => {
    const position = index + 1;
    if (typeof value === 'string') {
      prepared.bindVarchar(position, value);
    } else if (typeof value === 'number' && Number.isInteger(value)) {
      // BIGINT rather than INTEGER: order_id outgrows int32 at 10M rows.
      prepared.bindBigInt(position, BigInt(value));
    } else {
      throw new Error(`unsupported parameter at $${position}: ${JSON.stringify(value)}`);
    }
  });
}
