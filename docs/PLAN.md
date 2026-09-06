# OLAP Lab: Postgres + DuckDB

A complete, self-contained build plan. A reader with no other context can execute this
end to end.

- **Status:** built. See [README.md](../README.md) for how to run it,
  [results.md](results.md) for every measurement, and [concepts.md](concepts.md) for
  each concept tied to the number that demonstrated it. This document is kept as
  written, as the plan of record; where the build diverged from it, the divergence and
  the reason are noted below and in the code.
- **Written:** 2026-09-06
- **Companion:** `docs/diagrams/row-vs-column.excalidraw` (the mental model, read it first)

---

## 0. How to read this document

| Marker | Meaning |
| --- | --- |
| **VERIFIED** | Executed on the target machine on 2026-09-06. Command and output recorded in section 3. |
| **CITED** | Taken from vendor documentation on 2026-09-06. Not executed. Re-check if stale. |
| **ASSUMED** | Reasonable but unproven. Every one has a day on which it gets proven or replaced. |

Nothing in this plan is stated without one of those three standing behind it. If you find an
unlabelled claim, treat it as ASSUMED and verify before relying on it.

Sections 1 to 11 are reference. Section 12 is the build. Read 1 to 11 once, then work from 12.

---

## 0.1 What the build changed, and why

Seven deliberate divergences. Everything else was built as written.

| Plan said | Built | Why |
| --- | --- | --- |
| Query catalogue as `sql/queries/*.sql` | TypeScript modules in `src/queries/` | Lanes D and E run in a browser tab, where there is no filesystem. A catalogue only the server can read is not a shared catalogue. |
| Lane C reads `read_parquet('lake/**')` from disk | Lane C reads over HTTP | DuckDB's byte counter is only accurate for reads through `httpfs`; a local read reports the footer and nothing else. Reading over HTTP is also the topology a hosted deployment uses. |
| Q7 is `SELECT *` | Explicit column list | The lake's fact table carries a `month` partition column the heap does not, so `*` means different things per lane and the equality check would compare shapes rather than values. |
| Q2 groups by `date_trunc('month', order_ts)` | Groups by `YYYY-MM` text | The only representation all six engines format identically, and it is the lake's partition key, so the grouping key and the pruning key are the same string. |
| Neon and Vercel from Day 6 | Local only | Out of scope for this pass. Everything the deployment needs is in place and verified - DuckLake's relative paths, the range-request host, the slice in `public/` - but no cloud account is touched. |
| `docs/diagrams/system.excalidraw` | The "How it works" page | Same job in a form that can be kept correct by the code it describes. |
| Q5 defaults to exact or approximate distinct: undecided | Exact | Measured: DuckDB 1.5.3's `approx_count_distinct` is 12-25% off for a 1.3-2.9x speedup. |

Two things the plan did not anticipate, both found by measurement:

- **DuckDB takes its timezone from the host.** On a machine east of Greenwich, an
  order placed at 19:00 UTC on 28 February was reported as March. Fixed at instance
  and connection level, with tests over every month boundary in the dataset.
- **pg_duckdb declines silently.** Four of the seven queries fall back to plain
  Postgres with a warning no client surfaces, so lane F now checks the plan and
  reports which engine actually ran.

---

## 1. What this project is

One system that answers the same analytical questions over the same e-commerce dataset using
six different engines, and reports honest, reproducible numbers for each: wall time, bytes
read, rows scanned.

The deliverable is a public URL where anyone picks a question, hits run, and watches the
engines race, with the exact SQL each one executed shown beside its result.

**Two things it must prove.**

1. Why a column store wins at analytics. **VERIFIED**: on 1M rows, DuckDB over Parquet
   answered a group-by in 7 ms reading 1.56 MB; Postgres 18 answered the same query in
   40.67 ms reading 104 MB. That is 5.8x faster on **67x less I/O**.
2. Where it loses. **VERIFIED**: on a point lookup by `order_id`, Postgres answered in
   0.045 ms reading 80 KB; DuckDB took 5 ms. Postgres is **111x faster**.

A comparison that never loses is marketing. Q7 exists so this one is not.

**Secondary goal, equally real:** the author is new to DuckDB, DuckLake, lakehouses and
dimensional modelling. The build order is pedagogical on purpose. Each day introduces exactly
one new idea and proves it with a number.

---

## 2. Cost and accounts

**Hard requirement: zero cost, no credit card, ever.**

| Need | Service | Card required | Limits that bind us |
| --- | --- | --- | --- |
| Local dev, Days 1 to 5 | Docker + DuckDB CLI | no | none |
| Hosted Postgres | **Neon** free plan | **no** (CITED) | 0.5 GB storage/project, 100 compute-hr/project/month, scales to zero after 5 min idle |
| App hosting | **Vercel** Hobby | **no** | 100 MB source upload (includes `public/`), 15,000 files, 100 GB bandwidth/month, non-commercial use only (CITED) |
| Parquet lake | **Vercel `public/lake/`** | **no** | inside the 100 MB source cap. 12.34 MB at 1M rows (VERIFIED) |
| Lake overflow path | **jsDelivr** from a public GitHub repo | **no** | 20 MB per file. Our partitions are ~570 KB (VERIFIED) |
| DuckLake catalog | Neon Postgres | **no** | metadata only, kilobytes |
| CI and nightly refresh | GitHub Actions, public repo | **no** | 2,000 min/month, unlimited for public repos |

**Explicitly rejected.**

| Rejected | Reason |
| --- | --- |
| Cloudflare R2 | Requires a payment method on file even for the free tier. Disqualified by the hard requirement. |
| AWS S3 | Same. |
| Backblaze B2 | Same. |
| Vercel Blob | Works and needs no card, but adds a Vercel-specific API and a token for no benefit over `public/`. Keep as a fallback only. |

**Consequence to accept:** Neon scales to zero after 5 minutes of inactivity. A cold query
includes a wake-up of a few hundred milliseconds. This is disclosed on the site, never averaged
into a warm number. See section 9 rule 3.

---

## 3. Verified facts

All measured 2026-09-06 on the target machine.

**Host:** Apple M5, 10 cores, 16 GB RAM, macOS 26.6.2.
**Toolchain present before any work started:** DuckDB CLI v1.5.3 (Variegata), Docker 29.4.0
(OrbStack), Node v24.18.0, pnpm 11.25.0.

### 3.1 Data generation and Parquet write

Generating 1M synthetic rows and writing 24 month-partitioned zstd Parquet files:

