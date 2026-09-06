import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Generation 1 of the lake: Hive-partitioned Parquet and nothing else.
 *
 * This module is the gap in section 6 of the plan that has no name in the table -
 * "no catalog" - made concrete. There is no metadata anywhere, so something has to
 * walk the directory and produce the list of files a query should read. Over HTTP
 * that is not even possible: `httpfs` cannot glob a remote directory, so the list
 * must be resolved somewhere with a filesystem and shipped to whoever is reading.
 *
 * Day 3 deletes all of this. DuckLake answers "which files make up this table" with
 * one query against Postgres, and the answer is correct mid-write, which a directory
 * listing never is.
 */

export interface LakePartition {
  /** Hive partition value, `YYYY-MM`. */
  readonly month: string;
  /** Path under the lake root, e.g. `raw/month=2025-03/data_0.parquet`. */
  readonly path: string;
  readonly sizeBytes: number;
}

/** Walks a Hive-partitioned directory. Sorted, so the file list is reproducible. */
export function discoverPartitions(lakeRoot: string, partitionDir: string): LakePartition[] {
  const root = join(lakeRoot, partitionDir);
  const partitions: LakePartition[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const month = entry.name.startsWith('month=') ? entry.name.slice('month='.length) : undefined;
    if (month === undefined) continue;

    for (const file of readdirSync(join(root, entry.name))) {
      if (!file.endsWith('.parquet')) continue;
      const absolute = join(root, entry.name, file);
      partitions.push({
        month,
        path: relative(lakeRoot, absolute),
        sizeBytes: statSync(absolute).size,
      });
    }
  }

  return partitions.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A `read_parquet` call over an explicit list of URLs.
 *
 * `hive_partitioning` still works with an explicit list - DuckDB reads `month=` out
 * of each path - so partition pruning survives the loss of globbing. Verified in
 * docs/results.md: filtering to one month of twenty-four opens one file.
 */
export function parquetRelation(baseUrl: string, partitions: readonly LakePartition[]): string {
  if (partitions.length === 0) throw new Error('lake is empty; run `pnpm load` first');
  const urls = partitions.map((p) => `'${baseUrl}/${p.path}'`).join(', ');
  return `read_parquet([${urls}], hive_partitioning = true)`;
}

export function totalBytes(partitions: readonly LakePartition[]): number {
  return partitions.reduce((sum, p) => sum + p.sizeBytes, 0);
}
