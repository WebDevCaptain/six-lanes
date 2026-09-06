# Results

Every measurement, appended as taken. Numbers only - the reasoning lives in
`docs/concepts.md`, the plan lives in `docs/PLAN.md`.

Reproduce any of it with:

```
pnpm up && pnpm generate && pnpm load && pnpm compare --write
```

---

## Methodology

These rules are enforced in code, not in good intentions. Where a rule is
implemented, the file is named.

| Rule | Where it lives |
| --- | --- |
| A lane's timing is published only if its rows match lane A exactly | `src/bench/compare.ts`, `tests/integration/lanes.test.ts` |
| Median and p95 of 5 timed runs after 1 warm-up, never a mean | `src/bench/measure.ts`, `src/lanes/create-lane.ts` |
| Bytes read comes from the engine, in a pass outside the timed loop | `src/lanes/postgres.ts`, `src/duckdb/profile.ts` |
| Every result carries the host it was measured on | `src/host.ts` |
| Handicaps are attached to the lane, not to a footnote | `src/lanes/meta.ts` |

### How bytes read is measured

**Lane A (Postgres).** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)`, taking
`(Shared Hit Blocks + Shared Read Blocks) x 8192` from the **root** plan node.
Verified before relying on it: Postgres buffer counts are inclusive of a node's
children, so summing the tree would count the same blocks several times.

**Lane C (DuckDB).** `total_bytes_read` from the JSON query profile. Three things
were established on DuckDB 1.5.3 before this was trusted:

1. The counter is exact **only for reads through `httpfs`**. For a local file read it
   reports the footer and nothing else - 1,407 bytes for a scan of a 377 KB column.
   This is why lane C reads the lake over HTTP and never off the disk, which also
   happens to be the topology a CDN-hosted deployment uses.
2. `operator_rows_scanned` is not rows scanned. It reported 1,254,480 for a scan of
   120,000 rows. The scan operator's `operator_cardinality` is the real figure.
3. `extra_info` on the scan carries `Total Files Read` and `Projections`, so
   partition pruning and column pruning are counted rather than asserted.

Column pruning shows up byte for byte. Reading `d` alone from a four-column file
cost 394,301 bytes; adding `c`, whose column chunk is 214 bytes, cost 394,515.

**The warm/cold split.** Lane A is timed with the table in shared buffers. Lane C is
timed with DuckDB's caches on, for the same reason - comparing a warm engine to a
cold one is the thing rule 9 forbids. Byte counts for lane C then come from a
*separate* uncached pass, because a warm re-read reports zero bytes, which is true
and useless. Timing and accounting are two passes in both lanes.

---

## Day 1 - two engines, three queries

Dataset: 1,000,000 line items, 581,190 orders, 24 months (2024-09 to 2026-08),
182,187 distinct customers, 5,000 products, 1.98% returns booked as negative
revenue. Seed 42, fingerprint `1942343578140121437`.

| Store | Size |
| --- | ---: |
| Postgres heap | 109 MB |
| Postgres total, with indexes | 166 MB |
| Parquet lake, zstd, 24 partitions | 15.68 MB |
| Ratio | **7.0x** |

### Reading the Day 1 table

**Q1, column pruning.** DuckDB answers in 6.7 ms reading 2.67 MB; Postgres answers in
32 ms reading 109 MB. **4.8x on time, 41x on I/O.** Both scan all 1,000,000 rows, and
that is the point: the row count is identical and the byte count is not. Postgres
must walk past ten columns it was never asked about to reach the two it was. The
profile confirms DuckDB read exactly `['category', 'revenue']` and nothing else.

The I/O ratio is the number that transfers. 4.8x on time is a fact about an M5; 41x
on bytes is a fact about the layout, and it will hold on any machine.

**Q2, partition pruning.** DuckDB opens **7 of 24 files**. Six months of data are
requested, so six files can contain a matching row - plus one more, because the range
ends at a month boundary and pruning is only allowed to discard files that *cannot*
match. The exact `order_ts` predicate still runs; the partition predicate only
decides which files are opened.

Lane A here is worth its own note. The first honest measurement of this query was
**80.6 ms**, and it was slow for a reason that has nothing to do with row stores:
grouping by `to_char(order_ts, 'YYYY-MM')` is grouping by an expression the planner
has no statistics for. It estimated the group count wildly high, refused a hash
aggregate, and sorted 237,171 rows through a 5.8 MB external merge on disk. One
`CREATE STATISTICS` on the expression later, the planner sees six groups, runs a
parallel hash aggregate and spills nothing: **19.9 ms, a 4.0x speedup from telling
the planner the truth.** That statement is now part of the load (`sql/02_tune.postgres.sql`).
Lane A is the baseline, so it is measured at its best; a comparison won by leaving
the other engine misconfigured proves nothing.

**Q7, the query the row store wins.** Postgres: 0.301 ms end to end, of which
**0.007 ms is the engine** and the rest is the TCP round trip. DuckDB: 5.6 ms. On
engine time that is **800x**; even counting the network against Postgres it is 19x.
A b-tree goes straight to three tuples in 32 KB. The column store has to reassemble a
row from twelve separate places.

But look at what the lake did *not* do. It read 970 KB, not 15.68 MB, and scanned 3
rows, not 1,000,000 - while still opening all 24 files. That is row-group min/max
statistics working: `order_id` rises with `order_ts`, the lake is written in time
order, so every row group's min/max on `order_id` rules itself out immediately.
DuckDB reads 24 footers and one row group. It still loses, and it should - but it
loses by 19x instead of by 1000x, and the difference is entirely down to the data
being clustered on the column being searched.

### 2026-09-06 04:50 UTC - 1,000,000 line items

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Parameters: `from=2025-03-01T00:00:00Z  to=2025-09-01T00:00:00Z  order_id=250000`

| query | lane | median | p95 | engine | bytes read | rows scanned | returned | files |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | A  Postgres 18 | 32.08 | 37.49 | 33.70 | 109.00 MB | 1,000,000 | 8 | - |
| revenue_by_category | C  DuckDB over the lake | 6.749 | 7.590 | - | 2.67 MB | 1,000,000 | 8 | 24 |
| revenue_by_month_filtered | A  Postgres 18 | 19.91 | 20.80 | 19.80 | 33.98 MB | 237,171 | 6 | - |
| revenue_by_month_filtered | C  DuckDB over the lake | 5.803 | 7.352 | - | 1.11 MB | 237,171 | 6 | 7 |
| order_lookup | A  Postgres 18 | 0.301 | 0.355 | 0.007 | 32.0 KB | 3 | 3 | - |
| order_lookup | C  DuckDB over the lake | 5.613 | 6.103 | - | 970.3 KB | 3 | 3 | 24 |

5 timed runs per cell after 1 warm-up; median and p95, never a mean.