```
0.31 s wall, 12.34 MB on disk, 24 partitions
```

### 3.2 Per-column bytes, one partition (~42K rows, 572.8 KB total)

This table is the whole project in one artifact.

| column | KB | | column | KB |
| --- | --- | --- | --- | --- |
| order_ts | 156.7 | | order_item_id | 51.3 |
| revenue | **75.0** | | unit_price | 22.2 |
| cost | 73.8 | | category | **1.4** |
| order_id | 66.4 | | channel | 0.7 |
| customer_key | 65.2 | | quantity | 0.3 |
| product_key | 59.8 | | **total** | **572.8** |

`category + revenue` is 76.4 KB of 572.8 KB. **13.3%.** That is column pruning in bytes.

`category` costs 1.4 KB for 42,000 rows because it has 8 distinct values and Parquet
dictionary-encodes it. `order_ts` costs 156.7 KB because it is near-unique. Cardinality drives
storage cost, and that single row pair teaches it.

### 3.3 Head to head, 1M rows

Postgres 18.4 in Docker, fully warm (`shared hit=13379`, `read=0`), 2 parallel workers,
`ANALYZE` run, index on `order_id`. Table size 116 MB total / 104 MB heap.

| Query | Postgres 18 | DuckDB + Parquet | Winner |
| --- | --- | --- | --- |
| Group by category, sum revenue | **40.67 ms**, 104 MB read | **7 ms**, 1.56 MB read | DuckDB, 5.8x time, 67x I/O |
| Point lookup by `order_id` | **0.045 ms**, 80 KB read | **5 ms** | Postgres, **111x** |

Postgres numbers are its best case: everything in shared buffers, nothing from disk. Cold
would be materially worse. DuckDB's 1.56 MB is the exact compressed size of the two columns it
needed, out of a 12.34 MB lake.

### 3.4 DuckDB extensions

`ducklake`, `postgres_scanner` (aliased `postgres`), `httpfs` all install and load on DuckDB
1.5.3. Note the catalog name is `postgres_scanner`, not `postgres`, when querying
`duckdb_extensions()`.

### 3.5 DuckDB writes to Postgres

Loading 1M rows from DuckDB into Postgres through the `postgres` extension:

```
0.546 s
```

### 3.6 DuckLake

DuckLake v1.0 is stable and requires DuckDB v1.5.2 or newer (CITED). Verified working:
`ATTACH`, `CREATE TABLE AS`, `SELECT`, `DELETE`, time travel via `AT (VERSION => n)`, and
`lake.snapshots()`. All operations completed in under 20 ms.

**The load-bearing finding:** DuckLake stores data file paths **relative** to `DATA_PATH`.

```
SELECT path, path_is_relative FROM __ducklake_metadata_<name>.ducklake_data_file;
-- ducklake-01a0732d-...parquet | true
```

Therefore the lake is portable. Write it locally in CI, ship the Parquet with the deploy, and
read it from any HTTPS base by re-attaching with a different `DATA_PATH`. **This is what makes
a zero-cost, no-object-storage lakehouse possible.** VERIFIED end to end by serving the lake
over local HTTP and querying it successfully.

### 3.7 Free static hosts, range requests and CORS

Tested with real ranged `GET` requests, `Origin: https://example.com`.

| Host | Status | `Content-Range` | `Access-Control-Allow-Origin` | `Access-Control-Expose-Headers` |
| --- | --- | --- | --- | --- |
| Vercel CDN | 206 | yes | `*` | none |
| jsDelivr | 206 | yes | `*` | `*` |
| Hugging Face | 206 | yes | `*` | `*` |
| GitHub raw | 206 | yes | `*` | none |

All four support HTTP range requests. Vercel is chosen because same-origin removes CORS from
the problem entirely. jsDelivr is the overflow path because it exposes headers too.

---

## 4. The mental model

Read `docs/diagrams/row-vs-column.excalidraw` before writing code. It shows three orders stored
two ways, with every value the query must read in orange and every value it skips in grey.

The one sentence: **a column store never reads what it does not need.** Everything in this
project is plumbing around that fact.

The corollary, equally important: **when you need the whole row, that layout is a liability.**
Reconstructing one order from a column store means one read per column. That is why Postgres
wins Q7 by 111x.

---

## 5. Architecture: six lanes

A lane is one implementation of the query catalog behind a single interface.

```ts
interface Lane {
  id: LaneId;
  label: string;
  available(): Promise<boolean>;
  run(queryId: QueryId, params: QueryParams): Promise<LaneResult>;
}

interface LaneResult {
  rows: Row[];
  sql: string;              // exactly what was executed
  timings: { coldMs?: number; warmMs: number; p95Ms: number; runs: number };
  metrics: {
    bytesRead?: number;     // from the engine, not estimated
    rowsScanned?: number;
    rowsReturned: number;
  };
  handicaps: string[];      // disclosed on screen next to the numbers
}
```

| Lane | Engine | Runs on | Reads from | Demonstrates | Deployed |
| --- | --- | --- | --- | --- | --- |
| **A** | Postgres 18 | Neon | Neon heap + indexes | Row store doing an OLAP job. The baseline. | yes |
| **B** | DuckDB + `postgres` ext | Node server | Neon, live, via `ATTACH` | Zero-ETL federation. No copy, no pruning. | yes |
| **C** | DuckDB + `httpfs` | Node server | The lake | The lakehouse read path. | yes |
| **D** | DuckDB-WASM | Browser | The lake, HTTP range reads | No server at all. | yes |
| **E** | PGlite (Postgres in WASM) | Browser | Local WASM datadir | Controlled row-store baseline. | yes |
| **F** | pg_duckdb | Local Docker | Local Postgres heap | DuckDB embedded *inside* Postgres. | no |

**Lane F cannot deploy.** pg_duckdb needs `shared_preload_libraries`, which Neon does not
allow (CITED). It runs in the local bench and its results are committed as JSON that the app
renders, labelled as locally measured.

**D vs E is the most rigorous experiment here.** Same browser, same CPU, same rows, no network
variance. Lane A is the real-world Postgres number; lane E is the controlled one. Publish both.

**On lanes A and B and the OLTP constraint.** The stated constraint is that OLAP must never
raise OLTP latency. Lanes A and B violate it by design: they query the transactional cluster.
They are in the project as the *before* case that motivates C and D. The app must say this in
plain words on the page, not bury it. In production, A and B belong on a read replica or off
the cluster entirely.

