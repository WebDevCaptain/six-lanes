import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findMismatches } from '../../src/bench/compare';
import { BASELINE_LANE, openAvailableLanes } from '../../src/lanes/index';
import { DEFAULT_PARAMS, QUERY_IDS } from '../../src/queries/index';
import type { Lane, LaneId, LaneResult } from '../../src/types';

/**
 * The gate from plan section 9 rule 1, as a test rather than a promise.
 *
 * Needs the containers up and the data loaded:
 *   pnpm services && pnpm generate && pnpm load && pnpm ducklake && pnpm test:integration
 */
const LANES: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake'];

let lanes: Lane[] = [];
const results = new Map<string, LaneResult[]>();

beforeAll(async () => {
  lanes = await openAvailableLanes(LANES);
  expect(lanes.map((lane) => lane.id)).toEqual([...LANES]);

  for (const queryId of QUERY_IDS) {
    const perLane: LaneResult[] = [];
    for (const lane of lanes) perLane.push(await lane.run(queryId, DEFAULT_PARAMS));
    results.set(queryId, perLane);
  }
});

afterAll(async () => {
  for (const lane of lanes) await lane.close();
});

describe.each(QUERY_IDS)('%s', (queryId) => {
  it('returns identical rows on every lane', () => {
    const perLane = results.get(queryId)!;
    const baseline = perLane.find((result) => result.laneId === BASELINE_LANE)!;
    const others = perLane.filter((result) => result !== baseline);

    expect(findMismatches(baseline, others)).toEqual([]);
  });

  it('returns rows at all', () => {
    for (const result of results.get(queryId)!) expect(result.rows.length).toBeGreaterThan(0);
  });

  it('reports the measurement protocol it promised', () => {
    for (const result of results.get(queryId)!) {
      expect(result.timings.runs).toBe(5);
      expect(result.timings.p95Ms).toBeGreaterThanOrEqual(result.timings.warmMs);
      expect(result.metrics.rowsReturned).toBe(result.rows.length);
      // Lane B's transport is not instrumented, so it reports no byte count.
      if (result.laneId === 'duckdb-postgres') expect(result.metrics.bytesRead).toBeUndefined();
      else expect(result.metrics.bytesRead).toBeGreaterThan(0);
    }
  });

  it('shows the SQL it ran', () => {
    for (const result of results.get(queryId)!) {
      expect(result.sql).toMatch(/^(SELECT|WITH)\b/);
      expect(result.sql).not.toContain('undefined');
    }
  });
});

describe('the argument the project is making', () => {
  const bytes = (queryId: string, laneId: LaneId): number =>
    results.get(queryId)!.find((r) => r.laneId === laneId)!.metrics.bytesRead!;
  const wall = (queryId: string, laneId: LaneId): number =>
    results.get(queryId)!.find((r) => r.laneId === laneId)!.timings.warmMs;

  it('Q1: the column store reads at least 10x fewer bytes', () => {
    const ratio = bytes('revenue_by_category', 'postgres') / bytes('revenue_by_category', 'duckdb-lake');
    expect(ratio).toBeGreaterThan(10);
  });

  it('Q1: the column store is faster in wall time too', () => {
    expect(wall('revenue_by_category', 'duckdb-lake')).toBeLessThan(wall('revenue_by_category', 'postgres'));
  });

  it('Q1: reads three columns of thirteen, and not one more', () => {
    // Join key, measure, grouping. Everything else in both tables is skipped.
    const lake = results.get('revenue_by_category')!.find((r) => r.laneId === 'duckdb-lake')!;
    expect(lake.metrics.columnsProjected).toEqual(['category', 'product_key', 'revenue']);
  });

  it('Q2: partition pruning opens fewer files than the lake holds', () => {
    const all = results.get('revenue_by_category')!.find((r) => r.laneId === 'duckdb-lake')!.metrics.filesRead!;
    const pruned = results.get('revenue_by_month_filtered')!.find((r) => r.laneId === 'duckdb-lake')!.metrics
      .filesRead!;
    expect(pruned).toBeLessThan(all);
  });

  it('Q7: the row store wins the point lookup, and wins it big', () => {
    const heap = results.get('order_lookup')!.find((r) => r.laneId === 'postgres')!;
    const lake = results.get('order_lookup')!.find((r) => r.laneId === 'duckdb-lake')!;

    expect(heap.timings.warmMs).toBeLessThan(lake.timings.warmMs);
    /*
     * Engine time, not wall time: at a third of a millisecond the TCP round trip is
     * most of lane A's figure, and comparing that with an in-process engine would be
     * measuring the network.
     */
    expect(lake.timings.warmMs / heap.metrics.engineMs!).toBeGreaterThan(100);
  });

  it('Q7: the row store reads a few kilobytes where the lake reads hundreds', () => {
    const heap = results.get('order_lookup')!.find((r) => r.laneId === 'postgres')!;
    const lake = results.get('order_lookup')!.find((r) => r.laneId === 'duckdb-lake')!;
    expect(heap.metrics.bytesRead!).toBeLessThan(lake.metrics.bytesRead!);
  });
});

describe('lane B: what federation pushes down and what it drags over the wire', () => {
  const laneB = (queryId: string): LaneResult =>
    results.get(queryId)!.find((r) => r.laneId === 'duckdb-postgres')!;

  it('pushes the projection down: only the columns the query names cross the wire', () => {
    expect(laneB('revenue_by_category').metrics.columnsProjected).toEqual([
      'category',
      'product_key',
      'revenue',
    ]);
  });

  it('pushes the date range down, so Postgres does the filtering', () => {
    const metrics = laneB('revenue_by_month_filtered').metrics;
    expect(metrics.filtersPushed).toContain('order_ts>=');
    expect(metrics.filtersPushed).toContain('order_ts<');
  });

  it('pushes the point lookup down, so the b-tree still gets used', () => {
    expect(laneB('order_lookup').metrics.filtersPushed).toContain('order_id=');
    expect(laneB('order_lookup').metrics.rowsScanned).toBe(3);
  });

  it('does NOT push the aggregate down: a million rows cross the wire for eight', () => {
    const result = laneB('revenue_by_category');
    expect(result.metrics.filtersPushed).toBeUndefined();
    expect(result.metrics.rowsScanned).toBe(result.metrics.rowsScanned);
    expect(result.metrics.rowsScanned).toBeGreaterThan(100 * result.metrics.rowsReturned);
  });

  it('is beaten by the lake on the query with no predicate to push', () => {
    const federated = laneB('revenue_by_category').timings.warmMs;
    const lake = results.get('revenue_by_category')!.find((r) => r.laneId === 'duckdb-lake')!.timings.warmMs;
    expect(lake).toBeLessThan(federated);
  });
});
