import {
  DuckDBDecimalValue,
  DuckDBTimestampTZValue,
  type DuckDBConnection,
} from '@duckdb/node-api';

import { readSqlFile } from '../sql-files';
import { buildProductCatalog } from './catalog';
import { buildCustomers, type CustomerVersion } from './customers';
import type { GeneratorConfig } from './generator';

/**
 * Turns the flat `orders` table into a star.
 *
 * The dimensions are generated; the fact table is derived from `orders` by joining
 * them. That direction matters: the fact does not carry `customer_id`, it carries the
 * surrogate key of the customer version that was current **at the moment of the
 * order**, and the only honest way to get that is the range join below.
 */

export interface StarCounts {
  readonly dates: number;
  readonly customers: number;
  readonly customerVersions: number;
  readonly products: number;
  readonly facts: number;
  readonly inventorySnapshots: number;
}

/**
 * How many days of daily stock levels to keep.
 *
 * One row per product per day is the fastest-growing table in any warehouse: at 5,000
 * products, the full two years would be 3.65M rows, more than the fact table it is
 * meant to accompany. Real schemas keep a window, and so does this one.
 */
const SNAPSHOT_DAYS = 90;

export async function buildStar(
  connection: DuckDBConnection,
  config: GeneratorConfig,
): Promise<StarCounts> {
  await connection.run(readSqlFile('03_star.duckdb.sql'));

  await buildDimDate(connection, config);
  const customerVersions = await buildDimCustomer(connection, config);
  const products = await buildDimProduct(connection, config);
  const facts = await buildFact(connection);
  const inventorySnapshots = await buildInventorySnapshot(connection);

  return {
    dates: Number(await count(connection, 'dim_date')),
    customers: config.customers,
    customerVersions,
    products,
    facts,
    inventorySnapshots,
  };
}

/**
 * Daily stock levels as a running balance: a starting level per product, less what
 * has sold, plus replenishment before it goes negative.
 *
 * That makes each day's number a state rather than an event, which is what makes it
 * semi-additive: adding two days counts the same physical units twice.
 */
async function buildInventorySnapshot(connection: DuckDBConnection): Promise<number> {
  await connection.run(`
    INSERT INTO fact_inventory_snapshot
    -- The last N calendar days. Taken by rank, not by subtracting from date_key:
    -- date_key is YYYYMMDD, so "max - 90" crosses a month boundary into dates that
    -- do not exist and quietly returns a third of the window.
    WITH window_days AS (
      SELECT date_key FROM dim_date ORDER BY date_key DESC LIMIT ${SNAPSHOT_DAYS}
    ),
    sold AS (
      SELECT f.date_key, f.product_key, sum(f.quantity) AS units
      FROM fact_order_item f
      JOIN window_days d ON d.date_key = f.date_key
      GROUP BY 1, 2
    ),
    grid AS (
      SELECT d.date_key, p.product_key, coalesce(s.units, 0) AS units
      FROM window_days d
      CROSS JOIN dim_product p
      LEFT JOIN sold s ON s.date_key = d.date_key AND s.product_key = p.product_key
    ),
    running AS (
      SELECT date_key,
             product_key,
             units,
             sum(units) OVER (PARTITION BY product_key ORDER BY date_key) AS cumulative
      FROM grid
    )
    SELECT date_key,
           product_key,
           -- A starting level plus replenishment that keeps stock positive. The point
           -- is the shape of the measure, not a supply-chain simulation.
           400 + (product_key % 250) - cumulative
             + 500 * CAST(greatest(0, ceil((cumulative - 400 - (product_key % 250)) / 500.0)) AS INTEGER) AS on_hand,
           CAST(greatest(0, units) * 3 AS INTEGER) AS on_order
    FROM running
  `);
  return Number(await count(connection, 'fact_inventory_snapshot'));
}

/**
 * A conformed date dimension, generated from its endpoints.
 *
 * Its real job is Q4: a rolling window needs a row for every day, including the days
 * nothing sold. A 30-row window over a series with holes is not a 30-day window.
 */
