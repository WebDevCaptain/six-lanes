import { describe, expect, it } from 'vitest';

import { enumerateDays } from '../../src/data/calendar.js';
import { generateDataset, type GeneratorConfig, type OrderItem } from '../../src/data/generator.js';

/**
 * The generator's contract, asserted rather than assumed.
 *
 * Determinism is the load-bearing one: every number this project publishes claims
 * to be reproducible, and that claim is worth exactly as much as this test.
 */
const CONFIG: GeneratorConfig = {
  seed: 42,
  orderItems: 20_000,
  customers: 4_000,
  products: 300,
  startDate: '2024-09-01',
  endDate: '2025-03-01',
};

const collect = (config: GeneratorConfig): OrderItem[] => [...generateDataset(config).batches()].flat();

describe('generateDataset', () => {
  const items = collect(CONFIG);

  it('emits exactly the requested number of line items', () => {
    expect(items).toHaveLength(CONFIG.orderItems);
  });

  it('is byte-for-byte reproducible at the same seed', () => {
    expect(collect(CONFIG)).toEqual(items);
  });

  it('produces different data at a different seed', () => {
    expect(collect({ ...CONFIG, seed: 43 })).not.toEqual(items);
  });

  it('keeps revenue = quantity * unit_price - discount, to the cent', () => {
    for (const item of items) {
      expect(item.revenueCents).toBe(item.quantity * item.unitPriceCents - item.discountCents);
    }
  });

  it('gives every line item a unique id, densely numbered from 1', () => {
    const ids = new Set(items.map((i) => i.orderItemId));
    expect(ids.size).toBe(items.length);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(items.length);
  });

  it('groups line items into orders of one to four', () => {
    const sizes = new Map<number, number>();
    for (const item of items) sizes.set(item.orderId, (sizes.get(item.orderId) ?? 0) + 1);
    expect(Math.min(...sizes.values())).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes.values())).toBeLessThanOrEqual(4);
  });

  it('keeps every line of an order at one instant and one customer', () => {
    const byOrder = new Map<number, OrderItem[]>();
    for (const item of items) byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item]);
    for (const lines of byOrder.values()) {
      expect(new Set(lines.map((l) => l.orderTsMicros)).size).toBe(1);
      expect(new Set(lines.map((l) => l.customerId)).size).toBe(1);
    }
  });

  it('emits rows in ascending order_ts', () => {
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.orderTsMicros).toBeGreaterThanOrEqual(items[i - 1]!.orderTsMicros);
    }
  });

  it('stays inside the configured date range', () => {
    const startMicros = BigInt(Date.parse(`${CONFIG.startDate}T00:00:00Z`)) * 1000n;
    const endMicros = BigInt(Date.parse(`${CONFIG.endDate}T00:00:00Z`)) * 1000n;
    for (const item of items) {
      expect(item.orderTsMicros).toBeGreaterThanOrEqual(startMicros);
      expect(item.orderTsMicros).toBeLessThan(endMicros);
    }
  });

  it('books returns as negative measures with a positive unit price', () => {
    const returns = items.filter((i) => i.quantity < 0);
    expect(returns.length / items.length).toBeGreaterThan(0.01);
    expect(returns.length / items.length).toBeLessThan(0.035);
    for (const item of returns) {
      expect(item.revenueCents).toBeLessThan(0);
      expect(item.costCents).toBeLessThanOrEqual(0);
      expect(item.unitPriceCents).toBeGreaterThan(0);
    }
  });

  it('spikes on Black Friday', () => {
    // 2024-11-29 is the Friday after the fourth Thursday of November.
    const perDay = countByDate(items);
    const blackFriday = perDay.get('2024-11-29') ?? 0;
    const ordinaryFriday = perDay.get('2024-11-08') ?? 0;
    expect(blackFriday).toBeGreaterThan(ordinaryFriday * 3);
  });

  it('sells more at the weekend than midweek', () => {
    const perDay = countByDate(items);
    const days = enumerateDays(CONFIG.startDate, CONFIG.endDate);
    const mean = (wanted: readonly number[]): number => {
      const chosen = days.filter((d) => wanted.includes(d.dayOfWeek));
      return chosen.reduce((sum, d) => sum + (perDay.get(isoDate(d.startMs)) ?? 0), 0) / chosen.length;
    };
    expect(mean([6])).toBeGreaterThan(mean([2]));
  });

  it('skews to a head of bestselling products and a long tail', () => {
    const perProduct = new Map<number, number>();
    for (const item of items) perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + 1);
    const sorted = [...perProduct.values()].sort((a, b) => b - a);
    const topDecile = sorted.slice(0, Math.ceil(sorted.length / 10)).reduce((a, b) => a + b, 0);
    expect(topDecile / items.length).toBeGreaterThan(0.2);
  });
});

function countByDate(items: readonly OrderItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const date = isoDate(Number(item.orderTsMicros / 1000n));
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
