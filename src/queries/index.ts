import { q1RevenueByCategory } from './q1-revenue-by-category.js';
import { q2RevenueByMonth } from './q2-revenue-by-month.js';
import { q7OrderLookup } from './q7-order-lookup.js';
import type { QueryDef, QueryParams } from './types.js';

/**
 * The query catalogue: one logical question, one definition, every dialect.
 *
 * This is TypeScript rather than the `.sql` files the plan sketched, for one
 * reason that overrides the rest: lanes D and E run inside a browser tab, where
 * there is no filesystem to read a `.sql` file from. A catalogue that only the
 * server can load is not a shared catalogue, and "the same query on every engine"
 * is the claim the whole project rests on.
 */
export const QUERIES = {
  revenue_by_category: q1RevenueByCategory,
  revenue_by_month_filtered: q2RevenueByMonth,
  order_lookup: q7OrderLookup,
} as const satisfies Record<string, QueryDef>;

export type QueryId = keyof typeof QUERIES;

export const QUERY_IDS = Object.keys(QUERIES) as readonly QueryId[];

export function getQuery(id: QueryId): QueryDef {
  return QUERIES[id];
}

/**
 * The parameters every lane is measured with.
 *
 * Fixed rather than random so that two runs a week apart are comparable, and
 * covering a six-month window in the middle of the dataset so Q2 has files to
 * prune on both sides.
 */
export const DEFAULT_PARAMS: QueryParams = {
  from: '2025-03-01T00:00:00Z',
  to: '2025-09-01T00:00:00Z',
  orderId: 250_000,
  limit: 10,
};

export type { ColumnSpec, ColumnType, Dialect, QueryDef, QueryParams, QueryValue, SqlTarget } from './types.js';
