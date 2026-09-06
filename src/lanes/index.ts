import { LAKE_BASE_URL, LAKE_DIRS, PGDUCKDB_URL, POSTGRES_URL } from '../config';
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
      // READ_ONLY: this lane reads somebody else's transactional database.
      setup: [`ATTACH '${toLibpqConnectionString(POSTGRES_URL)}' AS pg (TYPE postgres, READ_ONLY)`],
      schema: 'pg.',
      partitioned: false,
      uncachedMetrics: false,
    }),

  /**
   * Lane C reads through the DuckLake catalog: metadata from Postgres, Parquet over
   * HTTP with an overridden DATA_PATH. That split is what a deployment uses, and it
   * needs no rewriting because DuckLake stores file paths relative to DATA_PATH.
   *
   * Gone since generation 1: the directory walk, the inlined URL list, and the view
   * hiding them. The file list is now one transactional metadata query.
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

  /**
   * Lane F - DuckDB embedded inside Postgres.
   *
   * The same client, the same wire protocol and the same SQL as lane A, with one
   * session setting changed. Sharing the lane implementation is what makes the
   * comparison fair: anything else and the two would differ in the harness as well
   * as in the engine.
   */
  'pg-duckdb': () =>
    createPostgresLane({
      id: 'pg-duckdb',
      label: LANE_META['pg-duckdb'].label,
      connectionString: PGDUCKDB_URL,
      handicaps: LANE_META['pg-duckdb'].handicaps,
      sessionSetup: [
        `CREATE EXTENSION IF NOT EXISTS pg_duckdb`,
        // Without this pg_duckdb only takes queries it is confident about.
        `SET duckdb.force_execution = true`,
      ],
      /*
       * The plan here is DuckDB's, so Postgres' buffer counters describe an access
       * method that is not doing the work. Reporting them would put a real-looking
       * number against the wrong thing.
       */
      reportBuffers: false,
      detectExecutor: true,
    }),
};

export async function openLane(id: LaneId): Promise<Lane> {
  const factory = SERVER_LANES[id];
  if (!factory) throw new Error(`lane ${id} does not run on the server`);
  return factory();
}

/**
 * Opens the given lanes and drops any that cannot answer.
 *
 * Settled rather than all: lane F's container is optional and Postgres may simply be
 * down, and one refused connection should skip a lane rather than abort the command
 * with a socket error. Lanes that did open are closed either way, so a partial
 * failure does not leak the connections its siblings acquired.
 */
export async function openAvailableLanes(ids: readonly LaneId[]): Promise<Lane[]> {
  const opened = await Promise.allSettled(ids.map((id) => openLane(id)));
  const usable: Lane[] = [];

  for (const outcome of opened) {
    if (outcome.status === 'rejected') continue;
    if (await outcome.value.available()) usable.push(outcome.value);
    else await outcome.value.close().catch(() => undefined);
  }
  return usable;
}

export { LANE_META, LANE_ORDER, BASELINE_LANE } from './meta';
export type { LaneMeta } from './meta';
