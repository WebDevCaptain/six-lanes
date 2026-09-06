import { NextResponse } from 'next/server';

import { runCatalogue } from '@/bench/run-catalogue';
import { DEFAULT_PARAMS, QUERIES, type QueryId } from '@/queries/index';
import { withServerLanes } from '../lanes';

export const runtime = 'nodejs';
/** Every request measures; a cached benchmark is not a benchmark. */
export const dynamic = 'force-dynamic';

/**
 * Runs lanes A, B and C over one question.
 *
 * The query is chosen by id from a fixed catalogue. There is no endpoint that accepts
 * SQL and there will not be one: this is reachable from a browser.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const { queryId } = (await request.json()) as { queryId?: string };
  if (!queryId || !(queryId in QUERIES)) {
    return NextResponse.json({ error: `unknown question: ${String(queryId)}` }, { status: 400 });
  }

  const rows = await withServerLanes((lanes) =>
    runCatalogue(lanes, DEFAULT_PARAMS, [queryId as QueryId]),
  );
  return NextResponse.json({ rows });
}
