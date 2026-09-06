import Link from 'next/link';

import { DATASET } from '@/config';
import { describeHost, hostSpec } from '@/host';
import { LANE_META } from '@/lanes/meta';
import { QUERIES, QUERY_IDS, DEFAULT_PARAMS } from '@/queries/index';
import { Race } from './components/race';
import { readSliceManifest } from './slice-manifest';

export const dynamic = 'force-dynamic';

/**
 * The race page.
 *
 * Everything static is resolved here on the server - the question catalogue, the lane
 * descriptions, the host, what the browser slice contains - and handed to one client
 * component that does the running. Nothing about the measurement itself is decided
 * in the browser except when to start.
 */
export default async function Page() {
  const host = hostSpec();
  const slice = await readSliceManifest();

  const questions = QUERY_IDS.map((id) => ({
    id,
    question: QUERIES[id].question,
    concept: QUERIES[id].concept,
  }));

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>The same question, six ways</h1>
          <p className="lede">
            One e-commerce dataset, one question at a time, answered by engines that store it
            differently. The bars are bytes read. That is the number that travels.
          </p>
        </div>
        <div className="environment">
          <dl>
            <dt>machine</dt>
            <dd>
              {host.cpu}, {host.cores} cores
            </dd>
            <dt>dataset</dt>
            <dd>{DATASET.orderItems.toLocaleString('en-US')} line items, 24 months</dd>
            <dt>window</dt>
            <dd>
              {DEFAULT_PARAMS.from.slice(0, 10)} to {DEFAULT_PARAMS.to.slice(0, 10)}
            </dd>
            <dt>measured</dt>
            <dd>{host.measuredAt}</dd>
          </dl>
        </div>
      </header>

      <Race questions={questions} lanes={LANE_META} slice={slice} host={describeHost(host)} />

      <section className="section prose">
        <h2>Reading this page</h2>
        <p>
          Every lane runs the same logical query from the same catalogue, and no lane&apos;s timing
          is shown unless its rows match lane A exactly. If a lane disagrees, the page says so
          instead of showing a number.
        </p>
        <p>
          Timings are the median of five runs after a warm-up, alongside the slowest of the five.
          Bytes read comes from the engine itself, collected in a separate pass so that measuring
          does not change what is measured.{' '}
          <Link href="/how-it-works">How it works</Link> has the details, including what each lane
          gives up.
        </p>
      </section>
    </main>
  );
}
