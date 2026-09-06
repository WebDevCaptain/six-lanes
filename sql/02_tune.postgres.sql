-- Run after the bulk load, never before: building a b-tree while inserting a
-- million rows costs several times what building it once at the end costs.
--
-- Lane A is the baseline the whole project is measured against, so it is given
-- every advantage a competent DBA would give it. A comparison won by leaving the
-- other engine misconfigured proves nothing.

-- Q7 wins on this. Without it the point lookup degrades to a sequential scan and
-- the one query Postgres is supposed to win stops being interesting.
CREATE INDEX idx_orders_order_id ON orders (order_id);

-- Q2's range predicate. The table is physically ordered by order_ts, so this scan
-- reads a contiguous run of heap blocks rather than jumping around.
CREATE INDEX idx_orders_order_ts ON orders (order_ts);

-- Q2 groups by an expression, and the planner has no statistics for expressions it
-- has never been told about. Without this it estimated the group count wildly high,
-- refused a hash aggregate, and sorted 237k rows through a 5.8 MB external merge:
-- 80.6 ms. With it the planner sees six groups, parallelises a hash aggregate, and
-- spills nothing: 19.1 ms. Same data, same index, same query - 4.2x, entirely from
-- telling the planner the truth. Measured, see docs/results.md.
CREATE STATISTICS orders_month_expr
  ON (to_char(order_ts AT TIME ZONE 'UTC', 'YYYY-MM'))
  FROM orders;

ANALYZE orders;
