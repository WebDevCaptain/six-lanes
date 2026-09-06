import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BENCH } from './bench/measure';
import { disagreements, runCatalogue, type MeasuredRow } from './bench/run-catalogue';
import { formatBytes, formatCount, formatMs, renderTable, type Column } from './bench/table';
import { DATASET, PATHS } from './config';
import { hostSpec, describeHost, type HostSpec } from './host';
import { LANE_META, openAvailableLanes } from './lanes/index';
import { DEFAULT_PARAMS, getQuery } from './queries/index';
import type { LaneId } from './types';

/**
 * `pnpm bench` - every server lane on one machine and one dataset, committed to
 * bench/results/ so any published number traces back to the run that produced it.
 *
 * Unlike `pnpm compare` this includes lane F, which cannot be deployed. Lanes D and E
 * are absent because they need a browser.
 */
const LANES: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake', 'pg-duckdb'];

const COLUMNS: readonly Column<MeasuredRow>[] = [
  { header: 'query', value: ({ queryId }) => queryId },
  {
    header: 'lane',
    value: ({ result }) => `${LANE_META[result.laneId].letter}  ${LANE_META[result.laneId].label}`,
  },
  { header: 'median', align: 'right', value: ({ result, agrees }) => (agrees ? formatMs(result.timings.warmMs) : 'withheld') },
  { header: 'p95', align: 'right', value: ({ result, agrees }) => (agrees ? formatMs(result.timings.p95Ms) : '-') },
  {
    header: 'engine',
    align: 'right',
    value: ({ result }) => (result.metrics.engineMs === undefined ? '-' : formatMs(result.metrics.engineMs)),
  },
  { header: 'bytes read', align: 'right', value: ({ result }) => formatBytes(result.metrics.bytesRead) },
  { header: 'rows scanned', align: 'right', value: ({ result }) => formatCount(result.metrics.rowsScanned) },
  { header: 'returned', align: 'right', value: ({ result }) => formatCount(result.metrics.rowsReturned) },
  { header: 'ran on', value: ({ result }) => result.metrics.executedBy ?? '' },
];

const host = hostSpec();
const lanes = await openAvailableLanes(LANES);
const missing = LANES.filter((id) => !lanes.some((lane) => lane.id === id));

console.log(`${describeHost(host)}\n`);
if (missing.length > 0) {
  console.log(`unavailable, skipped: ${missing.join(', ')}`);
  if (missing.includes('pg-duckdb')) console.log('  (start lane F with `pnpm services:pgduckdb`)');
  console.log('');
}

const rows = await runCatalogue(lanes, DEFAULT_PARAMS);
for (const lane of lanes) await lane.close();

console.log(renderTable(COLUMNS, rows));

const failed = disagreements(rows);
const record = {
  measuredAt: new Date().toISOString(),
  host,
  dataset: {
    rows: DATASET.orderItems,
    seed: DATASET.seed,
    from: DATASET.startDate,
    to: DATASET.endDate,
  },
  protocol: { ...BENCH, params: DEFAULT_PARAMS },
  lanes: lanes.map((lane) => ({ id: lane.id, ...LANE_META[lane.id] })),
  results: rows.map(({ queryId, result, agrees }) => ({
    queryId,
    concept: getQuery(queryId).concept,
    laneId: result.laneId,
    agreesWithBaseline: agrees,
    timings: result.timings,
    metrics: result.metrics,
    sql: result.sql,
  })),
};

mkdirSync(PATHS.benchResults, { recursive: true });
const file = join(PATHS.benchResults, `${record.measuredAt.slice(0, 10)}-${slug(host)}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

console.log(`\n${DATASET.orderItems.toLocaleString('en-US')} line items, ${BENCH.timedRuns} timed runs per cell after ${BENCH.warmupRuns} warm-up.`);
console.log(`wrote ${file}`);

if (failed.length > 0) {
  console.error(`\n${failed.length} lane/query pair(s) disagreed with lane A; their timings are withheld.`);
  for (const row of failed) {
    console.error(`  ${row.queryId} / lane ${LANE_META[row.result.laneId].letter}: ${row.disagreement}`);
  }
  process.exitCode = 1;
}

/** A filename fragment that identifies the machine without needing to be parsed. */
function slug(spec: HostSpec): string {
  return `${spec.cpu}-${spec.cores}c-${spec.memoryGb}gb`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
