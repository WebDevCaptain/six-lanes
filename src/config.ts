import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every path, connection string and dataset dimension in one place.
 *
 * Anything a reader might want to change while running the lab is an environment
 * variable with a documented default; nothing else is configurable, because a knob
 * nobody turns is just a place for the code to disagree with itself.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const fromRoot = (...segments: string[]): string => resolve(REPO_ROOT, ...segments);

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/**
 * Shape of the synthetic dataset.
 *
 * Grain: one row per line item on one order. Every aggregation in this repo
 * assumes it, and section 7.1 of the plan says to write it down before writing a
 * query, so here it is.
 */
export const DATASET = {
  /** Fixed seed. Same seed, same bytes, forever - asserted by tests. */
  seed: int('OLAP_SEED', 42),
  /** Line items. 1M for Days 1-3, 10M from Day 4 (`OLAP_ROWS=10000000`). */
  orderItems: int('OLAP_ROWS', 1_000_000),
  customers: int('OLAP_CUSTOMERS', 200_000),
  products: int('OLAP_PRODUCTS', 5_000),
  /** 24 months: [start, end). All timestamps are UTC. */
  startDate: '2024-09-01',
  endDate: '2026-09-01',
} as const;

export const PATHS = {
  /** The generated dataset, canonical form. `pnpm generate` writes it. */
  database: fromRoot('data/olap.duckdb'),
  /** Served at {@link LAKE_BASE_URL} by the `lake-http` container. */
  lakeRoot: fromRoot('lake'),
  /** Generation 1 lake: raw Hive-partitioned Parquet (plan section 6). */
  rawLake: fromRoot('lake/raw'),
  /** Generation 2 lake: DuckLake DATA_PATH (plan section 6). */
  duckLake: fromRoot('lake/ducklake'),
  /** Day 2 layout study output. */
  study: fromRoot('lake/study'),
  results: fromRoot('docs/results.md'),
} as const;

/** Directory names under {@link PATHS.lakeRoot}, which double as URL prefixes. */
export const LAKE_DIRS = { raw: 'raw', duckLake: 'ducklake', study: 'study' } as const;

/**
 * Where the lake is served from over HTTP.
 *
 * Lane C reads the lake through `httpfs`, never off the local filesystem, for two
 * reasons: it is the same code path a CDN-hosted deployment uses, and DuckDB only
 * reports honest byte counts for reads that go through its HTTP file system
 * (local reads bypass the counter - see docs/results.md, Day 1 methodology).
 */
export const LAKE_BASE_URL = process.env.OLAP_LAKE_URL ?? 'http://localhost:8080';

export const POSTGRES_URL =
  process.env.OLAP_POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:55432/olap';

/** Lane F only. `pnpm up:pgduckdb` starts it. */
export const PGDUCKDB_URL =
  process.env.OLAP_PGDUCKDB_URL ?? 'postgres://postgres:postgres@localhost:55433/olap';

/** Measurement protocol, plan section 9 rule 2. */
export const BENCH = {
  warmupRuns: 1,
  timedRuns: int('OLAP_RUNS', 5),
} as const;
