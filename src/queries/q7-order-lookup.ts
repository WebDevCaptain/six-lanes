import type { QueryDef } from './types.js';

/**
 * Q7 - the query the row store wins.
 *
 * One order, every column of it. A b-tree on `order_id` takes Postgres straight to
 * a handful of tuples; the column store has to touch every column chunk in every
 * file, because `order_id` says nothing about which file a row is in. A comparison
 * that never loses is marketing, and this is why this one is not.
 *
 * Columns are listed explicitly rather than `SELECT *`. The lake carries an extra
 * `month` partition column that the heap does not, so `*` would mean different
 * things in different lanes and the equality check would be comparing shapes rather
 * than values.
 */
export const q7OrderLookup: QueryDef = {
  question: 'One order and its line items, by id',
  concept: 'Point lookup: where the row store wins',
  columns: [
    { name: 'order_item_id', type: 'int' },
    { name: 'order_id', type: 'int' },
    { name: 'order_ts', type: 'timestamp' },
    { name: 'customer_id', type: 'int' },
    { name: 'product_id', type: 'int' },
    { name: 'channel', type: 'text' },
    { name: 'category', type: 'text' },
    { name: 'quantity', type: 'int' },
    { name: 'unit_price', type: 'money' },
    { name: 'discount_amount', type: 'money' },
    { name: 'revenue', type: 'money' },
    { name: 'cost', type: 'money' },
  ],

  bind: ({ orderId }) => [orderId],

  build: ({ relation }) => `
SELECT order_item_id,
       order_id,
       order_ts,
       customer_id,
       product_id,
       channel,
       category,
       quantity,
       unit_price,
       discount_amount,
       revenue,
       cost
FROM ${relation}
WHERE order_id = $1
ORDER BY order_item_id
`.trim(),
};
