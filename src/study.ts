import { appendFileSync, existsSync } from 'node:fs';

import {
  formatBytes,
  formatCount,
  formatMs,
  renderMarkdownTable,
  renderTable,
  type Column,
} from './bench/table.js';
import { LAKE_DIRS, PATHS } from './config.js';
import { connectDuckDB } from './duckdb/connect.js';
import { createProfiler } from './duckdb/profile.js';
import { describeHost } from './host.js';
import { perColumnBytes, type ColumnBytes } from './study/columns.js';
import { LAYOUT_VARIANTS, PROBES, writeVariant, type WrittenVariant } from './study/layout.js';

/**
 * `pnpm study` - the Day 2 layout study.
 *
 * Writes the same million rows nine ways, then asks each copy the same four
 * questions and records what the engine had to read to answer them. Add `--write`
 * to append the tables to docs/results.md.
 *
 * Every measurement here runs with DuckDB's caches off, so the numbers are what a
 * cold reader pays. That makes them comparable with each other, which is the only
 * comparison this study is making.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

const writer = await connectDuckDB({ path: PATHS.database });
const reader = await connectDuckDB({ extensions: ['httpfs'], disableCaches: true });
const profiler = await createProfiler(reader);

console.log(`${describeHost()}\n`);

interface SizeRow {
  readonly written: WrittenVariant;
}

interface ProbeRow {
  readonly written: WrittenVariant;
  readonly probe: string;
  readonly ms: number;
  readonly bytesRead: number;
  readonly filesRead: number;
  readonly rowsScanned: number;
}

const SIZE_COLUMNS: readonly Column<SizeRow>[] = [
  { header: 'factor', value: ({ written }) => written.variant.factor },
  { header: 'setting', value: ({ written }) => written.variant.setting },
  { header: 'files', align: 'right', value: ({ written }) => formatCount(written.files) },
  { header: 'on disk', align: 'right', value: ({ written }) => formatBytes(written.bytesOnDisk) },
  { header: 'write', align: 'right', value: ({ written }) => formatMs(written.writeMs) },
];

const PROBE_COLUMNS: readonly Column<ProbeRow>[] = [
  { header: 'factor', value: (row) => row.written.variant.factor },
  { header: 'setting', value: (row) => row.written.variant.setting },
  { header: 'bytes read', align: 'right', value: (row) => formatBytes(row.bytesRead) },
  { header: 'files', align: 'right', value: (row) => formatCount(row.filesRead) },
  { header: 'rows scanned', align: 'right', value: (row) => formatCount(row.rowsScanned) },
  { header: 'uncached ms', align: 'right', value: (row) => formatMs(row.ms) },
];

const COLUMN_BYTES_COLUMNS: readonly Column<ColumnBytes>[] = [
  { header: 'column', value: (row) => row.column },
  { header: 'distinct', align: 'right', value: (row) => formatCount(row.distinctValues) },
  { header: 'compressed', align: 'right', value: (row) => formatBytes(row.compressedBytes) },
  { header: 'uncompressed', align: 'right', value: (row) => formatBytes(row.uncompressedBytes) },
  { header: 'share', align: 'right', value: (row) => `${(row.shareOfFile * 100).toFixed(1)}%` },
];


const sizeRows: SizeRow[] = [];
const probeRows: ProbeRow[] = [];

for (const variant of LAYOUT_VARIANTS) {
  process.stdout.write(`\r  ${variant.factor}: ${variant.setting}`.padEnd(60));
  const written = await writeVariant(writer, variant);
  sizeRows.push({ written });

  for (const probe of PROBES) {
    const sql = probe.sql(written.relation);
    const started = performance.now();
    const summary = await profiler.measure(sql, []);
    probeRows.push({
      written,
      probe: probe.name,
      ms: performance.now() - started,
      bytesRead: summary.bytesRead,
      filesRead: summary.filesRead,
      rowsScanned: summary.rowsScanned,
    });
  }
}
process.stdout.write(`\r${' '.repeat(60)}\r`);

const columns = await perColumnBytes(
  writer,
  `${PATHS.rawLake}/**/*.parquet`,
  'orders',
);

writer.disconnectSync();
reader.disconnectSync();

console.log('Layout variants: what each one costs to store\n');
console.log(renderTable(SIZE_COLUMNS, sizeRows));

for (const probe of PROBES) {
  const rows = probeRows.filter((row) => row.probe === probe.name);
  console.log(`\n"${probe.name}" - ${probe.asks}\n`);
  console.log(renderTable(PROBE_COLUMNS, rows));
}

console.log('\nPer-column bytes in the baseline lake\n');
console.log(renderTable(COLUMN_BYTES_COLUMNS, columns));

if (process.argv.includes('--write')) writeStudy();

function writeStudy(): void {
  const sections = [
    ``,
    `### ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC - layout study`,
    ``,
    `\`${describeHost()}\``,
    ``,
    `${LAYOUT_VARIANTS.length} layouts of the same rows, measured with DuckDB's caches off.`,
    ``,
    `**What each layout costs to store**`,
    ``,
    renderMarkdownTable(SIZE_COLUMNS, sizeRows),
    ...PROBES.flatMap((probe) => [
      ``,
      `**"${probe.name}" - ${probe.asks}**`,
      ``,
      renderMarkdownTable(PROBE_COLUMNS, probeRows.filter((row) => row.probe === probe.name)),
    ]),
    ``,
    `**Per-column bytes, baseline lake** (\`${LAKE_DIRS.raw}\`)`,
    ``,
    renderMarkdownTable(COLUMN_BYTES_COLUMNS, columns),
    ``,
  ].join('\n');

  appendFileSync(PATHS.results, sections);
  console.log(`\nappended to ${PATHS.results}`);
}
