import { createRng, deriveSeed, type Rng } from './random';

/**
 * `dim_customer`, as a Slowly Changing Dimension of Type 2.
 *
 * Type 1 overwrites the old value and every historical report silently changes with
 * it. Type 2 writes a new row with a new validity range, so a question about January
 * is answered with January's facts.
 *
 * Roughly one customer in six changes here, so the invariant tests have something to
 * catch.
 */

export const COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'CA', 'AU', 'IN', 'JP', 'BR', 'NL', 'SE', 'ES',
] as const;
export type Country = (typeof COUNTRIES)[number];

export const SEGMENTS = ['consumer', 'small business', 'enterprise'] as const;
export type Segment = (typeof SEGMENTS)[number];

/**
 * The open end of a validity range.
 *
 * A concrete far-future date rather than NULL or `infinity`. NULL would make every
 * range predicate need an OR, and the whole point of the range is that
 * `order_ts >= valid_from AND order_ts < valid_to` works without special cases.
 */
export const FOREVER = '2999-12-31T00:00:00Z';
export const FOREVER_MICROS = BigInt(Date.parse(FOREVER)) * 1000n;

export interface CustomerVersion {
  /** Surrogate key. Unique per version, not per person. */
  readonly customerKey: number;
  /** Natural key. Shared by every version of the same person. */
  readonly customerId: number;
  readonly name: string;
  readonly country: Country;
  readonly segment: Segment;
  readonly validFromMicros: bigint;
  readonly validToMicros: bigint;
  readonly isCurrent: boolean;
}

/** Share of customers whose attributes change during the dataset's span. */
const CHANGE_ONCE = 0.14;
const CHANGE_TWICE = 0.03;

export function buildCustomers(
  seed: number,
  count: number,
  startMicros: bigint,
  endMicros: bigint,
): CustomerVersion[] {
  const rng = createRng(deriveSeed(seed, 0xc05f));
  const versions: CustomerVersion[] = [];
  let customerKey = 1;

  for (let customerId = 1; customerId <= count; customerId++) {
    const name = `Customer ${customerId.toString().padStart(6, '0')}`;
    const changes = changeTimes(rng, startMicros, endMicros);

    let country = COUNTRIES[rng.int(COUNTRIES.length)]!;
    let segment = SEGMENTS[rng.int(SEGMENTS.length)]!;
    let validFrom = startMicros;

    for (const changeAt of [...changes, FOREVER_MICROS]) {
      const isCurrent = changeAt === FOREVER_MICROS;
      versions.push({
        customerKey: customerKey++,
        customerId,
        name,
        country,
        segment,
        validFromMicros: validFrom,
        validToMicros: changeAt,
        isCurrent,
      });

      if (isCurrent) break;
      // Usually one attribute, not both, so the versions differ in one dimension.
      if (rng.chance(0.55)) segment = nextDistinct(rng, SEGMENTS, segment);
      else country = nextDistinct(rng, COUNTRIES, country);
      validFrom = changeAt;
    }
  }

  return versions;
}

/** Zero, one or two change instants, strictly increasing and inside the span. */
function changeTimes(rng: Rng, startMicros: bigint, endMicros: bigint): bigint[] {
  const roll = rng.next();
  const howMany = roll < CHANGE_TWICE ? 2 : roll < CHANGE_TWICE + CHANGE_ONCE ? 1 : 0;
  if (howMany === 0) return [];

  const span = endMicros - startMicros;
  const times = Array.from({ length: howMany }, () =>
    startMicros + (span * BigInt(1 + rng.int(998))) / 1000n,
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Two changes at one instant produce a zero-length version: legal, and nonsense.
  return times[0] === times[1] ? [times[0]!] : times;
}

function nextDistinct<T>(rng: Rng, options: readonly T[], current: T): T {
  const alternatives = options.filter((option) => option !== current);
  return alternatives[rng.int(alternatives.length)]!;
}
