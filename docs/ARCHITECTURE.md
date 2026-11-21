# Architecture

How Vigil is built for its first release. The reasoning is in decisions [0008](decisions/0008-local-first-release.md) (local release), [0009](decisions/0009-zova-and-duckdb.md) (Zova and DuckDB) and [0010](decisions/0010-typescript-and-bun.md) (TypeScript on Bun). Data rules are in [`kap.md`](kap.md), the schema in [`SCHEMA.md`](SCHEMA.md).

> **Status:** the TypeScript port (0010) is done: `packages/core` and `apps/server` replace the Python code, with identical results on 2026/1–2026/3. Zova, the collector, the API and the frontend are still to be built.

## Overview

Vigil runs on the user's own computer with Docker. Nothing is published to the internet.

```
User's computer (Docker Compose, bound to 127.0.0.1)
┌──────────────────────────────────────────────────────────────┐
│ server — one Bun process (Hono)                              │
│                                                              │
│   collector ──► processor ──────────────► API                │
│   KAP list,     parse → check →           /v1/...            │
│   downloads     metrics → findings                           │
│        │             │        │             │                │
│        ▼             ▼        ▼             ▼                │
│   ┌──────────────┐        ┌──────────────────────────┐       │
│   │ Zova         │ ─────► │ DuckDB                   │       │
│   │ source of    │ rebuild│ derived: facts, versions,│       │
│   │ truth        │        │ checks, metrics, findings│       │
│   └──────────────┘        └──────────────────────────┘       │
├──────────────────────────────────────────────────────────────┤
│ web — Next.js  →  http://localhost                           │
└──────────────────────────────────────────────────────────────┘
          ▲
          │ HTTPS, one request at a time
     kap.org.tr
```

## Repository layout

```
apps/server      Hono app: collector, processor and API in one Bun process
apps/web         Next.js frontend
packages/core    parser, checks, quality report, metrics, findings; no I/O
tests/golden     golden dataset (CSV, unchanged)
tests/raw_files.txt   raw files the tests need (decision 0007)
docs/            documentation and decision records
docker-compose.yml
```

`packages/core` takes raw file contents and returns typed results. It does no network or database access, so it can be tested on its own and reused by later tools.

## Components

### Collector

Finds and downloads new financial reports.

1. Every few minutes, while the app runs, it asks the disclosure list (`POST disclosure/list/main`, `docs/kap.md`) for new disclosures of class `FR` since the last check.
2. For each new `Finansal Rapor`, it downloads that company's file (`home-financial/download-file/{company}/{year}/{period}`, about 1 MB). The zip holds the statement file and the footnote PDFs.
3. It stores the raw files in Zova as objects, records the download, and emits a "report downloaded" event.
4. After a reporting period, it compares the quarter's bulk zip (`financialTable/download/{year}/{quarter}`) with what it has, to catch anything missed.

