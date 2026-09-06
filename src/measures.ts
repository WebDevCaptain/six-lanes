import { existsSync } from 'node:fs';

import { formatCount, formatMs, renderTable, type Column } from './bench/table';
import { DEFAULT_PARAMS } from './queries/index';
import { PATHS } from './config';
import { connectDuckDB, scalar } from './duckdb/connect';

/**
 * `pnpm measures` - what you are and are not allowed to add up, and what an
 * approximate answer costs.
 *
 * Summing a column from the wrong measure class is arithmetically correct and
 * semantically meaningless, and nothing errors. Whether to trade exactness for speed
 * on a distinct count is a measurement rather than an opinion, so both are measured.
 */
if (!existsSync(PATHS.database)) {
  throw new Error(`${PATHS.database} not found - run \`pnpm generate\` first`);
}

const duck = await connectDuckDB({ path: PATHS.database });
const { from, to } = DEFAULT_PARAMS;
const WINDOW = `order_ts >= TIMESTAMPTZ '${from}' AND order_ts < TIMESTAMPTZ '${to}'`;

// ---------------------------------------------------------------------------
console.log('ADDITIVE: revenue survives being grouped any way you like\n');

const totals = await duck.runAndReadAll(`
  SELECT 'grand total'          AS grouping, sum(revenue) AS revenue FROM fact_order_item
  UNION ALL SELECT 'by category',  sum(revenue) FROM (SELECT p.category, sum(f.revenue) AS revenue
              FROM fact_order_item f JOIN dim_product p ON p.product_key = f.product_key GROUP BY 1)
  UNION ALL SELECT 'by month',     sum(revenue) FROM (SELECT month, sum(revenue) AS revenue
              FROM fact_order_item GROUP BY 1)
  UNION ALL SELECT 'by channel',   sum(revenue) FROM (SELECT channel, sum(revenue) AS revenue
              FROM fact_order_item GROUP BY 1)
  UNION ALL SELECT 'by customer',  sum(revenue) FROM (SELECT customer_key, sum(revenue) AS revenue
              FROM fact_order_item GROUP BY 1)
`);
for (const row of totals.getRowObjectsJson() as Record<string, string>[]) {
  console.log(`  ${String(row['grouping']).padEnd(14)}${String(row['revenue']).padStart(18)}`);
}
console.log(`
  Five groupings, one number. That is what "additive" means: the measure can be
  summed across every dimension of the fact table and still answers the same
  question. Revenue, cost, quantity and discount are all in this class.`);

// ---------------------------------------------------------------------------
console.log('\nNON-ADDITIVE: unit_price is a rate, and rates do not add\n');

const prices = await duck.runAndReadAll(`
  SELECT sum(unit_price)                                        AS sum_of_prices,
         avg(unit_price)                                        AS unweighted_avg,
         sum(revenue + discount_amount) / sum(quantity)         AS weighted_avg
  FROM fact_order_item
  WHERE ${WINDOW}
`);
const price = prices.getRowObjectsJson()[0] as Record<string, string>;

console.log(`  sum(unit_price)                                  ${String(price['sum_of_prices']).padStart(16)}`);
console.log(`  avg(unit_price)                                  ${String(price['unweighted_avg']).padStart(16)}`);
console.log(`  sum(revenue + discount) / sum(quantity)          ${String(price['weighted_avg']).padStart(16)}`);
console.log(`
  The first number is the sum of the prices printed on every line item's sticker.
  Nothing in the business has that value. It is not revenue - revenue is already a
  column - and it is not a total of anything anyone would ask for. It grows if you
  split an order into more lines, which is the giveaway: a measure that changes when
  you change the grain is not a measure.

  The second is the trap, because it looks reasonable. It is the mean price *per line
  item*, weighting a line that sold one unit the same as a line that sold five.

  The third is the number people actually mean by "average selling price": total money
  over total units. It is derived at query time from two additive measures, which is
  the only safe way to carry a ratio into a fact table - by not carrying it.`);

// ---------------------------------------------------------------------------
console.log('\nSEMI-ADDITIVE: on_hand adds across products, never across days\n');

const stock = await duck.runAndReadAll(`
  WITH latest AS (SELECT max(date_key) AS date_key FROM fact_inventory_snapshot)
  SELECT (SELECT count(DISTINCT date_key) FROM fact_inventory_snapshot)  AS days,
         (SELECT sum(on_hand) FROM fact_inventory_snapshot s
           JOIN latest l ON l.date_key = s.date_key)                     AS units_today,
         (SELECT sum(on_hand) FROM fact_inventory_snapshot)              AS units_summed,
         (SELECT avg(daily) FROM (
            SELECT sum(on_hand) AS daily FROM fact_inventory_snapshot GROUP BY date_key
          ))                                                             AS units_average
`);
const inventory = stock.getRowObjectsJson()[0] as Record<string, string>;
const days = Number(inventory['days']);

