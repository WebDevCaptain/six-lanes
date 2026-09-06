# Results

Every measurement, appended as taken. Numbers only - the reasoning lives in
`docs/concepts.md`, the plan lives in `docs/PLAN.md`.

Reproduce any of it with:

```
pnpm services && pnpm generate && pnpm load && pnpm ducklake && pnpm compare --write
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

## Day 3 - the lake grows a catalog

`pnpm gaps` reproduces each of the six gaps in section 6 of the plan against a real
lake, then does the same six things through DuckLake. What follows is what it printed,
not what the table promised.

### The gaps, felt

**No ACID.** A partition file is renamed out of the way, as a writer replacing it
would. The lake goes from 110,392 rows to **75,228 rows** and answers cheerfully. No
error, no warning - just a smaller number that a dashboard would render as a bad week.

**No atomic multi-partition change.** Repricing three months produced four totals:
29,499,234 -> 30,459,807 -> 31,399,018 -> 32,449,157. The three in the middle are
answers to a question nobody asked - some months repriced, some not.

**No schema evolution, and this one was not what I expected.** Adding a `margin`
column to one partition of three did **not** break the lake. Queries touching only
the old columns kept working, because column pruning means they never look at the
part of the schema that disagrees. The lake is inconsistent and everything reports
healthy. The failure surfaces later, in an unrelated query:

```
Invalid Input Error: schema mismatch in glob: column "margin" was read from the
original file ".../month=2025-01/data.parquet", but could not be found in file
".../month=2025-03/data.parquet"
```

`union_by_name=true` recovers, and makes it worse: the new column now reads NULL for
two thirds of the data, indistinguishable from a real NULL.

**No history.** The repricing overwrote three files. The previous rows are not
archived or superseded, they are gone.

**No catalog.** A directory walk found the three files in 0.12 ms locally. The same
thing over HTTP:

```
Invalid Input Error: Globs (`*`) for generic HTTP file is are not supported.
```

That is the sentence that decides the architecture. A lake on object storage cannot
be globbed, so the file list has to be produced somewhere with a filesystem and
carried to the reader - which is a catalog, just a hand-rolled one that is stale the
moment a writer starts.

### The gaps, closed

| Gap | DuckLake |
| --- | --- |
| No ACID | `BEGIN; DELETE ...; ROLLBACK` - 75,228 rows inside the transaction, 110,392 after. Never visible outside. |
| No atomic multi-partition change | Three partitions repriced in one transaction produced **one** snapshot. No intermediate state exists. |
| No schema evolution | `ALTER TABLE ADD COLUMN margin` - every reader keeps working, old files untouched, the catalog records which schema version each file belongs to. |
| No history | `AT (VERSION => 3)` returns the pre-backfill total from the same table in the same query. |
| No catalog | One indexed query against Postgres returns the live file list with per-column min/max. |
| Slow planning | The walk grows with the number of files and needs a filesystem. The catalog query grows with the number of files that *match* and needs a socket. |

### What the catalog was actually worth

Lane C moved from globbing raw Parquet to reading `lake.orders`. Same data, same
partitioning, same compression - the only change is that a Postgres table now knows
what the files are.

| Query | Gen 1, raw glob | Gen 2, DuckLake |
| --- | --- | --- |
| revenue by category | 4.79 ms, 2.67 MB, 24 files | 4.22 ms, 2.33 MB, 24 files |
| revenue by month | 5.80 ms, 1.11 MB, **7 files** | 5.90 ms, 1017 KB, **6 files** |
| order lookup | 4.81 ms, 970 KB, **24 files** | 4.81 ms, 590 KB, **1 file** |

The point lookup is the one that matters. `order_id` is **not** the partition key, so
path-based pruning could do nothing and generation 1 opened all 24 files to read their
footers. DuckLake keeps min/max per column per file in Postgres, so it eliminated 23
files **before touching storage at all** - one indexed query instead of two dozen HTTP
round trips.

That is the difference between metadata you have to go and fetch and metadata you can
query.

### A default worth knowing about

The first DuckLake build came out at **25.30 MB** against generation 1's 14.95 MB.
That is exactly the snappy figure from the Day 2 layout study: DuckLake does not
inherit the compression choice, it has its own default. One
`ducklake_set_option('parquet_compression', 'zstd')` and it is 14.96 MB - within 0.1%
of the hand-written lake. A lakehouse layer is a set of defaults as much as it is a
format.

### Why this is the project's most interesting answer

The catalog is Postgres. The data is Parquet. The compute is DuckDB.

Postgres and DuckDB are not competing in lane C, they are cooperating - each doing
what it is actually good at. Postgres holds a small, transactional, heavily indexed
set of metadata and answers point queries against it in microseconds, which is
precisely its strength and precisely what a catalog needs. DuckDB scans columnar
files, which is precisely its strength and precisely what a query needs.

The whole first half of this project is a fight between the two. The second half is
the observation that the fight was the wrong frame.

## Day 4 - the star, and what a dimension is actually for

The flat table became `fact_order_item` plus `dim_date`, `dim_customer` and
`dim_product`. 240,096 customer versions of 200,000 people, because roughly one in
six moved country or changed segment during the two years.

### The SCD2 lookup is a range join, and it is not optional

```sql
JOIN dim_customer c
  ON c.customer_id = o.customer_id
 AND o.order_ts >= c.valid_from
 AND o.order_ts <  c.valid_to
