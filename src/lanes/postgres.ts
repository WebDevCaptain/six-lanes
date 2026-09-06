import pg from 'pg';

import { createLane, type LaneSpec } from './create-lane';
import type { QueryValue } from '../queries/types';
import type { Lane, LaneId, QueryMetrics } from '../types';

/**
 * Lane A - Postgres 18 doing an OLAP job, and the only lane whose rows are treated
 * as the correct answer.
 *
 * Also the body of lane F, which is the same protocol and SQL with one session
 * setting changed. Sharing the implementation keeps the two lanes differing in the
 * engine rather than in the harness.
 */
export interface PostgresLaneOptions {
  readonly id: LaneId;
  readonly label: string;
  readonly connectionString: string;
  readonly handicaps?: readonly string[];
  /** Session setup run once on connect, after the shared defaults. */
  readonly sessionSetup?: readonly string[];
  /** Lane F's plans are DuckDB's, and Postgres buffer counters do not describe them. */
  readonly reportBuffers?: boolean;
  /**
   * Check which engine the plan actually belongs to.
   *
   * Only lane F needs this, and it needs it badly: see {@link detectExecutor}.
   */
  readonly detectExecutor?: boolean;
}

const BLOCK_BYTES = 8192;

export async function createPostgresLane(options: PostgresLaneOptions): Promise<Lane> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    // One timezone, or the engines disagree which month a midnight belongs to.
    await client.query(`SET TimeZone = 'UTC'`);
    for (const statement of options.sessionSetup ?? []) await client.query(statement);
  } catch (cause) {
    // Setup failing leaves a live connection nobody holds a reference to.
    await client.end().catch(() => undefined);
    throw cause;
  }

  const spec: LaneSpec = {
    id: options.id,
    label: options.label,
    handicaps: options.handicaps ?? [],
    target: { dialect: 'postgres', schema: '', partitioned: false },

    available: async () => {
      try {
        await client.query('SELECT 1 FROM fact_order_item LIMIT 1');
        return true;
      } catch {
        return false;
      }
    },

    execute: async (sql, params) => (await client.query(sql, [...params])).rows,

    measure: async (sql, params) => ({
      ...(options.reportBuffers === false ? {} : await explain(client, sql, params)),
      ...(options.detectExecutor ? await detectExecutor(client, sql, params) : {}),
    }),

    close: () => client.end(),
  };

  return createLane(spec);
}

/**
 * Bytes read, straight from `EXPLAIN (ANALYZE, BUFFERS)`.
 *
 * `TIMING OFF` because this pass is not timed and per-node timing is the expensive
 * part of instrumenting a plan. Buffer counts in Postgres are inclusive of a node's
 * children - verified before this was written - so the root node already holds the
 * total and summing the tree would count the same blocks several times over.
 */
async function explain(
  client: pg.Client,
  sql: string,
  params: readonly QueryValue[],
): Promise<Omit<QueryMetrics, 'rowsReturned'>> {
  const explained = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF, COSTS OFF) ${sql}`,
    [...params],
  );
  const analysis = (explained.rows[0] as { 'QUERY PLAN': [ExplainResult] })['QUERY PLAN'][0];
  const plan = analysis.Plan;

  return {
    bytesRead: ((plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0)) * BLOCK_BYTES,
    rowsScanned: countScannedRows(plan),
    engineMs: analysis['Execution Time'],
  };
}

interface ExplainResult {
  readonly Plan: PlanNode;
  readonly 'Execution Time'?: number;
}

/**
 * Which engine is really going to run this.
 *
 * pg_duckdb does not fail when DuckDB cannot handle a statement: it warns where no
 * client sees it, plans the Postgres way, and returns the right answer at Postgres
 * speed. Four of the seven queries fall back, all on `to_char`, and without this
 * check lane F would report them as pg_duckdb results.
 */
async function detectExecutor(
  client: pg.Client,
  sql: string,
  params: readonly QueryValue[],
): Promise<Pick<QueryMetrics, 'executedBy'>> {
  const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [...params]);
  const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
  return { executedBy: plan.includes('DuckDBScan') ? 'DuckDB' : 'Postgres (DuckDB declined)' };
}

interface PlanNode {
  readonly 'Node Type': string;
  /** Present only on scans of a base relation, which is exactly what we want to count. */
  readonly 'Relation Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly PlanNode[];
}

/**
 * Rows the plan pulled off the relations.
 *
 * Only nodes with `Relation Name` count: that skips the Bitmap Index Scan under a
 * Bitmap Heap Scan, which would otherwise double the figure. Under a parallel plan
 * `Actual Rows` is a per-loop mean, so the product with `Actual Loops` is the total,
 * and rounding removes the fraction an uneven split leaves behind.
 */
function countScannedRows(node: PlanNode): number {
  const own =
    node['Relation Name'] === undefined
      ? 0
      : (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
  return Math.round((node.Plans ?? []).reduce((sum, child) => sum + countScannedRows(child), own));
}
