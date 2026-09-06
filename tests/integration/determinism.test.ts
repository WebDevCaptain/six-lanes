import { describe, expect, it } from 'vitest';

import { contentFingerprint, type Fingerprint } from '../../src/data/fingerprint';
import { generateDataset, type GeneratorConfig } from '../../src/data/generator';
import { ingestOrders } from '../../src/data/ingest';
import { connectDuckDB } from '../../src/duckdb/connect';
import { readSqlFile } from '../../src/sql-files';

/**
 * The plan's Day 1 checklist: the same seed must produce the same data, every time.
 *
 * tests/unit/generator.test.ts proves the generator emits identical objects. This
 * goes further and takes them through DuckDB, because that is where a decimal could
 * lose its scale or a timestamp its timezone, and a checksum computed in SQL is the
 * only thing that would notice.
 */
const CONFIG: GeneratorConfig = {
  seed: 42,
  orderItems: 40_000,
  customers: 5_000,
  products: 400,
  startDate: '2024-09-01',
  endDate: '2025-01-01',
};

async function fingerprintOf(config: GeneratorConfig): Promise<Fingerprint> {
  const connection = await connectDuckDB({});
  try {
    await connection.run(readSqlFile('01_schema.duckdb.sql'));
    await ingestOrders(connection, generateDataset(config));
    return await contentFingerprint(connection);
  } finally {
    connection.disconnectSync();
  }
}

describe('generate, twice', () => {
  it('produces an identical fingerprint at the same seed', async () => {
    expect(await fingerprintOf(CONFIG)).toEqual(await fingerprintOf(CONFIG));
  });

  it('produces a different fingerprint at a different seed', async () => {
    const first = await fingerprintOf(CONFIG);
    const second = await fingerprintOf({ ...CONFIG, seed: 43 });
    expect(second.checksum).not.toBe(first.checksum);
    expect(second.lineItems).toBe(first.lineItems);
  });

  it('carries money through DuckDB without losing a cent', async () => {
    // The generator works in integer cents; the fingerprint sums DECIMAL(12,2).
    const { revenue } = await fingerprintOf(CONFIG);
    expect(revenue).toMatch(/^-?\d+\.\d{2}$/);
  });
});
