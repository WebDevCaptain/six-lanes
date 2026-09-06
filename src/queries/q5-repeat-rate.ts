import { monthOf, rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q5 - distinct customers and repeat rate by month.
 *
 * The join to `dim_customer` is not decoration, it is the correctness of the query.
 * `customer_key` identifies a *version* of a person: a customer who moved country in
 * March has two keys, and counting keys would report them as two customers. Counting
 * `customer_id` counts people.
 *
 * This is the SCD2 trap in its natural habitat. The query looks right either way, the
 * numbers differ by a few percent, and nothing fails - which is why
 * tests/integration/star.test.ts asserts the two counts differ, so the join can never
 * be quietly optimised away.
 */
export const q5RepeatRate: QueryDef = {
  question: 'Distinct customers and repeat rate by month',
  concept: 'Counting people, not surrogate keys',
  columns: [
    { name: 'month', type: 'text' },
    { name: 'customers', type: 'int' },
    { name: 'repeat_customers', type: 'int' },
    { name: 'repeat_rate_pct', type: 'money' },
  ],

  bind: ({ from, to }) => [from, to],

  build: (target) => `
WITH per_customer AS (
  SELECT ${monthOf(target, 'f')}      AS month,
         c.customer_id,
         count(DISTINCT f.order_id)   AS orders
  FROM ${table(target, 'fact')} f
  JOIN ${table(target, 'customer')} c ON c.customer_key = f.customer_key
  WHERE ${rangeFilter(target, 'f')}
  GROUP BY month, c.customer_id
)
SELECT month,
       count(*)                                             AS customers,
       count(*) FILTER (WHERE orders > 1)                   AS repeat_customers,
       round(100.0 * count(*) FILTER (WHERE orders > 1) / count(*), 2) AS repeat_rate_pct
FROM per_customer
GROUP BY month
ORDER BY month
`.trim(),
};
