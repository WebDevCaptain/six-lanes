import type { QueryDef } from './types.js';

/**
 * Q1 - the column pruning query.
 *
 * Two columns of twelve. Identical SQL in both dialects, which is the point: the
 * gap between lanes comes entirely from storage layout, not from the query.
 *
 * `category` is a tiebreaker in ORDER BY only so the displayed order is stable when
 * two categories tie. Equality across lanes is checked on sorted rows regardless.
 */
export const q1RevenueByCategory: QueryDef = {
  question: 'Revenue per category, all history',
  concept: 'Column pruning: 2 columns of 12',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'revenue', type: 'money' },
  ],

  bind: () => [],

  build: ({ relation }) => `
SELECT category,
       sum(revenue) AS revenue
FROM ${relation}
GROUP BY category
ORDER BY revenue DESC, category
`.trim(),
};
