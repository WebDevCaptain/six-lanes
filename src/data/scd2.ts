/**
 * The three invariants that make a Type 2 dimension usable. Break any one and queries
 * do not fail, they quietly return a different number:
 *
 *   - two current rows: every "as of today" query double counts the customer
 *   - overlapping ranges: the fact join fans out and revenue is counted twice
 *   - a gap between ranges: an order matches no version and leaves the fact table
 */

/** The minimum a row needs for its validity to be checkable. */
export interface Scd2Row {
  readonly customerKey: number;
  readonly customerId: number;
  readonly validFromMicros: bigint;
  readonly validToMicros: bigint;
  readonly isCurrent: boolean;
}

export interface Scd2Violation {
  readonly invariant: 'unique key' | 'one current' | 'no overlap' | 'no gap' | 'ordered range';
  readonly customerId: number;
  readonly detail: string;
}

export function findScd2Violations(rows: readonly Scd2Row[]): Scd2Violation[] {
  const violations: Scd2Violation[] = [];
  const seenKeys = new Set<number>();
  const byCustomer = new Map<number, Scd2Row[]>();

  for (const row of rows) {
    if (seenKeys.has(row.customerKey)) {
      violations.push({
        invariant: 'unique key',
        customerId: row.customerId,
        detail: `customer_key ${row.customerKey} used more than once`,
      });
    }
    seenKeys.add(row.customerKey);
    byCustomer.set(row.customerId, [...(byCustomer.get(row.customerId) ?? []), row]);
  }

  for (const [customerId, unsorted] of byCustomer) {
    const versions = [...unsorted].sort((a, b) =>
      a.validFromMicros < b.validFromMicros ? -1 : a.validFromMicros > b.validFromMicros ? 1 : 0,
    );

    const current = versions.filter((version) => version.isCurrent);
    if (current.length !== 1) {
      violations.push({
        invariant: 'one current',
        customerId,
        detail: `${current.length} rows flagged is_current, expected exactly 1`,
      });
    }

    for (const version of versions) {
      if (version.validToMicros <= version.validFromMicros) {
        violations.push({
          invariant: 'ordered range',
          customerId,
          detail: `valid_to ${version.validToMicros} is not after valid_from ${version.validFromMicros}`,
        });
      }
    }

    // Consecutive versions must meet exactly, or there is an overlap or a hole.
    for (let i = 1; i < versions.length; i++) {
      const previous = versions[i - 1]!;
      const next = versions[i]!;
      if (previous.validToMicros > next.validFromMicros) {
        violations.push({
          invariant: 'no overlap',
          customerId,
          detail: `version ${previous.customerKey} ends after version ${next.customerKey} begins`,
        });
      } else if (previous.validToMicros < next.validFromMicros) {
        violations.push({
          invariant: 'no gap',
          customerId,
          detail: `nothing is valid between ${previous.validToMicros} and ${next.validFromMicros}`,
        });
      }
    }
  }

  return violations;
}
