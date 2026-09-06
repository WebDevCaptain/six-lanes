import { LAKE_BASE_URL, LAKE_DIRS, PATHS, POSTGRES_URL } from '../config.js';
import { discoverPartitions, parquetRelation } from '../lake/raw-lake.js';
import type { Lane, LaneId } from '../types.js';
import { createDuckDBLakeLane } from './duckdb-lake.js';
import { LANE_META } from './meta.js';
import { createPostgresLane } from './postgres.js';

/**
 * Construction of the lanes that run on the server. Lanes D and E are browser-only
 * and are built in app/, where a browser exists.
 */
const SERVER_LANES: Partial<Record<LaneId, () => Promise<Lane>>> = {
  postgres: () =>
    createPostgresLane({
      id: 'postgres',
      label: LANE_META.postgres.label,
      connectionString: POSTGRES_URL,
      handicaps: LANE_META.postgres.handicaps,
    }),

  'duckdb-lake': () =>
    createDuckDBLakeLane({
      label: LANE_META['duckdb-lake'].label,
      relation: parquetRelation(LAKE_BASE_URL, discoverPartitions(PATHS.lakeRoot, LAKE_DIRS.raw)),
      partitioned: true,
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
