import type { QueryDef, SqlTarget } from './types.js';

/**
 * Q2 - the partition pruning query.
 *
 * The month is produced as `YYYY-MM` text rather than a truncated timestamp. That
 * is not cosmetic: it is the only representation all six engines format identically,
 * and it is the same value the lake uses as its Hive partition key, so the grouping
 * key and the pruning key are literally the same string.
 *
 * The lake variant carries an extra predicate on that partition key. It is redundant
 * - the `order_ts` bounds below it already give the right answer - but it is what
 * lets the engine discard whole files at plan time instead of opening them. The
 * difference between the two variants is measured, not asserted: see the file counts
 * in docs/results.md.
 */
export const q2RevenueByMonth: QueryDef = {
  question: 'Revenue per month within a date range',
  concept: 'Partition pruning and predicate pushdown',
  columns: [
    { name: 'month', type: 'text' },
    { name: 'revenue', type: 'money' },
  ],

  bind: ({ from, to }) => [from, to],

  build: (target) =>
    target.dialect === 'postgres' ? postgres(target) : duckdb(target),
};

const postgres = ({ relation }: SqlTarget): string => `
SELECT to_char(order_ts AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
       sum(revenue) AS revenue
FROM ${relation}
WHERE order_ts >= $1::timestamptz
  AND order_ts <  $2::timestamptz
GROUP BY month
ORDER BY month
`.trim();

const duckdb = ({ relation, partitioned }: SqlTarget): string => `
SELECT ${partitioned ? 'month' : `strftime(order_ts, '%Y-%m') AS month`},
       sum(revenue) AS revenue
FROM ${relation}
WHERE ${partitioned ? partitionFilter : ''}order_ts >= CAST($1 AS TIMESTAMPTZ)
  AND order_ts <  CAST($2 AS TIMESTAMPTZ)
GROUP BY month
ORDER BY month
`.trim();

/**
 * `<=` on the upper bound, not `<`: the range end is an instant inside (or at the
 * start of) a month, and that whole month's file has to stay in the plan for the
 * exact `order_ts` predicate to filter it. Pruning may only remove files that
 * cannot contain a matching row.
 */
const partitionFilter = `month >= strftime(CAST($1 AS TIMESTAMPTZ), '%Y-%m')
  AND month <= strftime(CAST($2 AS TIMESTAMPTZ), '%Y-%m')
  AND `;