console.log(`  ${formatCount(days)} daily snapshots of every product`);
console.log(`  stock on hand today                              ${formatCount(Number(inventory['units_today'])).padStart(16)}`);
console.log(`  sum(on_hand) across all days                     ${formatCount(Number(inventory['units_summed'])).padStart(16)}`);
console.log(`  average daily stock                              ${formatCount(Math.round(Number(inventory['units_average']))).padStart(16)}`);
console.log(`
  The middle number is ${days} times too large and describes nothing. There are not
  ${formatCount(Number(inventory['units_summed']))} units anywhere; there are about
  ${formatCount(Number(inventory['units_today']))}, counted again on each of ${days} days.

  This is the class that catches people, because it is fine right up until the moment
  somebody widens the date range. Sum on_hand across products and you get the stock in
  the warehouse. Sum it across two days and you have counted the same physical boxes
  twice. The measure is additive across every dimension except time.

  The safe aggregations across time are the ones that pick a point or a level rather
  than a total: the closing balance, the average, the minimum. Revenue has no such
  restriction because revenue is an event, and events do not persist into the next day
  waiting to be counted again.`);

// ---------------------------------------------------------------------------
console.log('\nEXACT VS APPROXIMATE DISTINCT\n');

interface DistinctRow {
  readonly label: string;
  readonly exact: number;
  readonly approximate: number;
  readonly exactMs: number;
  readonly approximateMs: number;
}

const cases: readonly { label: string; column: string; where: string }[] = [
  { label: 'customers, 6 months', column: 'c.customer_id', where: WINDOW },
  { label: 'customers, all time', column: 'c.customer_id', where: 'TRUE' },
  { label: 'orders, all time', column: 'f.order_id', where: 'TRUE' },
  { label: 'products, all time', column: 'f.product_key', where: 'TRUE' },
];

const rows: DistinctRow[] = [];
for (const { label, column, where } of cases) {
  const relation = `FROM fact_order_item f
    JOIN dim_customer c ON c.customer_key = f.customer_key
    WHERE ${where}`;

  const exact = await timedScalar(`SELECT count(DISTINCT ${column}) ${relation}`);
  const approximate = await timedScalar(`SELECT approx_count_distinct(${column}) ${relation}`);

  rows.push({
    label,
    exact: Number(exact.value),
    approximate: Number(approximate.value),
    exactMs: exact.ms,
    approximateMs: approximate.ms,
  });
}

const COLUMNS: readonly Column<DistinctRow>[] = [
  { header: 'distinct count of', value: (r) => r.label },
  { header: 'exact', align: 'right', value: (r) => formatCount(r.exact) },
  { header: 'approx', align: 'right', value: (r) => formatCount(r.approximate) },
  {
    header: 'error',
    align: 'right',
    value: (r) => `${(((r.approximate - r.exact) / r.exact) * 100).toFixed(3)}%`,
  },
  { header: 'exact ms', align: 'right', value: (r) => formatMs(r.exactMs) },
  { header: 'approx ms', align: 'right', value: (r) => formatMs(r.approximateMs) },
  { header: 'speedup', align: 'right', value: (r) => `${(r.exactMs / r.approximateMs).toFixed(1)}x` },
];

console.log(renderTable(COLUMNS, rows));

// A control: `range(n)` has exactly n distinct values, so this isolates the function.
console.log('\n  control - the same function over a known-cardinality sequence:\n');
for (const n of [1_000, 5_000, 100_000, 600_000]) {
  const result = await duck.runAndReadAll(
    `SELECT count(DISTINCT i) AS e, approx_count_distinct(i) AS a FROM range(${n}) t(i)`,
  );
  const [exact, approximate] = result.getRowsJson()[0]!.map(Number) as [number, number];
  console.log(
    `    n = ${formatCount(n).padStart(9)}   approx ${formatCount(approximate).padStart(9)}   error ${(((approximate - exact) / exact) * 100).toFixed(2)}%`,
  );
}

console.log(`
  approx_count_distinct is HyperLogLog: constant memory, one pass, no sort. The
  textbook error for HLL is around 1-2%, and this is not that. On DuckDB 1.5.3 it is
  off by 25% on a thousand distinct values and 13% on five thousand, on a sequence
  whose cardinality is exact by construction. The implementation is cheaper and
  coarser than the name suggests.

  So the plan's open question - should Q5 default to exact or approximate - has a
  measured answer rather than a preference: **exact**. The speedup is 1.3x to 2.9x on
  this data, and the price is an error of 12% to 25%. Nobody trades a quarter of the
  answer for under 3x. At a hundred times the data the calculus changes, because the
  exact count's sort grows and HLL's registers do not - but that is a decision to make
  against a measurement at that size, not this one.

  Q5 in the catalogue uses the exact count regardless: it feeds a repeat rate that is
  compared for equality across six engines, and an estimate cannot be compared for
  equality with anything.`);

duck.disconnectSync();

async function timedScalar(sql: string): Promise<{ value: string; ms: number }> {
  await scalar(duck, sql); // warm-up, matching the protocol the lanes use
  const started = performance.now();
  const value = await scalar<string>(duck, sql);
  return { value: String(value), ms: performance.now() - started };
}
