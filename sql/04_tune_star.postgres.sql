-- Run after the bulk load. Lane A is the baseline, so it gets every advantage a
-- competent DBA would give it; a comparison won by leaving the other engine
-- misconfigured proves nothing.

-- Q7's point lookup. Without it the one query Postgres is supposed to win degrades
-- to a sequential scan.
CREATE INDEX idx_fact_order_id ON fact_order_item (order_id);

-- The range predicate every analytical query carries. The table is written in time
-- order, so this scan reads a contiguous run of heap blocks.
CREATE INDEX idx_fact_order_ts ON fact_order_item (order_ts);

-- Star joins. Without these the planner hash-joins the whole dimension every time,
-- which is usually right for dim_product (5,000 rows) and usually wrong for
-- dim_customer (230,000 versions).
CREATE INDEX idx_fact_product_key ON fact_order_item (product_key);
CREATE INDEX idx_fact_customer_key ON fact_order_item (customer_key);
CREATE INDEX idx_fact_date_key ON fact_order_item (date_key);

-- The SCD2 lookup: find the version of a customer valid at an instant.
CREATE INDEX idx_customer_natural ON dim_customer (customer_id, valid_from, valid_to);
CREATE INDEX idx_customer_current ON dim_customer (customer_id) WHERE is_current;

-- Grouping by an expression defeats the planner's statistics: it has none for
-- to_char(order_ts, ...), estimates the group count wildly high, refuses a hash
-- aggregate and sorts through an external merge on disk. Measured on the flat table
-- at Day 1: 80.6 ms without this, 19.9 ms with it. Same data, same index, 4.0x.
CREATE STATISTICS fact_month_expr
  ON (to_char(order_ts AT TIME ZONE 'UTC', 'YYYY-MM'))
  FROM fact_order_item;

ANALYZE dim_date;
ANALYZE dim_customer;
ANALYZE dim_product;
ANALYZE fact_order_item;
