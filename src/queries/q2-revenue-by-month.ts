import { monthOf, rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q2 - the partition pruning query, and the only one needing no dimension.
 *
 * The month is the Hive partition key on the lake and derived from `order_ts`
 * elsewhere, both as `YYYY-MM` text, which is what lets the engines agree on it.
 *
 * On the lake this carries an extra predicate on that key. It cannot change the
 * answer, since the exact `order_ts` bounds remain, but it stops the engine opening
 * eighteen of the twenty-four monthly files.
 */
export const q2RevenueByMonth: QueryDef = {
  question: 'Revenue per month within a date range',
  concept: 'Partition pruning and predicate pushdown',
  columns: [
    { name: 'month', type: 'text' },
    { name: 'revenue', type: 'money' },
  ],

  bind: ({ from, to }) => [from, to],

  build: (target) => `
SELECT ${monthOf(target, 'f')} AS month,
       sum(f.revenue) AS revenue
FROM ${table(target, 'fact')} f
WHERE ${rangeFilter(target, 'f')}
GROUP BY month
ORDER BY month
`.trim(),
};
