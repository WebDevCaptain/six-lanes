import { q1RevenueByCategory } from './q1-revenue-by-category.js';
import { q2RevenueByMonth } from './q2-revenue-by-month.js';
import { q3TopCategories } from './q3-top-categories.js';
import { q4RollingRevenue } from './q4-rolling-revenue.js';
import { q5RepeatRate } from './q5-repeat-rate.js';
import { q6CategoryByMonth } from './q6-category-by-month.js';
import { q7OrderLookup } from './q7-order-lookup.js';
import type { QueryDef, QueryParams } from './types.js';

/**
 * The query catalogue: one logical question, one definition, every dialect.
 *
 * This is TypeScript rather than the `.sql` files the plan sketched, for one reason
 * that overrides the rest: lanes D and E run inside a browser tab, where there is no
 * filesystem to read a `.sql` file from. A catalogue only the server can load is not
 * a shared catalogue, and "the same query on every engine" is the claim the whole
 * project rests on.
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
 * The parameters every lane is measured with.
 *
 * Fixed rather than random, so two runs a week apart are comparable. A six-month
 * window in the middle of the dataset, so there are files to prune on both sides.
 *
 * `limit` is 5 against eight categories: a LIMIT that never limits demonstrates
 * nothing about what a LIMIT costs.
 */
export const DEFAULT_PARAMS: QueryParams = {
  from: '2025-03-01T00:00:00Z',
  to: '2025-09-01T00:00:00Z',
  orderId: 250_000,
  limit: 5,
};

export { TABLES, table } from './dialect.js';
export type { TableName } from './dialect.js';
export type {
  ColumnSpec,
  ColumnType,
  Dialect,
  QueryDef,
  QueryParams,
  QueryValue,
  SqlTarget,
} from './types.js';
