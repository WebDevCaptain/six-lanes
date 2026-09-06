import { NextResponse } from 'next/server';

import { findMismatches } from '@/bench/compare';
import { BASELINE_LANE } from '@/lanes/meta';
import { DEFAULT_PARAMS, QUERIES, type QueryId } from '@/queries/index';
import type { LaneResult } from '@/types';
import { serverLanes } from '../lanes';

export const runtime = 'nodejs';
/** Every request measures; a cached benchmark is not a benchmark. */
export const dynamic = 'force-dynamic';

/**
 * Runs lanes A, B and C over one question and returns their results.
 *
 * The query is chosen by id from a fixed catalogue. There is no endpoint that accepts
 * SQL, and there will not be one: this is reachable from a browser, and "let the
 * caller pass a query" is not a feature.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const { queryId } = (await request.json()) as { queryId?: string };
  if (!queryId || !(queryId in QUERIES)) {
    return NextResponse.json({ error: `unknown question: ${String(queryId)}` }, { status: 400 });
  }

  const lanes = await serverLanes();
  const results: LaneResult[] = [];
  for (const lane of lanes) results.push(await lane.run(queryId as QueryId, DEFAULT_PARAMS));

  const baseline = results.find((result) => result.laneId === BASELINE_LANE);
  const mismatches = baseline
    ? findMismatches(baseline, results.filter((result) => result !== baseline))
    : [];

  // Plan section 9 rule 1: a lane that disagrees does not get to show a timing.
  return NextResponse.json({ results, mismatches });
}
