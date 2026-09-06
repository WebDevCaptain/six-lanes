import { describe, expect, it } from 'vitest';

import { allocate, createRng, cumulativeWeights, deriveSeed, zipfWeights } from '../../src/data/random';

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = Array.from({ length: 8 }, () => createRng(42).next());
    const b = Array.from({ length: 8 }, () => createRng(42).next());
    expect(a).toEqual(b);
  });

  it('produces a different sequence for a different seed', () => {
    expect(createRng(42).next()).not.toEqual(createRng(43).next());
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps int() inside the requested range', () => {
    const rng = createRng(11);
    for (let i = 0; i < 10_000; i++) expect(rng.int(5)).toBeLessThan(5);
  });
});

describe('deriveSeed', () => {
  it('gives distinct streams for adjacent indices', () => {
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(42, i)));
    expect(seeds.size).toBe(1000);
  });
});

describe('cumulativeWeights', () => {
  it('normalises to a final value of 1', () => {
    const cumulative = cumulativeWeights([3, 1, 6]);
    expect(cumulative[cumulative.length - 1]).toBeCloseTo(1, 12);
  });

  it('samples in rough proportion to the weights', () => {
    const cumulative = cumulativeWeights([1, 3]);
    const rng = createRng(5);
    let ones = 0;
    for (let i = 0; i < 40_000; i++) if (rng.pickWeighted(cumulative) === 1) ones++;
    expect(ones / 40_000).toBeCloseTo(0.75, 2);
  });

  it('rejects weights that sum to zero', () => {
    expect(() => cumulativeWeights([0, 0])).toThrow(/positive/);
  });
});

describe('zipfWeights', () => {
  it('makes rank 0 the most likely outcome', () => {
    const cumulative = zipfWeights(100, 0.9);
    expect(cumulative[0]!).toBeGreaterThan(cumulative[1]! - cumulative[0]!);
  });
});

describe('allocate', () => {
  it('distributes exactly the requested total', () => {
    const counts = allocate(1_000_000, [1, 2.5, 0.3, 7, 4]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it('handles a total smaller than the number of buckets', () => {
    const counts = allocate(2, [1, 1, 1, 1]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('is deterministic', () => {
    const weights = [1, 1, 1, 1, 1, 1, 1];
    expect(allocate(100, weights)).toEqual(allocate(100, weights));
  });

  it('gives more to heavier buckets', () => {
    const [small = 0, large = 0] = allocate(1000, [1, 9]);
    expect(large).toBeGreaterThan(small);
  });
});
