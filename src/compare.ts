import { appendFileSync } from 'node:fs';

import { findMismatches } from './bench/compare';
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
import { DEFAULT_PARAMS, QUERY_IDS, getQuery, type QueryId } from './queries/index';
import type { Lane, LaneId, LaneResult } from './types';

/**
 * `pnpm compare` - runs every available lane over every query, checks that they
 * agree, and prints the one table this project exists to produce.
 *
 * `pnpm compare --write` also appends the run to docs/results.md, so the lab
 * notebook is a by-product of measuring rather than a thing to remember to update.
 *
 * Exits non-zero when any lane disagrees with lane A. That gate is deliberately
 * fatal: a published timing next to a wrong answer is worse than no number at all.
 */
const LANES_TO_RUN: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake'];

interface ResultRow {
  readonly queryId: QueryId;
  readonly result: LaneResult;
}

const COLUMNS: readonly Column<ResultRow>[] = [
  { header: 'query', value: ({ queryId }) => queryId },
  {
    header: 'lane',
    value: ({ result }) => `${LANE_META[result.laneId].letter}  ${LANE_META[result.laneId].label}`,
  },
  { header: 'median', align: 'right', value: ({ result }) => formatMs(result.timings.warmMs) },
  { header: 'p95', align: 'right', value: ({ result }) => formatMs(result.timings.p95Ms) },
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
  throw new Error(`baseline lane ${BASELINE_LANE} is unavailable - run \`pnpm up && pnpm load\``);
}

const host = describeHost();
const parameters = `from=${DEFAULT_PARAMS.from}  to=${DEFAULT_PARAMS.to}  order_id=${DEFAULT_PARAMS.orderId}`;

const rows: ResultRow[] = [];
const failures: string[] = [];

for (const queryId of QUERY_IDS) {
  const results = await runAll(lanes, queryId);
  const baseline = results.find((result) => result.laneId === BASELINE_LANE)!;

  for (const mismatch of findMismatches(baseline, results.filter((r) => r !== baseline))) {
    failures.push(`${queryId} / lane ${LANE_META[mismatch.laneId as LaneId].letter}: ${mismatch.detail}`);
  }
  rows.push(...results.map((result) => ({ queryId, result })));
}

for (const lane of lanes) await lane.close();

console.log(`${host}\n`);
console.log(`parameters  ${parameters}\n`);
console.log(renderTable(COLUMNS, rows));
console.log(`\n${DATASET.orderItems.toLocaleString()} line items. ${describeProtocol()}`);

for (const queryId of QUERY_IDS) console.log(`  ${queryId.padEnd(26)}${getQuery(queryId).concept}`);

console.log(`\n${describePushdown()}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} lane(s) disagreed with lane A:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nall lanes agree with lane A on every query.');
  if (process.argv.includes('--write')) writeResults();
}

async function runAll(lanes: readonly Lane[], queryId: QueryId): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const lane of lanes) results.push(await lane.run(queryId, DEFAULT_PARAMS));
  return results;
}

function describeProtocol(): string {
  const runs = rows[0]?.result.timings.runs ?? 0;
  return `${runs} timed runs per cell after 1 warm-up; median and p95, never a mean.`;
}

/**
 * What each lane got its storage layer to do for it.
 *
 * This is the whole subject of lane B. Federation's bet is that the remote side
 * does the filtering; the rows that still crossed the wire say how the bet paid off.
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
    `### ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC - ${DATASET.orderItems.toLocaleString()} line items`,
    ``,
    `\`${host}\``,
    ``,
    `Parameters: \`${parameters}\``,
    ``,
    renderMarkdownTable(COLUMNS, rows),
    ``,
    describeProtocol(),
    ``,
  ].join('\n');

  appendFileSync(PATHS.results, section);
  console.log(`appended to ${PATHS.results}`);
}
