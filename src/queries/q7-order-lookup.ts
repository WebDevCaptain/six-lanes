import { table } from './dialect.js';
import type { QueryDef } from './types.js';

/**
 * Q7 - the query the row store wins.
 *
 * One order, every column of it, no joins. Deliberately no joins: the point being
 * measured is how expensive it is to reassemble a whole row, and adding a dimension
 * lookup would mix that with how expensive it is to probe an index.
 *
 * Columns are listed rather than `SELECT *`. The lake's fact table carries an extra
 * `month` partition column that the heap does not, so `*` would mean different things
 * in different lanes and the equality check would be comparing shapes, not values.
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
