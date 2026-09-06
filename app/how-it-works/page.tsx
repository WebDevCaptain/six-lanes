import Link from 'next/link';

import { LANE_META, LANE_ORDER } from '@/lanes/meta';
import { QUERIES, QUERY_IDS } from '@/queries/index';

export const metadata = { title: 'How it works - OLAP Lab' };

/**
 * The page that answers "why should I believe any of this".
 *
 * Every claim on the race page depends on a measurement rule, and every rule is
 * enforced somewhere in the repository rather than promised here. This page names
 * the file for each one.
 */
export default function HowItWorks() {
  return (
    <main className="page prose">
      <header className="masthead">
        <div>
          <h1>How it works</h1>
          <p className="lede">
            What each lane is, what it gives up, and how the numbers beside it were obtained.
          </p>
        </div>
        <div className="environment">
          <Link href="/">Back to the race</Link>
          <br />
          <Link href="/bench">Local bench</Link>
        </div>
      </header>

      <h2>The six lanes</h2>
      <p>
        A lane is one implementation of the same query catalogue. They differ in engine and in
        where the bytes live, and in nothing else: the SQL comes from one place, and one wrapper
        decides how all of them are timed.
      </p>
      <table className="plain">
        <thead>
          <tr>
            <th>Lane</th>
            <th>Engine</th>
            <th>Runs on</th>
            <th>Reads from</th>
            <th>Shows</th>
          </tr>
        </thead>
        <tbody>
          {LANE_ORDER.map((id) => {
            const lane = LANE_META[id];
            return (
              <tr key={id}>
                <td>{lane.letter}</td>
                <td>{lane.engine}</td>
                <td>{lane.runsOn}</td>
                <td>{lane.readsFrom}</td>
                <td>{lane.demonstrates}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>The seven questions</h2>
      <table className="plain">
        <thead>
          <tr>
            <th>Question</th>
            <th>What it exercises</th>
          </tr>
        </thead>
        <tbody>
          {QUERY_IDS.map((id) => (
            <tr key={id}>
              <td>{QUERIES[id].question}</td>
              <td>{QUERIES[id].concept}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>How the numbers are produced</h2>
      <p>
        <strong>Correctness gates publication.</strong> A lane&apos;s timing is shown only if its
        rows match the reference exactly, compared row by row after normalising every value to one
        canonical form. Money never becomes a floating point number on the way through. Lanes A, B
        and C are checked against lane A over the whole dataset; lanes D and E are checked against
        the same query run server-side over the exact Parquet the browser downloaded.
      </p>
      <p>
        <strong>Median of five, never a mean.</strong> One warm-up, then five timed runs. The page
        shows the median and the slowest of the five. A mean would let one scheduler hiccup move a
        published number.
      </p>
      <p>
        <strong>Bytes read comes from the engine.</strong> Postgres reports it through{' '}
        <code>EXPLAIN (ANALYZE, BUFFERS)</code>; DuckDB through its JSON query profile; PGlite
        through the same EXPLAIN as Postgres; DuckDB-WASM through the browser&apos;s Resource
        Timing, which counts what actually crossed the network. Collecting it is a separate pass
        outside the timed loop, because asking an engine to account for itself changes what it
        costs.
      </p>
      <p>
        <strong>Handicaps sit next to the numbers they qualify.</strong> Lanes A and B query the
        transactional database directly, which is the thing the rest of the project argues against;
        they are here as the case that motivates the others. PGlite has no parallel workers. The
        browser lanes hold a slice, not the whole dataset. All of it is printed on the race page
        rather than in a footnote.
      </p>

      <h2>Why bytes and not just milliseconds</h2>
      <p>
        Milliseconds are a fact about a particular machine on a particular afternoon. Bytes read is
        a fact about the storage layout, and it is the number that survives being carried to
        somebody else&apos;s hardware. When a column store answers a question having read three
        columns of thirteen, that ratio holds wherever it runs.
      </p>
      <p>
        Which is also why the one query the row store wins is on this page. A comparison that never
        loses is marketing. Ask for a single order by id and the column store has to reassemble a
        row from twelve separate places, while a b-tree walks straight to it.
      </p>
    </main>
  );
}
