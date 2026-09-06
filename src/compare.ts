import { appendFileSync } from 'node:fs';

import { BENCH } from './bench/measure';
import { disagreements, runCatalogue, type MeasuredRow } from './bench/run-catalogue';
import {
  formatBytes,
  formatCount,
  formatMs,
  renderMarkdownTable,
  renderTable,
  type Column,
} from './bench/table';
import { DATASET, PATHS } from './config';
import { describeHost } from './host';
import { BASELINE_LANE, LANE_META, openAvailableLanes } from './lanes/index';
import { DEFAULT_PARAMS, QUERY_IDS, getQuery } from './queries/index';
import type { LaneId } from './types';

/**
 * `pnpm compare` - runs every available lane over every query, checks that they
 * agree, and prints the table. `--write` appends the run to docs/results.md.
 *
 * Exits non-zero when a lane disagrees with lane A, and withholds that lane's
 * timing: a published number next to a wrong answer is worse than no number.
 */
const LANES_TO_RUN: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake'];

const COLUMNS: readonly Column<MeasuredRow>[] = [
  { header: 'query', value: ({ queryId }) => queryId },
  {
    header: 'lane',
    value: ({ result }) => `${LANE_META[result.laneId].letter}  ${LANE_META[result.laneId].label}`,
  },
  {
    header: 'median',
    align: 'right',
    value: ({ result, agrees }) => (agrees ? formatMs(result.timings.warmMs) : 'withheld'),
  },
  {
    header: 'p95',
    align: 'right',
    value: ({ result, agrees }) => (agrees ? formatMs(result.timings.p95Ms) : '-'),
  },
  {
    header: 'engine',
    align: 'right',
    value: ({ result }) =>
      result.metrics.engineMs === undefined ? '-' : formatMs(result.metrics.engineMs),
  },
  { header: 'bytes read', align: 'right', value: ({ result }) => formatBytes(result.metrics.bytesRead) },
  { header: 'rows scanned', align: 'right', value: ({ result }) => formatCount(result.metrics.rowsScanned) },
  { header: 'returned', align: 'right', value: ({ result }) => formatCount(result.metrics.rowsReturned) },
  { header: 'files', align: 'right', value: ({ result }) => formatCount(result.metrics.filesRead) },
];

const lanes = await openAvailableLanes(LANES_TO_RUN);
if (!lanes.some((lane) => lane.id === BASELINE_LANE)) {
  throw new Error(`baseline lane ${BASELINE_LANE} is unavailable - run \`pnpm services && pnpm load\``);
}

const host = describeHost();
const parameters = `from=${DEFAULT_PARAMS.from}  to=${DEFAULT_PARAMS.to}  order_id=${DEFAULT_PARAMS.orderId}`;
const protocol = `${BENCH.timedRuns} timed runs per cell after ${BENCH.warmupRuns} warm-up; median and p95, never a mean.`;

const rows = await runCatalogue(lanes, DEFAULT_PARAMS);
for (const lane of lanes) await lane.close();

console.log(`${host}\n`);
console.log(`parameters  ${parameters}\n`);
console.log(renderTable(COLUMNS, rows));
console.log(`\n${DATASET.orderItems.toLocaleString('en-US')} line items. ${protocol}`);

for (const queryId of QUERY_IDS) console.log(`  ${queryId.padEnd(26)}${getQuery(queryId).concept}`);

console.log(`\n${describePushdown()}`);

const failed = disagreements(rows);
if (failed.length > 0) {
  console.error(`\n${failed.length} lane/query pair(s) disagreed with lane A:\n`);
  for (const row of failed) {
    console.error(`  ${row.queryId} / lane ${LANE_META[row.result.laneId].letter}: ${row.disagreement}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nall lanes agree with lane A on every query.');
  if (process.argv.includes('--write')) writeResults();
}

/**
 * What each lane got its storage layer to do for it, which is the whole subject of
 * lane B: federation's bet is that the remote side filters, and the rows that still
 * crossed the wire say how the bet paid off.
 */
function describePushdown(): string {
  const lines = ['pushdown, per lane:'];

  for (const { queryId, result } of rows) {
    const { columnsProjected, filtersPushed, rowsScanned, rowsReturned } = result.metrics;
    if (columnsProjected === undefined) continue;

    lines.push(
      `  ${LANE_META[result.laneId].letter}  ${queryId}`,
      `       projects  ${columnsProjected.join(', ')}`,
      `       filters   ${filtersPushed ?? 'none pushed down'}`,
      `       rows      ${formatCount(rowsScanned)} scanned to return ${formatCount(rowsReturned)}`,
    );
  }
  return lines.join('\n');
}

/** Appends the run to the lab notebook. Never rewrites history, only adds to it. */
function writeResults(): void {
  const section = [
    ``,
    `### ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC - ${DATASET.orderItems.toLocaleString('en-US')} line items`,
    ``,
    `\`${host}\``,
    ``,
    `Parameters: \`${parameters}\``,
    ``,
    renderMarkdownTable(COLUMNS, rows),
    ``,
    protocol,
    ``,
  ].join('\n');

  appendFileSync(PATHS.results, section);
  console.log(`appended to ${PATHS.results}`);
}
