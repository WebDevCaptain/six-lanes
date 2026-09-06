import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Generation 1 of the lake: Hive-partitioned Parquet with no catalog, so something
 * has to walk the directory to find out which files a query should read.
 *
 * Over HTTP that is not possible at all, since `httpfs` cannot glob a remote
 * directory. DuckLake replaces this with one metadata query that is also correct
 * mid-write, which a directory listing never is.
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
 * Blocks until the HTTP host reports the same size for every file on disk.
 *
 * The lake is a bind mount into the nginx container and propagation is not instant,
 * so a freshly written file fails with "too small to be a Parquet file".
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
 * `encodeURI`, not `encodeURIComponent`: a Hive directory is named `month=2025-03`,
 * and percent-encoding the `=` leaves DuckDB unable to read the partition value back
 * out of the path. It still escapes the space in `category=Home & Kitchen`.
 */
const encodeLakePath = (path: string): string => encodeURI(path);
