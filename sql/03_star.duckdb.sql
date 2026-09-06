-- Day 4: the flat table becomes a star.
--
-- Grain of the fact table: one row per line item on one order. Unchanged from Day 1,
-- and still the first thing to write down before any query.
--
-- What moved: `category` left the fact for dim_product, and `customer_id` /
-- `product_id` became surrogate keys. `channel` stayed - it is a property of the
-- order, not of a dimension worth having, and it is the column that shows dictionary
-- encoding at its best.

CREATE OR REPLACE TABLE dim_date (
  date_key    INTEGER NOT NULL,   -- YYYYMMDD
  date        DATE    NOT NULL,
  year        INTEGER NOT NULL,
  quarter     INTEGER NOT NULL,
  month       INTEGER NOT NULL,
  month_name  VARCHAR NOT NULL,
  day_of_week INTEGER NOT NULL,   -- ISO: 1 = Monday
  is_weekend  BOOLEAN NOT NULL,
  iso_week    INTEGER NOT NULL
);

-- Slowly Changing Dimension, Type 2. One row per version of a customer, not one row
-- per customer: `customer_key` identifies a version, `customer_id` identifies a
-- person, and only their combination with a validity range identifies a fact's
-- context correctly.
CREATE OR REPLACE TABLE dim_customer (
  customer_key BIGINT      NOT NULL,   -- surrogate, unique per version
  customer_id  BIGINT      NOT NULL,   -- natural, shared across versions
  name         VARCHAR     NOT NULL,
  country      VARCHAR     NOT NULL,
  segment      VARCHAR     NOT NULL,
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ NOT NULL,   -- exclusive; 2999-12-31 while current
  is_current   BOOLEAN     NOT NULL
);

CREATE OR REPLACE TABLE dim_product (
  product_key BIGINT        NOT NULL,  -- surrogate
  product_id  BIGINT        NOT NULL,  -- natural
  name        VARCHAR       NOT NULL,
  category    VARCHAR       NOT NULL,
  brand       VARCHAR       NOT NULL,
  list_price  DECIMAL(10,2) NOT NULL
);

CREATE OR REPLACE TABLE fact_order_item (
  order_item_id   BIGINT        NOT NULL,
  order_id        BIGINT        NOT NULL,
  order_ts        TIMESTAMPTZ   NOT NULL,
  date_key        INTEGER       NOT NULL,  -- FK to dim_date
  customer_key    BIGINT        NOT NULL,  -- FK to dim_customer, SCD2-aware
  product_key     BIGINT        NOT NULL,  -- FK to dim_product
  channel         VARCHAR       NOT NULL,
  quantity        INTEGER       NOT NULL,  -- additive
  unit_price      DECIMAL(10,2) NOT NULL,  -- NON-additive: never sum this
  discount_amount DECIMAL(12,2) NOT NULL,  -- additive
  revenue         DECIMAL(12,2) NOT NULL,  -- additive
  cost            DECIMAL(12,2) NOT NULL,  -- additive
  month           VARCHAR       NOT NULL   -- Hive partition key for the lake
);

-- Day 7: the semi-additive measure.
--
-- Grain: one row per product per day. `on_hand` can be summed across products - the
-- total stock on a given day is a real quantity - and must never be summed across
-- days, because Monday's stock and Tuesday's stock are largely the same physical
-- items. That is what "semi-additive" means, and it is the only class of measure the
-- other tables cannot demonstrate.
--
-- A rolling window rather than all 730 days, which is also what real warehouses do:
-- snapshots are the fastest-growing table in any schema, 5,000 products x 730 days is
-- more rows than the fact table, and nobody keeps daily stock levels forever.
CREATE OR REPLACE TABLE fact_inventory_snapshot (
  date_key    INTEGER NOT NULL,   -- FK to dim_date
  product_key BIGINT  NOT NULL,   -- FK to dim_product
  on_hand     INTEGER NOT NULL,   -- SEMI-ADDITIVE: across products yes, across days no
  on_order    INTEGER NOT NULL    -- semi-additive, same rule
);
