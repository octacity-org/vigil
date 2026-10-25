# Storage schema

Bitemporal DuckDB schema for parsed KAP facts. Code: [`src/vigil/schema.py`](../src/vigil/schema.py). Loader: [`src/vigil/db.py`](../src/vigil/db.py). Decision: [0002](decisions/0002-bitemporal-schema.md).

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
| `raw_value` | BIGINT | Cell `title` value |
| `scale_unit`, `scale_multiplier` | VARCHAR, BIGINT | Unit of `raw_value` |
| `normalized_value_tl` | HUGEINT | `raw_value × scale_multiplier` |

Primary key: `(disclosure_id, row_id, column_class)`, i.e. one value per cell. Every value traces back to its file, report, statement, row and column.

The links marked → are not declared as foreign keys. DuckDB checks foreign keys against the state before the transaction, so replacing a report (delete its facts, then the report) would fail. Whatever writes the tables keeps the links consistent by always replacing a report and its facts together.

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
| `version_no`, `version_count` | This report's place among the reports that carry the fact, and how many there are |

`fact_conflicts` has the fact identity, `disclosure_id`, and the lists `column_classes` and `raw_values`.

Versions are ordered by report period (`year`, `quarter`), then `disclosure_id`. "Latest" therefore means "from the most recent report period", not "most recently published": a correction to 2025/2 published in 2026 still ranks below the 2026/2 report. Within one report period the order assumes that KAP disclosure ids grow over time, so a corrected filing would count as the later version (2025/2 and 2026/2 have no second filing for the same company and consolidation). A version is a report, not a column: if one report carries the same fact in two columns (for example, a Q1 report whose cumulative and 3-month columns cover the same three months), both rows have the same `version_no`. If their values differ they appear in `fact_conflicts` and both stay in `facts_latest`; Vigil does not pick one.

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
- **Correctness beyond the parser.** The database stores what the parser produces. Until the column-shift bug (#14) is fixed, about 1% of values sit in the wrong column. Matching row counts prove the load is complete, not that the values are right; that is what the golden dataset checks.

## Loading

```bash
python -m vigil.db data/raw/2026_2 data/vigil.duckdb
```

Each report is deleted and rewritten in one transaction, so re-running never duplicates rows. The command exits with an error when a file fails to load, when a report's row count differs from the parse report, or when a file that failed this time still has rows from an earlier load (stale report), or when a report of the same year and quarter is in the database but its file is no longer in the directory (missing file). Stale and missing reports are listed, not deleted.

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
