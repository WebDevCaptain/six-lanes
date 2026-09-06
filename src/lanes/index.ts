import { LAKE_BASE_URL, LAKE_DIRS, PATHS, POSTGRES_URL } from '../config.js';
import { discoverParquetFiles, parquetRelation } from '../lake/raw-lake.js';
import { toLibpqConnectionString } from '../postgres/connection.js';
import type { Lane, LaneId } from '../types.js';
import { createDuckDBLane } from './duckdb.js';
import { LANE_META } from './meta.js';
import { createPostgresLane } from './postgres.js';

/**
 * Construction of the lanes that run on the server. Lanes D and E are browser-only
 * and are built in app/, where a browser exists.
 */

/** The view lane C reads through, so the SQL on screen is not two dozen URLs. */
const LAKE_VIEW = 'lake_orders';

const SERVER_LANES: Partial<Record<LaneId, () => Promise<Lane>>> = {
  postgres: () =>
    createPostgresLane({
      id: 'postgres',
      label: LANE_META.postgres.label,
      connectionString: POSTGRES_URL,
      handicaps: LANE_META.postgres.handicaps,
    }),

  'duckdb-postgres': () =>
    createDuckDBLane({
      id: 'duckdb-postgres',
      label: LANE_META['duckdb-postgres'].label,
      handicaps: LANE_META['duckdb-postgres'].handicaps,
      extensions: ['postgres'],
      // READ_ONLY makes the intent explicit: this lane is a reader of somebody
      // else's transactional database and has no business writing to it.
      setup: [`ATTACH '${toLibpqConnectionString(POSTGRES_URL)}' AS pg (TYPE postgres, READ_ONLY)`],
      relation: 'pg.orders',
      partitioned: false,
      uncachedMetrics: false,
    }),

  'duckdb-lake': () =>
    createDuckDBLane({
      id: 'duckdb-lake',
      label: LANE_META['duckdb-lake'].label,
      handicaps: [
        'Reads the lake over HTTP, the same path a CDN-hosted deployment uses.',
        'Byte counts come from an uncached pass: no client-side file cache, so every run pays the full transfer.',
      ],
      extensions: ['httpfs'],
      relation: parquetRelation(LAKE_BASE_URL, discoverParquetFiles(PATHS.lakeRoot, LAKE_DIRS.raw)),
      viewName: LAKE_VIEW,
      partitioned: true,
      uncachedMetrics: true,
    }),
};

export async function openLane(id: LaneId): Promise<Lane> {
  const factory = SERVER_LANES[id];
  if (!factory) throw new Error(`lane ${id} does not run on the server`);
  return factory();
}

/** Opens the given lanes and drops any that cannot answer, e.g. an unloaded store. */
export async function openAvailableLanes(ids: readonly LaneId[]): Promise<Lane[]> {
  const lanes = await Promise.all(ids.map((id) => openLane(id)));
  const usable: Lane[] = [];

  for (const lane of lanes) {
    if (await lane.available()) usable.push(lane);
    else await lane.close();
  }
  return usable;
}

export { LANE_META, LANE_ORDER, BASELINE_LANE } from './meta.js';
export type { LaneMeta } from './meta.js';
