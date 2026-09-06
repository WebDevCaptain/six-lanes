/**
 * What the browser downloads, and how much of it.
 *
 * Both browser lanes have a cost the server lanes do not: they have to fetch their
 * data before they can answer anything. That cost is measured here rather than
 * estimated, and is reported next to their query timings - a lane that answers in
 * 4 ms after a 20-second download has not answered in 4 ms.
 */

export interface SliceManifest {
  readonly builtAt: string;
  readonly fromDateKey: number;
  readonly toDateKey: number;
  readonly rows: Readonly<Record<string, number>>;
  readonly parquet: { readonly bytes: number; readonly files: readonly string[] };
  readonly pglite: { readonly bytes: number; readonly file: string };
  readonly budgetBytes: number;
}

/** Where the slice is served from, relative to the page. */
export const SLICE_BASE = '/slice';

/** How a browser lane got ready, and what it cost. */
export interface Preparation {
  /**
   * Payload bytes the engine consumed, from Resource Timing.
   *
   * The compressed body size rather than the transferred size, because a second
   * visit revalidates from cache and reports a transfer of a few hundred bytes -
   * true about the network and a lie about what the engine had to load.
   */
  readonly bytesDownloaded: number;
  /** True when the browser served the payload from its cache. */
  readonly fromCache: boolean;
  readonly downloadMs: number;
  /** Time to get the engine from "downloaded" to "able to answer a query". */
  readonly initialiseMs: number;
  readonly rows: number;
  /** Free text for the UI, e.g. the engine's own version string. */
  readonly engineVersion: string;
}

export interface Transferred {
  /** Compressed payload size, whether it came from the network or the cache. */
  readonly bytes: number;
  /** True when almost nothing crossed the wire, i.e. the cache answered. */
  readonly fromCache: boolean;
}

/**
 * What a set of URLs cost, from the Resource Timing API.
 *
 * `encodedBodySize` is the payload the engine loaded; `transferSize` is what crossed
 * the network, and it collapses to a few hundred bytes of revalidation on a second
 * visit. Reporting the transfer alone would claim PGlite downloads 300 bytes.
 *
 * Undefined rather than zero when the browser declines to report.
 */
export function transferred(match: (url: string) => boolean): Transferred | undefined {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return undefined;

  const entries = performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => 'encodedBodySize' in entry)
    .filter((entry) => match(entry.name));

  if (entries.length === 0) return undefined;

  const bytes = entries.reduce((sum, entry) => sum + entry.encodedBodySize, 0);
  const overWire = entries.reduce((sum, entry) => sum + entry.transferSize, 0);
  if (bytes === 0) return undefined;

  return { bytes, fromCache: overWire < bytes / 2 };
}
