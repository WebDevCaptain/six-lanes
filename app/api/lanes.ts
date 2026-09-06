import 'server-only';

import { openAvailableLanes } from '@/lanes/index';
import type { Lane, LaneId } from '@/types';

/**
 * Server lanes, opened once and kept: attaching DuckLake and connecting to Postgres
 * costs a few hundred milliseconds, which has no place in numbers resolving
 * differences of a few.
 *
 * Held on `globalThis` so the dev server's hot reload does not leak a connection on
 * every save.
 */
const SERVER_LANES: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake'];

const cache = globalThis as typeof globalThis & { olapLanes?: Promise<Lane[]> | undefined };

function serverLanes(): Promise<Lane[]> {
  cache.olapLanes ??= openAvailableLanes(SERVER_LANES);
  return cache.olapLanes;
}

async function discardServerLanes(): Promise<void> {
  const pending = cache.olapLanes;
  cache.olapLanes = undefined;
  if (!pending) return;
  await Promise.allSettled((await pending).map((lane) => lane.close()));
}

/**
 * Runs work against the cached lanes, replacing them if the connection died.
 *
 * A held Postgres connection does not survive the database restarting, a network
 * blip, or a managed instance idling to zero, and node-postgres then answers every
 * later query with "Client has encountered a connection error and is not queryable"
 * until the process restarts. Discarding the cache and retrying once turns that
 * permanent failure into one slow request; a second failure is a real one and is
 * allowed through.
 */
export async function withServerLanes<T>(work: (lanes: readonly Lane[]) => Promise<T>): Promise<T> {
  try {
    return await work(await serverLanes());
  } catch {
    await discardServerLanes();
    return work(await serverLanes());
  }
}
