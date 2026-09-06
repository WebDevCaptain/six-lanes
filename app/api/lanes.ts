import 'server-only';

import { openAvailableLanes } from '@/lanes/index';
import type { Lane, LaneId } from '@/types';

/**
 * Server lanes, opened once and kept.
 *
 * Opening a lane is not free - lane C attaches DuckLake and installs two extensions,
 * lane A opens a Postgres connection - and doing it per request would put a few
 * hundred milliseconds of setup into numbers that are trying to resolve differences
 * of a few milliseconds.
 *
 * Held on `globalThis` rather than in a module variable so that the dev server's hot
 * reload, which re-evaluates modules freely, does not quietly leak a connection pool
 * on every save.
 */
const SERVER_LANES: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake'];

const cache = globalThis as typeof globalThis & { olapLanes?: Promise<Lane[]> };

export function serverLanes(): Promise<Lane[]> {
  cache.olapLanes ??= openAvailableLanes(SERVER_LANES);
  return cache.olapLanes;
}
