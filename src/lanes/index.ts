import { LAKE_BASE_URL, LAKE_DIRS, POSTGRES_URL } from '../config';
import { DUCKLAKE, DUCKLAKE_EXTENSIONS, attachDuckLakeSql } from '../lake/ducklake';
import { toLibpqConnectionString } from '../postgres/connection';
import type { Lane, LaneId } from '../types';
import { createDuckDBLane } from './duckdb';
import { LANE_META } from './meta';
import { createPostgresLane } from './postgres';

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

  'duckdb-postgres': () =>
    createDuckDBLane({
      id: 'duckdb-postgres',
      label: LANE_META['duckdb-postgres'].label,
      handicaps: LANE_META['duckdb-postgres'].handicaps,
      extensions: ['postgres'],
      // READ_ONLY makes the intent explicit: this lane is a reader of somebody
      // else's transactional database and has no business writing to it.
      setup: [`ATTACH '${toLibpqConnectionString(POSTGRES_URL)}' AS pg (TYPE postgres, READ_ONLY)`],
      schema: 'pg.',
      partitioned: false,
      uncachedMetrics: false,
    }),

  /**
   * Lane C reads generation 2, through the DuckLake catalog.
   *
   * The catalog lives in Postgres and the data is fetched over HTTP with an
   * overridden DATA_PATH - the same split a deployment uses, where the catalog is a
   * managed database and the Parquet sits on a CDN. Nothing was rewritten to make
   * that work: DuckLake stores its file paths relative to DATA_PATH, so re-pointing
   * is a connection string change.
   *
   * Note what is gone compared with generation 1: no directory walk, no explicit
   * list of two dozen URLs, no view to hide them behind. `FROM lake.fact_order_item`
   * is the whole thing, and the file list comes from one transactional metadata
   * query.
   */
  'duckdb-lake': () =>
    createDuckDBLane({
      id: 'duckdb-lake',
      label: LANE_META['duckdb-lake'].label,
      handicaps: [
        'Reads the lake over HTTP, the same path a CDN-hosted deployment uses.',
        'Byte counts come from an uncached pass: no client-side file cache, so every run pays the full transfer.',
      ],
      extensions: [...DUCKLAKE_EXTENSIONS],
      setup: [
        attachDuckLakeSql({
          alias: DUCKLAKE.alias,
          dataPath: `${LAKE_BASE_URL}/${LAKE_DIRS.duckLake}`,
          metadataSchema: DUCKLAKE.metadataSchema,
          overrideDataPath: true,
          readOnly: true,
        }),
      ],
      schema: `${DUCKLAKE.alias}.`,
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

export { LANE_META, LANE_ORDER, BASELINE_LANE } from './meta';
export type { LaneMeta } from './meta';
