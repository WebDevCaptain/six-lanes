import { describe, expect, it } from 'vitest';

import { normalizeRows, toFixed2 } from '../../src/bench/normalize';
import type { ColumnSpec } from '../../src/queries/types';

/**
 * Normalisation is what makes cross-lane equality mean anything, so its edge cases
 * are worth more attention than the happy path. Every input shape below is one an
 * engine in this project actually returns.
 */
describe('toFixed2', () => {
  it.each([
    ['1234.50', '1234.50'],
    ['1234.5', '1234.50'],
    ['1234', '1234.00'],
    ['-1234.50', '-1234.50'],
    ['0', '0.00'],
    ['-0.00', '0.00'],
    ['0.05', '0.05'],
    ['.5', '0.50'],
  ])('formats %s as %s', (input, expected) => {
    expect(toFixed2(input)).toBe(expected);
  });

  it('rounds a third decimal away from zero rather than truncating', () => {
    expect(toFixed2('1.005')).toBe('1.01');
    expect(toFixed2('-1.005')).toBe('-1.01');
  });

  it('survives values beyond what a double can hold exactly', () => {
    expect(toFixed2('123456789012345678.99')).toBe('123456789012345678.99');
  });

  it('accepts a bigint, which DuckDB-WASM returns for wide integers', () => {
    expect(toFixed2(42n)).toBe('42.00');
  });

  it('rejects anything that is not a decimal', () => {
    expect(() => toFixed2('NaN', 'revenue')).toThrow(/revenue/);
  });
});

describe('normalizeRows', () => {
  const columns: readonly ColumnSpec[] = [
    { name: 'category', type: 'text' },
    { name: 'revenue', type: 'money' },
    { name: 'orders', type: 'int' },
    { name: 'at', type: 'timestamp' },
  ];

  it('brings four different engine spellings to one form', () => {
    const fromPostgres = { category: 'Books', revenue: '10.50', orders: '3', at: new Date('2025-03-14T09:30:00Z') };
    const fromDuckDB = { category: 'Books', revenue: '10.50', orders: 3, at: '2025-03-14 09:30:00+00' };
    const fromWasm = { category: 'Books', revenue: '10.5', orders: 3n, at: '2025-03-14T09:30:00.000Z' };

    const [a, b, c] = normalizeRows(columns, [fromPostgres, fromDuckDB, fromWasm]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual({ category: 'Books', revenue: '10.50', orders: 3, at: '2025-03-14T09:30:00.000Z' });
  });

  it('keeps nulls as nulls', () => {
    expect(normalizeRows(columns, [{ category: null, revenue: null, orders: null, at: null }])).toEqual([
      { category: null, revenue: null, orders: null, at: null },
    ]);
  });

  it('fails loudly when a declared column is missing', () => {
    expect(() => normalizeRows(columns, [{ category: 'Books' }])).toThrow(/revenue/);
  });

  it('drops columns the query did not declare', () => {
    const rows = normalizeRows([{ name: 'category', type: 'text' }], [{ category: 'Books', month: '2025-03' }]);
    expect(rows[0]).toEqual({ category: 'Books' });
  });

  it('reads a naive timestamp as UTC rather than as local time', () => {
    const rows = normalizeRows([{ name: 'at', type: 'timestamp' }], [{ at: '2025-03-14 09:30:00' }]);
    expect(rows[0]!['at']).toBe('2025-03-14T09:30:00.000Z');
  });

  it('refuses an integer too large to represent exactly', () => {
    expect(() => normalizeRows([{ name: 'orders', type: 'int' }], [{ orders: '9007199254740993' }])).toThrow(
      /safe integer/,
    );
  });
});
