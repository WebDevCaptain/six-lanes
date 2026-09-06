export type Dialect = 'postgres' | 'duckdb';

/**
 * Where a lane reads from, in the only terms a query needs to know.
 *
 * Lanes differ in engine and in storage, but a query only cares about three
 * things: which SQL dialect to speak, what to put after FROM, and whether the
 * relation exposes a Hive `month` column that can eliminate whole files.
 */
export interface SqlTarget {
  readonly dialect: Dialect;
  /**
   * Qualifies every star table: `''` for the default schema, `'lake.'` for the
   * DuckLake catalog, `'pg.'` for an attached Postgres.
   *
   * A prefix rather than a single relation name, because from Day 4 a query joins
   * a fact table to its dimensions and needs to address all four.
   */
  readonly schema: string;
  /**
   * True only for the Parquet lake, whose fact table carries a `month` Hive
   * partition column. When set, range queries add a redundant predicate on it -
   * redundant for correctness, decisive for I/O.
   */
  readonly partitioned: boolean;
}

/** Bound parameter values. Strings are ISO instants; numbers are integers. */
export type QueryValue = string | number;

/**
 * The complete parameter surface. There is no free-form SQL and there never will
 * be: this catalogue is reachable from a public URL, and "let the user pass SQL"
 * is not a feature, it is a vulnerability.
 */
export interface QueryParams {
  /** Inclusive lower bound, `YYYY-MM-DD`, UTC. */
  readonly from: string;
  /** Exclusive upper bound, `YYYY-MM-DD`, UTC. */
  readonly to: string;
  readonly orderId: number;
  readonly limit: number;
}

/**
 * How a column is compared across lanes.
 *
 * Postgres hands back NUMERIC as a string, DuckDB hands back DECIMAL as a
 * differently formatted string, and PGlite hands back something else again. Rather
 * than teach every lane about every other lane, each query declares the shape of
 * its output once and one normaliser applies it everywhere.
 */
export type ColumnType = 'money' | 'int' | 'text' | 'timestamp';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
}

/**
 * A query has no `id` field: the key it is registered under in `QUERIES` is its id,
 * so the two can never drift apart.
 */
export interface QueryDef {
  /** Shown in the UI as the question being asked. */
  readonly question: string;
  /** The one thing this query exists to demonstrate. */
  readonly concept: string;
  readonly columns: readonly ColumnSpec[];
  /** Positional values for `$1..$n`, in order. */
  bind(params: QueryParams): readonly QueryValue[];
  build(target: SqlTarget): string;
}
