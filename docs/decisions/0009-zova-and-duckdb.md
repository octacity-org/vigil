# 0009. Zova for raw data and state, DuckDB for analysis

- **Status:** accepted
- **Date:** 2026-10-31
- **Decided by:** @BerkeDurdu
- **Discussion:** to be linked

## Context

Decision 0002 put the bitemporal schema in DuckDB and planned a move to PostgreSQL. With a local application (decision 0008) there is no database server to run, and the app needs to keep two different kinds of data:

- **Raw material and app state:** KAP files and footnote PDFs exactly as downloaded, which disclosures were seen and downloaded, events such as "a new report arrived", and local settings.
- **Analysis:** parsed values, version views, check results, metrics and findings. These are wide analytical queries over hundreds of thousands of rows; the current DuckDB views already do this.

[Zova](https://github.com/ata-sesli/zova) is an embedded, SQLite-based database with content-addressed object storage, app events, backup and salvage. It is developed by a member of the team (@ata-sesli). It has a JavaScript package (`zova-js`) for Node and Bun.

## Options considered

1. **PostgreSQL** as planned. A server process for a single-user local app; no object storage.
2. **DuckDB only.** Good for analysis; raw files would stay as loose files on disk with no events or integrity tracking.
3. **Zova only.** One file and one engine; analytical queries over SQLite may be slower than DuckDB, and the version views would need rewriting.
4. **Zova and DuckDB together**, each for what it does best.

## Decision

Option 4.

- **Zova is the source of truth.** It holds the raw KAP files and footnote PDFs as objects, the collector's state (seen disclosures, downloads, errors), app events and local settings. Later it can hold footnote vectors for search (Phase 5).
- **DuckDB is derived.** It holds companies, reports, facts, version views, check results, metrics and findings, and can be rebuilt completely from the raw files in Zova.
- Every report is tracked by its disclosure id and a hash of its raw file. The same file is never processed twice; a changed file is processed as a new version.
- A raw file is written to Zova before anything is written to DuckDB. There is no transaction across the two; if processing stops halfway, the report is processed again from Zova (the loader already replaces a report as a whole).
- PostgreSQL is dropped for this release.

## Consequences

- No database server in the Docker setup.
- A parser change (as in decision 0005) can be applied to all data by rebuilding DuckDB from Zova, without downloading from KAP again.
- DuckDB allows one writing process per file; the server is a single process (decision 0010), so the collector, processor and API share one connection.
- Zova's file format versions need explicit migration between releases; the app runs it on upgrade and keeps the old file until the new one is validated.
- A hosted multi-user service later will need its own design for both stores.
- Updates decision 0002: the bitemporal schema stays, in DuckDB; the planned move to PostgreSQL is dropped.