Step 1 is [`poller.ts`](../apps/server/src/poller.ts) (#201): every five minutes after the previous poll ended, it asks for class `FR` from the day before the last covered day to today (Istanbul), records each new `Finansal Rapor` once in Zova's `seen_disclosures`, and moves the covered day forward in the same transaction. A failed poll is reported and the next one runs as usual.

Steps 2 and 3 are [`report-downloads.ts`](../apps/server/src/report-downloads.ts) (#203). After each poll, each pending disclosure is resolved to its company and period (#202) and its company's zip downloaded. The statement file goes into Zova with one `report_stored` event, the PDFs as attachments.
- A disclosure is closed only when its own file is in Zova. Other pending disclosures in the same zip are closed with it.
- When KAP offers only a later correction, the disclosure is closed as superseded.
- A failed download keeps its error and is tried again after 10 minutes, doubling up to a day. It is never dropped.

Rules built into the code and not configurable:
- one request at a time, with a wait between requests;
- retries with backoff (#38);
- a file is downloaded only once;
- the disclosure-list range is at most 90 days per request (#40).

### Processor

Turns a raw file into checked data. It runs when the collector emits an event, and on demand to rebuild DuckDB.

1. **Parse** (`packages/core`):
   - six template families;
   - the value is the number shown in each cell (decision 0005);
   - scale, period dates, 3-month and cumulative columns, publication time;
   - unknown formats raise an error; nothing is guessed.
2. **Check:**
   - reconciliation and the subtotal formulas;
   - single-value tolerance 5 units, subtotals one unit per component (decisions 0003, 0006);
   - known filing errors are listed with their reason.
3. **Load into DuckDB:** replace the report as a whole, then refresh its metrics and findings.

A report that fails a blocking check is stored with its check results but produces no findings.

Steps 1 and 2 are [`processor.ts`](../apps/server/src/processor.ts) (#207): for each pending `report_stored` event, a job on the write queue reads the latest version of the disclosure from Zova, parses and checks it, and records `report_processed` or `report_failed` with `finish`. Step 3 (#208) is its `handle` callback `loadInto(db)`, so the load and `finish` run in the same job: the report, its facts and its check results replace the disclosure's rows in one DuckDB transaction, and a load that throws leaves the event pending. `bun run process` runs it over every pending event. The processor always takes the latest version of a disclosure; if that version fails, the rows of an older version are removed from DuckDB (they are no longer the disclosure's numbers, and `report_failed` says why).

### Storage

| | Zova (source of truth) | DuckDB (derived) |
|---|---|---|
| Holds | raw KAP files and footnote PDFs; seen disclosures, downloads, errors; app events; local settings and watchlist | companies, reports, facts; version views; CPI series; check results; metrics; findings |
| Rebuilt from | KAP (only if lost) | Zova; the CPI series from `apps/server/reference/cpi-tr.csv` (#47) |

- Every report is keyed by disclosure id and a hash of its raw file.
- A raw file is always written to Zova first. DuckDB can be deleted and rebuilt from Zova at any time, for example after a parser change.
- The server reaches Zova only through `apps/server/src/zova.ts` (#175), using `zova-js`. The file is `vigil.zova` in the data folder; a lock file next to it stops a second Vigil process from opening the same folder. Object ids are the SHA-256 of the content, so the same file is stored once.
- On open, a store file in an older Zova format is upgraded (#181): Zova copies it forward into a new file, Vigil reads back every raw file's object and compares its SHA-256 and size, and only then replaces the old file, which is kept next to it as `vigil.zova.format-{N}.bak`. If the upgrade fails, the file is left unchanged and Vigil does not start; a format too old to migrate, or one from a newer Vigil, is refused with what to do.
- Zova tables are versioned like DuckDB's (`apps/server/src/store-schema.ts`). The first is `events` (#179): the collector (and `bun run import`, #180) adds `report_stored`; the processor reads pending events oldest first and calls `finish`, which marks the event handled and records `report_processed` or `report_failed` (with the reason) in one Zova transaction. Delivery is at least once, so processing must be idempotent.
- The bitemporal schema (decision 0002, `SCHEMA.md`) stays in DuckDB. Versions are ordered by report period, then publication time, then disclosure id (#157).
- DuckDB has one writer. Every write (collector, processor, settings) runs as a job on the write queue in `apps/server/src/queue.ts` (#197), one at a time, in order; a failed job does not stop the queue. Reads do not wait for it.

### API

Hono, under `/v1`, read-only. The contract is [`API.md`](API.md) (#161); its principles:

- **Every number comes with its source:** source system, document id (the KAP disclosure index), table, row, column, period label, and a link to the disclosure.
- **Every number has a status:** `ok`, `not_reported` (the company left it empty) or `not_computable` (with the reason and the data that would be needed). A missing value is never shown as 0.
- **Periods are explicit:** start, end and type (point in time, cumulative, 3-month).
- **Versions are selectable:** latest (default), first reported, or a given report.
- **Findings, not signals:** the public resource is `findings`; rule codes S1–S3 stay internal (`legal.md`).
- **Market-neutral names**, so that a second source (US filings, Phase 5) fits without renaming.
- Room for a tier field and authentication, unused in this release.

### Frontend

Next.js, served locally. Screens:
- finding list;
- company page, with 3-month and cumulative clearly separated, quality status and version history;
- finding card: a user can recompute the finding from the card alone (#83);
- methodology page;
- first-run setup: which quarters to download, progress, disk use.

Wording follows `legal.md`: "bulgu" and "değişim" in Turkish, no directive language, no prices, no personal recommendations.

## Numbers

Raw and TL values are integers and are held as `bigint`. Ratios are computed with a decimal library and rounded only for display. A JavaScript `number` cannot hold integers above 2^53 exactly, and the checks work to one unit of the reporting unit.

## Running it

- `bun run start [data_dir]` is the server process (#168, [`server.ts`](../apps/server/src/server.ts)): it reads the settings file, opens Zova and DuckDB (running their migrations), then starts the processor, the collector (poller with downloads, reconciler) and the API on `127.0.0.1:8787` (`VIGIL_PORT`). `/v1/ready` answers 200 once start-up has finished. The processor runs at start, after each collector run that stored files, and every minute. Logs are JSON lines.
- SIGINT or SIGTERM stops it gracefully (#198): the collector finishes its run, the write queue finishes the jobs it has and takes no new ones, then DuckDB and Zova are closed. After 30 seconds it exits anyway; each DuckDB write is one transaction, so a cut-off write leaves the database as it was.
- `docker compose up` starts `server` and `web`; data lives in one Docker volume (the Zova file and the DuckDB file).
- Images are published to GitHub Container Registry; users do not build them.
- A launcher script and an install guide cover Docker Desktop for users who are not developers.
- On upgrade, Zova's file format is migrated explicitly, keeping the old file until the new one is validated (0009).

## Testing

- Unit tests in `packages/core` with synthetic fixtures.
- API tests with [`apps/server/test/api-harness.ts`](../apps/server/test/api-harness.ts) (#229): the Hono app on the fixture filings and an in-memory DuckDB (check results, CPI, metrics and findings loaded as in a rebuild), requests sent in process without a port. `api-harness.test.ts` has example tests to copy, with a snapshot.
- Golden tests on the raw files listed in `tests/raw_files.txt`, downloaded in CI (decision 0007).
- The port was checked against the Python implementation's recorded output (0010): every parsed value, check result, quality row and finding of the 1,577 files of 2026/1–2026/3, and every row of the database views for 2026/1–2, were identical.

## Later, not in this release

- **Hosted service:** the same code with a multi-user design for Zova and DuckDB, accounts and tiers.
- **US filings:** SEC EDGAR as a second source.
- **Footnote extraction from PDFs.**

These stay in TypeScript too; nothing in the project is written in Python (0010).
