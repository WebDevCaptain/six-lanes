import type { ColumnSpec, ColumnType } from '../queries/types';
import type { Cell, Row } from '../types';

/**
 * One canonical form for every engine's output.
 *
 * The six engines disagree about how to hand back the same value. Postgres returns
 * NUMERIC as `"1234.50"` and TIMESTAMPTZ as a JS Date; DuckDB returns DECIMAL as
 * `"1234.50"` but TIMESTAMPTZ as `"2025-03-14 09:30:00+00"`; DuckDB-WASM returns
 * BIGINT as a JS BigInt. None of those differences are interesting, and all of them
 * would break an equality check that is supposed to be about the data.
 *
 * So each query declares its output columns once and this module applies that
 * declaration to every lane. Money never becomes a float on the way through -
 * `0.1 + 0.2` has no place in a comparison whose whole point is exactness.
 */
export function normalizeRows(
  columns: readonly ColumnSpec[],
  rows: readonly Record<string, unknown>[],
): Row[] {
  return rows.map((row) => {
    const normalized: Record<string, Cell> = {};
    for (const column of columns) {
      if (!(column.name in row)) {
        throw new Error(`result is missing declared column "${column.name}"`);
      }
      normalized[column.name] = normalizeCell(row[column.name], column.type, column.name);
    }
    return normalized;
  });
}

function normalizeCell(value: unknown, type: ColumnType, columnName: string): Cell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'money':
      return toFixed2(value, columnName);
    case 'int':
      return toInteger(value, columnName);
    case 'text':
      return String(value);
    case 'timestamp':
      return toIsoUtc(value, columnName);
  }
}

/**
 * Exact decimal-to-string with two places, via BigInt.
 *
 * Every money value in this project is already scale 2 - NUMERIC(12,2) in Postgres,
 * DECIMAL(12,2) in DuckDB, and their sums keep that scale - so this is normally
 * pure reformatting. The rounding branch exists so that an engine returning extra
 * digits fails visibly on the value rather than silently on the comparison.
 */
export function toFixed2(value: unknown, columnName = 'value'): string {
  const text =
    typeof value === 'number' ? value.toFixed(6) : String(value as string | bigint).trim();

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || /^-?\.?$/.test(text)) {
    throw new Error(`${columnName}: not a decimal number: ${JSON.stringify(value)}`);
  }

  const [, sign = '', whole = '0', fraction = ''] = match;
  const padded = (fraction + '000').slice(0, 3);
  const thousandths = BigInt(whole + padded);
  // Half away from zero, matching what both engines do at their own boundaries.
  const hundredths = (thousandths + 5n) / 10n;

  const digits = hundredths.toString().padStart(3, '0');
  const body = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return hundredths === 0n ? '0.00' : `${sign}${body}`;
}

function toInteger(value: unknown, columnName: string): number {
  const asNumber = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`${columnName}: not a safe integer: ${JSON.stringify(String(value))}`);
  }
  return asNumber;
}

function toIsoUtc(value: unknown, columnName: string): string {
  if (value instanceof Date) return value.toISOString();

  // DuckDB renders TIMESTAMPTZ as "2025-03-14 09:30:00+00": a space instead of a T,
  // and a two-digit UTC offset that Date.parse rejects until it has minutes.
  const text = String(value).trim().replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
    ? text
    : /[+-]\d{2}$/.test(text)
      ? `${text}:00`
      : `${text}Z`;

  const parsed = Date.parse(zoned);
  if (Number.isNaN(parsed)) {
    throw new Error(`${columnName}: not a timestamp: ${JSON.stringify(value)}`);
  }
  return new Date(parsed).toISOString();
}
