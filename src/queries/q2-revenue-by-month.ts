import { monthOf, rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q2 - the partition pruning query, and the only one that needs no dimension.
 *
 * The month comes from the fact table itself: on the lake it is the Hive partition
 * key, already in the file path; elsewhere it is derived from `order_ts`. Both give
 * the same `YYYY-MM` text, which is what lets six engines agree on it.
 *
 * On the lake this query carries an extra predicate on the partition key. It cannot
 * change the answer - the exact `order_ts` bounds are still there - but it is what
 * stops the engine opening eighteen of the twenty-four monthly files.
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
