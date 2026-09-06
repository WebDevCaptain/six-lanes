import { table } from './dialect.js';
import type { QueryDef } from './types.js';

/**
 * Q1 - the column pruning query, now with a star join.
 *
 * `category` moved to `dim_product` on Day 4, so the simplest question in the
 * catalogue now costs a join. That is the trade a star makes: descriptive attributes
 * live once, in one place, and every query that wants one pays a lookup for it.
 *
 * The lookup is cheap and the fact scan is not. `dim_product` is 5,000 rows, which
 * both engines build a hash table over in microseconds, while the fact table is a
 * million. Column pruning still decides the result.
 */
export const q1RevenueByCategory: QueryDef = {
  question: 'Revenue per category, all history',
  concept: 'Column pruning across a star join',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'revenue', type: 'money' },
  ],

  bind: () => [],

  build: (target) => `
SELECT p.category,
       sum(f.revenue) AS revenue
FROM ${table(target, 'fact')} f
JOIN ${table(target, 'product')} p ON p.product_key = f.product_key
GROUP BY p.category
ORDER BY revenue DESC, p.category
`.trim(),
};
