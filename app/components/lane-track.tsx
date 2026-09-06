'use client';

import type { LaneMeta } from '@/lanes/meta';
import type { Finished } from './race';
import { formatBytes, formatCount, formatMs } from './format';

interface LaneTrackProps {
  readonly entry: Finished;
  readonly meta: LaneMeta;
  readonly widestBytes: number;
}

/**
 * One lane's result.
 *
 * The bar is bytes read on a scale shared with every other lane, which is the only
 * way the comparison means anything. A lane that cannot report bytes honestly - lane
 * B reads over the Postgres wire protocol, which DuckDB does not instrument - gets no
 * bar rather than a zero-length one, because those are different claims.
 */
export function LaneTrack({ entry, meta, widestBytes }: LaneTrackProps) {
  const { result, agrees, disagreement } = entry;
  const { metrics, timings } = result;
  const bytes = metrics.bytesRead;

  return (
    <article className="track" style={{ ['--lane' as string]: `var(--lane-${result.laneId})` }}>
      <span className="letter" aria-hidden>
        {meta.letter}
      </span>

      <div className="who">
        <div className="label">{meta.label}</div>
        <div className="where">{meta.readsFrom}</div>
      </div>

      <div className="bar-row">
        <div className="bar">
          <span
            className="fill"
            style={{ ['--share' as string]: bytes === undefined ? 0 : bytes / widestBytes }}
          />
        </div>
        <span className={bytes === undefined ? 'bytes absent' : 'bytes'}>
          {bytes === undefined ? 'not instrumented' : formatBytes(bytes)}
        </span>
      </div>

      {agrees ? (
        <div className="facts">
          <span>
            <b>{formatMs(timings.warmMs)}</b> median
          </span>
          <span>{formatMs(timings.p95Ms)} slowest of {timings.runs}</span>
          {metrics.engineMs === undefined ? null : (
            <span>{formatMs(metrics.engineMs)} in the engine</span>
          )}
          <span>
            {formatCount(metrics.rowsScanned)} scanned, <b>{formatCount(metrics.rowsReturned)}</b>{' '}
            returned
          </span>
          {metrics.filesRead === undefined ? null : <span>{metrics.filesRead} files opened</span>}
        </div>
      ) : (
        <div className="facts">
          <span>
            <b>timing withheld</b> - this lane disagreed: {disagreement}
          </span>
        </div>
      )}

      {meta.handicaps.length > 0 ? (
        <ul className="handicaps">
          {meta.handicaps.map((handicap) => (
            <li key={handicap}>{handicap}</li>
          ))}
        </ul>
      ) : null}

      <details className="sql">
        <summary>
          the exact statement it ran
          {result.params.length > 0 ? `, with ${result.params.length} bound parameter(s)` : ''}
        </summary>
        <pre>
          <code>{result.sql}</code>
          {result.params.length > 0 ? `\n\n-- ${result.params.map(String).join('\n-- ')}` : ''}
        </pre>
      </details>
    </article>
  );
}
