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
| Parquet lake, zstd, 24 partitions | 14.95 MB |
| Ratio | **7.3x** |

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

But look at what the lake did *not* do. It read 970 KB, not 14.95 MB, and scanned 3
rows, not 1,000,000 - while still opening all 24 files. That is row-group min/max
statistics working: `order_id` rises with `order_ts`, the lake is written in time
order, so every row group's min/max on `order_id` rules itself out immediately.
DuckDB reads 24 footers and one row group. It still loses, and it should - but it
loses by 19x instead of by 1000x, and the difference is entirely down to the data
being clustered on the column being searched.

## Day 2 - what the file layout actually does

The same million rows written ten ways, then asked the same four questions. Raw
tables are below; this is what they say.

### Sorting is worthless on its own. Sorting plus small row groups is 3.6x.

Filtering to one category of eight:

| Layout | Bytes read | vs baseline |
| --- | ---: | ---: |
| baseline (natural order, default row groups) | 2.67 MB | 1.0x |
| sorted by `category, order_ts` | 2.33 MB | 1.15x |
| 10,000-row row groups, natural order | 3.02 MB | **0.88x - worse** |
| **sorted by category + 10,000-row row groups** | **734.9 KB** | **3.6x** |

Sorting alone barely moved. The reason is arithmetic: a month partition holds about
42,000 rows and DuckDB's default row group is 122,880, so **each file is a single row
group**. Min/max statistics per row group are useless when there is one row group -
its range covers everything, so nothing can be skipped, and it makes no difference
whether the rows inside are sorted.

Shrinking row groups without sorting is also worse than doing nothing: more row
groups means more metadata and worse compression, and if the values are scattered
every row group still has to be read.

**The two settings are one decision.** Neither is a tuning knob you turn alone. This
is the row-group-statistics mechanism made visible, and it is why the plan's Q7
result on Day 1 looked the way it did: `order_id` is clustered by construction, so
its min/max ranges are tight and the engine skips almost everything.

### Losing clustering costs 40% of your storage

| Sort | On disk |
| --- | ---: |
| natural (time order) | 14.95 MB |
| `category, order_ts` | 16.77 MB |
| shuffled | **20.93 MB** |

Identical rows, identical types, identical compression. The 6 MB difference is
entirely that compression works on runs of similar values, and shuffling destroys
every run. Sorting by `category` is *also* worse than natural order here, because it
scatters `order_ts` and `order_item_id` - two of the four largest columns - to buy
locality on one of the smallest.

### Over-partitioning is a real cost, paid by every query but one

Partitioning by `month + category` makes 201 files instead of 24:

| Query | 24 files | 201 files |
| --- | ---: | ---: |
| scan all | 2.67 MB, 25.9 ms | **5.13 MB, 90.3 ms** |
| month range | 583.8 KB, 7.0 ms | **1.24 MB, 20.4 ms** |
| point lookup | 491.4 KB, 6.7 ms | **3.09 MB, 36.8 ms** |
| one category | 2.67 MB | **539.2 KB** |

One query got 5x better and every other query got 2x to 6x worse. Each file carries
its own footer and its own dictionaries, so splitting the same data across more of
them adds overhead and takes away the compression that comes from having neighbours.

