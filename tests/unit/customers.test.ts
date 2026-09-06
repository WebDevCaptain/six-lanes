import { describe, expect, it } from 'vitest';

import { FOREVER_MICROS, buildCustomers, type CustomerVersion } from '../../src/data/customers.js';
import { findScd2Violations, type Scd2Row } from '../../src/data/scd2.js';

/**
 * The SCD2 dimension, and the checker that guards it.
 *
 * The plan asks that these tests fail when the generator is deliberately broken, so
 * the second half of this file breaks it on purpose - once per invariant - and
 * asserts the checker notices. A checker nobody has seen fail is not evidence.
 */
const START = BigInt(Date.parse('2024-09-01T00:00:00Z')) * 1000n;
const END = BigInt(Date.parse('2026-09-01T00:00:00Z')) * 1000n;

const versions = buildCustomers(42, 5_000, START, END);

describe('buildCustomers', () => {
  it('is deterministic at a given seed', () => {
    expect(buildCustomers(42, 500, START, END)).toEqual(buildCustomers(42, 500, START, END));
  });

  it('satisfies every SCD2 invariant', () => {
    expect(findScd2Violations(versions)).toEqual([]);
  });

  it('emits more versions than customers, or there is nothing to test', () => {
    const people = new Set(versions.map((version) => version.customerId));
    expect(people.size).toBe(5_000);
    expect(versions.length).toBeGreaterThan(people.size);
  });

  it('changes a real attribute at every change, not just the validity range', () => {
    const byCustomer = new Map<number, CustomerVersion[]>();
    for (const version of versions) {
      byCustomer.set(version.customerId, [...(byCustomer.get(version.customerId) ?? []), version]);
    }

    let changed = 0;
    for (const history of byCustomer.values()) {
      for (let i = 1; i < history.length; i++) {
        const before = history[i - 1]!;
        const after = history[i]!;
        expect(before.country !== after.country || before.segment !== after.segment).toBe(true);
        changed++;
      }
    }
    // Between a seventh and a quarter of customers should move at all.
    expect(changed / byCustomer.size).toBeGreaterThan(0.1);
    expect(changed / byCustomer.size).toBeLessThan(0.3);
  });

  it('starts every customer at the beginning of the dataset', () => {
    const firsts = versions.filter((version) => version.validFromMicros === START);
    expect(firsts.length).toBe(5_000);
  });

  it('leaves exactly one open-ended version per customer', () => {
    const open = versions.filter((version) => version.validToMicros === FOREVER_MICROS);
    expect(open.length).toBe(5_000);
    expect(open.every((version) => version.isCurrent)).toBe(true);
  });

  it('keeps the name stable across versions, because a name is not what changes', () => {
    const names = new Map<number, Set<string>>();
    for (const version of versions) {
      names.set(version.customerId, (names.get(version.customerId) ?? new Set()).add(version.name));
    }
    for (const set of names.values()) expect(set.size).toBe(1);
  });
});

describe('findScd2Violations catches a broken generator', () => {
  const history = (customerId: number): Scd2Row[] =>
    versions.filter((version) => version.customerId === customerId);

  /** A customer the generator gave more than one version, so there is a range to break. */
  const multiVersion = versions.find(
    (version) => history(version.customerId).length > 1,
  )!.customerId;

  it('notices two current rows', () => {
    const broken = history(multiVersion).map((row) => ({ ...row, isCurrent: true }));
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('one current');
  });

  it('notices no current row', () => {
    const broken = history(multiVersion).map((row) => ({ ...row, isCurrent: false }));
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('one current');
  });

  it('notices overlapping validity ranges', () => {
    const [first, ...rest] = history(multiVersion);
    const broken = [{ ...first!, validToMicros: first!.validToMicros + 86_400_000_000n }, ...rest];
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('no overlap');
  });

  it('notices a gap between validity ranges', () => {
    const [first, ...rest] = history(multiVersion);
    const broken = [{ ...first!, validToMicros: first!.validToMicros - 86_400_000_000n }, ...rest];
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('no gap');
  });

  it('notices a duplicated surrogate key', () => {
    const rows = history(multiVersion);
    const broken = rows.map((row) => ({ ...row, customerKey: rows[0]!.customerKey }));
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('unique key');
  });

  it('notices a range that ends before it starts', () => {
    const rows = history(multiVersion);
    const broken = [{ ...rows[0]!, validToMicros: rows[0]!.validFromMicros - 1n }];
    expect(findScd2Violations(broken).map((v) => v.invariant)).toContain('ordered range');
  });
});
