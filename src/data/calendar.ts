/**
 * The demand curve the generator sells against.
 *
 * Flat random data would make every partition the same size, every row group
 * statistically identical, and every pruning experiment a no-op. The whole Day 2
 * layout study depends on the data having real structure, so the seasonality here
 * is load-bearing, not decoration.
 */

const MS_PER_DAY = 86_400_000;

export interface Day {
  /** 0-based offset from the first day of the dataset. */
  readonly index: number;
  /** Midnight UTC, epoch milliseconds. */
  readonly startMs: number;
  /** 0 = Sunday. */
  readonly dayOfWeek: number;
  readonly year: number;
  /** 1-based. */
  readonly month: number;
  readonly dayOfMonth: number;
}

/** Days in `[startDate, endDate)`, both `YYYY-MM-DD`, interpreted as UTC. */
export function enumerateDays(startDate: string, endDate: string): Day[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('dates must be YYYY-MM-DD');
  if (end <= start) throw new Error('endDate must be after startDate');

  const days: Day[] = [];
  for (let ms = start, index = 0; ms < end; ms += MS_PER_DAY, index++) {
    const d = new Date(ms);
    days.push({
      index,
      startMs: ms,
      dayOfWeek: d.getUTCDay(),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      dayOfMonth: d.getUTCDate(),
    });
  }
  return days;
}

/** Sunday first, matching `Date.getUTCDay`. */
const DAY_OF_WEEK_FACTOR = [1.05, 0.92, 0.9, 0.95, 1.0, 1.15, 1.25] as const;

/**
 * Multiplier by offset from Black Friday, running Tuesday before to Tuesday after.
 * Two peaks - Black Friday itself and Cyber Monday - because that is what the real
 * curve looks like, and a double peak is a better test of row-group statistics than
 * a single one.
 */
const BLACK_FRIDAY_WINDOW = [1.3, 1.6, 1.2, 6.0, 3.5, 2.8, 4.5, 1.8] as const;
const BLACK_FRIDAY_WINDOW_START = -3;

/** Day the shopping year turns: the Friday after the fourth Thursday of November. */
function blackFridayDayOfMonth(year: number): number {
  const firstOfNovember = new Date(Date.UTC(year, 10, 1));
  const daysToFirstThursday = (4 - firstOfNovember.getUTCDay() + 7) % 7;
  return 1 + daysToFirstThursday + 21 + 1;
}

function seasonalFactor(day: Day): number {
  if (day.month === 11) {
    const offset = day.dayOfMonth - blackFridayDayOfMonth(day.year);
    const windowIndex = offset - BLACK_FRIDAY_WINDOW_START;
    const factor = BLACK_FRIDAY_WINDOW[windowIndex];
    if (factor !== undefined) return factor;
  }
  // Christmas build-up, then a near-shutdown over the holiday itself.
  if (day.month === 12) {
    if (day.dayOfMonth <= 23) return 1.35;
    if (day.dayOfMonth <= 26) return 0.6;
    return 1.1;
  }
  // The January hangover.
  if (day.month === 1 && day.dayOfMonth <= 15) return 0.85;
  return 1;
}

/**
 * Relative demand per day: weekday rhythm, seasonal spikes, and a gentle 18%
 * trend across the two years so the newest partitions are visibly the largest.
 */
export function demandWeights(days: readonly Day[]): number[] {
  const span = Math.max(days.length - 1, 1);
  return days.map((day) => {
    const growth = 1 + 0.18 * (day.index / span);
    return DAY_OF_WEEK_FACTOR[day.dayOfWeek]! * seasonalFactor(day) * growth;
  });
}

/**
 * Relative order volume by hour of day, UTC. A lunchtime shoulder and an evening
 * peak; almost nothing at 04:00.
 */
export const HOUR_OF_DAY_WEIGHTS = [
  0.30, 0.20, 0.15, 0.10, 0.10, 0.15, 0.35, 0.70, 1.10, 1.40, 1.60, 1.70,
  1.80, 1.70, 1.60, 1.55, 1.60, 1.70, 1.90, 2.10, 2.00, 1.60, 1.00, 0.55,
] as const;
