import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findMismatches } from './bench/compare';
import { formatBytes, formatCount, formatMs, renderTable, type Column } from './bench/table';
import { BENCH } from './bench/measure';
import { DATASET, PATHS } from './config';
import { hostSpec, describeHost, type HostSpec } from './host';
import { BASELINE_LANE, LANE_META, openAvailableLanes } from './lanes/index';
import { DEFAULT_PARAMS, QUERY_IDS, getQuery, type QueryId } from './queries/index';
import type { LaneId, LaneResult } from './types';

/**
 * `pnpm bench` - every server lane, one machine, one dataset, written to disk.
 *
 * `pnpm compare` is the loop you run while working. This is the artefact: it includes
 * lane F, which cannot be deployed anywhere, and it commits its output to
 * bench/results/ so a number on the site can always be traced back to the run that
 * produced it and the machine that ran it.
 *
 * Lanes D and E are absent because they need a browser. Their numbers come from the
 * page itself, where the honest thing to measure is what a visitor experiences.
 */
const LANES: readonly LaneId[] = ['postgres', 'duckdb-postgres', 'duckdb-lake', 'pg-duckdb'];

interface BenchRow {
  readonly queryId: QueryId;
  readonly result: LaneResult;
  readonly agrees: boolean;
}

const COLUMNS: readonly Column<BenchRow>[] = [
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

const rows: BenchRow[] = [];
for (const queryId of QUERY_IDS) {
  const results: LaneResult[] = [];
  for (const lane of lanes) results.push(await lane.run(queryId, DEFAULT_PARAMS));

  const baseline = results.find((result) => result.laneId === BASELINE_LANE)!;
  const disagreed = new Set(
    findMismatches(baseline, results.filter((result) => result !== baseline)).map((m) => m.laneId),
  );
  rows.push(...results.map((result) => ({ queryId, result, agrees: !disagreed.has(result.laneId) })));
}

for (const lane of lanes) await lane.close();

console.log(renderTable(COLUMNS, rows));

const failures = rows.filter((row) => !row.agrees);
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

if (failures.length > 0) {
  console.error(`\n${failures.length} lane/query pair(s) disagreed with lane A; their timings are withheld.`);
  process.exitCode = 1;
}

/** A filename fragment that identifies the machine without needing to be parsed. */
function slug(spec: HostSpec): string {
  return `${spec.cpu}-${spec.cores}c-${spec.memoryGb}gb`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