```

The alternative - joining on the natural key and filtering to `is_current` - is one
character shorter and restates all of history under today's attributes. Both are one
line of SQL, neither errors, and the difference shows up as a revenue number that
moves when nothing happened.

`tests/integration/star.test.ts` asks the same question both ways. Revenue attributed
to the `enterprise` segment differs depending on which join you use, and the test
asserts that it differs - so the SCD2 join can never be quietly "simplified" away.

Three invariants make the dimension usable, and all three fail silently:

| Broken | What happens |
| --- | --- |
| Two rows flagged `is_current` | every "as of today" query double counts that customer |
| Overlapping validity ranges | the fact join fans out and revenue is counted twice |
| A gap between ranges | an order matches no version and vanishes from the fact table |

They are checked by `findScd2Violations`, and `tests/unit/customers.test.ts` breaks
the dimension six different ways to prove the checker notices. A checker nobody has
watched fail is not evidence.

The star builder also asserts that the range join returns exactly as many rows as it
consumed. A range join that loses or duplicates rows means the ranges are not a
partition of time, and finding that out from a row count beats finding it out from a
revenue total.

### `count(DISTINCT)` is where Postgres and DuckDB genuinely differ

Q3 and Q5 both need one. The gap is not close:

| Query | A Postgres | B federated | C the lake |
| --- | ---: | ---: | ---: |
| top_categories (Q3) | **125.7 ms** | 32.7 ms | 10.8 ms |
| repeat_rate (Q5) | **156.8 ms** | 56.9 ms | 16.2 ms |

**Lane B beats lane A by 3.8x on Q3.** That is the first time federation has won
anything in this project, and it refines Day 2's conclusion rather than contradicting
it: federation loses when the *transfer* dominates and wins when the *aggregation*
does. Same million rows over the same socket - but now DuckDB is doing something with
them that Postgres is much slower at.

The reason is architectural. Postgres has no hash-based DISTINCT aggregate, so
`count(DISTINCT x)` requires its input sorted by `(group, x)`:

```
GroupAggregate (actual rows=8 loops=1)
  Group Key: p.category
  ->  Sort (actual rows=237171 loops=1)
        Sort Key: p.category, f.order_id
        Sort Method: external merge  Disk: 8648kB
