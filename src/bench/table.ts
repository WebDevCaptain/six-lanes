/**
 * A plain fixed-width table. The results table is the deliverable of every day in
 * this project, so it is worth 30 lines to have it line up in a terminal and paste
 * into Markdown unchanged.
 */

export type Align = 'left' | 'right';

export interface Column<T> {
  readonly header: string;
  readonly align?: Align;
  value(row: T): string;
}

export function renderTable<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((row) => row[i]!.length)),
  );

  const line = (values: readonly string[]): string =>
    values.map((value, i) => pad(value, widths[i]!, columns[i]!.align)).join('  ').trimEnd();

  return [
    line(columns.map((c) => c.header)),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...cells.map(line),
  ].join('\n');
}

/** The same table as GitHub-flavoured Markdown, for docs/results.md. */
export function renderMarkdownTable<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  const divider = columns.map((c) => (c.align === 'right' ? '---:' : '---'));
  return [
    `| ${columns.map((c) => c.header).join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((c) => c.value(row)).join(' | ')} |`),
  ].join('\n');
}

const pad = (value: string, width: number, align: Align = 'left'): string =>
  align === 'right' ? value.padStart(width) : value.padEnd(width);

export const formatMs = (ms: number): string =>
  ms < 10 ? ms.toFixed(3) : ms < 1000 ? ms.toFixed(2) : `${(ms / 1000).toFixed(2)}s`;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export const formatCount = (value: number | undefined): string =>
  value === undefined ? '-' : value.toLocaleString('en-US');
