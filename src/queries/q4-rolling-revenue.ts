import { asDate, rangeFilter, table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q4 - 30-day rolling revenue, and where the date dimension earns its keep.
 *
 * `ROWS BETWEEN 29 PRECEDING` counts rows, not days, so a series derived from the
 * facts would silently shorten the window across any day that sold nothing. Joining
 * outward from `dim_date` gives a dense, zero-filled spine, and then 29 preceding
 * rows really are 29 preceding days.
 */
export const q4RollingRevenue: QueryDef = {
  question: '30-day rolling revenue',
  concept: 'Window functions over a dense calendar spine',
  columns: [
    { name: 'date_key', type: 'int' },
    { name: 'revenue', type: 'money' },
    { name: 'rolling_30d', type: 'money' },
  ],

  bind: ({ from, to }) => [from, to],

  build: (target) => `
WITH daily AS (
  SELECT d.date_key,
         coalesce(sum(f.revenue), 0) AS revenue
  FROM ${table(target, 'date')} d
  LEFT JOIN ${table(target, 'fact')} f
    ON f.date_key = d.date_key
   AND ${rangeFilter(target, 'f')}
  WHERE d.date >= ${asDate(target, 1)}
    AND d.date <  ${asDate(target, 2)}
  GROUP BY d.date_key
)
SELECT date_key,
       revenue,
       sum(revenue) OVER (ORDER BY date_key ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rolling_30d
FROM daily
ORDER BY date_key
`.trim(),
};