**On DuckDB's shape.** There is no DuckDB server. Unlike ClickHouse you never deploy a DuckDB
you connect to. It is a library loaded into a process you already have: a `.node` binary in the
Next.js server (B, C), WASM in the browser tab (D), a library in a GitHub Actions runner (the
transform), a CLI binary on your laptop (the bench). Same engine, four hosts, zero servers.
That property is what makes lane D possible at all.

---

## 6. The lake, two generations

The lakehouse is not a seventh lane. It is the lake growing up. Building generation 1 first and
feeling its gaps is how you learn why generation 2 exists.

### Generation 1: raw Hive-partitioned Parquet (Day 2)

```
lake/
  month=2024-09/data_0.parquet
  month=2024-10/data_0.parquet
  ...
  month=2026-08/data_0.parquet
```

Written with:

```sql
COPY (SELECT *, strftime(order_ts, '%Y-%m') AS month FROM orders)
TO 'lake' (FORMAT parquet, PARTITION_BY month, COMPRESSION zstd, OVERWRITE_OR_IGNORE);
```

Read with:

```sql
SELECT ... FROM read_parquet('lake/**/*.parquet', hive_partitioning = true) WHERE month = '2025-03';
```

**What it gives you:** column pruning, partition pruning, row-group min/max skipping, and
excellent compression. All the physics.

**What it does not give you, and you must feel these before Day 3:**

| Gap | What goes wrong |
| --- | --- |
| No ACID | A reader mid-scan while the writer replaces a partition sees a torn state. |
| No atomic multi-partition change | Backfilling three months is three separate visible steps. |
| No schema evolution | Add a column and old files no longer match new ones. |
| No history | Overwrite a partition and the previous version is gone. |
| No catalog | You hand-maintain a `manifest.json` listing partitions, counts and sizes. |
| Slow planning at scale | Every query globs the filesystem or lists the bucket. |

### Generation 2: DuckLake, catalog in Postgres (Day 3)

DuckLake is an open lakehouse format where **metadata lives in a SQL database** and data lives
as Parquet. Contrast with Iceberg and Delta, which put metadata in files on object storage and
then need a catalog service anyway (CITED).

```sql
INSTALL ducklake; LOAD ducklake;
INSTALL postgres;  LOAD postgres;

ATTACH 'ducklake:postgres:host=... dbname=... user=... password=...' AS lake
  (DATA_PATH 'lake/');
```

**Every gap above closes.** ACID transactions, atomic multi-table commits, schema evolution,
snapshots and time travel, statistics in the catalog for file skipping, and a single fast
metadata query instead of a filesystem glob.

It also **deletes the hand-rolled `manifest.json`.** That file was a worse reimplementation of a
catalog and it is not in this plan.

**Why this matters for the project's thesis:** the catalog is Postgres and the data is Parquet
read by DuckDB. Postgres and DuckDB are not competing here, they are cooperating, each doing
what it is good at. That is a third mode of interaction beyond "sync" and "extension", and it is
the most interesting answer the project has.

**Reading the lake from a different location than it was written:**

```sql
ATTACH 'ducklake:postgres:...' AS lake
  (DATA_PATH 'https://your-app.vercel.app/lake/', OVERRIDE_DATA_PATH true, READ_ONLY);
```

VERIFIED. Paths are stored relative, so this resolves correctly. Note the syntax is
`OVERRIDE_DATA_PATH true`, with a space. `OVERRIDE_DATA_PATH => true` is a parser error.

---

## 7. Data model

### 7.1 Day 1: one flat table

Start where a real OLTP app starts. This is deliberately *not* a star schema, so that Day 4's
refactor teaches something.

```sql
CREATE TABLE orders (
  order_item_id   BIGINT        PRIMARY KEY,
  order_id        BIGINT        NOT NULL,
  order_ts        TIMESTAMPTZ   NOT NULL,
  customer_id     BIGINT        NOT NULL,
  product_id      BIGINT        NOT NULL,
  channel         TEXT          NOT NULL,   -- web | app | store
  category        TEXT          NOT NULL,
  quantity        INT           NOT NULL,
  unit_price      NUMERIC(10,2) NOT NULL,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  revenue         NUMERIC(12,2) NOT NULL,   -- quantity * unit_price - discount_amount
  cost            NUMERIC(12,2) NOT NULL
);

CREATE INDEX idx_orders_order_id ON orders (order_id);
CREATE INDEX idx_orders_order_ts ON orders (order_ts);
```

**Grain: one row per line item on one order.** Write that sentence down before writing any
query. Every aggregation bug in a warehouse traces back to not knowing the grain.

### 7.2 Day 4: star schema

**`fact_order_item`** - grain: one row per line item on one order.

| Column | Type | Notes |
| --- | --- | --- |
| `order_item_id` | BIGINT | surrogate PK |
| `order_id` | BIGINT | groups line items. Used by Q5 and Q7 |
| `order_ts` | TIMESTAMPTZ | event time |
| `date_key` | INT | FK to `dim_date`, format YYYYMMDD |
| `customer_key` | BIGINT | FK to `dim_customer`. Surrogate, SCD2-aware |
| `product_key` | BIGINT | FK to `dim_product` |
| `channel` | TEXT | low cardinality, shows dictionary encoding |
| `quantity` | INT | **additive** |
| `unit_price` | NUMERIC(10,2) | **non-additive**. Never sum it. Derive as revenue/quantity |
| `discount_amount` | NUMERIC(12,2) | **additive** |
| `revenue` | NUMERIC(12,2) | **additive** |
| `cost` | NUMERIC(12,2) | **additive** |

**`dim_date`** - conformed. `date_key` (INT, YYYYMMDD), `date`, `year`, `quarter`, `month`,
`month_name`, `day_of_week`, `is_weekend`, `iso_week`.

**`dim_customer`** - **SCD Type 2**. `customer_key` (surrogate PK), `customer_id` (natural key),
`name`, `country`, `segment`, `valid_from`, `valid_to`, `is_current`.

Customers change country and segment over time. Type 2 preserves history, so a query about
January uses January's segment, not today's. **This is the single most common thing people get
wrong in a warehouse.** The generator must produce real changes so the tests have something to
catch.

Invariants, enforced by tests:
- Exactly one row per `customer_id` has `is_current = true`
- No two rows for the same `customer_id` have overlapping `[valid_from, valid_to)`
- Every fact's `customer_key` resolves to a row whose validity range contains `order_ts`

**`dim_product`** - `product_key` (surrogate PK), `product_id` (natural), `name`, `category`,
`brand`, `list_price`.

