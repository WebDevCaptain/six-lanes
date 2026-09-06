import { describe, expect, it } from 'vitest';

import { arrowRows } from '../../src/browser/arrow';

/**
 * Regression tests for a bug the browser only revealed because its rows were checked
 * against another engine's: DuckDB-WASM returns a DECIMAL as its unscaled integer, so
 * 3,237,919.01 arrived as 323791901 and the page reported a revenue a hundred times
 * too large. Nothing threw.
 */
const table = (
  fields: { name: string; type: Record<string, unknown> }[],
  rows: Record<string, unknown>[],
) => ({
  schema: { fields },
  toArray: () => rows.map((row) => ({ toJSON: () => ({ ...row }) })),
});

const decimal = (scale: number) => ({ scale, precision: 38 });
const timestamp = () => ({ unit: 2, timezone: 'UTC' });

describe('arrowRows', () => {
  it('puts the decimal point where the schema says it goes', () => {
    const rows = arrowRows(
      table([{ name: 'revenue', type: decimal(2) }], [{ revenue: 323791901 }]),
    );
    expect(rows[0]!['revenue']).toBe('3237919.01');
  });

  it('handles a bigint too large for a double', () => {
    const rows = arrowRows(
      table([{ name: 'revenue', type: decimal(2) }], [{ revenue: 12345678901234567890n }]),
    );
    expect(rows[0]!['revenue']).toBe('123456789012345678.90');
  });

  it('handles values smaller than one unit of scale', () => {
    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: 5 }]))[0]!['v']).toBe('0.05');
    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: 0 }]))[0]!['v']).toBe('0.00');
  });

  it('keeps the sign', () => {
    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: -12345 }]))[0]!['v']).toBe(
      '-123.45',
    );
  });

  it('reassembles a wide decimal from Arrow 32-bit words', () => {
    // 123456789012345678901 as four little-endian uint32 words.
    const value = 123456789012345678901n;
    const words = new Uint32Array(4);
    for (let i = 0; i < 4; i++) words[i] = Number((value >> BigInt(32 * i)) & 0xffffffffn);

    const rows = arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: words }]));
    expect(rows[0]!['v']).toBe('1234567890123456789.01');
  });

  it('reassembles a negative wide decimal', () => {
    const value = -4242n;
    const words = new Uint32Array(4);
    const twos = (1n << 128n) + value;
    for (let i = 0; i < 4; i++) words[i] = Number((twos >> BigInt(32 * i)) & 0xffffffffn);

    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: words }]))[0]!['v']).toBe(
      '-42.42',
    );
  });

  it('leaves a value that already carries a point alone', () => {
    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: '12.34' }]))[0]!['v']).toBe(
      '12.34',
    );
  });

  it('leaves nulls alone', () => {
    expect(arrowRows(table([{ name: 'v', type: decimal(2) }], [{ v: null }]))[0]!['v']).toBeNull();
  });

  it('reads a timestamp as epoch milliseconds, whatever unit the schema declares', () => {
    // duckdb-wasm declares TIMESTAMPTZ as MICROSECOND and then hands over
    // milliseconds. Rescaling by the declared unit put a July 2025 order in 1970.
    const at = Date.parse('2025-07-26T11:29:35Z');
    const rows = arrowRows(table([{ name: 'at', type: timestamp() }], [{ at }]));
    expect(rows[0]!['at']).toBe('2025-07-26T11:29:35.000Z');
  });

  it('leaves a Date alone', () => {
    const when = new Date('2025-07-26T11:29:35Z');
    expect(arrowRows(table([{ name: 'at', type: timestamp() }], [{ at: when }]))[0]!['at']).toBe(when);
  });

  it('passes through columns the schema says nothing special about', () => {
    const rows = arrowRows(
      table([{ name: 'category', type: {} }], [{ category: 'Books' }]),
    );
    expect(rows[0]!['category']).toBe('Books');
  });
});
