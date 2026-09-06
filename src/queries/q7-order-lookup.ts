import { table } from './dialect';
import type { QueryDef } from './types';

/**
 * Q7 - the query the row store wins. One order, every column, no joins: the cost being
 * measured is reassembling a whole row, and a dimension lookup would mix that with
 * the cost of probing an index.
 *
 * Columns are listed rather than `SELECT *` because the lake's fact table carries a
 * `month` column the heap does not, so `*` would compare shapes rather than values.
 */
export const q7OrderLookup: QueryDef = {
  question: 'One order and its line items, by id',
  concept: 'Point lookup: where the row store wins',
  columns: [
    { name: 'order_item_id', type: 'int' },
    { name: 'order_id', type: 'int' },
    { name: 'order_ts', type: 'timestamp' },
    { name: 'date_key', type: 'int' },
    { name: 'customer_key', type: 'int' },
    { name: 'product_key', type: 'int' },
    { name: 'channel', type: 'text' },
    { name: 'quantity', type: 'int' },
    { name: 'unit_price', type: 'money' },
    { name: 'discount_amount', type: 'money' },
    { name: 'revenue', type: 'money' },
    { name: 'cost', type: 'money' },
  ],

  bind: ({ orderId }) => [orderId],

  build: (target) => `
SELECT order_item_id,
       order_id,
       order_ts,
       date_key,
       customer_key,
       product_key,
       channel,
       quantity,
       unit_price,
       discount_amount,
       revenue,
       cost
FROM ${table(target, 'fact')}
WHERE order_id = $1
ORDER BY order_item_id
`.trim(),
};
