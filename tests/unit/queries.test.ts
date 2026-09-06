import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, QUERIES, QUERY_IDS, getQuery } from '../../src/queries/index.js';
import type { SqlTarget } from '../../src/queries/types.js';

const heap: SqlTarget = { dialect: 'postgres', relation: 'orders', partitioned: false };
const lake: SqlTarget = { dialect: 'duckdb', relation: 'lake_orders', partitioned: true };
const federated: SqlTarget = { dialect: 'duckdb', relation: 'pg.orders', partitioned: false };

describe('the catalogue', () => {
  it('registers every query under its own id', () => {
    for (const id of QUERY_IDS) expect(getQuery(id)).toBe(QUERIES[id]);
  });

  it('builds a statement for every query against every target', () => {
    for (const id of QUERY_IDS) {
      for (const target of [heap, lake, federated]) {
        expect(getQuery(id).build(target)).toContain(target.relation);
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
  it('is the same statement in both dialects', () => {
    const a = getQuery('revenue_by_category').build({ ...heap, relation: 'x' });
    const b = getQuery('revenue_by_category').build({ ...lake, relation: 'x' });
    expect(a).toBe(b);
  });

  it('reads only the two columns it needs', () => {
    const sql = getQuery('revenue_by_category').build(heap);
    for (const unused of ['order_ts', 'customer_id', 'unit_price', 'cost']) {
      expect(sql).not.toContain(unused);
    }
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
      expect(q2.build(target)).toContain('order_ts >=');
      expect(q2.build(target)).toContain('order_ts <');
    }
  });

  it('derives the month itself when the relation has no partition column', () => {
    expect(q2.build(federated)).toContain("strftime(order_ts, '%Y-%m')");
  });

  it('bounds the partition filter inclusively at the top', () => {
    // `month <` would drop the file holding the last matching rows whenever the
    // range ends mid-month; pruning may only remove files that cannot match.
    expect(q2.build(lake)).toContain('month <=');
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
