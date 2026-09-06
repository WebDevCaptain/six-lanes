import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, QUERIES, QUERY_IDS, getQuery } from '../../src/queries/index';
import type { SqlTarget } from '../../src/queries/types';

const heap: SqlTarget = { dialect: 'postgres', schema: '', partitioned: false };
const lake: SqlTarget = { dialect: 'duckdb', schema: 'lake.', partitioned: true };
const federated: SqlTarget = { dialect: 'duckdb', schema: 'pg.', partitioned: false };

describe('the catalogue', () => {
  it('registers every query under its own id', () => {
    for (const id of QUERY_IDS) expect(getQuery(id)).toBe(QUERIES[id]);
  });

  it('builds a statement for every query against every target', () => {
    for (const id of QUERY_IDS) {
      for (const target of [heap, lake, federated]) {
        expect(getQuery(id).build(target)).toContain(`${target.schema}fact_order_item`);
      }
    }
  });

  it('binds one value for every placeholder it emits', () => {
    for (const id of QUERY_IDS) {
      const query = getQuery(id);
      const placeholders = new Set(query.build(heap).match(/\$\d+/g) ?? []);
      expect(query.bind(DEFAULT_PARAMS)).toHaveLength(placeholders.size);
    }
  });

  it('declares at least one output column for every query', () => {
    for (const id of QUERY_IDS) expect(getQuery(id).columns.length).toBeGreaterThan(0);
  });

  it('never interpolates a parameter into the SQL text', () => {
    for (const id of QUERY_IDS) {
      const sql = getQuery(id).build(heap);
      expect(sql).not.toContain(String(DEFAULT_PARAMS.orderId));
      expect(sql).not.toContain(DEFAULT_PARAMS.from);
    }
  });
});

describe('Q1 revenue_by_category', () => {
  it('is the same statement in both dialects, given the same schema', () => {
    const a = getQuery('revenue_by_category').build({ ...heap, schema: 'x.' });
    const b = getQuery('revenue_by_category').build({ ...lake, schema: 'x.', partitioned: false });
    expect(a).toBe(b);
  });

  it('names only the columns it needs', () => {
    const sql = getQuery('revenue_by_category').build(heap);
    for (const unused of ['order_ts', 'customer_key', 'unit_price', 'cost']) {
      expect(sql).not.toContain(unused);
    }
  });

  it('joins the product dimension, because category no longer lives on the fact', () => {
    expect(getQuery('revenue_by_category').build(heap)).toContain('dim_product');
  });
});

describe('Q2 revenue_by_month_filtered', () => {
  const q2 = getQuery('revenue_by_month_filtered');

  it('filters on the partition key only when the target has one', () => {
    expect(q2.build(lake)).toContain('month >=');
    expect(q2.build(federated)).not.toContain('month >=');
  });

  it('keeps the exact order_ts bounds in every variant, so pruning cannot change the answer', () => {
    for (const target of [heap, lake, federated]) {
      expect(q2.build(target)).toContain('f.order_ts >=');
      expect(q2.build(target)).toContain('f.order_ts <');
    }
  });

  it('derives the month itself when the relation has no partition column', () => {
    expect(q2.build(federated)).toContain("strftime(f.order_ts, '%Y-%m')");
  });

  it('bounds the partition filter inclusively at the top', () => {
    // `month <` would drop the last matching file when a range ends mid-month.
    expect(q2.build(lake)).toContain('month <=');
  });
});

describe('the star', () => {
  it('joins every dimension somewhere in the catalogue', () => {
    const everySql = QUERY_IDS.map((id) => getQuery(id).build(heap)).join('\n');
    for (const dimension of ['dim_product', 'dim_customer', 'dim_date']) {
      expect(everySql).toContain(dimension);
    }
  });

  it('never joins dim_customer on is_current, which would rewrite history', () => {
    // Filtering to the current version reattributes past orders to today's values.
    for (const id of QUERY_IDS) {
      const sql = getQuery(id).build(heap);
      if (sql.includes('dim_customer')) expect(sql).not.toContain('is_current');
    }
  });

  it('never sums unit_price, which is non-additive', () => {
    for (const id of QUERY_IDS) {
      expect(getQuery(id).build(heap)).not.toMatch(/sum\(\s*\w*\.?unit_price/);
    }
  });
});

describe('Q4 rolling_revenue', () => {
  const q4 = getQuery('rolling_revenue');

  it('drives the calendar from dim_date, not from the facts', () => {
    // A window of 29 preceding ROWS is only a 29-day window if every day has a row.
    expect(q4.build(heap)).toContain('LEFT JOIN');
    expect(q4.build(heap)).toContain('dim_date');
  });

  it('zero-fills days with no orders', () => {
    expect(q4.build(heap)).toContain('coalesce(sum(f.revenue), 0)');
  });
});

describe('Q5 repeat_rate', () => {
  it('counts customer_id, not customer_key: one person, not one SCD2 version', () => {
    const sql = getQuery('repeat_rate').build(heap);
    expect(sql).toContain('c.customer_id');
    expect(sql).toMatch(/GROUP BY month, c\.customer_id/);
  });
});

describe('Q7 order_lookup', () => {
  it('lists its columns rather than selecting star', () => {
    const sql = getQuery('order_lookup').build(lake);
    expect(sql).not.toContain('*');
    expect(getQuery('order_lookup').columns).toHaveLength(12);
  });

  it('names every declared column in the statement', () => {
    const sql = getQuery('order_lookup').build(heap);
    for (const column of getQuery('order_lookup').columns) expect(sql).toContain(column.name);
  });
});
