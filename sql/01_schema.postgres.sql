-- Day 1 baseline: one flat table, exactly where a real OLTP application starts.
-- It is deliberately not a star schema so that the Day 4 refactor has something to
-- teach. Grain: one row per line item on one order.

DROP TABLE IF EXISTS orders;

CREATE TABLE orders (
  order_item_id   BIGINT        PRIMARY KEY,
  order_id        BIGINT        NOT NULL,
  order_ts        TIMESTAMPTZ   NOT NULL,
  customer_id     BIGINT        NOT NULL,
  product_id      BIGINT        NOT NULL,
  channel         TEXT          NOT NULL,   -- web | app | store
  category        TEXT          NOT NULL,
  quantity        INT           NOT NULL,
  unit_price      NUMERIC(10,2) NOT NULL,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  revenue         NUMERIC(12,2) NOT NULL,   -- quantity * unit_price - discount_amount
  cost            NUMERIC(12,2) NOT NULL
);
