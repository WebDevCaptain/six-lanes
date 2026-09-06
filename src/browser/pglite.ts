import { PGlite } from '@electric-sql/pglite';

import { createLane, type LaneSpec } from '../lanes/create-lane';
import { LANE_META } from '../lanes/meta';
import type { BrowserLane } from './duckdb-wasm';
import { SLICE_BASE, transferred, type Preparation, type SliceManifest } from './slice';

/**
 * Lane E - real Postgres compiled to WebAssembly, and the controlled half of the
 * project's cleanest experiment: every variable except storage layout is held
 * identical to lane D. Same tab, same CPU, same rows, same query.
 *
 * The data directory arrives pre-built, because `COPY` for 160,000 rows inside PGlite
 * takes minutes and would become the entire measurement.
 */
export async function createPGliteLane(manifest: SliceManifest): Promise<BrowserLane> {
  const downloadStartedAt = performance.now();
  const response = await fetch(`${SLICE_BASE}/${manifest.pglite.file}`);
  if (!response.ok) throw new Error(`no PGlite datadir at ${SLICE_BASE} - run \`pnpm slice\``);
  const datadir = await response.blob();
  const downloadMs = performance.now() - downloadStartedAt;

  const initialiseStartedAt = performance.now();
  const pglite = await PGlite.create({ loadDataDir: datadir });
  await pglite.exec(`SET TimeZone = 'UTC'`);
  const initialiseMs = performance.now() - initialiseStartedAt;

  const version = await pglite.query<{ version: string }>('SELECT version()');
  const rows = await pglite.query<{ n: number }>('SELECT count(*)::int AS n FROM fact_order_item');

  const datadirTransfer = transferred((url) => url.includes(manifest.pglite.file));
  const preparation: Preparation = {
    bytesDownloaded: datadirTransfer?.bytes ?? manifest.pglite.bytes,
    fromCache: datadirTransfer?.fromCache ?? false,
    downloadMs,
    initialiseMs,
    rows: Number(rows.rows[0]?.n ?? 0),
    engineVersion: shortVersion(version.rows[0]?.version ?? 'PGlite'),
  };

  const spec: LaneSpec = {
    id: 'pglite',
    label: LANE_META.pglite.label,
    handicaps: LANE_META.pglite.handicaps,
    target: { dialect: 'postgres', schema: '', partitioned: false },

    available: async () => true,

    execute: async (sql, params) => {
      const result = await pglite.query<Record<string, unknown>>(sql, [...params]);
      return result.rows;
    },

    /**
     * PGlite is real Postgres, so it has real `EXPLAIN (ANALYZE, BUFFERS)` - which
     * makes lane E the only browser lane that can report bytes read the same way
     * lane A does. Being able to compare those two numbers directly is most of why
     * this lane is worth having.
     */
    measure: async (sql, params) => {
      const explained = await pglite.query<{ 'QUERY PLAN': ExplainRow[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF, COSTS OFF) ${sql}`,
        [...params],
      );
      const analysis = explained.rows[0]?.['QUERY PLAN']?.[0];
      if (!analysis) return {};

      return {
        bytesRead:
          ((analysis.Plan['Shared Hit Blocks'] ?? 0) + (analysis.Plan['Shared Read Blocks'] ?? 0)) *
          8192,
        rowsScanned: countScannedRows(analysis.Plan),
        engineMs: analysis['Execution Time'],
      };
    },

    close: () => pglite.close(),
  };

  return { ...createLane(spec), preparation };
}

interface ExplainRow {
  readonly Plan: PlanNode;
  readonly 'Execution Time'?: number;
}

interface PlanNode {
  readonly 'Relation Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly PlanNode[];
}

/** Same rule as lane A: only base-relation scans count, and loops multiply. */
function countScannedRows(node: PlanNode): number {
  const own =
    node['Relation Name'] === undefined
      ? 0
      : (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
  return Math.round((node.Plans ?? []).reduce((sum, child) => sum + countScannedRows(child), own));
}

/** "PostgreSQL 17.4 on ..." is most of a paragraph; the UI wants the first clause. */
const shortVersion = (full: string): string => full.split(' on ')[0] ?? full;
