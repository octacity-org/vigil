# 0002. Bitemporal storage schema

- **Status:** proposed
- **Date:** 2026-10-24
- **Decided by:** pending review
- **Discussion:** #45, #46

## Context

Under IAS 29 (TMS 29) every report restates its comparative columns in its own balance sheet date's purchasing power. The same fact (company, item, period) therefore has several values: as first reported, and restated in each later report. Phase 1 stores every quarter since year-end 2023, so the archive must keep all of these values and tell them apart. Some companies use special fiscal periods (`MAVI` 2026/2 covers `01.02.2026 - 31.07.2026`), so the quarter number does not tell which period a value describes.

## Options considered

1. **Latest value only** — overwrite a fact when a later report restates it. Simple, but loses the as-reported value, so what a company first reported and how it was later restated can no longer be shown side by side.
2. **Separate tables per version** (`facts_as_reported`, `facts_restated`) — explicit, but a fact can be restated more than once, and every query has to union the tables.
3. **One row per value per report (bitemporal)** — `facts` keeps every cell of every report; knowledge time comes from the report, valid time from the column header dates; versions are derived in views.

## Decision

Option 3, as implemented in `src/vigil/schema.py` and documented in [`docs/SCHEMA.md`](../SCHEMA.md):

- Tables `companies`, `reports` (one per disclosure) and `facts` (one per value cell, key `(disclosure_id, row_id, column_class)`).
- Valid time is `period_start` / `period_end`, parsed from the column header dates. Point-in-time values have `period_start` NULL. Headers without dates give NULL and are not matched across reports.
- A fact is identified by `(company_code, consolidation_type, row_id, currency_part, period_start, period_end)`.
- Versions are ordered by report `year`, `quarter`, then `disclosure_id`. Views: `fact_versions`, `facts_first_reported`, `facts_latest`, `fact_conflicts`.
- When one report has two different values for the same fact, both are kept and listed in `fact_conflicts`; none is chosen.
- Loading replaces a report as a whole (idempotent). `reports → companies` and `facts → reports` are not declared as foreign keys, because DuckDB rejects deleting a report and its facts in one transaction; the loader keeps them consistent.

## Reasoning

Keeping every cell as written keeps every number traceable to its file, row and column, and loses nothing. Deriving versions in views means the ordering rule can change without reloading data. Using header dates instead of quarter numbers handles special fiscal periods without guessing.

## Consequences

- `docs/SCHEMA.md` holds the example queries.
- `row_id` contains the template family and role code. If a company switches role code between quarters (MSY's solo income statement is `310016` in 2025/2 and `310017` in 2026/2; the general template's income statement is `310003`, `310000` or `310002` depending on the report), or KAP renumbers a template, the same item gets a different `row_id` and its versions are not linked. The template row map (Phase 0) is needed to link them.
- "Latest" means the most recent report period, not the most recent publication. Within one period, ordering by `disclosure_id` assumes KAP ids grow over time. Revisit if a publication timestamp becomes available.
- This was written before a Discussion; it needs review by the methodology and data owners before it is accepted.
- Revisit when moving from DuckDB to PostgreSQL.
