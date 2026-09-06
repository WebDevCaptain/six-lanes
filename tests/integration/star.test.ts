import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { POSTGRES_URL } from '../../src/config.js';

/**
 * The star schema's integrity, checked against the loaded data rather than the
 * generator that produced it.
 *
 * The unit tests in tests/unit/customers.test.ts prove the dimension is well formed.
 * These prove the fact table was actually built against it - which is a separate
 * claim, and the one that a wrong join in src/data/star.ts would break.
 */
let client: pg.Client;

const scalar = async (sql: string): Promise<string> => {
  const result = await client.query<Record<string, string>>(sql);
  return Object.values(result.rows[0]!)[0]!;
};

beforeAll(async () => {
  client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();
  await client.query(`SET TimeZone = 'UTC'`);
});

afterAll(() => client.end());

describe('referential integrity', () => {
  it('resolves every foreign key', async () => {
    // Declared as REFERENCES in the DDL, so Postgres has already enforced this.
    // Asserted anyway, because the lake has no constraints at all and the same rows
    // are supposed to be in both.
    expect(await scalar(`
      SELECT count(*) FROM fact_order_item f
      LEFT JOIN dim_customer c ON c.customer_key = f.customer_key
      LEFT JOIN dim_product  p ON p.product_key  = f.product_key
      LEFT JOIN dim_date     d ON d.date_key     = f.date_key
      WHERE c.customer_key IS NULL OR p.product_key IS NULL OR d.date_key IS NULL
    `)).toBe('0');
  });

  it('gives dim_date a row for every day in the span, with no gaps', async () => {
    // Q4's rolling window counts rows, so a missing day would silently shorten it.
    expect(await scalar(`
      SELECT count(*) FROM (
        SELECT date, lead(date) OVER (ORDER BY date) - date AS step FROM dim_date
      ) s WHERE step <> 1
    `)).toBe('0');
  });
});

describe('the SCD2 join', () => {
  it('points every fact at the customer version that was valid when the order happened', async () => {
    // The invariant the whole dimension exists for. A fact joined to the wrong
    // version is not an error anywhere, it is a slightly different revenue number.
    expect(await scalar(`
      SELECT count(*) FROM fact_order_item f
      JOIN dim_customer c ON c.customer_key = f.customer_key
      WHERE f.order_ts < c.valid_from OR f.order_ts >= c.valid_to
    `)).toBe('0');
  });

  it('has customers who genuinely changed, or the test above proves nothing', async () => {
    const changed = Number(await scalar(`
      SELECT count(*) FROM (
        SELECT customer_id FROM dim_customer
        GROUP BY customer_id HAVING count(*) > 1
      ) s
    `));
    expect(changed).toBeGreaterThan(1000);
  });

  it('has facts on both sides of a change, or the join is never exercised', async () => {
    const spanning = Number(await scalar(`
      SELECT count(*) FROM (
        SELECT c.customer_id
        FROM fact_order_item f
        JOIN dim_customer c ON c.customer_key = f.customer_key
        GROUP BY c.customer_id
        HAVING count(DISTINCT f.customer_key) > 1
      ) s
    `));
    expect(spanning).toBeGreaterThan(100);
  });
});

describe('Type 2 versus Type 1, on the same question', () => {
  /**
   * The reason any of this is worth the trouble.
   *
   * "Revenue by segment" has two answers. Joining through the surrogate key uses the
   * segment each customer had at the time of the order. Joining through the natural
   * key to the current row restates all of history under today's segments. Both are
   * one line of SQL and neither errors.
   */
  it('attributes revenue differently, which is the entire point of Type 2', async () => {
    const asOfThen = await scalar(`
      SELECT sum(f.revenue) FROM fact_order_item f
      JOIN dim_customer c ON c.customer_key = f.customer_key
      WHERE c.segment = 'enterprise'
    `);
    const asOfNow = await scalar(`
      SELECT sum(f.revenue) FROM fact_order_item f
      JOIN dim_customer k ON k.customer_key = f.customer_key
      JOIN dim_customer n ON n.customer_id = k.customer_id AND n.is_current
      WHERE n.segment = 'enterprise'
    `);

    expect(asOfThen).not.toBe(asOfNow);
    // Same facts, same filter, different totals - and if the dimension were Type 1
    // the second number would be the only one available.
    const difference = Math.abs(Number(asOfThen) - Number(asOfNow));
    expect(difference).toBeGreaterThan(0);
  });

  it('answers a question about a past month with that month\'s segment', async () => {
    // Take one customer who moved segment mid-history, and check that their earliest
    // order is booked under the segment they had then, not the one they have now.
    const row = await client.query<{ then_segment: string; now_segment: string }>(`
      WITH movers AS (
        SELECT customer_id FROM dim_customer
        GROUP BY customer_id HAVING count(DISTINCT segment) > 1
      ),
      first_order AS (
        SELECT c.customer_id, f.order_ts, c.segment AS then_segment
        FROM fact_order_item f
        JOIN dim_customer c ON c.customer_key = f.customer_key
        JOIN movers m ON m.customer_id = c.customer_id
        ORDER BY f.order_ts
        LIMIT 1
      )
      SELECT o.then_segment, n.segment AS now_segment
      FROM first_order o
      JOIN dim_customer n ON n.customer_id = o.customer_id AND n.is_current
    `);

    const { then_segment: thenSegment, now_segment: nowSegment } = row.rows[0]!;
    expect(thenSegment).not.toBe(nowSegment);
  });
});

describe('measure classes', () => {
  it('keeps revenue additive across every dimension', async () => {
    const total = await scalar('SELECT sum(revenue) FROM fact_order_item');
    for (const dimension of ['channel', 'date_key', 'customer_key', 'product_key']) {
      const regrouped = await scalar(
        `SELECT sum(s) FROM (SELECT sum(revenue) AS s FROM fact_order_item GROUP BY ${dimension}) t`,
      );
      expect(regrouped).toBe(total);
    }
  });

  it('produces a meaningless number when unit_price is summed, as documented', async () => {
    // Not a bug to fix, a class of column to know about. sum(unit_price) is a
    // perfectly valid SQL expression that answers no question anyone has.
    const summed = Number(await scalar('SELECT sum(unit_price) FROM fact_order_item'));
    const revenue = Number(await scalar('SELECT sum(revenue) FROM fact_order_item'));
    expect(summed).toBeGreaterThan(0);
    expect(summed).not.toBeCloseTo(revenue, 0);
  });
});
