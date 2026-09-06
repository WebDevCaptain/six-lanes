import type { LaneId } from '../types';

/**
 * Section 5 of the plan as data. Pure - no engine imports - because the browser
 * renders this table too, and it must not drag a Postgres driver into a bundle.
 */
export interface LaneMeta {
  /** The letter the plan and the UI both use. */
  readonly letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  readonly label: string;
  readonly engine: string;
  readonly runsOn: string;
  readonly readsFrom: string;
  readonly demonstrates: string;
  /** Standing disclosures, shown next to this lane's numbers wherever they appear. */
  readonly handicaps: readonly string[];
}

export const LANE_META: Record<LaneId, LaneMeta> = {
  postgres: {
    letter: 'A',
    label: 'Postgres 18',
    engine: 'Postgres 18',
    runsOn: 'Docker (Neon when deployed)',
    readsFrom: 'heap + b-tree indexes',
    demonstrates: 'A row store doing an OLAP job. The baseline, and the correct answer.',
    handicaps: [
      'Queries the transactional cluster directly. In production this belongs on a read replica: analytics here competes with OLTP for the same buffers.',
      'Measured fully warm, with the whole table in shared buffers. A cold read would be materially worse.',
    ],
  },
  'duckdb-postgres': {
    letter: 'B',
    label: 'DuckDB over Postgres',
    engine: 'DuckDB + postgres extension',
    runsOn: 'Node',
    readsFrom: 'the Postgres heap, live, no copy',
    demonstrates: 'Zero-ETL federation: a vectorised engine over a row store it does not own.',
    handicaps: [
      'Also queries the transactional cluster. Same objection as lane A.',
      'No column or partition pruning is possible: the data is stored by row.',
    ],
  },
  'duckdb-lake': {
    letter: 'C',
    label: 'DuckDB over the lake',
    engine: 'DuckDB + httpfs',
    runsOn: 'Node',
    readsFrom: 'Parquet over HTTP',
    demonstrates: 'The lakehouse read path. Column pruning, partition pruning, and no load on the OLTP database at all.',
    handicaps: [],
  },
  'duckdb-wasm': {
    letter: 'D',
    label: 'DuckDB-WASM',
    engine: 'DuckDB compiled to WebAssembly',
    runsOn: 'the browser tab',
    readsFrom: 'Parquet over HTTP range requests',
    demonstrates: 'No server in the request path at all. The lake answers the browser directly.',
    handicaps: [
      'WebAssembly, single-threaded by default, with no access to native SIMD paths.',
      'Reads a slice of the dataset, not all of it, to stay inside the download budget.',
    ],
  },
  pglite: {
    letter: 'E',
    label: 'PGlite',
    engine: 'Postgres compiled to WebAssembly',
    runsOn: 'the browser tab',
    readsFrom: 'a pre-built datadir in the browser',
    demonstrates: 'The controlled row-store baseline: same tab, same CPU, same rows as lane D.',
    handicaps: [
      'Single user, single connection, no parallel workers. Lane A is the real Postgres number; this one is the controlled one.',
      'Reads the same slice as lane D, not the full dataset.',
    ],
  },
  'pg-duckdb': {
    letter: 'F',
    label: 'pg_duckdb',
    engine: 'DuckDB embedded inside Postgres',
    runsOn: 'Docker only',
    readsFrom: 'the local Postgres heap',
    demonstrates: 'The other direction: bring the column engine to the row store instead of the data to the column store.',
    handicaps: [
      'Cannot be deployed to a managed Postgres: it needs shared_preload_libraries.',
      'Reads Postgres heap tuples, so it gains vectorised execution but no columnar storage.',
    ],
  },
};

export const LANE_ORDER: readonly LaneId[] = [
  'postgres',
  'duckdb-postgres',
  'duckdb-lake',
  'duckdb-wasm',
  'pglite',
  'pg-duckdb',
];

/** Lane A is the reference every other lane's rows are checked against. */
export const BASELINE_LANE: LaneId = 'postgres';