```

The first instinct is that the 8.6 MB spill is the problem. It is not. Raising
`work_mem` from the 4 MB default to 64 MB turned the external merge into an in-memory
quicksort of 16 MB - and the query went from 118 ms to **125 ms**. Within noise.

**The sort is the cost, not the disk.** DuckDB answers the same query in 10.8 ms with
a hash-based distinct aggregate that never sorts anything. That is a difference you
cannot configure your way out of, which makes it worth more than most benchmark
numbers. (`work_mem=64MB` stays in the compose file regardless: lane A is the
baseline and gets what a competent DBA would give it.)

### Exact versus approximate distinct: the plan's open question, answered

| Distinct count of | Exact | Approx | Error | Speedup |
| --- | ---: | ---: | ---: | ---: |
| customers, 6 months | 93,603 | 117,390 | **+25.4%** | 1.4x |
| customers, all time | 182,187 | 184,987 | +1.5% | 2.1x |
| orders, all time | 581,190 | 677,490 | **+16.6%** | 2.5x |
| products, all time | 5,000 | 5,618 | **+12.4%** | 1.5x |

Those errors are far outside HyperLogLog's textbook 1-2%, which is enough to suspect
the data rather than the function. So `pnpm measures` runs a control over
`range(n)`, whose cardinality is exact by construction:

| n | approx | error |
| ---: | ---: | ---: |
| 1,000 | 1,249 | +24.9% |
| 5,000 | 5,661 | +13.2% |
| 100,000 | 96,408 | -3.6% |
| 600,000 | 682,265 | +13.7% |

It is the function. DuckDB 1.5.3's `approx_count_distinct` takes no accuracy
parameter and is much coarser than the name suggests.

**Decision: exact.** A 1.3x to 2.9x speedup does not buy a 25% error. This may invert
at a hundred times the data - the exact count's sort grows and HLL's registers do not
- but that is a decision to make against a measurement at that size, not this one.

### Semi-additive: the class that is fine until somebody widens the date range

`fact_inventory_snapshot` holds one row per product per day for 90 days - 450,000 rows
of stock levels, which is a *state* rather than an event.

| | Units |
| --- | ---: |
| stock on hand today | **2,445,331** |
| `sum(on_hand)` across all 90 days | **227,297,811** |
| average daily stock | 2,525,531 |

The middle number is 93x too large and describes nothing. There are not 227 million
units anywhere; there are about 2.4 million, counted again on each of 90 days.

`on_hand` is additive across every dimension **except time**. Sum it across products
and you get the stock in the warehouse; sum it across two days and you have counted the
same physical boxes twice. Revenue has no such restriction, because revenue is an event
and events do not persist into the next day waiting to be counted again.

The safe aggregations over time are the ones that pick a point or a level rather than a
total: closing balance, average, minimum.

### Additive, non-additive, and the column that looks fine

`sum(revenue)` grouped five different ways gives one number, to the cent:

```
grand total       270355036.38
by category       270355036.38
by month          270355036.38
by channel        270355036.38
by customer       270355036.38
```

`unit_price` does not behave that way, and nothing complains:

| Expression | Value |
| --- | ---: |
| `sum(unit_price)` | 35,783,996.79 |
| `avg(unit_price)` | 150.878 |
| `sum(revenue + discount) / sum(quantity)` | **150.500** |

The first is the sum of the prices printed on every sticker. No quantity in the
business has that value, and it grows if you split an order into more lines - a
measure that changes when the grain changes is not a measure.

The second is the trap, because it looks like the answer. It weights a line that sold
one unit the same as a line that sold five.

The third is what people mean by average selling price. It is derived at query time
from two additive measures, which is the only safe way to carry a ratio in a fact
table: by not carrying it.

## Day 4 - scaling to 10,000,000 rows

Same generator, same seed, `OLAP_ROWS=10000000`. Everything else identical.

| | 1M | 10M |
| --- | ---: | ---: |
| Postgres, `fact_order_item` with indexes | 198 MB | **1,959 MB** |
| Parquet lake | 14.79 MB | **139.36 MB** |
| Ratio | 13.4x | **14.1x** |
| Generate | 4.9 s | 398.8 s |
| Load into Postgres | 6.0 s | 67.0 s |
| Build DuckLake | 0.36 s | 0.76 s |

### The gap widens with scale, and not gently

| Query | A at 1M | A at 10M | C at 1M | C at 10M | A:C at 1M | A:C at 10M |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | 52 ms | **830 ms** | 6.9 ms | 28.6 ms | 7.6x | **29.0x** |
| revenue_by_month | 19 ms | 290 ms | 5.3 ms | 18.7 ms | 3.6x | 15.5x |
| top_categories | 126 ms | **1.53 s** | 10.8 ms | 64.7 ms | 11.6x | 23.6x |
| repeat_rate | 157 ms | **1.73 s** | 16.2 ms | 75.8 ms | 9.7x | 22.8x |
| rolling_revenue | 27 ms | 366 ms | 9.4 ms | 35.6 ms | 2.8x | 10.3x |
| category_by_month | 27 ms | 394 ms | 9.1 ms | 46.1 ms | 3.0x | 8.5x |
| **order_lookup** | **0.22 ms** | **0.33 ms** | 4.4 ms | 11.6 ms | **0.05x** | **0.03x** |

Ten times the data made lane C between 3x and 6x slower. It made lane A between 10x
and 16x slower. Every ratio roughly quadrupled.

The reason is visible in the byte counts. At 1M, lane A read 108 MB per scan out of a
`shared_buffers` of 256 MB - everything was already in memory and the measurement was
of CPU. At 10M it reads **1,062 MB** for the same query, which does not fit, so the
warm number now includes real disk. The column store never had that problem: it reads
34.9 MB for the same answer, because it still only needs three columns of thirteen.

**A column store's advantage is not a constant factor. It grows at exactly the point
where the row store stops fitting in memory**, which is the point at which anyone
starts caring.

### The one that goes the other way

`order_lookup` moved the other direction and stayed there. Postgres went from 0.22 ms
to 0.33 ms across a tenfold increase, because a b-tree lookup costs `log(n)` and log
of ten times more is barely more. Lane C went from 4.4 ms to 11.6 ms.

At 10M, Postgres answers a point lookup **35x faster in wall time and roughly 800x
faster in engine time**, while losing the analytical queries by 20x to 29x. Both facts
come from the same table, on the same machine, in the same run.

### What got slower that was not a query

Generating 10x the rows took **80x** the time: 4.9 s to 398.8 s. Almost all of it is
the SCD2 range join in `src/data/star.ts`, which resolves 10,000,000 facts against
240,096 customer versions. A range join is not a hash join - there is no equality to
hash on for the validity window - so the cost is superlinear.

That is a genuine warehousing lesson rather than a benchmark artefact. Production
pipelines do not re-resolve the whole history nightly; they resolve keys for the batch
being loaded, against the small set of dimension versions valid during that batch's
window. The naive full re-join is fine at a million rows and is the first thing that
breaks at a hundred million.

## Day 5 - the browser, and the cleanest comparison in the project

Lanes D and E hold the same 166,150 rows, in the same tab, on the same CPU, answering
the same seven questions. No network between them, no server, no configuration
difference. The only variable left is how the bytes are arranged.

| Question | D  DuckDB-WASM | E  PGlite | ratio |
| --- | ---: | ---: | ---: |
| revenue per category | 15.8 ms | 88.0 ms | **5.6x** |
| revenue per month | 12.0 ms | 128.6 ms | **10.7x** |
| top categories | 26.0 ms | 335.5 ms | **12.9x** |
| 30-day rolling revenue | 16.3 ms | 86.3 ms | **5.3x** |
| repeat rate | 30.3 ms | 421.3 ms | **13.9x** |
| revenue by category by month | 19.3 ms | 176.3 ms | **9.1x** |
| **one order by id** | 11.8 ms | **0.270 ms** | **0.02x** |

Vectorised columnar execution beats tuple-at-a-time by 5x to 14x on the analytical
questions and loses the point lookup by 44x. That is the entire thesis of this
project with every confounder removed.

PGlite reports itself as **PostgreSQL 18.3**, against the server's 18.4 - close enough
that lane E is a fair stand-in for lane A's engine, running on the reader's own laptop.

### Shipping the data costs more than answering the question

For **identical rows**:

| | Lane D, Parquet | Lane E, Postgres datadir |
| --- | ---: | ---: |
| Download | **2.96 MB** | **24.13 MB** |
| Share of the 25 MB budget | 12% | 97% |
| Start-up after download | 517 ms | 516 ms |

**8.1x.** Same 166,150 line items, same four tables, same indexes on the Postgres side
because removing them would have made lane E a straw man. A row store carries its
per-row overhead onto the wire; a column store compresses each column against its own
neighbours and then only sends the columns that were asked for.

This is also why the browser slice is row-capped: `pnpm slice` builds, measures, and
rebuilds smaller until both artefacts fit, so the row count is a consequence of the
budget rather than a constant somebody guessed. It settled at 160-166k rows.

### Three bugs the correctness gate caught that no unit test would have

None of these threw. All three produced plausible numbers.

1. **DuckDB-WASM returns Arrow DECIMALs unscaled.** Revenue of 3,237,919.01 arrived as
   323791901 and rendered as a hundred times too much money. The scale is in the Arrow
   schema; `toJSON()` does not apply it.
2. **It declares TIMESTAMPTZ as MICROSECOND and hands over milliseconds.** Rescaling by
   the declared unit put a July 2025 order in January 1970.
3. **The slice was cut from the wrong end of the dataset.** It held the most recent
   days while the questions ask about a window in the middle, so lanes D and E answered
   every range query with nothing - and agreed perfectly with a reference that also
   returned nothing. **A vacuous pass looks exactly like success.** The slice is now cut
   from inside the window, the build fails if it does not contain the order Q7 asks
   for, and the page flags a browser lane that returns nothing when the server did not.

The third is the one worth remembering. The first two were caught because two engines
disagreed. The third was caught only because somebody asked why a passing lane had no
rows in it.

---

## Day 7 - pg_duckdb, and a lane that lies unless you check

Lane F embeds DuckDB inside Postgres. Same wire protocol, same SQL, same client code
as lane A, with `duckdb.force_execution = true` and nothing else changed. Both
instances are loaded from the same DuckDB file in the same run, so "identical data" is
literally true.

### It ran three of the seven queries

| Query | A  Postgres | F  pg_duckdb | Ran on |
| --- | ---: | ---: | --- |
| revenue_by_category | 41.6 ms | **68.6 ms** | DuckDB |
| top_categories | 122.8 ms | **34.0 ms** | DuckDB |
| order_lookup | 0.247 ms | **2.88 ms** | DuckDB |
| revenue_by_month_filtered | 21.2 ms | 19.6 ms | Postgres (DuckDB declined) |
| rolling_revenue | 26.4 ms | 27.6 ms | Postgres (DuckDB declined) |
| repeat_rate | 157.7 ms | 173.1 ms | Postgres (DuckDB declined) |
| category_by_month | 25.4 ms | 26.6 ms | Postgres (DuckDB declined) |

**pg_duckdb does not fail when DuckDB cannot run something.** It emits a warning no
client surfaces, plans the query the ordinary Postgres way, and returns the right
answer at ordinary Postgres speed:

```
WARNING:  (PGDuckDB/CreatePlan) Prepared query returned an error:
Catalog Error: Scalar Function with name to_char does not exist!
```

Four of the seven queries group by month, all four use `to_char`, and DuckDB has no
`to_char`. `force_execution = true` does not force anything here - it cannot force a
function that does not exist.

So lane F checks the plan for a `Custom Scan (DuckDBScan)` before publishing anything,
and reports which engine actually ran. The four fallback rows land within noise of
lane A **because they are lane A**, which is a nice independent confirmation that the
check works.

### Where it helps, where it hurts

Of the three it did run, it won one:

- **top_categories, 3.6x faster.** This is the `count(DISTINCT ...)` query, where
  Postgres must sort its input per group and DuckDB uses a hash aggregate. The
  computation dominates, and pg_duckdb is doing the computation.
- **revenue_by_category, 1.65x slower.** A plain `sum` over a full scan. The scan
  dominates, and pg_duckdb is still reading Postgres heap tuples one at a time and
  converting them into vectors before it can do anything clever. The conversion costs
  more than the vectorisation saves.
- **order_lookup, 11.7x slower.** Vectorised execution has nothing to offer a b-tree
  probe for three rows, and the setup is pure overhead.

**pg_duckdb accelerates computation, not storage.** It gets you DuckDB's execution
engine over Postgres' row-oriented pages, which is worth having exactly when the
aggregate is the bottleneck. It cannot give you column pruning, partition pruning or
compressed columnar scans, because the bytes on disk are still rows. Lane C reads
1.60 MB to answer the query lane F wins; lane F reads the whole heap.

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

### 2026-09-06 05:24 UTC - 1,000,000 line items

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Parameters: `from=2025-03-01T00:00:00Z  to=2025-09-01T00:00:00Z  order_id=250000`

| query | lane | median | p95 | engine | bytes read | rows scanned | returned | files |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | A  Postgres 18 | 43.79 | 46.16 | 46.15 | 107.84 MB | 1,015,000 | 8 | - |
| revenue_by_category | B  DuckDB over Postgres | 50.66 | 229.47 | - | - | 1,005,000 | 8 | - |
| revenue_by_category | C  DuckDB over the lake | 8.015 | 8.341 | - | 3.72 MB | 1,005,000 | 8 | 25 |
| revenue_by_month_filtered | A  Postgres 18 | 19.74 | 21.58 | 21.16 | 29.83 MB | 237,171 | 6 | - |
| revenue_by_month_filtered | B  DuckDB over Postgres | 25.08 | 26.99 | - | - | 237,171 | 6 | - |
| revenue_by_month_filtered | C  DuckDB over the lake | 5.347 | 5.934 | - | 1.01 MB | 237,171 | 6 | 6 |
| order_lookup | A  Postgres 18 | 0.234 | 0.265 | 0.006 | 32.0 KB | 3 | 3 | - |
| order_lookup | B  DuckDB over Postgres | 3.218 | 3.288 | - | - | 3 | 3 | - |
| order_lookup | C  DuckDB over the lake | 4.915 | 5.145 | - | 580.4 KB | 3 | 3 | 1 |
| top_categories | A  Postgres 18 | 124.70 | 126.35 | 129.36 | 29.84 MB | 242,171 | 5 | - |
| top_categories | B  DuckDB over Postgres | 34.96 | 36.55 | - | - | 242,171 | 5 | - |
| top_categories | C  DuckDB over the lake | 10.77 | 11.11 | - | 1.60 MB | 242,171 | 5 | 7 |
| rolling_revenue | A  Postgres 18 | 26.58 | 27.35 | 29.55 | 29.45 MB | 237,355 | 184 | - |
| rolling_revenue | B  DuckDB over Postgres | 22.70 | 28.50 | - | - | 237,355 | 184 | - |
| rolling_revenue | C  DuckDB over the lake | 9.481 | 9.633 | - | 1.01 MB | 237,355 | 184 | 7 |
| repeat_rate | A  Postgres 18 | 155.24 | 155.73 | 164.13 | 53.20 MB | 477,267 | 6 | - |
| repeat_rate | B  DuckDB over Postgres | 61.32 | 64.32 | - | - | 477,267 | 6 | - |
| repeat_rate | C  DuckDB over the lake | 15.11 | 15.43 | - | 1.68 MB | 477,265 | 6 | 7 |
| category_by_month | A  Postgres 18 | 24.54 | 25.60 | 26.39 | 31.16 MB | 252,171 | 48 | - |
| category_by_month | B  DuckDB over Postgres | 32.41 | 38.78 | - | - | 242,171 | 48 | - |
| category_by_month | C  DuckDB over the lake | 9.934 | 10.66 | - | 1.49 MB | 242,171 | 48 | 7 |

5 timed runs per cell after 1 warm-up; median and p95, never a mean.

### 2026-09-06 05:39 UTC - 10,000,000 line items

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Parameters: `from=2025-03-01T00:00:00Z  to=2025-09-01T00:00:00Z  order_id=250000`

| query | lane | median | p95 | engine | bytes read | rows scanned | returned | files |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | A  Postgres 18 | 782.37 | 819.66 | 855.80 | 1062.66 MB | 10,015,000 | 8 | - |
| revenue_by_category | B  DuckDB over Postgres | 713.24 | 786.99 | - | - | 10,005,000 | 8 | - |
| revenue_by_category | C  DuckDB over the lake | 25.59 | 26.97 | - | 34.92 MB | 10,005,000 | 8 | 25 |
| revenue_by_month_filtered | A  Postgres 18 | 279.57 | 293.62 | 296.73 | 292.79 MB | 2,371,741 | 6 | - |
| revenue_by_month_filtered | B  DuckDB over Postgres | 321.03 | 360.18 | - | - | 2,371,741 | 6 | - |
| revenue_by_month_filtered | C  DuckDB over the lake | 18.10 | 20.68 | - | 9.05 MB | 2,371,741 | 6 | 6 |
| order_lookup | A  Postgres 18 | 0.364 | 0.524 | 0.014 | 32.0 KB | 1 | 1 | - |
| order_lookup | B  DuckDB over Postgres | 10.02 | 10.52 | - | - | 1 | 1 | - |
| order_lookup | C  DuckDB over the lake | 11.51 | 12.83 | - | 1.69 MB | 1 | 1 | 1 |
| top_categories | A  Postgres 18 | 1.50s | 1.52s | 1.63s | 292.80 MB | 2,376,741 | 5 | - |
| top_categories | B  DuckDB over Postgres | 361.48 | 505.02 | - | - | 2,376,741 | 5 | - |
| top_categories | C  DuckDB over the lake | 60.21 | 62.83 | - | 14.55 MB | 2,376,741 | 5 | 7 |
| rolling_revenue | A  Postgres 18 | 362.68 | 375.98 | 408.71 | 292.41 MB | 2,371,925 | 184 | - |
| rolling_revenue | B  DuckDB over Postgres | 296.72 | 346.06 | - | - | 2,371,925 | 184 | - |
| rolling_revenue | C  DuckDB over the lake | 31.63 | 32.37 | - | 9.06 MB | 2,371,925 | 184 | 7 |
| repeat_rate | A  Postgres 18 | 1.72s | 1.90s | 1.81s | 316.16 MB | 2,611,837 | 6 | - |
| repeat_rate | B  DuckDB over Postgres | 630.14 | 812.13 | - | - | 2,611,837 | 6 | - |
| repeat_rate | C  DuckDB over the lake | 71.63 | 79.92 | - | 11.66 MB | 2,611,837 | 6 | 7 |
| category_by_month | A  Postgres 18 | 450.78 | 466.17 | 464.64 | 294.13 MB | 2,386,741 | 48 | - |
| category_by_month | B  DuckDB over Postgres | 482.66 | 702.94 | - | - | 2,376,741 | 48 | - |
| category_by_month | C  DuckDB over the lake | 31.85 | 34.52 | - | 13.52 MB | 2,376,741 | 48 | 7 |

5 timed runs per cell after 1 warm-up; median and p95, never a mean.

### 2026-09-06 06:17 UTC - 1,000,000 line items

`Apple M5, 10 cores, 16 GB, darwin 25.6.0, node v24.18.0, measured 2026-09-06`

Parameters: `from=2025-03-01T00:00:00Z  to=2025-09-01T00:00:00Z  order_id=250000`

| query | lane | median | p95 | engine | bytes read | rows scanned | returned | files |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| revenue_by_category | A  Postgres 18 | 47.55 | 48.75 | 53.20 | 107.84 MB | 1,015,000 | 8 | - |
| revenue_by_category | B  DuckDB over Postgres | 38.88 | 40.62 | - | - | 1,005,000 | 8 | - |
| revenue_by_category | C  DuckDB over the lake | 8.692 | 9.322 | - | 3.72 MB | 1,005,000 | 8 | 25 |
| revenue_by_month_filtered | A  Postgres 18 | 20.27 | 22.07 | 20.59 | 29.84 MB | 237,171 | 6 | - |
| revenue_by_month_filtered | B  DuckDB over Postgres | 25.53 | 26.06 | - | - | 237,171 | 6 | - |
| revenue_by_month_filtered | C  DuckDB over the lake | 5.613 | 7.106 | - | 1.01 MB | 237,171 | 6 | 6 |
| order_lookup | A  Postgres 18 | 0.237 | 0.261 | 0.007 | 32.0 KB | 3 | 3 | - |
| order_lookup | B  DuckDB over Postgres | 3.672 | 4.089 | - | - | 3 | 3 | - |
| order_lookup | C  DuckDB over the lake | 4.748 | 5.715 | - | 580.4 KB | 3 | 3 | 1 |
| top_categories | A  Postgres 18 | 120.46 | 124.73 | 125.56 | 29.85 MB | 242,171 | 5 | - |
| top_categories | B  DuckDB over Postgres | 28.44 | 33.56 | - | - | 242,171 | 5 | - |
| top_categories | C  DuckDB over the lake | 11.98 | 12.49 | - | 1.60 MB | 242,171 | 5 | 7 |
| rolling_revenue | A  Postgres 18 | 27.00 | 28.01 | 29.36 | 29.46 MB | 237,355 | 184 | - |
| rolling_revenue | B  DuckDB over Postgres | 22.57 | 30.21 | - | - | 237,355 | 184 | - |
| rolling_revenue | C  DuckDB over the lake | 10.75 | 10.87 | - | 1.01 MB | 237,355 | 184 | 7 |
| repeat_rate | A  Postgres 18 | 153.50 | 156.12 | 166.07 | 53.22 MB | 477,267 | 6 | - |
| repeat_rate | B  DuckDB over Postgres | 54.70 | 59.42 | - | - | 477,267 | 6 | - |
| repeat_rate | C  DuckDB over the lake | 15.66 | 16.59 | - | 1.68 MB | 477,265 | 6 | 7 |
| category_by_month | A  Postgres 18 | 26.52 | 27.21 | 27.87 | 31.18 MB | 252,171 | 48 | - |
| category_by_month | B  DuckDB over Postgres | 30.62 | 33.13 | - | - | 242,171 | 48 | - |
| category_by_month | C  DuckDB over the lake | 9.955 | 10.31 | - | 1.49 MB | 242,171 | 48 | 7 |

5 timed runs per cell after 1 warm-up; median and p95, never a mean.
