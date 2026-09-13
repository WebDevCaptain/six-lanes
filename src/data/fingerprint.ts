import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * A content fingerprint of the generated dataset. `bit_xor` over per-row hashes is
 * order independent, so batching and arrival order do not affect it; paired with the
 * row count and revenue total it is what "same seed, same data" is checked against.
 */
export interface Fingerprint {
  readonly lineItems: number;
  readonly orders: number;
  readonly customers: number;
  readonly products: number;
  readonly revenue: string;
  readonly returnRate: number;
  readonly checksum: string;
}

export async function contentFingerprint(connection: DuckDBConnection): Promise<Fingerprint> {
  const result = await connection.runAndReadAll(`
    SELECT count(*)                                                  AS line_items,
           count(DISTINCT order_id)                                  AS orders,
           count(DISTINCT customer_id)                               AS customers,
           count(DISTINCT product_id)                                AS products,
           sum(revenue)                                              AS revenue,
           count(*) FILTER (WHERE quantity < 0) / count(*)::DOUBLE   AS return_rate,
           bit_xor(hash(order_item_id, order_id, order_ts, customer_id,
                        product_id, channel, category, quantity,
                        unit_price, discount_amount, revenue, cost)) AS checksum
    FROM orders
  `);

  const row = result.getRowObjectsJson()[0] as Record<string, string>;
  return {
    lineItems: Number(row['line_items']),
    orders: Number(row['orders']),
    customers: Number(row['customers']),
    products: Number(row['products']),
    revenue: String(row['revenue']),
    returnRate: Number(row['return_rate']),
    checksum: String(row['checksum']),
  };
}