**`fact_inventory_snapshot`** (Day 7 stretch) - grain: one row per product per day. `on_hand` is
**semi-additive**: summable across products, meaningless summed across days. Its only purpose is
to make the additive / semi-additive / non-additive distinction concrete.

### 7.3 Volumes

| Dataset | Where | Day 1 | Day 4 onward |
| --- | --- | --- | --- |
| Fact rows | everywhere | **1,000,000** | 10,000,000 |
| Time span | | 24 months, 2024-09-01 to 2026-08-31 | same |
| Parquet lake | `public/lake/` then jsDelivr | **12.34 MB** (VERIFIED) | ~130 MB (ASSUMED, linear) |
| Postgres heap | Docker, then Neon | **104 MB** (VERIFIED) | hot window only, see below |
| Customers | | 200,000 | 200,000 (~230,000 SCD2 rows) |
| Products | | 5,000 | 5,000 |

**Neon has 0.5 GB.** 10M rows will not fit. From Day 6, Postgres holds a **rolling hot window**
and the lake holds full history. Window size is config, not a constant. Start at 90 days
(~1.25M rows, ASSUMED ~130 MB by extrapolation from the VERIFIED 104 MB/1M figure) and shrink to
30 if measurement disagrees.

**This is not a workaround. It is the correct architecture**, and the free tier merely forced
you to discover it: transactional systems keep a hot window, analytics keeps history.

**Browser slice budget: 25 MB total download per engine, hard cap, enforced in CI.** Row count
for lanes D and E is tuned to fit and displayed on screen.

---

## 8. Query catalog

Three queries on Day 1. Seven by Day 4. One logical definition each, expressed per dialect,
with results asserted identical across all lanes.

| # | id | Question | Added | Concept it exercises |
| --- | --- | --- | --- | --- |
| Q1 | `revenue_by_category` | Revenue per category, all history | **Day 1** | Column pruning: 2 of 11 columns |
| Q2 | `revenue_by_month_filtered` | Revenue per month within a date range | **Day 1** | Partition pruning, predicate pushdown |
| Q7 | `order_lookup` | One order and its line items, by id | **Day 1** | **Where the row store wins** |
| Q3 | `top_categories` | Top 10 categories by revenue in a range | Day 4 | Star join, row-group min/max skipping |
| Q4 | `rolling_revenue` | 30-day rolling revenue | Day 4 | Window functions, ordered aggregation |
| Q5 | `repeat_rate` | Distinct customers and repeat rate by month | Day 4 | Exact vs approximate distinct (HLL) |
| Q6 | `category_by_month` | Revenue by category by month | Day 4 | Two-dimension grouping, wide output |

Day 1 picks Q1, Q2 and Q7 deliberately: one that shows column pruning, one that shows partition
pruning, and one that Postgres wins. That is the complete argument in three queries.

**Rules.**

- Parameters are limited to a date range and a limit. No free-form SQL, ever. It is not a query
  builder and accepting arbitrary SQL from a public URL is a security problem.
- Money is compared rounded to 2 decimal places. Results are sorted before comparison.
- A lane that disagrees with lane A on any query has its timings suppressed and CI fails.

### Day 1 SQL, both dialects

**Q1** is identical in both:

```sql
SELECT category, sum(revenue) AS revenue
FROM <source>
GROUP BY 1
ORDER BY revenue DESC;
```

`<source>` is `orders` for Postgres, `read_parquet('lake/**/*.parquet', hive_partitioning=true)`
for DuckDB.

**Q2**, Postgres:

```sql
SELECT date_trunc('month', order_ts) AS month, sum(revenue) AS revenue
FROM orders
WHERE order_ts >= $1 AND order_ts < $2
GROUP BY 1 ORDER BY 1;
```

**Q2**, DuckDB, written so the partition column does the pruning:

```sql
SELECT month, sum(revenue) AS revenue
FROM read_parquet('lake/**/*.parquet', hive_partitioning = true)
WHERE month >= strftime(CAST($1 AS TIMESTAMP), '%Y-%m')
  AND month <= strftime(CAST($2 AS TIMESTAMP), '%Y-%m')
GROUP BY 1 ORDER BY 1;
```

The difference between these two is itself a lesson: the DuckDB version filters on the Hive
partition key so whole files are never opened. Record how many files each version touches.

**Q7**, identical in both:

```sql
SELECT * FROM <source> WHERE order_id = $1 ORDER BY order_item_id;
```

---

## 9. Measurement rules

The numbers are the product. These are enforced in code, not aspiration, and are stated on the
site.

1. **Correctness gates publication.** A lane's timing is published only if its rows match lane A
   exactly. CI fails otherwise.
2. **Median of 5 runs after 1 warm-up.** Report median and p95, never the mean.
3. **Cold and warm are separate numbers, never averaged.** Neon scales to zero after 5 minutes,
   so lane A's cold figure includes a wake-up. Label it, do not hide it.
4. **Report bytes read, not just time.** Time is hardware. Bytes read is architecture, and it is
   the number that transfers to a reader's own situation.

   | Lane | How bytes read is obtained |
   | --- | --- |
   | A, E | `EXPLAIN (ANALYZE, BUFFERS)`, `(shared hit + shared read) * 8192` |
   | B, C, F | `EXPLAIN ANALYZE` profiling output |
   | D | Browser Resource Timing `transferSize`, summed over lake requests |

5. **Report rows scanned and rows returned.** The ratio is the story.
6. **Show the SQL.** Every lane's exact executed statement is visible in the UI.
7. **Stamp the environment.** Every published number carries CPU, RAM, region and date.
8. **Disclose handicaps next to the numbers they qualify.** PGlite is single-user with no
   parallel workers. Neon free is a small compute. These belong on screen, not in a footnote.
9. **Never compare a warm lane to a cold one in the same figure.**

---

## 10. Tech stack, pinned

