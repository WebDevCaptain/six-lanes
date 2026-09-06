import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findMismatches } from '../../src/bench/compare.js';
import { BASELINE_LANE, openAvailableLanes } from '../../src/lanes/index.js';
import { DEFAULT_PARAMS, QUERY_IDS } from '../../src/queries/index.js';
import type { Lane, LaneId, LaneResult } from '../../src/types.js';

/**
 * The gate from plan section 9 rule 1, as a test rather than a promise.
 *
 * Needs the containers up and the data loaded:
 *   pnpm up && pnpm generate && pnpm load && pnpm test:integration
 */
const LANES: readonly LaneId[] = ['postgres', 'duckdb-lake'];

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
      expect(result.metrics.bytesRead).toBeGreaterThan(0);
    }
  });

  it('shows the SQL it ran', () => {
    for (const result of results.get(queryId)!) {
      expect(result.sql).toMatch(/^SELECT/);
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

  it('Q1: only the two columns the query mentions are read', () => {
    const lake = results.get('revenue_by_category')!.find((r) => r.laneId === 'duckdb-lake')!;
    expect(lake.metrics.columnsRead).toEqual(['category', 'revenue']);
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
    // Engine time, not wall time: at a third of a millisecond the TCP round trip
    // is most of lane A's wall figure, and comparing that to an in-process engine
    // would be measuring the network.
    expect(lake.timings.warmMs / heap.metrics.engineMs!).toBeGreaterThan(100);
  });

  it('Q7: the row store reads a few kilobytes where the lake reads hundreds', () => {
    const heap = results.get('order_lookup')!.find((r) => r.laneId === 'postgres')!;
    const lake = results.get('order_lookup')!.find((r) => r.laneId === 'duckdb-lake')!;
    expect(heap.metrics.bytesRead!).toBeLessThan(lake.metrics.bytesRead!);
  });
});
