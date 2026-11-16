# Storage schema

Bitemporal DuckDB schema for parsed KAP facts. Code: [`apps/server/src/schema.ts`](../apps/server/src/schema.ts). Loader: [`apps/server/src/db.ts`](../apps/server/src/db.ts). Decision: [0002](decisions/0002-bitemporal-schema.md).

## Why bitemporal

Under IAS 29 (TMS 29) every report restates its comparative columns in the purchasing power of its own balance sheet date. The same fact (company, item, period) therefore exists more than once: **as first reported** and **restated in each later report** (see [`DATA_CONTRACT.md`](DATA_CONTRACT.md), section 5.1). Nothing is overwritten. Every value from every report is a row, and the two time axes are kept apart:

| Axis | Meaning | Columns |
|---|---|---|
| Knowledge time | Which report the value comes from | `reports.year`, `reports.quarter`, `reports.disclosure_id` |
| Valid time | Which period the value describes | `facts.period_start`, `facts.period_end` |

Valid time is read from the dates in the column header, never derived from the quarter number, because some companies use special fiscal periods (for example `MAVI`: `01.02.2026 - 31.07.2026` in `2026_2`). A balance sheet value is a point in time, so its `period_start` is NULL. A header without dates gives NULL for both; such facts stay in `facts` but cannot be matched across reports.

## Tables

### `companies`

