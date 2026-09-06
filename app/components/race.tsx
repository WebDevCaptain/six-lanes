'use client';

import { useCallback, useMemo, useState } from 'react';

import { findMismatches } from '@/bench/compare';
import type { BrowserLane } from '@/browser/duckdb-wasm';
import type { Preparation, SliceManifest } from '@/browser/slice';
import type { LaneMeta } from '@/lanes/meta';
import { LANE_ORDER } from '@/lanes/meta';
import { DEFAULT_PARAMS, type QueryId } from '@/queries/index';
import type { LaneId, LaneResult, Row } from '@/types';
import { LaneTrack } from './lane-track';
import { formatBytes, formatMs } from './format';

export interface QuestionSummary {
  readonly id: QueryId;
  readonly question: string;
  readonly concept: string;
}

interface RaceProps {
  readonly questions: readonly QuestionSummary[];
  readonly lanes: Record<LaneId, LaneMeta>;
  readonly slice: SliceManifest | null;
  readonly host: string;
}

/** A lane's result plus whether it is allowed to be believed. */
export interface Finished {
  readonly result: LaneResult;
  readonly agrees: boolean;
  readonly disagreement?: string;
}

export function Race({ questions, lanes, slice, host }: RaceProps) {
  const [selected, setSelected] = useState<QueryId>(questions[0]!.id);
  const [finished, setFinished] = useState<readonly Finished[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browser = useBrowserLanes(slice);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setFinished([]);
    try {
      setFinished([...(await runServerLanes(selected)), ...(await browser.run(selected))]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [browser, selected]);

  const ordered = useMemo(
    () => [...finished].sort((a, b) => LANE_ORDER.indexOf(a.result.laneId) - LANE_ORDER.indexOf(b.result.laneId)),
    [finished],
  );
  // One scale across every lane, or the bars would compare each lane with itself.
  const widest = Math.max(1, ...ordered.map((entry) => entry.result.metrics.bytesRead ?? 0));
  const disagreeing = ordered.filter((entry) => !entry.agrees);

  /**
   * Two engines that both return nothing agree perfectly and prove nothing.
   *
   * This happened for real: the browser slice was cut from the end of the dataset
   * while the questions ask about a window in the middle, so lanes D and E answered
   * every range query with an empty result and the page called it success. The slice
   * is now cut from inside the window, and this notices if that ever stops being
   * true.
   */
  const serverAnswered = ordered.some(
    (entry) => BROWSER_LANES.indexOf(entry.result.laneId) === -1 && entry.result.rows.length > 0,
  );
  const vacuous = ordered.filter(
    (entry) => BROWSER_LANES.indexOf(entry.result.laneId) !== -1 && entry.result.rows.length === 0,
  );

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>Pick a question</h2>
          <span className="note">the same seven every lane answers</span>
        </div>

        <div className="questions">
          {questions.map((question) => (
            <button
              key={question.id}
              type="button"
              className="question"
              aria-pressed={question.id === selected}
              onClick={() => setSelected(question.id)}
            >
              <span className="name">{question.question}</span>
              <span className="concept">{question.concept}</span>
            </button>
          ))}
        </div>

        <div className="controls">
          <button type="button" className="run" onClick={() => void run()} disabled={running}>
            {running ? 'Running' : 'Run'}
          </button>

          {slice ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => void browser.load()}
                disabled={browser.state !== 'idle'}
              >
                {browserButtonLabel(browser.state)}
              </button>
              <span className="hint">
                {browser.state === 'ready'
                  ? `${browser.rows.toLocaleString('en-US')} rows in the tab. Lanes D and E now race too.`
                  : `Lanes D and E run in this tab. Loading them downloads ${formatBytes(
                      slice.parquet.bytes,
                    )} of Parquet and ${formatBytes(slice.pglite.bytes)} of Postgres, for ${(
                      slice.rows['fact_order_item'] ?? 0
                    ).toLocaleString('en-US')} rows.`}
              </span>
            </>
          ) : (
            <span className="hint">
              Run <code>pnpm slice</code> to enable the two browser lanes.
            </span>
          )}
        </div>
      </section>

      {browser.prepared.length > 0 ? (
        <section className="section">
          <div className="section-head">
            <h2>What the browser paid before answering anything</h2>
            <span className="note">
              the data slice only; each engine&apos;s WebAssembly runtime is a separate,
              CDN-cached download
            </span>
          </div>
          <table className="plain">
            <thead>
              <tr>
                <th>Lane</th>
                <th>Engine</th>
                <th className="num">Downloaded</th>
                <th className="num">Download</th>
                <th className="num">Start up</th>
                <th className="num">Rows in the tab</th>
              </tr>
            </thead>
            <tbody>
              {browser.prepared.map(({ laneId, preparation }) => (
                <tr key={laneId}>
                  <td>{lanes[laneId].letter}</td>
                  <td>{preparation.engineVersion}</td>
                  <td className="num">
                    {formatBytes(preparation.bytesDownloaded)}
                    {preparation.fromCache ? ' (cached)' : ''}
                  </td>
                  <td className="num">{formatMs(preparation.downloadMs)}</td>
                  <td className="num">{formatMs(preparation.initialiseMs)}</td>
                  <td className="num">{preparation.rows.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Bytes read</h2>
          {ordered.length > 0 ? (
            <span className="note">shared scale, widest bar is {formatBytes(widest)}</span>
          ) : null}
        </div>

        {error ? <p className="verdict bad">{error}</p> : null}
        {browser.error ? <p className="verdict bad">{browser.error}</p> : null}

        {ordered.length === 0 && !error ? (
          <p className="pending">
            {running ? 'Measuring: one warm-up then five timed runs per lane.' : 'Press Run.'}
          </p>
        ) : null}

        {ordered.map((entry) => (
          <LaneTrack
            key={entry.result.laneId}
            entry={entry}
            meta={lanes[entry.result.laneId]}
            widestBytes={widest}
          />
        ))}

        {ordered.length > 0 ? (
          <p className={disagreeing.length > 0 || (serverAnswered && vacuous.length > 0) ? 'verdict bad' : 'verdict'}>
            {disagreeing.length > 0
              ? `${disagreeing.length} lane(s) returned different rows, so their timings are withheld.`
              : serverAnswered && vacuous.length > 0
                ? `${vacuous.length} browser lane(s) returned no rows while the server lanes returned some. The slice does not cover this question, so their agreement means nothing - rebuild it with \`pnpm slice\`.`
                : `Every lane returned identical rows. Measured on ${host}.`}
          </p>
        ) : null}
      </section>
    </>
  );
}

async function runServerLanes(queryId: QueryId): Promise<Finished[]> {
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queryId }),
  });
  if (!response.ok) throw new Error(`the server could not run this question (${response.status})`);

  const body = (await response.json()) as {
    results: LaneResult[];
    mismatches: { laneId: string; detail: string }[];
  };

  return body.results.map((result) => {
    const mismatch = body.mismatches.find((entry) => entry.laneId === result.laneId);
    return mismatch ? { result, agrees: false, disagreement: mismatch.detail } : { result, agrees: true };
  });
}

const BROWSER_LANES: readonly LaneId[] = ['duckdb-wasm', 'pglite'];

type BrowserState = 'idle' | 'loading' | 'ready';

interface BrowserLanes {
  readonly state: BrowserState;
  readonly rows: number;
  readonly prepared: readonly { laneId: LaneId; preparation: Preparation }[];
  readonly error: string | null;
  load(): Promise<void>;
  run(queryId: QueryId): Promise<Finished[]>;
}

/**
 * Lanes D and E, loaded on request.
 *
 * Not on page load: between them they download tens of megabytes, and starting that
 * without being asked would be rude and would also hide the cost this page exists to
 * show. The button says what the download is before it happens.
 */
function useBrowserLanes(slice: SliceManifest | null): BrowserLanes {
  const [state, setState] = useState<BrowserState>('idle');
  const [lanes, setLanes] = useState<readonly BrowserLane[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slice || state !== 'idle') return;
    setState('loading');
    setError(null);
    try {
      // Imported here so neither engine's WebAssembly is in the initial bundle.
      const [{ createDuckDBWasmLane }, { createPGliteLane }] = await Promise.all([
        import('@/browser/duckdb-wasm'),
        import('@/browser/pglite'),
      ]);
      setLanes([await createDuckDBWasmLane(slice), await createPGliteLane(slice)]);
      setState('ready');
    } catch (cause) {
      setError(`browser lanes failed to load: ${cause instanceof Error ? cause.message : String(cause)}`);
      setState('idle');
    }
  }, [slice, state]);

  const run = useCallback(
    async (queryId: QueryId): Promise<Finished[]> => {
      if (lanes.length === 0) return [];

      const expected = await fetchReference(queryId);
      const finished: Finished[] = [];
      for (const lane of lanes) {
        const result = await lane.run(queryId, DEFAULT_PARAMS);
        // Checked against the slice, not against lane A: lane A answers over the
        // whole dataset and these two hold a slice of it.
        const [mismatch] = findMismatches({ ...result, rows: expected }, [result]);
        finished.push(
          mismatch ? { result, agrees: false, disagreement: mismatch.detail } : { result, agrees: true },
        );
      }
      return finished;
    },
    [lanes],
  );

  return {
    state,
    rows: lanes[0]?.preparation.rows ?? 0,
    prepared: lanes.map((lane) => ({ laneId: lane.id, preparation: lane.preparation })),
    error,
    load,
    run,
  };
}

async function fetchReference(queryId: QueryId): Promise<Row[]> {
  const response = await fetch(`/api/reference?queryId=${encodeURIComponent(queryId)}`);
  if (!response.ok) throw new Error('could not fetch the rows to check the browser lanes against');
  return ((await response.json()) as { rows: Row[] }).rows;
}

const browserButtonLabel = (state: BrowserState): string =>
  state === 'ready' ? 'Browser lanes loaded' : state === 'loading' ? 'Loading engines' : 'Load browser lanes';
