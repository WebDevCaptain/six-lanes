# OLAP Lab: Postgres and DuckDB

Six engines answer the same seven questions over the same e-commerce dataset, and the
project reports honest, reproducible numbers for each: wall time, bytes read, rows
scanned. No lane's timing is published unless its rows match the baseline exactly.

It is built to prove two things, and the second one is why the first is worth
believing.

**A column store wins at analytics.** On 1M line items, DuckDB over Parquet answers
"revenue by category" in **7.4 ms reading 3.72 MB**. Postgres answers the same question
in **41.6 ms reading 107.8 MB**. At 10M rows the gap widens to **29x on time and 30x on
bytes**, because that is where the row store stops fitting in memory.

**And it loses.** Ask for one order by id and Postgres answers in **0.25 ms reading
32 KB**; the lake takes 6 ms. On engine time that is roughly **800x**. A comparison that
never loses is marketing.

---

## Run it

Everything is local. No cloud account, no credit card, no external service.

```bash
docker --version   # Docker running
duckdb -version    # DuckDB CLI, optional but handy
node --version     # v24+
pnpm --version     # v11+

pnpm install
pnpm up            # Postgres 18 and an nginx serving the lake
pnpm generate      # seeded dataset -> data/olap.duckdb
pnpm load          # -> Postgres star schema + raw Parquet lake
pnpm ducklake      # -> DuckLake, catalog in Postgres
pnpm compare       # the table this project exists to produce
```

Then, for the page:

```bash
pnpm slice         # builds what the browser downloads
pnpm dev           # http://localhost:3000
```

Every container is declared in `docker-compose.yml`. Nothing is started by an ad-hoc
`docker run`.

| Command | What it does |
| --- | --- |
| `pnpm up` / `pnpm down` / `pnpm reset` | containers; `reset` drops the volumes too |
| `pnpm generate` | seeded dataset and star schema into `data/olap.duckdb` |
| `pnpm load` | Postgres star + generation 1 lake (+ pg_duckdb if running) |
| `pnpm ducklake` | generation 2 lake, catalog in Postgres, proves portability |
| `pnpm slice` | the browser's Parquet and PGlite datadir, sized to the budget |
| `pnpm compare` | lanes A, B, C over all seven queries. `--write` appends to results |
| `pnpm bench` | every server lane including F, writes `bench/results/*.json` |
| `pnpm study` | the Day 2 layout study: ten layouts, four probes |
| `pnpm gaps` | the six things raw Parquet cannot do, then DuckLake doing them |
| `pnpm measures` | additive vs non-additive, exact vs approximate distinct |
| `pnpm test` | unit tests. `pnpm test:integration` needs the containers and data |
| `pnpm dev` | the page |

Bigger dataset: `OLAP_ROWS=10000000 pnpm generate && pnpm load && pnpm ducklake`.
It takes about eight minutes and needs ~2 GB in Postgres.

---

## The six lanes

A lane is one implementation of the query catalogue behind a single interface. They
differ in engine and in where the bytes live, and in nothing else - the SQL comes from
one catalogue and one wrapper decides how all of them are timed.

| | Engine | Runs on | Reads from | Shows |
| --- | --- | --- | --- | --- |
| **A** | Postgres 18 | Docker | heap + b-tree | A row store doing an OLAP job. The baseline, and the correct answer. |
| **B** | DuckDB + `postgres` | Node | the live heap | Zero-ETL federation: no copy, and no layout either. |
| **C** | DuckDB + `httpfs` | Node | Parquet over HTTP | The lakehouse read path. |
| **D** | DuckDB-WASM | the browser | Parquet, range requests | No server in the request path at all. |
| **E** | PGlite | the browser | a pre-built datadir | The controlled row-store baseline: same tab as D. |
| **F** | pg_duckdb | Docker only | the local heap | DuckDB inside Postgres. Needs `shared_preload_libraries`. |

---

## What the numbers say

Full detail, with the raw tables, is in [docs/results.md](docs/results.md). The
conclusions:

**Bytes read is the number that transfers.** Milliseconds are a fact about one machine
on one afternoon. That a query needs three columns of thirteen is a fact about the
layout, and it holds wherever it runs.

**The column store's advantage grows with scale.** 7.6x at 1M rows, 29x at 10M - not
because DuckDB got better but because Postgres stopped fitting in `shared_buffers`.

**Sort order and row group size are one decision, not two.** Sorting by a filter column
bought 1.15x on its own, because a month partition was a single row group and there was
nothing to skip. Sorting *and* shrinking row groups bought **3.6x**. Shuffling the rows
cost 40% more disk.

**Federation loses on transfer and wins on computation.** Lane B moves 1,000,000 rows
over a socket to return 8, and loses to plain Postgres. On `count(DISTINCT)` it wins by
3.8x, because Postgres sorts and DuckDB hashes.

**A catalog is not bookkeeping, it is a query plan.** Moving lane C from globbing
Parquet to DuckLake took a point lookup from **24 files opened to 1**: `order_id` is not
the partition key, so path-based pruning could do nothing, while per-file min/max
statistics in Postgres eliminated 23 files before touching storage.

**pg_duckdb accelerates computation, not storage** - and quietly declines the queries it
cannot translate. Four of our seven fall back to plain Postgres with only a warning.

**Vectorised beats tuple-at-a-time by 5-14x, with everything else held constant.** Lanes
D and E, same tab, same CPU, same 166,150 rows. And E wins the point lookup by 44x.

---

## Why you should believe the numbers

Each of these is enforced by code named here, not by good intentions.

| Rule | Where |
| --- | --- |
| A lane's timing is published only if its rows match the baseline exactly | `src/bench/compare.ts`, `tests/integration/lanes.test.ts` |
| Median and p95 of 5 runs after 1 warm-up, never a mean | `src/bench/measure.ts`, `src/lanes/create-lane.ts` |
| Bytes read comes from the engine, in a pass outside the timed loop | `src/lanes/postgres.ts`, `src/duckdb/profile.ts` |
| Money is compared as exact decimal text, never a float | `src/bench/normalize.ts` |
| Every result carries the machine it came from | `src/host.ts` |
| Handicaps are attached to the lane, not to a footnote | `src/lanes/meta.ts` |

The equality check is not ceremony. It caught a DuckDB-WASM decimal that was a hundred
times too large, a timestamp off by 55 years, and a browser lane that was "passing" by
returning nothing at all.

Lane A is measured at its best throughout: indexes, extended statistics on the grouping
expression, and 64 MB of `work_mem`. A comparison won by leaving the other engine
misconfigured proves nothing.

---

## Where things are

```
src/queries/      the catalogue: one question, one definition, every dialect
src/lanes/        one lane per engine, one shared measurement wrapper
src/data/         the seeded generator and the star it builds
src/lake/         generation 1 (raw Parquet) and generation 2 (DuckLake)
src/browser/      lanes D and E, plus the Arrow conversion they needed
sql/              schema and tuning, in each dialect
app/              the page
docs/results.md   every measurement, and what it means
docs/concepts.md  each concept, and the number that demonstrated it
bench/results/    committed benchmark records, one per run per machine
```

The query catalogue is TypeScript rather than `.sql` files for one reason that
overrides the rest: lanes D and E run in a browser tab, and a catalogue only the server
can read is not a shared catalogue.

---

## Not done here

Deployment. Everything runs locally against Docker; there is no cloud account
anywhere in this repository. The pieces that make hosting straightforward are in place
and verified - DuckLake stores its data-file paths relative to `DATA_PATH`, so the same
catalog serves a local directory or an HTTPS base with one connection-string change,
and `pnpm slice` already writes the browser's download into `public/`.
