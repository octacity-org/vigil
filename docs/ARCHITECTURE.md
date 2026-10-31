# Architecture

How Vigil is built for its first release. The reasoning is in decisions [0008](decisions/0008-local-first-release.md) (local release), [0009](decisions/0009-zova-and-duckdb.md) (Zova and DuckDB) and [0010](decisions/0010-typescript-and-bun.md) (TypeScript on Bun). Data rules are in [`kap.md`](kap.md), the schema in [`SCHEMA.md`](SCHEMA.md).

> **Status:** target architecture. The code is still Python (`src/vigil/`) until the TypeScript port is merged (0010).

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

### Storage

| | Zova (source of truth) | DuckDB (derived) |
|---|---|---|
| Holds | raw KAP files and footnote PDFs; seen disclosures, downloads, errors; app events; local settings and watchlist | companies, reports, facts; version views; check results; metrics; findings |
| Rebuilt from | KAP (only if lost) | Zova |

- Every report is keyed by disclosure id and a hash of its raw file.
- A raw file is always written to Zova first. DuckDB can be deleted and rebuilt from Zova at any time, for example after a parser change.
- The bitemporal schema (decision 0002, `SCHEMA.md`) stays in DuckDB. Versions are ordered by report period, then publication time, then disclosure id (#157).

### API

Hono, under `/v1`, read-only. The API contract is described in a separate document; its principles:

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

- `docker compose up` starts `server` and `web`; data lives in one Docker volume (the Zova file and the DuckDB file).
- Images are published to GitHub Container Registry; users do not build them.
- A launcher script and an install guide cover Docker Desktop for users who are not developers.
- On upgrade, Zova's file format is migrated explicitly, keeping the old file until the new one is validated (0009).

## Testing

- Unit tests in `packages/core` with synthetic fixtures.
- Golden tests on the raw files listed in `tests/raw_files.txt`, downloaded in CI (decision 0007).
- During the port: every value of all 1,450 reports of 2026/1–2 must equal the Python reference output, and the quality report must be the same (0010).

## Later, not in this release

- **Hosted service:** the same code with a multi-user design for Zova and DuckDB, accounts and tiers.
- **US filings:** SEC EDGAR as a second source.
- **Footnote extraction from PDFs.**

US XBRL and PDF work may use separate Python tools, because the best libraries are there.