| Layer | Choice | Version | Status |
| --- | --- | --- | --- |
| Language | TypeScript, `strict: true` | 5.x | |
| Runtime | Node | v24.18.0 | VERIFIED present |
| Package manager | pnpm | 11.25.0 | VERIFIED present |
| DuckDB CLI | `duckdb` | v1.5.3 | VERIFIED present |
| Server DuckDB | `@duckdb/node-api` | 1.5.5-r.4 | CITED, npm latest |
| Browser DuckDB | `@duckdb/duckdb-wasm` | 1.33.1-dev57.0 | CITED, npm latest |
| Browser Postgres | `@electric-sql/pglite` | 0.5.8 | CITED, npm latest. Its PG major version to be printed in the UI on Day 5 |
| Postgres driver | `pg` | 8.x | |
| Postgres, local | Docker `postgres:18` | 18.4 | VERIFIED running |
| Postgres, hosted | Neon free | PG 17 or 18 | Confirm at Day 6 |
| pg_duckdb | Docker `pgduckdb/pgduckdb:18-v1.1.1` | v1.1.1 | CITED, latest release |
| DuckLake format | `ducklake` extension | v1.0 stable, needs DuckDB >= 1.5.2 | VERIFIED working |
| App | Next.js App Router | latest stable at Day 6 | |
| Hosting | Vercel Hobby | | see risk R1 |
| Scheduled refresh | GitHub Actions cron | | |
| Tests | Vitest | 3.x | |

**Do not use the `duckdb` npm package.** It is the deprecated legacy binding.
`@duckdb/node-api` is the supported Node path.

---

## 11. Repo layout

Start flat. Split a package out only when a boundary actually hurts. A five-package monorepo
before the first line of code is overhead, not architecture.

**Day 1:**

```
olap-postgres/
├─ docs/
│  ├─ PLAN.md
│  ├─ results.md                  every measurement, appended as taken
│  └─ diagrams/row-vs-column.excalidraw
├─ sql/
│  ├─ 01_schema.sql
│  └─ queries/{q1,q2,q7}.{postgres,duckdb}.sql
├─ src/
│  ├─ generate.ts                 seeded generator
│  ├─ load.ts                     load Postgres, write Parquet
│  ├─ lanes/{postgres,duckdb-parquet}.ts
│  ├─ compare.ts                  runs lanes, asserts equality, prints the table
│  └─ types.ts                    Lane, LaneResult, QueryId
├─ docker-compose.yml
├─ package.json
└─ tsconfig.json
```

**By Day 7 it will have grown to:**

```
├─ src/lanes/           six lanes
├─ src/pipeline/        transform, DuckLake writer
├─ src/bench/           local harness, writes bench/results/*.json
├─ app/                 Next.js, public/lake/ holds the Parquet
├─ bench/results/       committed JSON
└─ .github/workflows/   ci.yml, refresh.yml
```

---

## 12. The build

Seven days. Each day ends with something that works on its own and a number you measured.
Stopping after any day leaves a real artifact.

---

### Day 1 - Two engines, three queries, one table of numbers

**Goal.** By end of day, see the gap yourself and be able to explain it in both directions.
No cloud, no framework, no accounts.

**Prerequisites.** Docker running, DuckDB CLI on PATH, Node 24, pnpm. All VERIFIED present.

**Steps.**

1. `pnpm init`, TypeScript strict, Vitest. Nothing else.
2. `docker-compose.yml` with one service:

   ```yaml
   services:
     pg:
       image: postgres:18
       environment:
         POSTGRES_PASSWORD: postgres
         POSTGRES_DB: olap
       ports: ["55432:5432"]
       command: -c shared_buffers=256MB -c max_parallel_workers_per_gather=2
   ```

   Port 55432 avoids collision with any local Postgres.
3. `sql/01_schema.sql` - the flat `orders` table from section 7.1.
4. `src/generate.ts` - seeded, deterministic. Same seed produces byte-identical output, always.
   1M rows, 24 months, 2024-09-01 to 2026-08-31.

   Shape it realistically or the numbers teach nothing:
   - weekday/weekend seasonality
   - category skew, a long tail of products
   - a Black Friday spike in late November
   - ~2% returns as negative revenue
5. `src/load.ts` - load Postgres, then write the Parquet lake:

   ```sql
   COPY (SELECT *, strftime(order_ts,'%Y-%m') AS month FROM orders)
   TO 'lake' (FORMAT parquet, PARTITION_BY month, COMPRESSION zstd, OVERWRITE_OR_IGNORE);
   ```
6. Write Q1, Q2, Q7 in both dialects (section 8).
7. `src/lanes/postgres.ts` and `src/lanes/duckdb-parquet.ts`, both implementing `Lane`.
   Capture `EXPLAIN (ANALYZE, BUFFERS)` for Postgres and convert buffers to bytes.
8. `src/compare.ts` - run both lanes on all three queries, **assert results are identical**,
   print one table: query, lane, median ms, p95, bytes read, rows scanned, rows returned.
9. Append the output to `docs/results.md`.

**Done when.**

- [ ] `pnpm compare` prints one table with six rows (3 queries x 2 lanes)
- [ ] Every query's results match across both lanes, asserted in code, not eyeballed
- [ ] `pnpm generate` twice at the same seed produces identical checksums
- [ ] Q1 shows DuckDB reading roughly 67x fewer bytes
- [ ] Q7 shows Postgres winning by roughly 100x
- [ ] `docs/results.md` has the numbers with the host spec stamped on them

**Expected results** (VERIFIED on this machine, so treat as the target):
Q1 Postgres 40.67 ms / 104 MB, DuckDB 7 ms / 1.56 MB. Q7 Postgres 0.045 ms, DuckDB 5 ms.

**What you learned.** Column pruning and partition pruning are not abstractions, they are the
byte counts in your own table. And a column store is genuinely bad at fetching one row.

---

### Day 2 - Parquet internals, and DuckDB reading Postgres live

**Goal.** Understand what file layout actually does, and try zero-ETL federation.

**Steps.**

1. **The layout study.** Same query, same data, one factor changed at a time. Record bytes read
   and wall time for each variant into `docs/results.md`.

   | Factor | Variants |
   | --- | --- |
   | Partitioning | none, by month, by month+category |
   | Sort within partition | unsorted, sorted by `(category, order_ts)` |
   | Row group size | 10k, 100k, 1M rows |
   | Compression | uncompressed, snappy, zstd |

   Read the footers directly to explain the results:

   ```sql
   SELECT path_in_schema, sum(total_compressed_size), sum(total_uncompressed_size)
   FROM parquet_metadata('lake/**/*.parquet') GROUP BY 1 ORDER BY 2 DESC;

   SELECT * FROM parquet_file_metadata('lake/month=2025-03/*.parquet');
   ```
2. **Lane B.** DuckDB attaches Postgres and queries it live:

   ```sql
   INSTALL postgres; LOAD postgres;
   ATTACH 'host=localhost port=55432 dbname=olap user=postgres password=postgres'
     AS pg (TYPE postgres, READ_ONLY);
   SELECT category, sum(revenue) FROM pg.orders GROUP BY 1;
   ```
