import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Link from 'next/link';

import { PATHS } from '@/config';
import { LANE_META } from '@/lanes/meta';
import type { HostSpec } from '@/host';
import type { LaneId, QueryMetrics, Timings } from '@/types';
import { formatBytes, formatCount, formatMs } from '../components/format';

export const metadata = { title: 'Local bench - OLAP Lab' };
export const dynamic = 'force-dynamic';

/**
 * The lane that cannot be deployed.
 *
 * pg_duckdb needs `shared_preload_libraries`, which no managed Postgres allows, so
 * lane F can only ever be measured on a machine somebody owns. Its numbers are
 * committed to bench/results/ by `pnpm bench` and rendered here, labelled as locally
 * measured and stamped with the machine, rather than being quietly mixed in with the
 * live lanes on the race page.
 */
interface BenchRecord {
  readonly measuredAt: string;
  readonly host: HostSpec;
  readonly dataset: { rows: number; seed: number; from: string; to: string };
  readonly protocol: { warmupRuns: number; timedRuns: number };
  readonly results: readonly {
    queryId: string;
    concept: string;
    laneId: LaneId;
    agreesWithBaseline: boolean;
    timings: Timings;
    metrics: QueryMetrics;
  }[];
}

export default async function BenchPage() {
  const record = await latestRecord();

  if (!record) {
    return (
      <main className="page prose">
        <h1>Local bench</h1>
        <p>
          No results recorded yet. Run <code>pnpm up:pgduckdb</code>, then{' '}
          <code>pnpm load</code> and <code>pnpm bench</code>.
        </p>
        <p>
          <Link href="/">Back to the race</Link>
        </p>
      </main>
    );
  }

  const byQuery = new Map<string, BenchRecord['results'][number][]>();
  for (const row of record.results) {
    byQuery.set(row.queryId, [...(byQuery.get(row.queryId) ?? []), row]);
  }

  return (
    <main className="page prose">
      <header className="masthead">
        <div>
          <h1>Local bench</h1>
          <p className="lede">
            Every server lane on one machine and one dataset, including the one that cannot be
            deployed anywhere.
          </p>
        </div>
        <div className="environment">
          <dl>
            <dt>machine</dt>
            <dd>
              {record.host.cpu}, {record.host.cores} cores
            </dd>
            <dt>dataset</dt>
            <dd>{record.dataset.rows.toLocaleString('en-US')} line items, seed {record.dataset.seed}</dd>
            <dt>protocol</dt>
            <dd>
              median of {record.protocol.timedRuns} after {record.protocol.warmupRuns} warm-up
            </dd>
            <dt>measured</dt>
            <dd>{record.measuredAt.slice(0, 10)}</dd>
          </dl>
        </div>
      </header>

      <p>
        These are not live. They were measured by <code>pnpm bench</code> on the machine named
        above and committed to <code>bench/results/</code>, so any figure quoted elsewhere can be
        traced to the run that produced it. <Link href="/">The race page</Link> measures lanes A to
        E live in front of you.
      </p>

      {[...byQuery].map(([queryId, rows]) => (
        <section key={queryId}>
          <h2>{queryId}</h2>
          <p>{rows[0]?.concept}</p>
          <table className="plain">
            <thead>
              <tr>
                <th>Lane</th>
                <th>Engine</th>
                <th className="num">Median</th>
                <th className="num">p95</th>
                <th className="num">Bytes read</th>
                <th className="num">Rows scanned</th>
                <th>Actually ran on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.laneId}>
                  <td>{LANE_META[row.laneId].letter}</td>
                  <td>{LANE_META[row.laneId].label}</td>
                  <td className="num">
                    {row.agreesWithBaseline ? formatMs(row.timings.warmMs) : 'withheld'}
                  </td>
                  <td className="num">
                    {row.agreesWithBaseline ? formatMs(row.timings.p95Ms) : '-'}
                  </td>
                  <td className="num">{formatBytes(row.metrics.bytesRead)}</td>
                  <td className="num">{formatCount(row.metrics.rowsScanned)}</td>
                  <td>{row.metrics.executedBy ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <h2>Reading the pg_duckdb column</h2>
      <p>
        <strong>pg_duckdb does not fail when DuckDB cannot run something.</strong> It emits a
        warning no client surfaces, plans the query the ordinary Postgres way, and returns the
        right answer at ordinary Postgres speed. On this catalogue, three of the seven queries
        fall back - every one of them because DuckDB has no <code>to_char</code> - and their
        timings land within noise of lane A because they <em>are</em> lane A.
      </p>
      <p>
        That is why the last column exists. Without it, four rows of this table would report plain
        Postgres under a DuckDB heading, and the mistake would be invisible.
      </p>
    </main>
  );
}

/** The newest record on disk. One file per run per machine, named by both. */
async function latestRecord(): Promise<BenchRecord | null> {
  try {
    const files = (await readdir(PATHS.benchResults)).filter((name) => name.endsWith('.json')).sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    return JSON.parse(await readFile(join(PATHS.benchResults, newest), 'utf8')) as BenchRecord;
  } catch {
    return null;
  }
}