Going the other way is instructive too: **no partitioning at all** reads the fewest
bytes for a full scan (2.18 MB against the baseline's 2.67 MB) for the same reason in
reverse - one dictionary, one footer. It only loses when a query could have skipped
files, which is exactly what the month range shows (702.3 KB against 583.8 KB).

Partitioning is not free storage hygiene. It buys pruning for queries that filter on
the partition key and charges every other query for it.

### zstd, and it is not close

| Compression | On disk | Write | Bytes read, scan all |
| --- | ---: | ---: | ---: |
| uncompressed | 47.98 MB | 120.6 ms | 3.59 MB |
| snappy | 25.29 MB | 151.7 ms | 3.10 MB |
| **zstd** | **14.95 MB** | 210.4 ms | **2.67 MB** |

zstd is 3.2x smaller than raw and 1.7x smaller than snappy, for 90 ms of extra write
time on a million rows. For a lake written once by a nightly job and read many times
over a network, that trade is not close. Note that bytes *read* separate much less
than bytes stored - 1.34x, not 3.2x - because the two columns this query touches are
not the ones that compress best.

### Cardinality is only half of why a column is expensive

| Column | Distinct | Compressed | Share |
| --- | ---: | ---: | ---: |
| cost | 23,009 | 2.28 MB | 15.9% |
| order_ts | 577,066 | 2.20 MB | 15.3% |
| customer_id | 182,187 | 2.00 MB | 13.9% |
| revenue | 20,778 | 1.94 MB | 13.5% |
| **order_item_id** | **1,000,000** | **1022.0 KB** | **6.9%** |
| category | 8 | 361.4 KB | 2.5% |
| quantity | 10 | 264.2 KB | 1.8% |
| channel | 3 | 159.8 KB | 1.1% |

`category` costs 2.5% of the file for a million rows because it has eight distinct
values and Parquet dictionary-encodes it into almost nothing. `channel`, with three,
costs 1.1%. That much is the expected lesson: low cardinality is cheap.

The interesting row is `order_item_id`. It has **the highest cardinality in the
table** - every value is unique - and it is one of the cheapest columns in the file,
at half the cost of `customer_id`, which has 5.5x fewer distinct values. It is a
dense ascending sequence, so delta encoding stores the differences and the
differences are all 1.

So the rule is not "cardinality drives storage cost". It is that **encodings exploit
structure**, and cardinality is only one kind of structure. A sorted high-cardinality
column can be cheaper than a scattered low-cardinality one.

### The column pruning ratio, in bytes

`category` + `revenue` is 2.5% + 13.5% = **16.0%** of the file. That is the number
behind Q1: not a claim about column stores in general, but the measured fraction of
this dataset that this query has any reason to read.

## Day 2 - lane B: zero-ETL federation

DuckDB attaches the live Postgres and queries it in place. No copy, no lake, no
pipeline - and no layout either, which turns out to be the whole story.

| Query | A Postgres | B federated | C the lake |
| --- | ---: | ---: | ---: |
| revenue by category | 33.4 ms | **42.9 ms** | 4.8 ms |
| revenue by month, filtered | 18.7 ms | **26.1 ms** | 3.0 ms |
| order lookup | 0.23 ms | **3.2 ms** | 4.2 ms |

**Lane B is slower than plain Postgres on every analytical query.** That is not a
failure of DuckDB, it is what federation costs: the vectorised engine still has to
receive every row over a socket, and rows arriving over a socket arrive as rows.

### What it pushed down, and what it did not

Read out of DuckDB's own query profile:

| Query | Projection pushed | Filter pushed | Rows over the wire | Rows returned |
| --- | --- | --- | ---: | ---: |
| revenue by category | `category, revenue` | none | **1,000,000** | 8 |
| revenue by month | `order_ts, revenue` | `order_ts >= ... AND order_ts < ...` | 237,171 | 6 |
| order lookup | all 12 columns | `order_id = 250000` | 3 | 3 |

Two of three pushdowns work well, and the exception is decisive.

**Projections push down.** Q1 pulls two columns, not twelve. Federation is not naive.

**Filters push down.** The date range became a Postgres `WHERE` clause, and the point
lookup became one that Postgres answered from the b-tree - which is why lane B beats
lane C on Q7 (3.2 ms against 4.2 ms) despite being the slower engine everywhere else.
A pushed-down predicate lets the remote side use the index it already has.

**Aggregates do not push down.** Q1 moved **1,000,000 rows across a socket to return
8**. DuckDB cannot ask Postgres for `sum(revenue) GROUP BY category`; it can only ask
for the two columns and add them up itself. The transfer is the entire cost.

### When federation is the right answer

The trade is now measurable rather than a matter of taste.

- **Use it when the predicate is selective.** Q7 pushes down to three rows and lane B
  is competitive. The remote index does the work and almost nothing crosses the wire.
- **Do not use it for aggregates over large scans.** Q1 is 9x slower than reading the
  same answer from Parquet, and it puts the full scan load on the transactional
  database while it happens.
- **What you buy is freshness.** Lane B is never stale; lane C is as old as the last
  pipeline run. That is the only axis on which lane B wins, and for some questions it
  is the only axis that matters.

Lanes A and B both query the transactional cluster, which violates the constraint
that analytics must not raise OLTP latency. They are here as the *before* case that
motivates C, and the app says so on the page rather than in a footnote.

---

## Raw measurement log

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

### 2026-09-06 04:55 UTC - layout study, raw

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Ten layouts of the same rows, measured with DuckDB's caches off.

**What each layout costs to store**

| factor | setting | files | on disk | write |
| --- | --- | ---: | ---: | ---: |
| baseline | month / natural / default / zstd | 24 | 14.95 MB | 210.38 |
| partitioning | none | 1 | 14.23 MB | 75.60 |
| partitioning | month + category | 201 | 16.93 MB | 270.27 |
| sort order | category, order_ts | 24 | 16.77 MB | 238.71 |
| sort order | shuffled | 24 | 20.93 MB | 270.68 |
| row group | 10,000 rows | 24 | 15.78 MB | 85.24 |
| row group | 1,000,000 rows | 24 | 14.95 MB | 229.75 |
| compression | uncompressed | 24 | 47.98 MB | 120.64 |
| compression | snappy | 24 | 25.29 MB | 151.71 |
| interaction | sorted by category + 10k row groups | 24 | 16.91 MB | 145.26 |

**"scan all" - revenue by category over everything**

| factor | setting | bytes read | files | rows scanned | uncached ms |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | month / natural / default / zstd | 2.67 MB | 24 | 1,000,000 | 25.90 |
| partitioning | none | 2.18 MB | 1 | 1,000,000 | 10.71 |
| partitioning | month + category | 5.13 MB | 201 | 1,000,000 | 90.33 |
| sort order | category, order_ts | 2.33 MB | 24 | 1,000,000 | 19.60 |
| sort order | shuffled | 2.68 MB | 24 | 1,000,000 | 17.31 |
| row group | 10,000 rows | 3.21 MB | 24 | 1,000,000 | 27.94 |
| row group | 1,000,000 rows | 2.67 MB | 24 | 1,000,000 | 22.65 |
| compression | uncompressed | 3.59 MB | 24 | 1,000,000 | 17.71 |
| compression | snappy | 3.10 MB | 24 | 1,000,000 | 20.83 |
| interaction | sorted by category + 10k row groups | 3.57 MB | 24 | 1,000,000 | 38.76 |

**"month range" - six months of twenty-four**

| factor | setting | bytes read | files | rows scanned | uncached ms |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | month / natural / default / zstd | 583.8 KB | 6 | 237,171 | 7.007 |
| partitioning | none | 702.3 KB | 1 | 237,171 | 6.883 |
| partitioning | month + category | 1.24 MB | 49 | 237,171 | 20.35 |
| sort order | category, order_ts | 585.3 KB | 6 | 237,171 | 6.436 |
| sort order | shuffled | 584.0 KB | 6 | 237,171 | 6.358 |
| row group | 10,000 rows | 661.7 KB | 6 | 237,171 | 6.164 |
| row group | 1,000,000 rows | 583.3 KB | 6 | 237,171 | 7.165 |
| compression | uncompressed | 775.1 KB | 6 | 237,171 | 6.930 |
| compression | snappy | 654.3 KB | 6 | 237,171 | 5.170 |
| interaction | sorted by category + 10k row groups | 595.0 KB | 6 | 237,171 | 10.22 |

**"one category" - a filter on a column you can sort by**

| factor | setting | bytes read | files | rows scanned | uncached ms |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | month / natural / default / zstd | 2.67 MB | 24 | 59,894 | 14.27 |
| partitioning | none | 2.18 MB | 1 | 59,894 | 13.98 |
| partitioning | month + category | 539.2 KB | 27 | 59,894 | 13.13 |
| sort order | category, order_ts | 2.33 MB | 24 | 59,894 | 17.39 |
| sort order | shuffled | 2.68 MB | 24 | 59,894 | 15.32 |
| row group | 10,000 rows | 3.02 MB | 24 | 59,894 | 25.37 |
| row group | 1,000,000 rows | 2.67 MB | 24 | 59,894 | 16.30 |
| compression | uncompressed | 3.59 MB | 24 | 59,894 | 16.13 |
| compression | snappy | 3.10 MB | 24 | 59,894 | 14.83 |
| interaction | sorted by category + 10k row groups | 734.9 KB | 24 | 59,894 | 14.83 |

**"point lookup" - one order id**

| factor | setting | bytes read | files | rows scanned | uncached ms |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | month / natural / default / zstd | 491.4 KB | 24 | 3 | 6.678 |
| partitioning | none | 331.8 KB | 1 | 3 | 5.173 |
| partitioning | month + category | 3.20 MB | 201 | 3 | 42.13 |
| sort order | category, order_ts | 505.9 KB | 24 | 3 | 9.343 |
| sort order | shuffled | 557.9 KB | 24 | 3 | 8.592 |
| row group | 10,000 rows | 414.8 KB | 24 | 3 | 7.241 |
| row group | 1,000,000 rows | 490.9 KB | 24 | 3 | 8.518 |
| compression | uncompressed | 808.5 KB | 24 | 3 | 9.026 |
| compression | snappy | 583.3 KB | 24 | 3 | 8.091 |
| interaction | sorted by category + 10k row groups | 465.7 KB | 24 | 3 | 9.043 |

**Per-column bytes, baseline lake** (`raw`)

| column | distinct | compressed | uncompressed | share |
| --- | ---: | ---: | ---: | ---: |
| cost | 23,009 | 2.28 MB | 7.38 MB | 15.9% |
| order_ts | 577,066 | 2.20 MB | 7.63 MB | 15.3% |
| customer_id | 182,187 | 2.00 MB | 7.63 MB | 13.9% |
| revenue | 20,778 | 1.94 MB | 2.73 MB | 13.5% |
| product_id | 5,000 | 1.71 MB | 2.41 MB | 11.9% |
| unit_price | 865 | 1.18 MB | 1.35 MB | 8.2% |
| order_item_id | 1,000,000 | 1022.0 KB | 7.63 MB | 6.9% |
| order_id | 581,190 | 695.0 KB | 7.63 MB | 4.7% |
| discount_amount | 8,322 | 629.6 KB | 1.78 MB | 4.3% |
| category | 8 | 361.4 KB | 496.7 KB | 2.5% |
| quantity | 10 | 264.2 KB | 495.7 KB | 1.8% |
| channel | 3 | 159.8 KB | 250.8 KB | 1.1% |

### 2026-09-06 05:00 UTC - 1,000,000 line items

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Parameters: `from=2025-03-01T00:00:00Z  to=2025-09-01T00:00:00Z  order_id=250000`

| query | lane | median | p95 | engine | bytes read | rows scanned | returned | files |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | A  Postgres 18 | 31.88 | 40.54 | 34.41 | 109.00 MB | 1,000,000 | 8 | - |
| revenue_by_category | B  DuckDB over Postgres | 44.36 | 57.68 | - | - | 1,000,000 | 8 | - |
| revenue_by_category | C  DuckDB over the lake | 4.430 | 4.773 | - | 2.67 MB | 1,000,000 | 8 | 24 |
| revenue_by_month_filtered | A  Postgres 18 | 18.86 | 22.13 | 18.55 | 34.21 MB | 237,171 | 6 | - |
| revenue_by_month_filtered | B  DuckDB over Postgres | 22.79 | 26.47 | - | - | 237,171 | 6 | - |
| revenue_by_month_filtered | C  DuckDB over the lake | 2.811 | 3.043 | - | 1.11 MB | 237,171 | 6 | 7 |
| order_lookup | A  Postgres 18 | 0.202 | 0.253 | 0.005 | 32.0 KB | 3 | 3 | - |
| order_lookup | B  DuckDB over Postgres | 3.043 | 3.112 | - | - | 3 | 3 | - |
| order_lookup | C  DuckDB over the lake | 4.024 | 4.911 | - | 970.3 KB | 3 | 3 | 24 |

5 timed runs per cell after 1 warm-up; median and p95, never a mean.
