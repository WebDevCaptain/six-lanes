import { q1RevenueByCategory } from './q1-revenue-by-category';
import { q2RevenueByMonth } from './q2-revenue-by-month';
import { q3TopCategories } from './q3-top-categories';
import { q4RollingRevenue } from './q4-rolling-revenue';
import { q5RepeatRate } from './q5-repeat-rate';
import { q6CategoryByMonth } from './q6-category-by-month';
import { q7OrderLookup } from './q7-order-lookup';
import type { QueryDef, QueryParams } from './types';

/**
 * The query catalogue: one logical question, one definition, every dialect.
 *
 * TypeScript rather than `.sql` files because lanes D and E run in a browser tab,
 * where there is no filesystem. A catalogue only the server can load would not
 * support the claim that every engine runs the same query.
 */
export const QUERIES = {
  revenue_by_category: q1RevenueByCategory,
  revenue_by_month_filtered: q2RevenueByMonth,
  order_lookup: q7OrderLookup,
  top_categories: q3TopCategories,
  rolling_revenue: q4RollingRevenue,
  repeat_rate: q5RepeatRate,
  category_by_month: q6CategoryByMonth,
} as const satisfies Record<string, QueryDef>;

export type QueryId = keyof typeof QUERIES;

export const QUERY_IDS = Object.keys(QUERIES) as readonly QueryId[];

export function getQuery(id: QueryId): QueryDef {
  return QUERIES[id];
}

/**
 * The parameters every lane is measured with. Fixed rather than random so two runs a
 * week apart are comparable, and a six-month window mid-dataset so there are files to
 * prune on both sides. `limit` is 5 against eight categories, since a LIMIT that
 * never limits demonstrates nothing.
 */
export const DEFAULT_PARAMS: QueryParams = {
  from: '2025-03-01T00:00:00Z',
  to: '2025-09-01T00:00:00Z',
  orderId: 250_000,
  limit: 5,
};

export { TABLES, table } from './dialect';
export type { TableName } from './dialect';
export type {
  ColumnSpec,
  ColumnType,
  Dialect,
  QueryDef,
  QueryParams,
  QueryValue,
  SqlTarget,
} from './types';