3. Record what DuckDB pushes down to Postgres versus what it pulls over the wire. Compare lane
   B against lane A and lane C on all three queries.

**Done when.**

- [ ] `docs/results.md` has the layout study table with bytes read per variant
- [ ] You can explain why sorting by `category` changes how many row groups are read
- [ ] Lane B matches lane A exactly on all three queries
- [ ] `docs/results.md` records which predicates lane B pushed down and which it did not

**What you learned.** Sort order and row group size are performance decisions, not defaults.
Federation avoids a copy but gives up pruning, and you have the numbers for the trade.

---

### Day 3 - DuckLake: the lake grows a catalog

**Goal.** Feel the gaps in raw Parquet, then close them.

**Steps.**

1. **Feel the gaps first.** Deliberately reproduce each one from the section 6 table. Overwrite
   a partition mid-scan. Add a column and watch old files disagree. Try to answer "what did this
   table look like yesterday" and fail. Write down what happened.
2. Attach DuckLake with the local Docker Postgres as catalog:

   ```sql
   INSTALL ducklake; LOAD ducklake;
   INSTALL postgres;  LOAD postgres;
   ATTACH 'ducklake:postgres:host=localhost port=55432 dbname=olap user=postgres password=postgres'
     AS lake (DATA_PATH 'lake_dl/');
   CREATE TABLE lake.orders AS SELECT * FROM read_parquet('lake/**/*.parquet');
   ```
3. Now close each gap and record it:
   - **ACID**: multi-statement transaction, roll it back, confirm no partial state
   - **Time travel**: `SELECT count(*) FROM lake.orders AT (VERSION => 1)`
   - **Snapshots**: `SELECT * FROM lake.snapshots()`
   - **Schema evolution**: `ALTER TABLE lake.orders ADD COLUMN margin DECIMAL(12,2)`, then query
     old snapshots
   - **Catalog**: inspect `__ducklake_metadata_lake.ducklake_data_file` and see the statistics
     that let it skip files
4. Point lane C at DuckLake instead of raw globbing. Confirm results still match lane A.
5. **Verify portability**, since the whole deployment depends on it. Serve `lake_dl/` over local
   HTTP and re-attach:

   ```sql
   ATTACH 'ducklake:postgres:...' AS lake
     (DATA_PATH 'http://localhost:8080/', OVERRIDE_DATA_PATH true, READ_ONLY);
   ```

   Note: `OVERRIDE_DATA_PATH true`, with a space. `=> true` is a parser error.

**Done when.**

- [ ] Each of the six gaps from section 6 is reproduced, then demonstrated closed
- [ ] Time travel returns a genuinely different row count than the current snapshot
- [ ] Lane C reads through DuckLake and still matches lane A
- [ ] The lake is proven readable over HTTP with an overridden `DATA_PATH`
- [ ] `docs/results.md` explains, in your own words, when a lakehouse format is worth it

**What you learned.** Why Iceberg, Delta and DuckLake exist. And the project's most interesting
answer: Postgres holds the catalog, DuckDB does the compute, Parquet holds the data. They
cooperate.

---

### Day 4 - Dimensional modelling, and scale up

**Goal.** Turn a flat table into a star, and find out why anyone bothers.

**Steps.**

1. Refactor the generator to emit `fact_order_item`, `dim_date`, `dim_customer` (SCD2),
   `dim_product`. Section 7.2 is the target.
2. The generator must produce **real SCD2 changes**: customers that move country and change
   segment mid-history, so the tests have something to catch.
3. Write the SCD2 invariant tests from section 7.2. They must fail if you break the generator.
4. Add Q3 to Q6. Each one needs a dimension join, so the star earns its keep.
5. Q5 gets both implementations: exact `count(distinct)` and approximate
   `approx_count_distinct()`. Measure the accuracy and speed difference, record both.
6. Demonstrate the measure classes concretely:
   - additive: `sum(revenue)` across any dimensions, correct
   - non-additive: `sum(unit_price)` produces a meaningless number, show it
   - semi-additive: deferred to Day 7 with the inventory snapshot
7. **Scale to 10M rows.** Regenerate, reload, rerun everything. Record the new numbers beside
   the 1M ones.

**Done when.**

- [ ] Seven queries pass on all lanes built so far
- [ ] SCD2 invariant tests exist and fail when the generator is deliberately broken
- [ ] A query about a past month uses that month's customer segment, proven by a test
- [ ] `docs/results.md` shows exact vs approximate distinct: error percentage and speedup
- [ ] 10M-row numbers recorded alongside 1M

**What you learned.** Grain, surrogate keys, conformed dimensions, and why summing a price
column is always a bug.

---

### Day 5 - The browser

**Goal.** Run both engines client-side and get the controlled head-to-head.

**Steps.**

1. Lane D: `@duckdb/duckdb-wasm` in a Web Worker, `httpfs` reading the lake over HTTP range
   requests.
2. Lane E: PGlite in a Web Worker. **Load a pre-built datadir via `loadDataDir()`.** Do not run
   `COPY` in the browser, it is far too slow. Build the datadir in CI with `dumpDataDir()` and
   publish it.
3. Instrument both separately: bytes downloaded to prepare, load time, query time. PGlite's
   preparation cost is part of its honest total.
4. Enforce the **25 MB per engine** budget. Tune the slice row count to fit. Display the row
   count on screen.
5. Assert lanes D and E agree with each other and with lane A on the same slice.
6. Print PGlite's actual Postgres major version in the UI.

**Done when.**

- [ ] Both engines answer all seven queries in the browser with zero server calls
- [ ] D vs E measured on identical rows in the same tab
- [ ] Downloads stay under 25 MB per engine, enforced in CI
- [ ] Handicap text for PGlite is on screen next to its numbers

**What you learned.** Vectorized columnar execution versus tuple-at-a-time, with host, CPU and
data held constant. This is the cleanest comparison in the project.

---

### Day 6 - Deploy

**Goal.** The public URL.

**Do the risky thing first.**

1. **The native-binding spike, before anything else.** Deploy a Next.js route on Vercel that
   loads `@duckdb/node-api`, installs `httpfs`, and reads one Parquet file.
   - `serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings']` in `next.config.js`
   - `export const runtime = 'nodejs'` on the route
   - `SET home_directory='/tmp'` before any extension use, since the sandbox has no home
   - Check the unzipped function bundle against Vercel's 250 MB limit
   - Known failure mode: `ERR_DLOPEN_FAILED`, missing `GLIBCXX_3.4.30`. Fix by pinning a
     binding version compiled against an older libstdc++ (CITED)

   **If it fails:** deploy the whole app as a Docker container instead, using Next.js standalone
   output. Same code, different host. Do not spend more than half a day here.