| Column | Type | Meaning |
|---|---|---|
| `company_code` | VARCHAR, PK | Primary ticker from the raw file name |
| `mkk_member_oid` | VARCHAR | KAP member id, from the disclosure list entry of the company's latest report (#189) |
| `stock_codes` | VARCHAR[] | All codes, from the same entry, e.g. `[A1CAP, ACP]` |
| `title` | VARCHAR | Company title, from the same entry |
| `template_family` | VARCHAR | Template family of the latest report |
| `main_sector_no`, `main_sector_name`, `sector_no`, `sector_name` | VARCHAR | KAP sector classification (#295), matched by `mkk_member_oid`, never by ticker; NULL for companies KAP does not classify |
| `sectors_read_at` | TIMESTAMP | UTC time of the sector reading used |
| `search_key` | VARCHAR | Codes and title lower-cased the Turkish way, without Turkish letters or accents (`ışık`, `IŞIK` and `isik` all give `isik`); search with `turkishSearchKey(query)` as a substring |

`bun run companies [data_dir] [db_path]` fills these from KAP's disclosure list for the days the latest reports were published and the archive's sector classification (`companies.ts`). A company whose latest report is not in the list keeps what it had, and the command exits 1. On 2026/2 (246 companies) every company got its member id; 24 are not on KAP's sector page (companies without listed shares, such as debt issuers and some brokers and banks).

### `reports` — one row per KAP disclosure (one raw file)

| Column | Type | Meaning |
|---|---|---|
| `disclosure_id` | BIGINT, PK | KAP disclosure id from the raw file name |
| `company_code` | VARCHAR → `companies` | |
| `raw_ticker_group` | VARCHAR | Full ticker group, e.g. `A1CAP-ACP` |
| `year`, `quarter` | INTEGER | Report period from the file name (knowledge time) |
| `consolidation_type` | VARCHAR | `Finansal Tablo Niteliği` as written |
| `template_family` | VARCHAR | `general`, `banks`, `finance`, `holding`, `insurance` |
| `scale_unit`, `scale_multiplier` | VARCHAR, BIGINT | `Sunum Para Birimi` and its multiplier |
| `has_tms29_monetary_item` | BOOLEAN | A net monetary position row exists |
| `filepath` | VARCHAR | Raw file the report was parsed from |
| `fact_count` | INTEGER | Facts written; must equal the parse report |
| `loaded_at` | TIMESTAMP | Last load |
| `published_at` | TIMESTAMP | `Gönderim Tarihi` from the file header: when KAP published the report, Istanbul time (#157). Added to older databases on connect |

### `facts` — one row per value cell

| Column | Type | Meaning |
|---|---|---|
| `disclosure_id` | BIGINT → `reports` | Report id |
| `row_id` | VARCHAR | Item: `{family}_role_{code}-row-{n}`. Row numbers alone mean different items in different templates |
| `column_class` | VARCHAR | Source column, `col-order-class-N` |
| `role_code`, `statement_type` | VARCHAR | Statement table and its type |
| `label_tr`, `footnote_ref` | VARCHAR | Row title and footnote number as written |
| `period_type` | VARCHAR | `POINT_IN_TIME`, `YTD_CUMULATIVE`, `Q_STANDALONE`; bank TP/YP columns end in `_TP` / `_YP`; `UNKNOWN` for a column the parser has no header for |
| `period_label` | VARCHAR | Column header as written |
| `period_start`, `period_end` | DATE | Valid time from the header dates |
| `is_comparative` | BOOLEAN | Comparative (prior period) column |
| `raw_value` | BIGINT | Number shown in the cell, unscaled (decision 0005) |
| `scale_unit`, `scale_multiplier` | VARCHAR, BIGINT | Unit of `raw_value` |
| `normalized_value_tl` | HUGEINT | `raw_value × scale_multiplier` |

Primary key: `(disclosure_id, row_id, column_class)`, i.e. one value per cell. Every value traces back to its file, report, statement, row and column.

The links marked → are not declared as foreign keys. DuckDB checks foreign keys against the state before the transaction, so replacing a report (delete its facts, then the report) would fail. Whatever writes the tables keeps the links consistent by always replacing a report, its facts and its check results together.

### `check_results` — one row per consistency check of a report (#183)

The checks of `packages/core` (`checks.ts`; decisions 0003 and 0006): reconciliation across statements and the subtotals of the income statement, balance sheet and cash flow statement. The same results that `bun run quality` counts, from the same function (`checkFiling`).

| Column | Type | Meaning |
|---|---|---|
| `disclosure_id` | BIGINT → `reports` | Report id |
| `position` | INTEGER | Order the checks ran in, from 0 |
| `check_group` | VARCHAR | `reconciliation`, `income_statement`, `balance_sheet`, `cash_flow` |
| `name` | VARCHAR | Check name, e.g. `total_assets_equal_liabilities_and_equity_current` |
| `severity` | VARCHAR | `blocking`, or `informational` (a difference that does not block the report) |
| `status` | VARCHAR | `pass`, `fail`, `not_checked` |
| `left_value`, `right_value` | BIGINT | Compared values, raw, in the report's reporting unit (× `reports.scale_multiplier` gives TL) |
| `left_source` | VARCHAR | `row_id column` of the left value |
| `right_source` | VARCHAR | `row_id column` of the right value; for a subtotal, the row ids of the components that have a value (same column as the left; `tolerance` counts every component of the formula) |
| `tolerance` | BIGINT | Largest difference accepted as a pass, in reporting units: 5 for two single values, one per formula component for a subtotal (decision 0006); NULL when not checked |
| `reason` | VARCHAR | Why a check is `not_checked` |
| `known_error` | VARCHAR | For a blocking failure confirmed as an error in the filing (`known-errors.ts`), the reason; the status stays `fail` and the report stays blocked |

Primary key: `(disclosure_id, position)`. A check name is not unique within a report: a subtotal check has one row per column, and the column is in `left_source` (for checked and not checked rows alike). `position` follows the order the checks run in, so it changes when checks are added or reordered; it is not a stable check id.

- The rows are replaced together with the report, in the same transaction, so reloading never duplicates them.
- A report with no values has no rows, as in `bun run quality`. A file that fails to parse has no report and no rows.
- A report with values but no check rows has not been checked (for example after the upgrade to version 4): treat it as blocked until it is loaded again.
- The rows are what the code produced when the report was loaded. After a change to the checks (`checks.ts`, `formulas.ts`), to `known-errors.ts` or to the parser, reload the reports.

### `metrics` — one row per metric of a report and period (#184)

A metric is a value or the reason it cannot be computed (#65), so the UI can show "not computable" and what would be needed. Written by `writeMetrics` ([`metrics-store.ts`](../apps/server/src/metrics-store.ts)); computing them for a report is #209.

| Column | Type | Meaning |
|---|---|---|
| `disclosure_id` | BIGINT → `reports` | Report the metric belongs to |
| `company_code` | VARCHAR → `companies` | |
| `metric_code` | VARCHAR | Glossary code, e.g. `gross_margin` |
| `period_type` | VARCHAR | `point_in_time`, `cumulative`, `three_month`, `ttm` |
| `period_start`, `period_end` | DATE | What the value describes; `period_start` is NULL for a point in time |
| `status` | VARCHAR | `ok`, `not_reported` (the company left the cell empty), `not_computable` |
| `value` | VARCHAR | Exact decimal text, as in the API: whole TL as digits, a ratio as the shortest text that reads back the same; NULL unless `ok` |
| `unit` | VARCHAR | `TRY`, `ratio`, `bps`, `days`, `count` |
| `reason_code`, `reason_message`, `needs` | VARCHAR, VARCHAR, VARCHAR[] | Only when `not_computable`: the code (`missing_input`, `zero_denominator`, …), the Turkish message and the inputs that would make it computable (glossary codes) |
| `formula` | VARCHAR | e.g. `gross_profit / revenue` |
| `definition_version` | VARCHAR | Version of the metric definitions it was computed under (`2026-11-01` in this release) |
| `computed_at` | TIMESTAMP | UTC |

Primary key: `(disclosure_id, metric_code, period_type, period_end)`. Checks: a value exactly when `ok`, a reason exactly when `not_computable`.

**`metric_inputs`**: the inputs of each metric in formula order (`position` from 0): `input_code` (glossary), `status`, `value`, `unit`, and the cell it was read from: `source_disclosure_id`, `source_row_id`, `source_column_class`, which join `facts` for the label, period label and the value as filed (the source reference of #72). The source is NULL for an input that is another metric or a row the report does not have.

- A report's metrics and inputs are replaced as a whole, in one transaction.
- Loading the report again, or removing it, removes its metrics: they were computed from the old facts.

### `findings` — one row per rule, report and config version (#185)

The output of the rules (S1–S3, `packages/core/src/signals.ts`), named as in `docs/API.md`. Written by `writeFindings` ([`findings-store.ts`](../apps/server/src/findings-store.ts)); `bun run signals <raw_dir> --db <path>` stores a quarter's findings.

| Column | Type | Meaning |
|---|---|---|
| `id` | VARCHAR | API id, e.g. `2026-2-KATMR-gross_margin_change` |
| `rule` | VARCHAR | `gross_margin_change` (S1), `profit_cash_divergence` (S2), `restated_comparatives` (S3) |
| `company_code`, `disclosure_id`, `year`, `quarter` | | The report it was found in |
| `title` | VARCHAR | Neutral Turkish title |
| `size_value`, `size_unit` | VARCHAR | Size of the change, exact text: S1 in `bps`, S2 in `TRY` (profit minus operating cash flow), S3 as a `count` of restated balance sheet lines |
| `rank_score` | DOUBLE | What a list sorts by within a rule |
| `summary` | VARCHAR | JSON of the rule's summary numbers; amounts as text, exact |
| `formula` | VARCHAR | How the rule computed it |
| `config_version` | VARCHAR | `version` of the configuration file the rules ran with (`config/vigil.json`, #69) |
| `created_at` | TIMESTAMP | UTC, when the finding was first found under this config |
| `calculation_formula` | VARCHAR | The calculation's formula over step ids, as in the API; NULL for a finding stored before version 8 |
| `definition_id` | VARCHAR | The rule's methodology id (`/methodology/{id}`) |

Primary key: `(rule, disclosure_id, config_version)`.

- A run over a set of reports replaces their findings under its config version in one transaction: a finding found again keeps its `created_at`, one no longer found is removed, and findings of other reports or other config versions stay. A rerun never adds duplicates.
- Loading a report again, or removing it, removes its findings and their steps.
- On 2026/2 (246 files): 46 S1, 9 S2 and 2 S3 findings; KATMR's S1 is -2596 bps.

### `finding_steps` and `finding_inputs` — the calculation of each finding (#186)

Every step of a finding's calculation (`docs/API.md` "Calculation", #72), stored with the finding in the same transaction. A finding can be recomputed from these rows alone; the card reads them and never recomputes. `readCalculation` rebuilds the API shape from them.

`finding_steps`, one row per step:

| Column | Type | Meaning |
|---|---|---|
| `rule`, `disclosure_id`, `config_version` | | The finding |
| `position` | INTEGER | Order of the step, from 0 |
| `step_id` | VARCHAR | E.g. `revenue_q`, `margin_q`; unique within a finding |
| `label` | VARCHAR | Turkish, for the card |
| `formula` | VARCHAR | Over earlier step ids, e.g. `gross_profit_q / revenue_q`; NULL for a value read from a filing |
| `result` | VARCHAR | Exact text: the computed result as shown (margins to 6 decimals, bps whole), or the value read |

`finding_inputs`, one row per step read from a filing (same key and `position`): the value and its full source.

| Column | Type | Meaning |
|---|---|---|
| `value`, `unit` | VARCHAR | Whole TL after scaling, exact text; `TRY` |
| `period_start`, `period_end`, `period_type`, `period_label`, `currency_part` | | The period, as in the API (`point_in_time`, `cumulative`, `three_month`; `total`, `tp`, `yp`) |
| `source_system`, `document_id` | VARCHAR | `KAP` and the disclosure the value was read from |
| `company_code`, `report_year`, `report_quarter`, `consolidation` | | The report |
| `table_id`, `row_id`, `row_label`, `column_class` | VARCHAR | The cell; joins `facts` on (`document_id`, `row_id`, `column_class`) |
| `shown_value`, `scale` | VARCHAR | The cell text as filed and the reporting unit (decision 0005) |
| `published_at` | TIMESTAMP | UTC |
| `url` | VARCHAR | The disclosure on KAP |

- KATMR's S1 is 7 steps, 4 of them inputs: rows 5 and 3, columns 6 and 7 of `general_role_310003`. (189,492,068 / 879,599,263 − 330,145,727 / 694,991,758) × 10,000 = −2,596 bps.
- On 2026/2 the 57 findings have 507 steps and 349 inputs, and every one reads back equal to what the rule produced.


## Fact identity

One fact, across reports, is:

```
(company_code, consolidation_type, row_id, currency_part, period_start, period_end)
```

- `consolidation_type` is part of it: consolidated and solo reports are different facts.
- `currency_part` is `TP`, `YP` or `TOTAL`, from the end of `period_type` (bank balance sheets).
- `period_type` itself is not part of it: the dates already say whether a value is cumulative or 3-month.

`row_id` contains the template family and the table's role code. Versions of an item are linked only while both stay the same. In 2026/2 the general template's income statement comes as `310003` in 443 reports, `310000` in 210 and `310002` in 1. A company that switches role code, or a template that renumbers its rows, starts a new fact. This happens: MSY's solo income statement is `banks_role_310016` in 2025/2 and `banks_role_310017` in 2026/2, so its income statement items have no linked versions. Linking those needs the template row map (Phase 0); the schema does not guess.

## Views

| View | Rows |
|---|---|
| `fact_versions` | Every fact with valid-time dates, plus `version_no` (1 = first reported) and `version_count` |
| `facts_first_reported` | `version_no = 1`: each fact as first reported |
| `facts_latest` | `version_no = version_count`: each fact as in the latest report |
| `fact_conflicts` | Same fact, same report, different values in two columns |

Columns of `fact_versions` (and of `facts_first_reported` / `facts_latest`, which filter it):

| Column | Meaning |
|---|---|
| `company_code`, `consolidation_type`, `row_id`, `currency_part`, `period_start`, `period_end` | Fact identity (see above) |
| `label_tr`, `raw_value`, `scale_unit`, `normalized_value_tl` | The value as written in this report |
| `disclosure_id`, `column_class`, `period_label`, `is_comparative` | Where it comes from |
| `reported_year`, `reported_quarter`, `as_reported_in` | Report period, e.g. `as_reported_in = '2026_2'` |
| `published_at` | When the report was published |
| `version_no`, `version_count` | This report's place among the reports that carry the fact, and how many there are |

`fact_conflicts` has the fact identity, `disclosure_id`, and the lists `column_classes` and `raw_values`.

Versions are ordered by report period (`year`, `quarter`), then publication time (`published_at`), then `disclosure_id` (#157). "Latest" therefore means "from the most recent report period", not "most recently published": a correction to 2025/2 published in 2026 still ranks below the 2026/2 report. Within one report period the later publication is the later version; a report without a publication time ranks after those with one. On 2026/1–2 this gives the same order as `disclosure_id` alone, because each quarter's zip holds only the current version of a filing (`docs/kap.md`). A version is a report, not a column: if one report carries the same fact in two columns (for example, a Q1 report whose cumulative and 3-month columns cover the same three months), both rows have the same `version_no`. If their values differ they appear in `fact_conflicts` and both stay in `facts_latest`; Vigil does not pick one.

## Checked on real data (2025/2 + 2026/2)

Both quarters loaded into one database: 736 + 776 reports, 340,201 + 366,437 facts, row counts matching the parse report.

- KATMR consolidated revenue (`general_role_310003-row-3`), 01.01.2025 – 30.06.2025: version 1 is 1,085,459,841 TL (2025/2, `col-order-class-4`), version 2 is 1,434,008,001 TL (2026/2, `col-order-class-5`, restated). The 3-month figure for 01.04.2025 – 30.06.2025 goes from 526,067,945 to 694,991,758 TL.
- 81,277 facts have two versions (162,554 rows); `fact_conflicts` is empty. Between the first and the latest version, 61,152 changed value and 20,125 kept it (11,148 of those are 0).
- Of the 88,474 current-period income, comprehensive income and cash flow facts in 2025/2 (companies that also reported in 2026/2 with the same consolidation), 80,906 (91.4%) are linked to their 2026/2 version. None of the 7,568 unlinked ones has a 2026/2 fact with the same row and dates, so none is missed by the schema:
  - 776: the 2026/2 report has the row and a value ending on the same date, but for a different start (for example only the cumulative, not the 3-month value);
  - 1,318: the row is there but has no value ending on that date (empty cell, or moved by #14);
  - 5,474: the row is not in the 2026/2 report at all (2,960 of them were 0 in 2025/2).
- Balance sheet values at 30.06.2025 have no second version and will not get one from quarterly reports: later balance sheets are compared with the previous year end. Year-end balances are what get restated (31.12.2025 appears in 2025/4 and again in each 2026 report). The 235 balance sheet facts that do have two versions (5 companies) are at 31.12.2024: the 2025/2 comparative column (`col-order-class-5`) and the third balance sheet column (`col-order-class-6`, `Bir Önceki Dönem 31.12.2024`) of 2026/2 reports that restated their prior periods.

## What is not in the database

- **Statement of changes in equity.** The parser skips it in Phase 0 (two-dimensional equity columns), so it is not loaded.
- **Files that fail to parse.** They are listed by the loader with the reason. In both 2025/2 and 2026/2: the two `ALBRK-ALK` filings, which use a `par-banks` template the parser does not recognise.
- **Dates for columns the parser does not know.** 509 facts in 2026/2 (EXIMB, VDFAS) come from balance sheet columns `col-order-class-10` to `12`, which the parser has no header for. They are loaded with `period_type = 'UNKNOWN'` and no dates, so they stay out of the version views (last example query).
- **Correctness beyond the parser.** The database stores what the parser produces. The column-shift bug (#14) put about 1% of values in the wrong column; it is fixed, so databases loaded before the fix should be reloaded. The counts on this page were measured before the fix. Matching row counts prove the load is complete, not that the values are right; that is what the golden dataset checks.

## Loading

```bash
bun run load data/raw/2026_2 data/vigil.duckdb
```

Each report, its facts and its check results are deleted and rewritten in one transaction, so re-running never duplicates rows. The command exits with an error when a file fails to load, when a report's row count differs from the parse report, or when a file that failed this time still has rows from an earlier load (stale report), or when a report of the same year and quarter is in the database but its file is no longer in the directory (missing file). Stale and missing reports are listed, not deleted.

## Example queries

Each fact as in the latest report, for one company and statement:

```sql
SELECT row_id, label_tr, period_start, period_end, normalized_value_tl, as_reported_in
FROM facts_latest
WHERE company_code = 'KATMR' AND consolidation_type = 'Konsolide'
  AND row_id LIKE 'general_role_310003-row-%'
ORDER BY period_end, row_id;
```

Each fact as first reported:

```sql
SELECT row_id, label_tr, period_start, period_end, normalized_value_tl, as_reported_in
FROM facts_first_reported
WHERE company_code = 'KATMR' AND consolidation_type = 'Konsolide'
  AND row_id = 'general_role_310003-row-3';
```

All versions of one fact (here: H1 2025 revenue, as reported in 2025/2 and restated in 2026/2):

```sql
SELECT version_no, as_reported_in, disclosure_id, column_class, raw_value, scale_unit, normalized_value_tl
FROM fact_versions
WHERE company_code = 'KATMR' AND consolidation_type = 'Konsolide'
  AND row_id = 'general_role_310003-row-3' AND currency_part = 'TOTAL'
  AND period_start = DATE '2025-01-01' AND period_end = DATE '2025-06-30'
ORDER BY version_no;
```

Facts that were restated, with the first and latest value side by side:

```sql
SELECT f.company_code, f.row_id, f.period_start, f.period_end,
       f.normalized_value_tl AS first_reported_tl, f.as_reported_in AS first_in,
       l.normalized_value_tl AS latest_tl,         l.as_reported_in AS latest_in
FROM facts_first_reported f
JOIN facts_latest l
  ON  l.company_code = f.company_code
  AND l.consolidation_type = f.consolidation_type
  AND l.row_id = f.row_id
  AND l.currency_part = f.currency_part
  AND l.period_start IS NOT DISTINCT FROM f.period_start
  AND l.period_end = f.period_end
WHERE f.version_count > 1;
```

Join on the fact identity with `IS NOT DISTINCT FROM` for `period_start`: it is NULL for balance sheet values, and `USING` or `=` never matches NULL, so those facts would silently drop out.

The restated value is in a different purchasing power from the first one. Comparing them is a statement about restatement, not about growth; across reports use the CPI (TÜFE) series (financial rule 1).

Facts that could not be placed in time (no dates in the column header):

```sql
SELECT r.company_code, f.disclosure_id, f.row_id, f.column_class, f.period_label
FROM facts f JOIN reports r USING (disclosure_id)
WHERE f.period_end IS NULL;
```

The `bun run quality` counts of one report, from `check_results` (here KATMR 2026/2: 141 passed, 0 failed, 12 not checked):

```sql
SELECT count(*) FILTER (severity = 'blocking' AND status = 'pass')                          AS passed,
       count(*) FILTER (severity = 'blocking' AND status = 'fail' AND known_error IS NULL)  AS failed,
       count(*) FILTER (status = 'not_checked')                                             AS not_checked,
       count(*) FILTER (severity = 'informational' AND status = 'fail')                     AS informational_differences,
       count(*) FILTER (known_error IS NOT NULL)                                            AS known_errors
FROM check_results
WHERE disclosure_id = 1651411;
```

Reports blocked from findings (any blocking failure, known errors included):

```sql
SELECT DISTINCT r.company_code, r.disclosure_id
FROM check_results c JOIN reports r USING (disclosure_id)
WHERE c.severity = 'blocking' AND c.status = 'fail';
```

## Schema versions

`connect()` brings every database to the current schema on start (#182). The steps are `MIGRATIONS` in [`schema.ts`](../apps/server/src/schema.ts); the runner is [`migrate.ts`](../apps/server/src/migrate.ts).

- `schema_version` lists the applied steps (`version`, `name`, `applied_at`). A database made before versioning has no such table and starts at 0; the first steps use `IF NOT EXISTS`, so they are safe on it.
- Each step runs once, in its own transaction. If one fails, it is rolled back and the database stays at the previous version.
- Steps are append-only: a released step is never edited or reordered. A new column or table is a new step.
- Views are not steps; they are recreated on every start.
- A database from a newer Vigil is refused.
- DuckDB is derived data (decision 0009). If a database cannot be migrated, delete it and load again from the raw files, then load the CPI series with `bun run cpi`. A new or upgraded database has an empty `cpi_monthly` until then.

| Version | Change |
|---|---|
| 1 | `companies`, `reports`, `facts` (#45) |
| 2 | `reports.published_at` (#157) |
| 3 | `cpi_monthly` (#188) |
| 4 | `check_results` (#183); a database upgraded to it has no check rows until its reports are loaded again |
| 5 | Company metadata columns on `companies` (#189) |
| 6 | `metrics`, `metric_inputs` (#184) |
| 7 | `findings` (#185) |
| 8 | `finding_steps`, `finding_inputs`, `findings.calculation_formula` and `definition_id` (#186); findings stored before it have no steps until the rules run again |

## CPI series

Amounts from two reports are in the prices of two different period ends (IAS 29). Before they are added or subtracted, the older one is multiplied by CPI(newer period end) / CPI(older period end) ([0014](decisions/0014-annualisation-and-averages.md)). A period that ends on the last day of a month uses that month's index.

**`cpi_monthly`** (#188): the monthly CPI (TÜFE) general index, one row per month.

| Column | Type | Meaning |
|---|---|---|
| `month` | DATE, PK | First day of the month |
| `index_value` | DECIMAL(18, 6) | The index as published (TÜİK gives the months before 2026 with up to six decimals) |
| `base` | VARCHAR | Base year, e.g. `2025=100` |
| `source` | VARCHAR | Publisher |
| `series_code` | VARCHAR | The publisher's id of the series |
| `retrieved_at` | TIMESTAMP | When the value was retrieved (UTC) |

- The table holds one series. `bun run cpi [series.csv] [db]` replaces it as a whole in one transaction, so values of two base years never mix and re-running changes nothing. Without arguments it loads the series that ships with Vigil into `data/vigil.duckdb`. Code: [`apps/server/src/cpi.ts`](../apps/server/src/cpi.ts).
- `retrieved_at` is UTC, like the Zova tables. The other DuckDB timestamps are not: `reports.loaded_at` and `schema_version.applied_at` are local time, `reports.published_at` is Istanbul time.
- The factor is computed in `packages/core` (`cpiFactor`, #47) as an exact fraction. A date that is not a month end, or a month missing from the series, gives "not computable" with the reason; nothing is estimated.
- To use the table, read `index_value` as text (`index_value::VARCHAR`) and build the series for `cpiFactor`. `@duckdb/node-api` returns a DECIMAL as a JavaScript number, and dividing in SQL gives a floating-point result; neither is exact. The text has six decimals (`140.770000` for the published `140.77`); the value is the same, and the file keeps the published text.

### The series file

The series ships with Vigil as [`apps/server/reference/cpi-tr.csv`](../apps/server/reference/cpi-tr.csv): TÜİK's monthly general index for Türkiye from TÜİK's dataset `DF_TUFE_SDMX_TT10` ("Tüketici fiyat endeksi ve değişim oranları"), one row per month with the index as published, its base year, the source, the dataset id and the retrieval time (UTC). A file with a bad value, a month listed twice or more than one base year is refused with the line number; nothing is loaded.

TÜİK rebased the CPI to 2025=100 from January 2026 and republished the earlier months in the new base (up to six decimals), keeping the headline changes. The file holds only the 2025=100 series, so a factor never mixes bases.

Maintainers refresh the file once a month, after TÜİK publishes the new month:

1. On [TÜİK's bulk download page](https://veriportali.tuik.gov.tr/tr/bulk-download), download `DF_TUFE_SDMX_TT10` as CSV.
2. `bun run cpi:import "<downloaded file>.csv"` updates `apps/server/reference/cpi-tr.csv` and prints the new and revised months. New or revised months get the retrieval time given with `--retrieved-at=…`, or else the downloaded file's modification time (UTC); unchanged months keep theirs, so a normal refresh adds one line.
3. Check the summary and the diff, then commit.

The import refuses an export that is not complete or not one chain:

- every month between the first and the last must have an index, with one base year, and no monthly change may come without its index;
- for every month after the first, the index must reproduce TÜİK's published monthly change to within 0.02 points. Both are rounded (the change to two decimals, the 2026 index values to two decimals). A mix of base years moves the change by far more; a small revision of one value can pass, and then shows among the revised months;
- it must have every month the current file has, so an export that lost months at either end is refused too. If TÜİK rebases the series again and the new export starts later, move the current file away and import into a new one.

A download cut inside the rows it reads, a missing month or a mix of base years stops it with the reason, and the file is not written. On the export of 2026-11-14 (2005-01 to 2026-10), all 261 monthly changes match, the largest gap being about 0.005 points (2012-04).

Check against the filings: CPI(June 2026) / CPI(December 2025) = 129.99 / 110.386963 = 1.177585, the 1.1776 that decision [0018](decisions/0018-profit-cash-divergence-trigger.md) measured from restated balance sheets.

Fetching the series automatically needs an account and a key at both TÜİK (SDMX service) and TCMB EVDS, so it is left for a later issue. Both allow reuse with the source named (`legal.md`).

## Raw archive (Zova)

The Zova store (`vigil.zova`, decision 0009) holds the raw files and app state. Its tables are versioned in [`store-schema.ts`](../apps/server/src/store-schema.ts) the same way as DuckDB's (`store_schema_version`).

**`raw_files`** (#176): one row per stored file. The bytes are a Zova object; `object_id` is the SHA-256 of the content (hex). Code: [`raw-files.ts`](../apps/server/src/raw-files.ts).

| Column | Meaning |
|---|---|
| `object_id` | Zova object id = SHA-256 of the bytes |
| `disclosure_id` | KAP disclosure number, from the file name |
| `company_code`, `raw_ticker_group` | First code and full ticker group (`A1CAP`, `A1CAP-ACP`) |
| `year`, `quarter` | Report period, from the file name |
| `file_name` | `{TICKER-GROUP}_{disclosure}_{year}_{quarter}.xls` |
| `size_bytes` | Size of the bytes |
| `downloaded_at` | When the bytes were downloaded (UTC) |
| `source_url` | The KAP URL, or `file://…` for an import |
| `stored_at` | When the row was written (UTC) |

Look-ups: by disclosure (oldest download first), by company, by quarter.

The same bytes for the same disclosure are stored once (#177): `storeRawFile` returns the existing record with `duplicate: true` and the caller emits no event. Different bytes for the same disclosure are a new version. The same bytes under another disclosure get their own row and share the object.

A new file and its `report_stored` event are written in one Zova transaction: `storeRawFile` takes an `onStored` callback that runs inside its transaction, because Zova has no nested transactions.

**Downloading** (#44): `bun run download <year> <quarter> [raw_dir] [data_dir]` stores every file it extracted, recovered ones from a cut-off download included, with `source: "download"` in the event's payload, the KAP bulk URL as `source_url` and the time of the download as `downloaded_at`. Files already in the folder from an earlier run are not part of it, and bytes stored before are skipped. `--files` (the test files) does not store anything.

**Importing `data/raw/`** (#180): `bun run import [raw_dir] [data_dir]` stores the `.xls` files of every `{year}_{quarter}` folder (or of one such folder) and emits `report_stored` for each new one, with `source: "import"` in the payload. Code: [`import.ts`](../apps/server/src/import.ts).

- `source_url` is the file's `file://` path.
- `downloaded_at` is when the quarter was downloaded, not the time of the import, because versions are ordered by it: the time given with `--downloaded-at` (only with one quarter folder), else the modification time of the quarter's zip next to the folder (`{year}_{quarter}.zip`, the name `bun run download` uses, or `kap_{year}_{quarter}.zip`, a name some earlier local downloads used), else of the oldest file in the folder. Which of these was used is in the event's payload (`downloaded_at_source`). A time in the future or before the quarter ended is refused: it would rank the files wrongly against other versions.
- An `.xls` file whose name is not a KAP file name, gives another quarter than its folder, or cannot be read is listed as failed and not stored; so is an entry named like a quarter that is not a readable folder. The others are still imported, and the command exits 1. Symbolic links are followed, as in `bun run load`. A file that is stored but does not parse is the processor's to report (`report_failed`).
- An error of the store itself (for example a full disk) stops the run. Every file stored before it, including those of the quarter in progress, is kept with its event and counted in the summary; running it again continues.
- Running it again skips every file already stored. If the app (or another import) holds the store, it stops with the lock message.

**`events`** (#179): `report_stored`, `report_processed`, `report_failed`; see `docs/ARCHITECTURE.md`.

**`raw_attachments`** (#164): the footnote PDFs of a company's zip, one row per company, period and content: `object_id` (SHA-256), `mkk_member_oid`, `year`, `quarter`, `path` inside the zip (`Dönem2Ekler/…pdf`), `size_bytes`, `downloaded_at`, `source_url`, `stored_at`. A zip can hold several statements (consolidated and solo), so the PDFs belong to the company's period, not to one disclosure.

**`quarter_downloads`** (#206): the quarters chosen for the first download (#165), one row per quarter: `status` (`pending`, `running`, `done`, `incomplete`: files lost or failed, `failed`: nothing came back), `requested_at`, `finished_at`, `attempts`, `files_stored` (new files over all attempts), `files_skipped`, `files_failed` and `files_lost` (of the last attempt) and `error`. `runQuarterDownloads` downloads every quarter that is not done, oldest first, with progress after each file; a restart continues with the quarter that was running, and files stored before the stop are skipped. Code: [`quarter-downloads.ts`](../apps/server/src/quarter-downloads.ts).

**Seen disclosures** (#201): `seen_disclosures` has one row per new `Finansal Rapor` disclosure the collector found in the disclosure list: its ids (`disclosure_id` = `disclosureIndex`, `disclosure_oid`), company (`mkk_member_oid`, `stock_codes` as JSON), period, publication time (Istanbul), correction fields, `seen_at`, and `handled_at` (NULL until its file is downloaded, #164/#203). From version 8 (#203) it also keeps the download state: `attempts`, `last_error`, `retry_after` (UTC; a failed download waits until then), and, once closed, `outcome` (`stored`, `duplicate`, `superseded`, `unresolved`) and the stored file's `object_id`. Code: [`report-downloads.ts`](../apps/server/src/report-downloads.ts). `collector_state` keeps `disclosures_covered_through`, the last day (Istanbul) a poll covered, so a restart continues from it. Code: [`poller.ts`](../apps/server/src/poller.ts).

**Sector classification** (#295): `sector_classifications` (one row per distinct classification: its SHA-256, the Zova object of the page it was first read from, the number of companies), `company_sectors` (per classification and `mkk_member_oid`: tickers and title as on the page, main sector and sub-sector number, name and oid; the sub-sector is NULL when the page gives none) and `sector_readings` (every reading: `read_at`, UTC, and its classification). The classification in use at a time is the latest reading at or before it. Code: [`sectors.ts`](../apps/server/src/sectors.ts).

**Processing into DuckDB** (#208): `bun run process [data_dir] [db_path]` handles every pending `report_stored` event: the latest version of the disclosure is parsed, checked and loaded with its check results in one DuckDB transaction (the same rows `bun run load` writes for that file; `reports.filepath` is the file name), then the event is finished. A report failing a blocking check is loaded too; its rows in `check_results` mark it as blocked. If the latest version fails, the disclosure's rows are removed. A load that throws leaves the event pending for the next run. The command exits 1 if a report failed or a job threw.

The processor (#207) records the outcome of a `report_stored` event with the same subject (the object id of the event's file). The payload names the file it processed: `disclosure_id`, `object_id`, `file_name`, `superseded` (true when the event's file was an older version and the latest one was processed instead), and `event`, the id of the `report_stored` event.

- `report_processed` adds `facts`, the check counts of `bun run quality` (`passed`, `failed`, `not_checked`, `informational_differences`, `known_errors`) and `blocked`: any blocking failure, known errors included. `blocked: false` does not mean verified: a report whose template the checks do not support yet has only `not_checked` results, and one without values has `facts: 0` and no checks.
- `report_failed` adds `reason`: the file cannot be parsed, has two values for one cell, cannot be checked, or is not stored under the event's disclosure (or the event has no valid disclosure id). When the failing file is the latest version and not the event's own file, the reason names it. A file that cannot be parsed or checked is not retried: with the same bytes and the same code it fails again. After a fix to the parser or the checks, the rebuild from Zova (#162) processes it again.
- A processing job that throws, such as a store or DuckDB error that may pass, leaves the event pending. Its `attempts` and `last_error` are counted on the event (store version 9, #211), and the next run tries it again.
- After `MAX_ATTEMPTS` (3) jobs the event is closed as `report_failed`, with `reason` "gave up after 3 attempts: …", `attempts` and `gave_up: true`, so it never blocks or loops.
- `failedReports(store)` lists the reports whose latest outcome is `report_failed`, newest first, for the quality page (#225). [`processor.ts`](../apps/server/src/processor.ts)

| Version | Change |
|---|---|
| 1 | `events` (#179) |
| 2 | `raw_files` (#176) |
| 3 | One row per disclosure and content: duplicates removed, unique index (#177) |
| 4 | `sector_classifications`, `company_sectors`, `sector_readings` (#295) |
| 5 | `seen_disclosures`, `collector_state` (#201) |
| 6 | `raw_attachments` (#164) |
| 7 | `quarter_downloads` (#206) |
| 8 | Download state on `seen_disclosures`: `attempts`, `last_error`, `retry_after`, `outcome`, `object_id` (#203) |
| 9 | `events.attempts`, `events.last_error`: processing jobs that threw (#211) |
