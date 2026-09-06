import { defineConfig } from 'vitest/config';

/**
 * Two suites, kept apart on purpose.
 *
 *   tests/unit         pure, no services, runs anywhere in under a second
 *   tests/integration  needs `pnpm up && pnpm generate && pnpm load`
 *
 * The split is not about speed, it is about what a failure means. A unit failure is
 * a bug in this repo. An integration failure might be a bug, or might be a container
 * that is not running, and mixing the two makes the suite easy to start ignoring.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env['OLAP_INTEGRATION'] ? [] : ['tests/integration/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The integration lanes hold Postgres connections and DuckDB instances; running
    // files in parallel would have them competing for the same warm caches and
    // quietly ruining each other's measurements.
    fileParallelism: false,
  },
});
