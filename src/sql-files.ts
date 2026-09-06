import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT } from './config';

/**
 * Reads DDL and maintenance scripts out of `sql/`.
 *
 * Only schema-level SQL lives on disk. The query catalogue does not, because lanes
 * D and E run in a browser where there is no filesystem to read from; see
 * src/queries/README.md.
 */
export function readSqlFile(name: string): string {
  return readFileSync(resolve(REPO_ROOT, 'sql', name), 'utf8');
}