2. Neon project, free plan, no card. Load the hot window. **Measure against 0.5 GB** and shrink
   the window from 90 days to 30 if needed.
3. DuckLake catalog moves to Neon. Data path becomes `public/lake/`.
4. Next.js app:
   - pick a question, run all available lanes, one card per lane
   - wall time, bytes read, rows scanned/returned, exact SQL
   - cold and warm as separate figures
   - handicap disclosures rendered next to the numbers they qualify
   - Q7 given its own treatment: the query where Postgres wins
   - a "How it works" page embedding both diagrams
5. `docs/diagrams/system.excalidraw` - the second diagram, how the project is wired. Same
   plainness rule as the first one, built and audited the same way.
6. `.github/workflows/refresh.yml` - nightly. Regenerate the tail, rewrite affected partitions
   through DuckLake, rebuild the PGlite datadir, redeploy.
7. Smoke test in CI: assert the deployed lake URL returns `206` with `Content-Range` on a ranged
   GET. **If DuckDB logs `Falling back to full file download`, range requests are broken.** That
   warning is a free self-test.

**Done when.**

- [ ] A public URL runs lanes A through E live
- [ ] Numbers are labelled cold or warm, with handicaps shown
- [ ] Neon storage is under 0.5 GB, measured
- [ ] The range-request smoke test passes in CI
- [ ] The nightly refresh has run successfully at least once

---

### Day 7 - The other direction, and the write-up

**Goal.** Close the loop on "sync versus extension", then make it readable.

**Steps.**

1. Add `pgduckdb/pgduckdb:18-v1.1.1` to `docker-compose.yml`. It needs
   `shared_preload_libraries`, which is why it cannot go on Neon.
2. Lane F: the same seven queries with `duckdb.force_execution`. Compare against vanilla
   Postgres on identical data and identical hardware.
3. Bench harness: run every lane in one controlled local environment on the full 10M rows,
   write `bench/results/<date>-<hostspec>.json`. Commit it.
4. The app renders those results, clearly marked as locally measured, with the host spec.
5. Stretch: `fact_inventory_snapshot` for semi-additive measures.
6. Stretch: a pre-aggregated rollup table and a materialized view, measured against the raw scan.
7. **The write-up.** README with the problem, the diagrams, the numbers, and the verdict: which
   lane for which workload, and what each one costs. Finish `docs/concepts.md` so every concept
   in section 13 has the measurement that demonstrated it.

**Done when.**

- [ ] All six lanes have numbers from one machine on one dataset
- [ ] `docs/concepts.md` states when to reach for pg_duckdb instead of an external lake
- [ ] A reader who knows Postgres but not OLAP can read the README and understand the trade-offs

---

## 13. Concept coverage map

Every concept is tied to something measured, not merely described.

| Concept | Where it is demonstrated | Day |
| --- | --- | --- |
| OLTP vs OLAP workload shapes | Q7 vs Q1-Q6 | 1 |
| Row store vs column store layout | The diagram, then lanes A vs C | 1 |
| Column pruning | Q1, bytes read: 1.56 MB vs 104 MB | 1 |
| Partition pruning | Q2, files touched with and without the partition predicate | 1 |
| Predicate pushdown | Lane B: what crosses the wire vs what does not | 2 |
| Row-group min/max statistics | Layout study, sorted vs unsorted | 2 |
| Compression and encoding | Layout study; `category` 1.4 KB vs `order_ts` 156.7 KB | 2 |
| Zero-ETL federation | Lane B vs lane C, with the cost of each | 2 |
| Why lakehouse formats exist | The six gaps, felt then closed | 3 |
| ACID on object storage | DuckLake transaction rollback | 3 |
| Time travel and snapshots | `AT (VERSION => n)`, `lake.snapshots()` | 3 |
| Schema evolution | `ALTER TABLE` then query an old snapshot | 3 |
| Catalog vs file-based metadata | DuckLake vs the `manifest.json` we deleted | 3 |
| Star schema and grain | Section 7.2, enforced by tests | 4 |
| Surrogate keys and SCD Type 2 | `dim_customer` invariant tests | 4 |
| Additive / semi-additive / non-additive | `revenue` vs `on_hand` vs `unit_price` | 4, 7 |
| Exact vs approximate distinct | Q5 both ways, error and speedup measured | 4 |
| Window functions | Q4, Q6 | 4 |
| Vectorized vs tuple-at-a-time | Lane E vs lane D: same tab, same CPU, same rows | 5 |
| Workload isolation | Hot window vs lake; lanes A and B labelled "before" | 6 |
| Idempotent partition reload | Nightly refresh rewrites a month | 6 |
| DuckDB inside Postgres | Lane F, pg_duckdb | 7 |
| Pre-aggregation and materialized views | Day 7 stretch | 7 |
| Query planning and I/O accounting | `EXPLAIN (ANALYZE, BUFFERS)` in every lane | all |

---

## 14. Gotchas

Found empirically. Each one costs an hour if rediscovered.

| Gotcha | Detail |
| --- | --- |
| `.timer on` in `duckdb -c` | Fails with "Invalid usage of command '.timer'". Put dot-commands in a `.sql` file and pipe it in, or use separate `-c` flags. |
| `OVERRIDE_DATA_PATH => true` | Parser error. The correct form is `OVERRIDE_DATA_PATH true`, space separated, inside the `ATTACH` options list. |
| DuckLake metadata tables | Not `lake.ducklake_data_file`. They live in `__ducklake_metadata_<name>.ducklake_data_file`. |
| Extension name in the catalog | `duckdb_extensions()` lists it as `postgres_scanner`, but you `INSTALL postgres` / `LOAD postgres`. |
| `AT (VERSION => n)` is off-by-one intuition | Snapshot `n` is the state **after** operation `n`. To see data before a delete recorded as snapshot 2, query version 1. |
| Range requests | If DuckDB logs `Falling back to full file download`, the host does not support range requests. Python's `http.server` does not. Vercel does (VERIFIED 206). Use the warning as a test. |
| Vercel `public/` counts as source | It falls under the 100 MB Hobby source upload cap, not a separate static budget. |
| Legacy `duckdb` npm package | Deprecated. Use `@duckdb/node-api`. |
| PGlite `COPY` in the browser | Far too slow for hundreds of thousands of rows. Use `dumpDataDir()` in CI and `loadDataDir()` in the browser. |
| Neon scale-to-zero | 5 minutes idle. The first query after that pays a wake-up. Never fold it into a warm average. |

