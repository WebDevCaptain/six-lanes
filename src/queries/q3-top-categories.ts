import { rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q3 - a star join with a range filter, which is the shape of most real analytical
 * queries. The lake prunes files before planning the join; the heap runs an index
 * scan into a hash join. Same answer, very different plans.
 *
 * `ORDER BY ... LIMIT` over an aggregate cannot stop early, since every group must be
 * complete before any can be ranked. The LIMIT saves transfer, not work.
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
