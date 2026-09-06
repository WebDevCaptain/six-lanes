import { table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q1 - the column pruning query, now with a star join, because `category` lives in
 * `dim_product`. That is the trade a star makes: attributes live in one place and
 * every query that wants one pays a lookup.
 *
 * The lookup is 5,000 rows and the fact scan is a million, so column pruning still
 * decides the result.
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
