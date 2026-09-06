import { monthOf, rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q6 - revenue by category by month.
 *
 * Two grouping dimensions, so the output is the product of their cardinalities rather
 * than the sum. Small here (eight categories by six months) and the reason a real
 * warehouse query gets slow: nothing about the scan changed, but the aggregate now
 * has to keep a hash table of every combination that appears.
 */
export const q6CategoryByMonth: QueryDef = {
  question: 'Revenue by category by month',
  concept: 'Two-dimension grouping, wide output',
  columns: [
    { name: 'month', type: 'text' },
    { name: 'category', type: 'text' },
    { name: 'revenue', type: 'money' },
    { name: 'units', type: 'int' },
  ],

  bind: ({ from, to }) => [from, to],

  build: (target) => `
SELECT ${monthOf(target, 'f')} AS month,
       p.category,
       sum(f.revenue)  AS revenue,
       sum(f.quantity) AS units
FROM ${table(target, 'fact')} f
JOIN ${table(target, 'product')} p ON p.product_key = f.product_key
WHERE ${rangeFilter(target, 'f')}
GROUP BY month, p.category
ORDER BY month, p.category
`.trim(),
};
