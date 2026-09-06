import { describe, expect, it } from 'vitest';

import { disagreements, runCatalogue } from '../../src/bench/run-catalogue';
import { DEFAULT_PARAMS } from '../../src/queries/index';
import type { Lane, LaneId, Row } from '../../src/types';

/**
 * The correctness gate, tested without needing an engine to actually disagree.
 *
 * Three commands and the app all publish through this, so which rows may be believed
 * is decided here. A stub lane is the only way to exercise the failing branch on
 * demand.
 */
const lane = (id: LaneId, rows: Row[]): Lane => ({
  id,
  label: id,
  available: async () => true,
  close: async () => undefined,
  run: async (queryId) => ({
    laneId: id,
    queryId,
    rows,
    sql: 'SELECT 1',
    params: [],
    timings: { warmMs: 1, p95Ms: 2, runs: 5 },
    metrics: { rowsReturned: rows.length },
    handicaps: [],
  }),
});

const truth: Row[] = [{ category: 'Books', revenue: '10.00' }];
const wrong: Row[] = [{ category: 'Books', revenue: '10.01' }];

const only = ['revenue_by_category'] as const;

describe('runCatalogue', () => {
  it('marks every lane as agreeing when they all match the baseline', async () => {
    const rows = await runCatalogue(
      [lane('postgres', truth), lane('duckdb-lake', truth)],
      DEFAULT_PARAMS,
      only,
    );
    expect(rows.map((row) => row.agrees)).toEqual([true, true]);
    expect(disagreements(rows)).toEqual([]);
  });

  it('marks only the lane that differs, and says how', async () => {
    const rows = await runCatalogue(
      [lane('postgres', truth), lane('duckdb-lake', wrong), lane('pglite', truth)],
      DEFAULT_PARAMS,
      only,
    );
    expect(rows.map((row) => [row.result.laneId, row.agrees])).toEqual([
      ['postgres', true],
      ['duckdb-lake', false],
      ['pglite', true],
    ]);
    expect(disagreements(rows)[0]?.disagreement).toMatch(/differs/);
  });

  it('never marks the baseline as disagreeing with itself', async () => {
    const rows = await runCatalogue([lane('postgres', wrong)], DEFAULT_PARAMS, only);
    expect(rows[0]?.agrees).toBe(true);
  });

  it('runs every query it is given, for every lane', async () => {
    const rows = await runCatalogue(
      [lane('postgres', truth), lane('duckdb-lake', truth)],
      DEFAULT_PARAMS,
      ['revenue_by_category', 'order_lookup'],
    );
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.queryId))).toEqual(
      new Set(['revenue_by_category', 'order_lookup']),
    );
  });

  it('reports agreement when no baseline lane is present, rather than throwing', async () => {
    // pnpm bench can run without lane A if Postgres is down; it should not crash.
    const rows = await runCatalogue([lane('duckdb-lake', truth)], DEFAULT_PARAMS, only);
    expect(rows[0]?.agrees).toBe(true);
  });
});
