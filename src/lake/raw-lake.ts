import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

export interface LakeFile {
  /** Path under the lake root, e.g. `raw/month=2025-03/data_0.parquet`. */
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * Every Parquet file under `lakeRoot/subdir`, at any depth.
 *
 * Recursive because Hive partitioning nests one directory per key, and the layout
 * study writes variants partitioned by two keys at once.
 */
export function discoverParquetFiles(lakeRoot: string, subdir: string): LakeFile[] {
  const files: LakeFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.parquet')) {
        files.push({ path: toUrlPath(relative(lakeRoot, absolute)), sizeBytes: statSync(absolute).size });
      }
    }
  };
  walk(join(lakeRoot, subdir));

  // Sorted so the file list, and therefore the SQL, is byte-identical between runs.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A `read_parquet` call over an explicit list of URLs.
 *
 * `hive_partitioning` still works with an explicit list - DuckDB reads `month=` out
 * of each path - so partition pruning survives the loss of globbing. Verified in
 * tests/integration/pruning.test.ts: filtering to one month of twenty-four opens
 * exactly one file.
 */
export function parquetRelation(
  baseUrl: string,
  files: readonly LakeFile[],
  hivePartitioning = true,
): string {
  if (files.length === 0) throw new Error('lake is empty; run `pnpm load` first');
  const urls = files.map((file) => `'${baseUrl}/${encodeLakePath(file.path)}'`).join(', ');
  return `read_parquet([${urls}]${hivePartitioning ? ', hive_partitioning = true' : ''})`;
}

export function totalBytes(files: readonly LakeFile[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

/**
 * Blocks until the HTTP host reports the same size for every file that is on disk.
 *
 * The lake is a bind mount into the container running nginx, and propagation across
 * that boundary is not instant. Querying a freshly written variant hits a file the
 * web server has not seen yet and fails with "too small to be a Parquet file" - a
 * confusing way to learn about mount latency. Checking is cheaper than retrying a
 * measurement that produced a wrong number instead of an error.
 */
export async function waitForLakeFiles(
  baseUrl: string,
  files: readonly LakeFile[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (const file of files) {
    const url = `${baseUrl}/${encodeLakePath(file.path)}`;
    for (;;) {
      const response = await fetch(url, { method: 'HEAD' });
      if (Number(response.headers.get('content-length')) === file.sizeBytes) break;
      if (Date.now() > deadline) {
        throw new Error(`${url} is not being served at its on-disk size of ${file.sizeBytes} bytes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const toUrlPath = (path: string): string => path.split(sep).join('/');

/**
 * Makes a filesystem path safe to put in a URL without disturbing its structure.
 *
 * `encodeURI` rather than `encodeURIComponent`, and that distinction is load
 * bearing: a Hive directory is named `month=2025-03`, and percent-encoding the `=`
 * leaves DuckDB unable to read the partition value back out of the path. It escapes
 * the space in `category=Home & Kitchen` and leaves the separators alone, which is
 * exactly the split we need.
 */
const encodeLakePath = (path: string): string => encodeURI(path);
