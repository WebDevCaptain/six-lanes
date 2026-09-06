-- The same table as 01_schema.postgres.sql, in DuckDB's spelling.
--
-- No PRIMARY KEY here on purpose. DuckDB would back it with an ART index that
-- costs time and memory during the bulk append and buys nothing: this copy is
-- append-only and is only ever scanned.

CREATE OR REPLACE TABLE orders (
  order_item_id   BIGINT        NOT NULL,
  order_id        BIGINT        NOT NULL,
  order_ts        TIMESTAMPTZ   NOT NULL,
  customer_id     BIGINT        NOT NULL,
  product_id      BIGINT        NOT NULL,
  channel         VARCHAR       NOT NULL,
  category        VARCHAR       NOT NULL,
  quantity        INTEGER       NOT NULL,
  unit_price      DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL,
  revenue         DECIMAL(12,2) NOT NULL,
  cost            DECIMAL(12,2) NOT NULL
);
