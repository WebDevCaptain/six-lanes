import { rangeFilter, table } from './dialect.js';
import type { QueryDef } from './types.js';

/**
 * Q3 - top categories by revenue in a window.
 *
 * A star join with a range filter, which is the shape of most real analytical
 * queries. On the lake the range prunes files before the join is planned; on the heap
 * it is an index scan feeding a hash join. Same answer, two very different plans.
 *
 * `ORDER BY ... LIMIT` on an aggregate cannot stop early: every group has to be
 * complete before any of them can be ranked. The LIMIT saves transfer, not work,
 * which is worth knowing before reaching for one as an optimisation.
 */
export const q3TopCategories: QueryDef = {
  question: 'Top categories by revenue in a date range',
  concept: 'Star join with a range filter; LIMIT after aggregation',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'revenue', type: 'money' },
    { name: 'orders', type: 'int' },
  ],

  bind: ({ from, to, limit }) => [from, to, limit],

  build: (target) => `
SELECT p.category,
       sum(f.revenue)          AS revenue,
       count(DISTINCT f.order_id) AS orders
FROM ${table(target, 'fact')} f
JOIN ${table(target, 'product')} p ON p.product_key = f.product_key
WHERE ${rangeFilter(target, 'f')}
GROUP BY p.category
ORDER BY revenue DESC, p.category
LIMIT $3
`.trim(),
};
