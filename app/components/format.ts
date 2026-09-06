/**
 * Number formatting for the page.
 *
 * Deliberately not shared with src/bench/table.ts: that renders a fixed-width
 * terminal table where every column has to be the same width, and this renders prose
 * where "1.6 s" is easier to read than "1600.00". Same values, different job.
 */

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 2 : 1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export const formatCount = (value: number | undefined | null): string =>
  value === undefined || value === null ? '-' : value.toLocaleString('en-US');
