-- The same star as 03_star.duckdb.sql, in Postgres' spelling.
--
-- One deliberate difference: there is no `month` column here. The lake needs it as a
-- Hive partition key; the heap has no partitions, so Postgres derives the month from
-- `order_ts` instead of storing 12 MB of redundant text. Q2 pays for that with an
-- expression it needs statistics for - see 04_tune_star.postgres.sql.

-- The Day 1 flat table. It has no readers left once the star exists, and leaving
-- 166 MB of it behind would quietly halve the headroom of a small managed Postgres.
-- It still lives in data/olap.duckdb, which is what the layout study reads.
DROP TABLE IF EXISTS orders;

DROP TABLE IF EXISTS fact_inventory_snapshot;
DROP TABLE IF EXISTS fact_order_item;
DROP TABLE IF EXISTS dim_customer;
DROP TABLE IF EXISTS dim_product;
DROP TABLE IF EXISTS dim_date;

CREATE TABLE dim_date (
  date_key    INTEGER PRIMARY KEY,
  date        DATE    NOT NULL,
  year        INTEGER NOT NULL,
  quarter     INTEGER NOT NULL,
  month       INTEGER NOT NULL,
  month_name  TEXT    NOT NULL,
  day_of_week INTEGER NOT NULL,
  is_weekend  BOOLEAN NOT NULL,
  iso_week    INTEGER NOT NULL
);

CREATE TABLE dim_customer (
  customer_key BIGINT      PRIMARY KEY,
  customer_id  BIGINT      NOT NULL,
  name         TEXT        NOT NULL,
  country      TEXT        NOT NULL,
  segment      TEXT        NOT NULL,
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ NOT NULL,
  is_current   BOOLEAN     NOT NULL
);

CREATE TABLE dim_product (
  product_key BIGINT        PRIMARY KEY,
  product_id  BIGINT        NOT NULL,
  name        TEXT          NOT NULL,
  category    TEXT          NOT NULL,
  brand       TEXT          NOT NULL,
  list_price  NUMERIC(10,2) NOT NULL
);

CREATE TABLE fact_order_item (
  order_item_id   BIGINT        PRIMARY KEY,
  order_id        BIGINT        NOT NULL,
  order_ts        TIMESTAMPTZ   NOT NULL,
  date_key        INTEGER       NOT NULL REFERENCES dim_date (date_key),
  customer_key    BIGINT        NOT NULL REFERENCES dim_customer (customer_key),
  product_key     BIGINT        NOT NULL REFERENCES dim_product (product_key),
  channel         TEXT          NOT NULL,
  quantity        INT           NOT NULL,
  unit_price      NUMERIC(10,2) NOT NULL,
  discount_amount NUMERIC(12,2) NOT NULL,
  revenue         NUMERIC(12,2) NOT NULL,
  cost            NUMERIC(12,2) NOT NULL
);

-- See 03_star.duckdb.sql for what "semi-additive" means and why this is a window.
CREATE TABLE fact_inventory_snapshot (
  date_key    INTEGER NOT NULL REFERENCES dim_date (date_key),
  product_key BIGINT  NOT NULL REFERENCES dim_product (product_key),
  on_hand     INTEGER NOT NULL,
  on_order    INTEGER NOT NULL,
  PRIMARY KEY (date_key, product_key)
);
