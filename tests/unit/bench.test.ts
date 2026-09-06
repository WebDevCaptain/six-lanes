import { describe, expect, it } from 'vitest';

import { findMismatches } from '../../src/bench/compare';
import { median, percentile95 } from '../../src/bench/measure';
import { formatBytes, formatMs, renderTable } from '../../src/bench/table';
import type { LaneResult, Row } from '../../src/types';

describe('median', () => {
  it('takes the middle of an odd sample', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the middle two of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('ignores a single outlier, which is the whole reason it is used', () => {
    expect(median([10, 10, 10, 10, 9000])).toBe(10);
  });

  it('refuses to report on nothing', () => {
    expect(() => median([])).toThrow(/no samples/);
  });
});

describe('percentile95', () => {
  it('is the slowest of five runs, by nearest rank', () => {
    expect(percentile95([4, 1, 5, 2, 3])).toBe(5);
  });

  it('is the 95th of a hundred', () => {
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});

describe('findMismatches', () => {
  const laneResult = (laneId: string, rows: Row[]): LaneResult =>
    ({ laneId, rows } as unknown as LaneResult);

  const baseline = laneResult('postgres', [
    { category: 'Books', revenue: '10.00' },
    { category: 'Toys', revenue: '20.00' },
  ]);

  it('accepts the same rows in a different order', () => {
    const shuffled = laneResult('duckdb-lake', [
      { category: 'Toys', revenue: '20.00' },
      { category: 'Books', revenue: '10.00' },
    ]);
    expect(findMismatches(baseline, [shuffled])).toEqual([]);
  });

  it('accepts the same row with its keys written in a different order', () => {
    const reordered = laneResult('duckdb-lake', [
      { revenue: '10.00', category: 'Books' },
      { revenue: '20.00', category: 'Toys' },
    ]);
    expect(findMismatches(baseline, [reordered])).toEqual([]);
  });

  it('catches a value that differs', () => {
    const wrong = laneResult('duckdb-lake', [
      { category: 'Books', revenue: '10.01' },
      { category: 'Toys', revenue: '20.00' },
    ]);
    expect(findMismatches(baseline, [wrong])[0]?.detail).toMatch(/differs/);
  });

  it('catches a missing row', () => {
    const short = laneResult('duckdb-lake', [{ category: 'Books', revenue: '10.00' }]);
    expect(findMismatches(baseline, [short])[0]?.detail).toMatch(/row count 1, expected 2/);
  });

  it('reports every lane that disagrees, not just the first', () => {
    const wrong = laneResult('duckdb-lake', []);
    const alsoWrong = laneResult('pglite', []);
    expect(findMismatches(baseline, [wrong, alsoWrong])).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('keeps sub-millisecond timings readable', () => {
    expect(formatMs(0.007)).toBe('0.007');
    expect(formatMs(38.26)).toBe('38.26');
    expect(formatMs(2500)).toBe('2.50s');
  });

  it('scales bytes to the unit a reader can compare', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(32_768)).toBe('32.0 KB');
    expect(formatBytes(2_797_000)).toBe('2.67 MB');
    expect(formatBytes(undefined)).toBe('-');
  });

  it('lines up columns', () => {
    const table = renderTable(
      [
        { header: 'lane', value: (r: { lane: string; ms: string }) => r.lane },
        { header: 'ms', align: 'right', value: (r) => r.ms },
      ],
      [{ lane: 'A', ms: '1.5' }, { lane: 'longer', ms: '22.75' }],
    );
    expect(table.split('\n')).toEqual(['lane       ms', '------  -----', 'A         1.5', 'longer  22.75']);
  });
});
