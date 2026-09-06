import type { SqlTarget } from './types';

/**
 * The handful of places the two dialects genuinely differ.
 *
 * Kept in one file so a query reads as a question rather than as a pile of
 * conditionals, and so that "how do we express a month" has exactly one answer per
 * dialect instead of six slightly different ones.
 */

export const TABLES = {
  fact: 'fact_order_item',
  customer: 'dim_customer',
  product: 'dim_product',
  date: 'dim_date',
} as const;

export type TableName = keyof typeof TABLES;

/** Qualifies a star table for the lane's schema: `orders`, `lake.orders`, `pg.orders`. */
export const table = (target: SqlTarget, name: TableName): string =>
  `${target.schema}${TABLES[name]}`;

/**
 * The month of a fact row, as `YYYY-MM` text.
 *
 * Text rather than a truncated timestamp because it is the only representation every
 * engine formats identically, and because it is literally the lake's partition key -
 * so on the lake the grouping key costs nothing to produce, it is already in the path.
 */
export const monthOf = (target: SqlTarget, alias: string): string => {
  if (target.partitioned) return `${alias}.month`;
  return target.dialect === 'postgres'
    ? `to_char(${alias}.order_ts AT TIME ZONE 'UTC', 'YYYY-MM')`
    : `strftime(${alias}.order_ts, '%Y-%m')`;
};

/** A bound parameter read as an instant. Params are always ISO 8601 with a Z. */
export const asTimestamp = (target: SqlTarget, position: number): string =>
  target.dialect === 'postgres' ? `$${position}::timestamptz` : `CAST($${position} AS TIMESTAMPTZ)`;

/** The same bound parameter read as a UTC calendar date, for joins to dim_date. */
export const asDate = (target: SqlTarget, position: number): string =>
  target.dialect === 'postgres'
    ? `($${position}::timestamptz AT TIME ZONE 'UTC')::date`
    : `CAST(CAST($${position} AS TIMESTAMPTZ) AS DATE)`;

/** The exact half-open range predicate. Every lane evaluates this one. */
export const inRange = (target: SqlTarget, alias: string): string =>
  `${alias}.order_ts >= ${asTimestamp(target, 1)}
  AND ${alias}.order_ts <  ${asTimestamp(target, 2)}`;

/**
 * A redundant predicate on the Hive partition key, emitted only for the lake.
 *
 * Redundant because {@link inRange} above already gives the right answer. Decisive
 * because this is what lets the engine discard whole files at plan time instead of
 * opening them. `<=` on the upper bound, not `<`: the range may end mid-month, and
 * pruning is only allowed to remove files that *cannot* contain a matching row.
 */
export const prunePartitions = (target: SqlTarget, alias: string): string =>
  target.partitioned
    ? `${alias}.month >= strftime(${asTimestamp(target, 1)}, '%Y-%m')
  AND ${alias}.month <= strftime(${asTimestamp(target, 2)}, '%Y-%m')
  AND `
    : '';

/** `WHERE` for a fact-table date range, with partition pruning where it applies. */
export const rangeFilter = (target: SqlTarget, alias: string): string =>
  `${prunePartitions(target, alias)}${inRange(target, alias)}`;
