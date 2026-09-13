import { createRng, cumulativeWeights, deriveSeed, zipfWeights } from './random';

/**
 * The product catalogue and the two low-cardinality dimensions.
 *
 * `channel` has 3 distinct values and `category` has 8. That is deliberate: they are
 * the columns that demonstrate dictionary encoding, and the per-column byte table in
 * docs/results.md is only interesting because they sit next to `order_ts`, which is
 * near-unique.
 */

export const CHANNELS = ['web', 'app', 'store'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_WEIGHTS = cumulativeWeights([0.55, 0.35, 0.1]);

export const CATEGORIES = [
  'Electronics',
  'Home & Kitchen',
  'Apparel',
  'Beauty',
  'Sports',
  'Toys',
  'Grocery',
  'Books',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Category demand share. Skewed, so a `GROUP BY category` has something to say. */
export const CATEGORY_WEIGHTS = cumulativeWeights([0.22, 0.18, 0.16, 0.12, 0.1, 0.08, 0.08, 0.06]);

/** List price band and gross margin per category, in cents. */
const CATEGORY_ECONOMICS: Record<Category, { minCents: number; maxCents: number; margin: number }> = {
  Electronics: { minCents: 1_999, maxCents: 149_999, margin: 0.22 },
  'Home & Kitchen': { minCents: 999, maxCents: 39_999, margin: 0.38 },
  Apparel: { minCents: 799, maxCents: 19_999, margin: 0.52 },
  Beauty: { minCents: 499, maxCents: 12_999, margin: 0.58 },
  Sports: { minCents: 1_299, maxCents: 59_999, margin: 0.35 },
  Toys: { minCents: 599, maxCents: 14_999, margin: 0.42 },
  Grocery: { minCents: 199, maxCents: 4_999, margin: 0.24 },
  Books: { minCents: 599, maxCents: 4_999, margin: 0.3 },
};

const BRANDS = [
  'Acme', 'Northwind', 'Contoso', 'Globex', 'Initech', 'Umbrella', 'Soylent',
  'Vandelay', 'Stark', 'Wayne', 'Tyrell', 'Cyberdyne', 'Aperture', 'Blue Sun',
  'Wonka', 'Duff', 'Gekko', 'Pied Piper', 'Hooli', 'Massive Dynamic',
] as const;

const PRODUCT_NOUNS: Record<Category, readonly string[]> = {
  Electronics: ['Headphones', 'Monitor', 'Keyboard', 'Router', 'Speaker', 'Charger', 'Webcam'],
  'Home & Kitchen': ['Kettle', 'Skillet', 'Blender', 'Lamp', 'Duvet', 'Mug Set', 'Toaster'],
  Apparel: ['Hoodie', 'Tee', 'Jacket', 'Runners', 'Chinos', 'Socks', 'Cap'],
  Beauty: ['Serum', 'Cleanser', 'Balm', 'Shampoo', 'Fragrance', 'Mask', 'Lotion'],
  Sports: ['Yoga Mat', 'Dumbbell', 'Bottle', 'Racket', 'Backpack', 'Tracker', 'Rope'],
  Toys: ['Brick Set', 'Puzzle', 'Board Game', 'Plush', 'RC Car', 'Kit', 'Figure'],
  Grocery: ['Coffee', 'Olive Oil', 'Pasta', 'Granola', 'Tea', 'Honey', 'Chocolate'],
  Books: ['Paperback', 'Hardcover', 'Cookbook', 'Atlas', 'Anthology', 'Guide', 'Manual'],
};

export interface Product {
  readonly productId: number;
  readonly name: string;
  readonly category: Category;
  readonly brand: string;
  readonly listPriceCents: number;
  /** Unit cost as a fraction of list price. */
  readonly costRatio: number;
}

export interface ProductCatalog {
  readonly products: readonly Product[];
  /** Product ids per category, best seller first. */
  readonly idsByCategory: ReadonlyMap<Category, readonly number[]>;
  /** Cumulative Zipf weights over `idsByCategory`, so bestsellers dominate. */
  readonly popularityByCategory: ReadonlyMap<Category, Float64Array>;
}

/**
 * A flatter tail than classic Zipf (exponent 1). At exponent 0.9 the top product in
 * a category takes single-digit percent of its sales rather than a sixth of them,
 * which is what real catalogues look like.
 */
const PRODUCT_POPULARITY_EXPONENT = 0.9;

export function buildProductCatalog(seed: number, count: number): ProductCatalog {
  const rng = createRng(deriveSeed(seed, 0x9c0d));
  const products: Product[] = [];
  const idsByCategory = new Map<Category, number[]>(CATEGORIES.map((c) => [c, []]));

  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[rng.pickWeighted(CATEGORY_WEIGHTS)]!;
    const economics = CATEGORY_ECONOMICS[category];
    const brand = rng.pick(BRANDS);
    const noun = rng.pick(PRODUCT_NOUNS[category]);
    const productId = i + 1;

    products.push({
      productId,
      name: `${brand} ${noun} ${100 + (productId % 900)}`,
      category,
      brand,
      // Log-uniform: cheap items are common, expensive ones rare, as in a real catalogue.
      listPriceCents: logUniformCents(rng.next(), economics.minCents, economics.maxCents),
      costRatio: 1 - economics.margin + (rng.next() - 0.5) * 0.08,
    });
    idsByCategory.get(category)!.push(productId);
  }

  const popularityByCategory = new Map<Category, Float64Array>();
  for (const [category, ids] of idsByCategory) {
    if (ids.length === 0) {
      throw new Error(`category ${category} has no products; increase OLAP_PRODUCTS`);
    }
    popularityByCategory.set(category, zipfWeights(ids.length, PRODUCT_POPULARITY_EXPONENT));
  }

  return { products, idsByCategory, popularityByCategory };
}

function logUniformCents(u: number, minCents: number, maxCents: number): number {
  const value = Math.exp(Math.log(minCents) + u * (Math.log(maxCents) - Math.log(minCents)));
  // Retail pricing: land on a .99 or .49 boundary.
  return Math.max(minCents, Math.round(value / 100) * 100 - (u < 0.5 ? 1 : 51));
}
