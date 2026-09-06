import { NextResponse } from 'next/server';

import { sliceReference } from '@/lanes/slice-reference';
import { DEFAULT_PARAMS, QUERIES, type QueryId } from '@/queries/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The rows lanes D and E are checked against.
 *
 * The browser cannot check itself against lane A: lane A answers over the whole
 * dataset and the browser holds a slice. This returns the same query run
 * server-side over the exact Parquet the browser downloaded, so the two are
 * comparable and the correctness gate still means something in the tab.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const queryId = new URL(request.url).searchParams.get('queryId');
  if (!queryId || !(queryId in QUERIES)) {
    return NextResponse.json({ error: `unknown question: ${String(queryId)}` }, { status: 400 });
  }

  const rows = await (await sliceReference()).run(queryId as QueryId, DEFAULT_PARAMS);
  return NextResponse.json({ rows });
}