---

## 15. Risks

| # | Risk | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- |
| R1 | Native DuckDB on Vercel: `GLIBCXX` mismatch, 250 MB bundle cap, no writable home | Lanes B and C cannot deploy | Day 6 spike, done first, timeboxed to half a day. `serverExternalPackages`, `runtime='nodejs'`, `SET home_directory='/tmp'`. Fallback: ship as a Docker container | open |
| R2 | Neon 0.5 GB cap | Cannot hold 10M rows | Hot window only, size configurable. The lake holds history. This is the intended architecture | accepted |
| R3 | Neon scales to zero | Lane A cold numbers look absurd | Cold and warm reported separately and labelled | accepted |
| R4 | DuckDB-WASM `httpfs` uses synchronous XHR range reads | Many small ranges are slow in the browser | Row group size is a tuned variable in the Day 2 layout study. Measure range reads against full-file download and choose per partition size | open |
| R5 | ~~CORS misconfiguration breaks lane D~~ | ~~Fails in production only~~ | **Eliminated.** Serving the lake same-origin from Vercel removes CORS from the problem | closed |
| R6 | PGlite is single-user, no parallel workers | Lane E understates Postgres | Disclosed on screen. Lane A is the real number, lane E the controlled one. Publish both | accepted |
| R7 | Browser download size ruins the demo | Nobody waits | Hard 25 MB per-engine budget, enforced in CI | open |
| R8 | Lake outgrows Vercel's 100 MB source cap at 10M rows | Cannot deploy the full lake | Switch `DATA_PATH` to jsDelivr off a public GitHub repo. One-line change, made possible by DuckLake relative paths (VERIFIED). Partitions are ~570 KB, well under jsDelivr's 20 MB per-file limit | mitigated |
| R9 | Scope creep across six lanes | Never ships | Days are independently shippable. Day 1 produces value; Day 6 produces the URL; Day 7 is additive | accepted |
| R10 | Numbers that are not reproducible | The project becomes worthless | Section 9 enforced in code: equality assertions in CI, median of 5, environment stamped on every result | accepted |
| R11 | Vercel Hobby is non-commercial only | Cannot be used for paid work | A portfolio project qualifies. Noted so it is not discovered later | accepted |

---

## 16. Open decisions

Resolved on the day noted, by measurement, not debate.

| Decision | Resolved on | By what evidence |
| --- | --- | --- |
| Row group size and compression | Day 2 | The layout study table |
| Whether Q5 defaults to exact or approximate distinct | Day 4 | Measured error percentage vs speedup |
| Hot window: 90 days or 30 | Day 6 | Measured Neon storage against 0.5 GB |
| Vercel serverless vs Docker container | Day 6 | The native-binding spike |
| Browser slice row count | Day 5 | The 25 MB budget |
| Whether the lake stays on Vercel or moves to jsDelivr | Day 6 | Lake size against the 100 MB source cap |

---

## 17. Glossary

For a reader who knows Postgres but not warehousing.

| Term | Meaning here |
| --- | --- |
| **OLTP** | Online Transaction Processing. Many small reads and writes, point lookups, one row at a time. What Postgres is built for. |
| **OLAP** | Online Analytical Processing. Few queries, each scanning millions of rows to return a handful. What DuckDB is built for. |
| **Row store** | Stores all of row 1, then all of row 2. Reaching one column means walking past all the others. |
| **Column store** | Stores all of column A, then all of column B. Reading two of eleven columns touches only those two. |
| **Column pruning** | Not reading columns the query never mentions. Also called projection pushdown. |
| **Partition pruning** | Not opening files whose partition key cannot match the filter. |
| **Predicate pushdown** | Pushing a `WHERE` clause as close to the data as possible, so less comes back. |
| **Row group** | A horizontal slice of a Parquet file, with its own per-column statistics. The unit of skipping. |
| **Zone map / min-max stats** | Per-row-group minimum and maximum per column. Lets an engine skip a whole row group without reading it. |
| **Parquet** | A columnar file format. Data grouped by column, compressed per column, with a footer of metadata and statistics. |
| **Data lake** | Files in storage. No transactions, no catalog, no history. |
| **Lakehouse** | A data lake plus a table format that adds ACID, schema evolution and time travel. Iceberg, Delta, DuckLake. |
| **DuckLake** | A lakehouse format that keeps its catalog in a SQL database instead of in metadata files. Here, Postgres. |
| **Catalog** | The record of which files make up a table, plus their schema and statistics. |
| **Snapshot / time travel** | A committed version of a table you can query as of a point in the past. |
| **Star schema** | One central fact table of measurements surrounded by dimension tables of descriptions. |
| **Grain** | Exactly what one row of a fact table represents. Declare it before writing any query. |
| **Fact** | A measurement. Numeric, usually additive. Revenue, quantity, cost. |
| **Dimension** | Context for a fact. Customer, product, date. What you group and filter by. |
| **Surrogate key** | A meaningless integer key owned by the warehouse, as opposed to a natural business key. Required for SCD2. |
| **SCD Type 2** | Slowly Changing Dimension Type 2. When an attribute changes, write a new row with a new validity range instead of updating, so history is preserved. |
| **Additive** | Summable across every dimension. Revenue. |
| **Semi-additive** | Summable across some dimensions but not time. Inventory on hand. |
| **Non-additive** | Never summable. Unit price, ratios, percentages. |
| **Conformed dimension** | A dimension shared identically by several fact tables, so results can be compared across them. |
| **ETL / ELT** | Extract, Transform, Load, in either order. Here: Postgres to Parquet is the T and L. |
| **Zero-ETL federation** | Querying the source system directly with no copy. Lane B. |
| **Vectorized execution** | Processing batches of column values at a time rather than one row at a time. Why DuckDB is fast. |
| **HyperLogLog (HLL)** | An algorithm giving approximate distinct counts in a fraction of the memory and time. |
| **PGlite** | Real Postgres compiled to WebAssembly, running in the browser. Single-user, no parallel workers. |
| **pg_duckdb** | A Postgres extension that embeds DuckDB inside the Postgres process. |
| **Hot window** | The recent slice of data kept in the transactional database, as opposed to full history in the lake. |
