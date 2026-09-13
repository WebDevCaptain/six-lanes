import { DuckDBDecimalValue, DuckDBTimestampTZValue, type DuckDBConnection } from '@duckdb/node-api';

import type { Dataset, OrderItem } from './generator';

/**
 * Moves generated rows into DuckDB through the appender.
 *
 * The appender rather than INSERT because it writes straight into column vectors;
 * a million rows land in under three seconds. Decimals go in as `DuckDBDecimalValue`
 * over the integer cents the generator produced, so no money value is ever a float,
 * not even in transit.
 */

const MONEY_WIDTH = 12;
const PRICE_WIDTH = 10;
const SCALE = 2;

export async function ingestOrders(
  connection: DuckDBConnection,
  dataset: Dataset,
  onProgress?: (rowsSoFar: number) => void,
): Promise<number> {
  const appender = await connection.createAppender('orders');
  let rows = 0;

  for (const batch of dataset.batches()) {
    for (const item of batch) appendOrderItem(appender, item);
    appender.flushSync();
    rows += batch.length;
    onProgress?.(rows);
  }

  appender.closeSync();
  return rows;
}

/** Column order must match sql/01_schema.duckdb.sql exactly. */
function appendOrderItem(appender: DuckDBAppenderLike, item: OrderItem): void {
  appender.appendBigInt(BigInt(item.orderItemId));
  appender.appendBigInt(BigInt(item.orderId));
  appender.appendTimestampTZ(new DuckDBTimestampTZValue(item.orderTsMicros));
  appender.appendBigInt(BigInt(item.customerId));
  appender.appendBigInt(BigInt(item.productId));
  appender.appendVarchar(item.channel);
  appender.appendVarchar(item.category);
  appender.appendInteger(item.quantity);
  appender.appendDecimal(new DuckDBDecimalValue(BigInt(item.unitPriceCents), PRICE_WIDTH, SCALE));
  appender.appendDecimal(new DuckDBDecimalValue(BigInt(item.discountCents), MONEY_WIDTH, SCALE));
  appender.appendDecimal(new DuckDBDecimalValue(BigInt(item.revenueCents), MONEY_WIDTH, SCALE));
  appender.appendDecimal(new DuckDBDecimalValue(BigInt(item.costCents), MONEY_WIDTH, SCALE));
  appender.endRow();
}

type DuckDBAppenderLike = Awaited<ReturnType<DuckDBConnection['createAppender']>>;
