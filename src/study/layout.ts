import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { DuckDBConnection } from '@duckdb/node-api';

import { LAKE_BASE_URL, LAKE_DIRS, PATHS } from '../config';
import {
  discoverParquetFiles,
  parquetRelation,
  totalBytes,
  waitForLakeFiles,
} from '../lake/raw-lake';

/**
 * Day 2: the layout study.
 *
 * One factor changed at a time from a fixed baseline, everything else held. The
 * point is not that one layout wins - it is that the same rows, the same query and
 * the same engine produce byte counts that differ by an order of magnitude
 * depending on decisions that look like defaults.
 */

export interface LayoutVariant {
  readonly factor: string;
  readonly setting: string;
  /** Hive partition keys, or none. */
  readonly partitionBy?: string;
  /** Sort applied before writing, which is what row-group min/max statistics see. */
  readonly orderBy?: string;
  readonly rowGroupSize?: number;
  readonly compression: 'zstd' | 'snappy' | 'uncompressed';
}

/**
 * Baseline: partitioned by month, written in natural (time) order, DuckDB's default
 * row group size, zstd. This is what `pnpm load` produces, so the baseline row of
 * the study is also the lane C configuration.
 */
const BASELINE = { factor: 'baseline', setting: 'month / natural / default / zstd', partitionBy: 'month', compression: 'zstd' } as const;

export const LAYOUT_VARIANTS: readonly LayoutVariant[] = [
  BASELINE,

  { factor: 'partitioning', setting: 'none', compression: 'zstd' },
  { factor: 'partitioning', setting: 'month + category', partitionBy: 'month, category', compression: 'zstd' },

  { factor: 'sort order', setting: 'category, order_ts', partitionBy: 'month', orderBy: 'category, order_ts', compression: 'zstd' },
  { factor: 'sort order', setting: 'shuffled', partitionBy: 'month', orderBy: 'hash(order_item_id)', compression: 'zstd' },

  { factor: 'row group', setting: '10,000 rows', partitionBy: 'month', rowGroupSize: 10_000, compression: 'zstd' },
  { factor: 'row group', setting: '1,000,000 rows', partitionBy: 'month', rowGroupSize: 1_000_000, compression: 'zstd' },

  { factor: 'compression', setting: 'uncompressed', partitionBy: 'month', compression: 'uncompressed' },
  { factor: 'compression', setting: 'snappy', partitionBy: 'month', compression: 'snappy' },

  /*
   * The one deliberate exception to one-factor-at-a-time, because the interaction is
   * the finding. A month partition holds ~42k rows, a single row group at DuckDB's
   * default of 122,880, and a sort cannot help an engine skip the only row group
   * there is.
   */
  {
    factor: 'interaction',
    setting: 'sorted by category + 10k row groups',
    partitionBy: 'month',
    orderBy: 'category, order_ts',
    rowGroupSize: 10_000,
    compression: 'zstd',
  },
];

export interface Probe {
  readonly name: string;
  readonly asks: string;
  readonly sql: (relation: string) => string;
}

export const PROBES: readonly Probe[] = [
  {
    name: 'scan all',
    asks: 'revenue by category over everything',
    sql: (r) => `SELECT category, sum(revenue) FROM ${r} GROUP BY 1`,
  },
  {
    name: 'month range',
    asks: 'six months of twenty-four',
    sql: (r) => `SELECT month, sum(revenue) FROM ${r} WHERE month >= '2025-03' AND month <= '2025-08' GROUP BY 1`,
  },
  {
    name: 'one category',
    asks: 'a filter on a column you can sort by',
    sql: (r) => `SELECT sum(revenue) FROM ${r} WHERE category = 'Books'`,
  },
  {
    name: 'point lookup',
    asks: 'one order id',
    sql: (r) => `SELECT sum(revenue) FROM ${r} WHERE order_id = 250000`,
  },
];

/** A directory name that is stable, readable and safe in a URL. */
export const variantSlug = (variant: LayoutVariant): string =>
  `${variant.factor}-${variant.setting}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface WrittenVariant {
  readonly variant: LayoutVariant;
  readonly relation: string;
  readonly files: number;
  readonly bytesOnDisk: number;
  readonly writeMs: number;
}

/** Writes one variant of the whole dataset and returns how to read it back. */
export async function writeVariant(
  connection: DuckDBConnection,
  variant: LayoutVariant,
): Promise<WrittenVariant> {
  const slug = variantSlug(variant);
  const directory = join(PATHS.study, slug);
  rmSync(directory, { recursive: true, force: true });
  // PARTITION_BY builds its own tree; a single-file COPY will not create a parent.
  mkdirSync(directory, { recursive: true });

  const options = [
    'FORMAT parquet',
    `COMPRESSION ${variant.compression}`,
    ...(variant.partitionBy ? [`PARTITION_BY (${variant.partitionBy})`] : []),
    ...(variant.rowGroupSize ? [`ROW_GROUP_SIZE ${variant.rowGroupSize}`] : []),
    'OVERWRITE_OR_IGNORE',
  ];

  /*
   * The month column is always projected. With PARTITION_BY it moves into the path
   * and out of the file; without it, it stays a column, which is part of what the
   * study measures.
   */
  const source = `SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders${
    variant.orderBy ? ` ORDER BY ${variant.orderBy}` : ''
  }`;
  const destination = variant.partitionBy ? directory : join(directory, 'data.parquet');

  const started = performance.now();
  await connection.run(`COPY (${source}) TO '${destination}' (${options.join(', ')})`);
  const writeMs = performance.now() - started;

  const files = discoverParquetFiles(PATHS.lakeRoot, `${LAKE_DIRS.study}/${slug}`);
  await waitForLakeFiles(LAKE_BASE_URL, files);

  return {
    variant,
    // Hive partitioning is only meaningful when there are partitions in the path.
    relation: parquetRelation(LAKE_BASE_URL, files, variant.partitionBy !== undefined),
    files: files.length,
    bytesOnDisk: totalBytes(files),
    writeMs,
  };
}