async function buildDimDate(connection: DuckDBConnection, config: GeneratorConfig): Promise<void> {
  await connection.run(`
    INSERT INTO dim_date
    SELECT CAST(strftime(d, '%Y%m%d') AS INTEGER) AS date_key,
           d                                      AS date,
           year(d), quarter(d), month(d), monthname(d),
           isodow(d)                              AS day_of_week,
           isodow(d) >= 6                         AS is_weekend,
           weekofyear(d)                          AS iso_week
    FROM (
      SELECT unnest(generate_series(DATE '${config.startDate}',
                                    DATE '${config.endDate}' - INTERVAL 1 DAY,
                                    INTERVAL 1 DAY)) AS d
    )
  `);
}

async function buildDimCustomer(
  connection: DuckDBConnection,
  config: GeneratorConfig,
): Promise<number> {
  const versions = buildCustomers(
    config.seed,
    config.customers,
    BigInt(Date.parse(`${config.startDate}T00:00:00Z`)) * 1000n,
    BigInt(Date.parse(`${config.endDate}T00:00:00Z`)) * 1000n,
  );

  const appender = await connection.createAppender('dim_customer');
  for (const version of versions) appendCustomer(appender, version);
  appender.closeSync();
  return versions.length;
}

function appendCustomer(
  appender: Awaited<ReturnType<DuckDBConnection['createAppender']>>,
  version: CustomerVersion,
): void {
  appender.appendBigInt(BigInt(version.customerKey));
  appender.appendBigInt(BigInt(version.customerId));
  appender.appendVarchar(version.name);
  appender.appendVarchar(version.country);
  appender.appendVarchar(version.segment);
  appender.appendTimestampTZ(new DuckDBTimestampTZValue(version.validFromMicros));
  appender.appendTimestampTZ(new DuckDBTimestampTZValue(version.validToMicros));
  appender.appendBoolean(version.isCurrent);
  appender.endRow();
}

/**
 * `product_key` is assigned in category-then-name order, so it is deliberately not
 * equal to `product_id`. A surrogate key that happens to match the natural key hides
 * every join bug that a surrogate key exists to expose.
 */
async function buildDimProduct(
  connection: DuckDBConnection,
  config: GeneratorConfig,
): Promise<number> {
  const { products } = buildProductCatalog(config.seed, config.products);
  const ordered = [...products].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.productId - b.productId,
  );

  const appender = await connection.createAppender('dim_product');
  ordered.forEach((product, index) => {
    appender.appendBigInt(BigInt(index + 1));
    appender.appendBigInt(BigInt(product.productId));
    appender.appendVarchar(product.name);
    appender.appendVarchar(product.category);
    appender.appendVarchar(product.brand);
    appender.appendDecimal(new DuckDBDecimalValue(BigInt(product.listPriceCents), 10, 2));
    appender.endRow();
  });
  appender.closeSync();
  return ordered.length;
}

/**
 * The fact table, and the one join here that has to be a range join.
 *
 * The validity bounds are the SCD2 lookup: of this person's several versions, take
 * the one true when the order happened. Joining on `is_current` is shorter and
 * silently reattributes every historical order to today's segment.
 */
async function buildFact(connection: DuckDBConnection): Promise<number> {
  await connection.run(`
    INSERT INTO fact_order_item
    SELECT o.order_item_id,
           o.order_id,
           o.order_ts,
           CAST(strftime(o.order_ts, '%Y%m%d') AS INTEGER) AS date_key,
           c.customer_key,
           p.product_key,
           o.channel,
           o.quantity,
           o.unit_price,
           o.discount_amount,
           o.revenue,
           o.cost,
           strftime(o.order_ts, '%Y-%m') AS month
    FROM orders o
    JOIN dim_customer c
      ON c.customer_id = o.customer_id
     AND o.order_ts >= c.valid_from
     AND o.order_ts <  c.valid_to
    JOIN dim_product p
      ON p.product_id = o.product_id
  `);

  const facts = Number(await count(connection, 'fact_order_item'));
  const source = Number(await count(connection, 'orders'));
  if (facts !== source) {
    // Lost or duplicated rows mean the validity ranges have a hole or an overlap.
    throw new Error(`fact has ${facts} rows, orders has ${source}: SCD2 ranges are not a partition`);
  }
  return facts;
}

async function count(connection: DuckDBConnection, table: string): Promise<string> {
  const result = await connection.runAndReadAll(`SELECT count(*) FROM ${table}`);
  return String(result.getRowsJson()[0]![0]);
}
