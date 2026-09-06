# Concepts, and the number that demonstrated each one

Every row here is tied to something measured in this repository, not merely described.
The measurement is in [results.md](results.md); the code that produced it is named so
you can re-run it.

| Concept | Demonstrated by | The number |
| --- | --- | --- |
| OLTP vs OLAP workload shapes | Q7 against Q1-Q6 | Postgres wins one by ~800x and loses six by up to 29x |
| Row store vs column store | lanes A and C, same rows | 107.8 MB read against 3.72 MB |
| Column pruning | Q1, `Projections` in the DuckDB profile | 3 columns of 13; `category` + `revenue` are 16.0% of the file |
| Partition pruning | Q2, `Total Files Read` | 6 of 24 files opened |
| Row-group min/max statistics | Q7 on the raw lake | 24 footers read, 3 rows scanned, 970 KB of 14.95 MB |
| Predicate pushdown | lane B's `Filters` | the range and the point lookup push down; the aggregate does not |
| Compression and encoding | the layout study | zstd 14.95 MB, snappy 25.29 MB, raw 47.98 MB |
| Sort order and clustering | the layout study | shuffling the same rows costs 40% more disk |
| Row group size | the layout study | only matters combined with sort: 1.15x alone, 3.6x together |
| Over-partitioning | month+category, 201 files | one query 5x better, every other 2-6x worse |
| Cardinality vs structure | per-column bytes | `order_item_id` has the highest cardinality and is among the cheapest columns |
| Zero-ETL federation | lane B against A and C | 1,000,000 rows over a socket to return 8 |
| Why lakehouse formats exist | `pnpm gaps` | six gaps reproduced, then closed |
| ACID on a lake | DuckLake rollback | 75,228 rows inside the transaction, 110,392 after |
| Atomic multi-partition change | three partitions, one commit | four visible totals become one |
| Time travel and snapshots | `AT (VERSION => n)` | the pre-backfill total from the same table |
| Schema evolution | `ALTER TABLE ADD COLUMN` | nothing breaks - which is the problem in generation 1 |
| Catalog vs file-based metadata | lane C before and after DuckLake | a point lookup goes from 24 files to 1 |
| Star schema and grain | `src/data/star.ts` | the range join returns exactly as many rows as it consumed |
| Surrogate keys and SCD Type 2 | `tests/integration/star.test.ts` | revenue by segment differs depending on which join you use |
| Additive / non-additive | `pnpm measures` | `sum(revenue)` is one number five ways; `sum(unit_price)` is none |
| Exact vs approximate distinct | `pnpm measures` | 12-25% error for 1.3-2.9x. Answer: exact |
| Window functions and a date spine | Q4 | `dim_date` supplies the days on which nothing was sold |
| Vectorised vs tuple-at-a-time | lanes D and E, same tab | 5x to 14x, and E wins the point lookup by 44x |
| Wire cost of a layout | the browser slice | identical rows: 2.96 MB of Parquet, 24.13 MB of Postgres |
| DuckDB inside Postgres | lane F | 3 of 7 queries executed; one win, two losses |
| Query planning and I/O accounting | every lane | `EXPLAIN (ANALYZE, BUFFERS)` and the DuckDB JSON profile |
| Planner statistics | Q2 on lane A | one `CREATE STATISTICS` took 80.6 ms to 19.9 ms |

---

## When to reach for which

The point of six lanes is that the answer is not the same for every question.

### A read replica of your Postgres (lane A's shape, done properly)

Reach for it when the queries are **selective** - a date range, a customer, an order -
and the answers must be **current to the transaction**. A b-tree over a hot window is
extremely hard to beat: 0.25 ms and 32 KB for a point lookup, against 6 ms for the
lake.

Do not reach for it for full-table aggregates. At 1M rows Postgres reads 107.8 MB to
answer a question about two columns; at 10M rows it reads 1,062 MB and the query takes
830 ms, because the table no longer fits in `shared_buffers`.

### Zero-ETL federation (lane B)

Reach for it when you need **freshness above all** and the predicate is selective. It
is the only lane here that is never stale, and DuckDB pushes both projections and
filters into Postgres, so a selective query moves very little.

Do not reach for it for aggregates over large scans. It cannot push an aggregate down,
so Q1 moves a million rows across a socket to return eight and loses to plain Postgres.
It also puts the full scan on your transactional database while it happens.

### A lakehouse (lane C)

Reach for it for **analytics at any scale you care about**, and especially when you
want the load off the OLTP database entirely. It won every analytical question here, by
3x to 29x, reading 1-4% of the bytes.

The cost is staleness: it is as old as the last pipeline run. And it needs a catalog.
Raw Parquet on object storage cannot even be listed - `httpfs` refuses to glob - so
"just put Parquet in a bucket" is not a design, it is the first half of one.

### DuckDB in the browser (lane D)

Reach for it when the dataset is **small enough to ship** and you want zero
per-query server cost: dashboards over a few hundred thousand rows, embedded analytics,
anything that must work offline. 166,150 rows cost 2.96 MB and answer in 12-34 ms with
no server in the request path.

Do not reach for it above a few million rows. The download is the ceiling, and it is
paid once per visitor.

### Postgres in the browser (lane E)

Reach for it when you want **real Postgres semantics** client-side - the same SQL, the
same types, the same `EXPLAIN` - for local-first applications or for teaching.

Do not reach for it for analytics. On identical rows in the same tab it is 5x to 14x
slower than DuckDB-WASM on every aggregate, and its data directory is 8.1x larger to
ship. It does win the point lookup by 44x, which is the same result as lane A at a
different scale, and for the same reason.

### pg_duckdb (lane F)

**Reach for it when the computation is the bottleneck and the data must stay in
Postgres.** It is one extension and one session setting - no pipeline, no second copy,
no staleness - and on `count(DISTINCT)` over 240,000 rows it was 3.6x faster than the
Postgres executor.

**Do not reach for it expecting an external lake's economics.** It gives you DuckDB's
*execution engine* over Postgres' *row-oriented pages*. There is no column pruning, no
partition pruning and no compressed columnar scan, because the bytes on disk are still
rows. On a plain `sum` over a full scan it was 1.65x **slower** than Postgres: the cost
of converting heap tuples into vectors exceeded what vectorising the aggregate saved.

Two more things to know before choosing it:

- It cannot be deployed to a managed Postgres. `shared_preload_libraries` is not a
  setting Neon, RDS or Cloud SQL will let you set.
- **It declines silently.** When DuckDB cannot translate something - `to_char`, in four
  of our seven queries - it emits a warning no client surfaces and hands the query back
  to Postgres. `force_execution = true` does not change this. If you adopt it, check
  the plan for `Custom Scan (DuckDBScan)`, or you will attribute Postgres' performance
  to it and be surprised later.

### And the one this project found most interesting

Lane C is not Postgres *or* DuckDB. Its catalog is a Postgres schema holding a few
thousand rows of file metadata with indexes on it, and its data is Parquet scanned by
DuckDB. Postgres answers "which files, and what is in them" in a millisecond, which is
exactly what a small, transactional, indexed workload is for. DuckDB scans the columns,
which is exactly what it is for.

The first half of this project is a fight between two engines. The second half is the
observation that the fight was the wrong frame.
