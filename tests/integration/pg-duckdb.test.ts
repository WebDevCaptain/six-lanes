import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findMismatches } from '../../src/bench/compare';
import { PGDUCKDB_URL } from '../../src/config';
import { openLane } from '../../src/lanes/index';
import { isReachable } from '../../src/postgres/load-star';
import { DEFAULT_PARAMS, QUERY_IDS } from '../../src/queries/index';
import type { Lane, LaneResult } from '../../src/types';

/**
 * Lane F, and the reason it needs watching.
 *
 * pg_duckdb accepts every statement. When DuckDB cannot translate one it emits a
 * warning no client surfaces, plans it the ordinary Postgres way, and returns the
 * right answer at Postgres speed. Without the executor check, lane F would publish
 * plain-Postgres timings under a DuckDB heading and nothing would look wrong.
 *
 * Skipped when the container is not running: lane F cannot be deployed anywhere, so
 * the rest of the project has to work without it.
 */
const available = await isReachable(PGDUCKDB_URL);

describe.skipIf(!available)('lane F: pg_duckdb', () => {
  let lane: Lane;
  const results = new Map<string, LaneResult>();
  let baseline: Lane;
  const baselineResults = new Map<string, LaneResult>();

  beforeAll(async () => {
    lane = await openLane('pg-duckdb');
    baseline = await openLane('postgres');
    for (const queryId of QUERY_IDS) {
      results.set(queryId, await lane.run(queryId, DEFAULT_PARAMS));
      baselineResults.set(queryId, await baseline.run(queryId, DEFAULT_PARAMS));
    }
  });

  afterAll(async () => {
    await lane?.close();
    await baseline?.close();
  });

  it('agrees with lane A on every query, whichever engine ran it', () => {
    for (const queryId of QUERY_IDS) {
      expect(findMismatches(baselineResults.get(queryId)!, [results.get(queryId)!])).toEqual([]);
    }
  });

  it('reports which engine actually executed each query', () => {
    for (const queryId of QUERY_IDS) {
      expect(results.get(queryId)!.metrics.executedBy).toMatch(/^(DuckDB|Postgres \(DuckDB declined\))$/);
    }
  });

  it('does hand some queries to DuckDB, or the lane is pointless', () => {
    const onDuckDB = QUERY_IDS.filter((id) => results.get(id)!.metrics.executedBy === 'DuckDB');
    expect(onDuckDB.length).toBeGreaterThan(0);
  });

  it('does decline some, which is the whole reason the check exists', () => {
    // Four of the seven group by month via to_char, which DuckDB does not implement.
    // If this ever stops being true the finding has changed and the write-up is stale.
    const declined = QUERY_IDS.filter((id) => results.get(id)!.metrics.executedBy !== 'DuckDB');
    expect(declined.length).toBeGreaterThan(0);
  });

  it('runs a declined query at about lane A speed, because it is lane A', () => {
    const declined = QUERY_IDS.filter((id) => results.get(id)!.metrics.executedBy !== 'DuckDB');
    for (const queryId of declined) {
      const ratio = results.get(queryId)!.timings.warmMs / baselineResults.get(queryId)!.timings.warmMs;
      // Generous bounds: this is a corroboration of the plan check, not a timing test.
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(2.5);
    }
  });
});
