import {
  CATEGORIES,
  CATEGORY_WEIGHTS,
  CHANNELS,
  CHANNEL_WEIGHTS,
  buildProductCatalog,
  type Category,
  type Channel,
  type Product,
  type ProductCatalog,
} from './catalog';
import { HOUR_OF_DAY_WEIGHTS, demandWeights, enumerateDays, type Day } from './calendar';
import { allocate, createRng, cumulativeWeights, deriveSeed, type Rng } from './random';

/**
 * The seeded generator. Same seed in, same rows out, on any machine.
 *
 * Money is carried as integer cents everywhere in this file. Floating point dollars
 * would drift by a cent somewhere in a million rows, and the whole project rests on
 * six engines agreeing on `sum(revenue)` exactly.
 */

/** Grain: one row per line item on one order. */
export interface OrderItem {
  readonly orderItemId: number;
  readonly orderId: number;
  /** Epoch microseconds, UTC. */
  readonly orderTsMicros: bigint;
  readonly customerId: number;
  readonly productId: number;
  readonly channel: Channel;
  readonly category: Category;
  /** Negative on a return. */
  readonly quantity: number;
  /** Always positive: a price is a rate, not an amount. Never sum this column. */
  readonly unitPriceCents: number;
  readonly discountCents: number;
  /** Exactly `quantity * unitPriceCents - discountCents`. Negative on a return. */
  readonly revenueCents: number;
  readonly costCents: number;
}

export interface GeneratorConfig {
  readonly seed: number;
  readonly orderItems: number;
  readonly customers: number;
  readonly products: number;
  readonly startDate: string;
  readonly endDate: string;
}

const ORDER_SIZE_WEIGHTS = cumulativeWeights([0.55, 0.25, 0.13, 0.07]);
const QUANTITY_WEIGHTS = cumulativeWeights([0.5, 0.25, 0.13, 0.07, 0.05]);
const HOUR_WEIGHTS = cumulativeWeights([...HOUR_OF_DAY_WEIGHTS]);
const DISCOUNT_RATES = [0.05, 0.1, 0.15, 0.2, 0.3] as const;

/** Share of orders that are returns, booked as a mirror-image credit order. */
const RETURN_RATE = 0.02;

/**
 * Skews customer selection towards a repeat-buying core without giving any single
 * customer an absurd share. Exponent > 1 pushes draws toward low ids; 1.6 puts
 * roughly half the orders with the most active fifth of the base, which is what
 * Q5's repeat rate needs in order to be a real number.
 */
const CUSTOMER_SKEW = 1.6;

const BATCH_SIZE = 50_000;

export interface Dataset {
  readonly catalog: ProductCatalog;
  /** Line items in ascending `order_ts`, yielded in batches to bound memory. */
  batches: () => Generator<OrderItem[]>;
}

export function generateDataset(config: GeneratorConfig): Dataset {
  const catalog = buildProductCatalog(config.seed, config.products);
  return { catalog, batches: () => generateBatches(config, catalog) };
}

function* generateBatches(config: GeneratorConfig, catalog: ProductCatalog): Generator<OrderItem[]> {
  const days = enumerateDays(config.startDate, config.endDate);
  const weights = demandWeights(days);
  const quotas = allocate(config.orderItems, weights);

  let orderItemId = 1;
  let orderId = 1;
  let batch: OrderItem[] = [];

  for (const day of days) {
    // Own stream per day, so rows depend on (seed, day) and not on earlier days.
    const rng = createRng(deriveSeed(config.seed, day.index));
    const promoChance = Math.min(0.6, 0.15 * weights[day.index]!);

    for (const order of planDay(rng, day, quotas[day.index]!, config.customers)) {
      const currentOrderId = orderId++;
      for (let line = 0; line < order.lineCount; line++) {
        batch.push(
          buildLineItem(rng, catalog, order, currentOrderId, orderItemId++, promoChance),
        );
      }
      if (batch.length >= BATCH_SIZE) {
        yield batch;
        batch = [];
      }
    }
  }

  if (batch.length > 0) yield batch;
}

interface PlannedOrder {
  readonly tsMicros: bigint;
  readonly customerId: number;
  readonly channel: Channel;
  readonly lineCount: number;
  /** A credit note: every measure on every line is negated. */
  readonly isReturn: boolean;
}

/**
 * Lays out one day's orders, sorted by timestamp.
 *
 * Sorting matters beyond realism: it makes `order_ts` monotonic within a Parquet
 * row group, which is exactly the clustering the Day 2 min/max-statistics study
 * measures.
 */
function planDay(rng: Rng, day: Day, itemQuota: number, customers: number): PlannedOrder[] {
  const orders: PlannedOrder[] = [];
  for (let remaining = itemQuota; remaining > 0; ) {
    const lineCount = Math.min(rng.pickWeighted(ORDER_SIZE_WEIGHTS) + 1, remaining);
    orders.push({
      tsMicros: timestampWithin(rng, day),
      customerId: pickCustomer(rng, customers),
      channel: CHANNELS[rng.pickWeighted(CHANNEL_WEIGHTS)]!,
      lineCount,
      isReturn: rng.chance(RETURN_RATE),
    });
    remaining -= lineCount;
  }
  return orders.sort((a, b) => (a.tsMicros < b.tsMicros ? -1 : a.tsMicros > b.tsMicros ? 1 : 0));
}

function timestampWithin(rng: Rng, day: Day): bigint {
  const hour = rng.pickWeighted(HOUR_WEIGHTS);
  const secondsIntoDay = hour * 3600 + rng.int(3600);
  return BigInt(day.startMs) * 1000n + BigInt(secondsIntoDay) * 1_000_000n;
}

function pickCustomer(rng: Rng, customers: number): number {
  return 1 + Math.min(customers - 1, Math.floor(customers * Math.pow(rng.next(), CUSTOMER_SKEW)));
}

function buildLineItem(
  rng: Rng,
  catalog: ProductCatalog,
  order: PlannedOrder,
  orderId: number,
  orderItemId: number,
  promoChance: number,
): OrderItem {
  const product = pickProduct(rng, catalog);
  const quantity = rng.pickWeighted(QUANTITY_WEIGHTS) + 1;
  const gross = quantity * product.listPriceCents;
  const discountCents = rng.chance(promoChance)
    ? Math.round(gross * rng.pick(DISCOUNT_RATES))
    : 0;
  const revenueCents = gross - discountCents;
  const costCents = Math.round(quantity * product.listPriceCents * product.costRatio);

  /*
   * A return reverses the sale line for line. Negating quantity, discount, revenue
   * and cost together keeps `revenue = quantity * unit_price - discount` exact, and
   * leaves `unit_price` positive because a rate has no sign.
   */
  const sign = order.isReturn ? -1 : 1;

  return {
    orderItemId,
    orderId,
    orderTsMicros: order.tsMicros,
    customerId: order.customerId,
    productId: product.productId,
    channel: order.channel,
    category: product.category,
    quantity: sign * quantity,
    unitPriceCents: product.listPriceCents,
    discountCents: sign * discountCents,
    revenueCents: sign * revenueCents,
    costCents: sign * costCents,
  };
}

function pickProduct(rng: Rng, catalog: ProductCatalog): Product {
  const category = CATEGORIES[rng.pickWeighted(CATEGORY_WEIGHTS)]!;
  const ids = catalog.idsByCategory.get(category)!;
  const rank = rng.pickWeighted(catalog.popularityByCategory.get(category)!);
  return catalog.products[ids[rank]! - 1]!;
}
