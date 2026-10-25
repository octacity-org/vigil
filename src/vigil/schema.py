"""Bitemporal storage schema for parsed KAP facts (issue #45, decision 0002, docs/SCHEMA.md).

Under IAS 29 (TMS 29) every report restates its comparative columns, so one fact exists more than once:
as first reported, and restated in each later report. Nothing is overwritten; every report's value is a row.

- knowledge time: the report a value comes from (`reports.year`, `reports.quarter`, `reports.disclosure_id`)
- valid time: the period the value describes (`facts.period_start`, `facts.period_end`), read from the
  column header dates. Balance sheet values are points in time: `period_start` is NULL.

One fact is identified by (company_code, consolidation_type, row_id, currency_part, period_start, period_end).
Facts whose header has no dates cannot be matched across reports and stay out of the version views.

The links reports -> companies and facts -> reports are not declared as foreign keys: DuckDB checks them
against the state before the transaction, so replacing a report (delete facts, delete report) fails.
"""

TABLES_SQL = """
CREATE TABLE IF NOT EXISTS companies (
    company_code            VARCHAR PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS reports (
    disclosure_id           BIGINT PRIMARY KEY,
    company_code            VARCHAR NOT NULL,  -- companies.company_code
    raw_ticker_group        VARCHAR NOT NULL,
    year                    INTEGER NOT NULL,
    quarter                 INTEGER NOT NULL,
    consolidation_type      VARCHAR NOT NULL,
    template_family         VARCHAR NOT NULL,
    scale_unit              VARCHAR NOT NULL,
    scale_multiplier        BIGINT NOT NULL,
    has_tms29_monetary_item BOOLEAN NOT NULL,
    filepath                VARCHAR NOT NULL,
    fact_count              INTEGER NOT NULL,
    loaded_at               TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
    disclosure_id           BIGINT NOT NULL,   -- reports.disclosure_id
    row_id                  VARCHAR NOT NULL,
    column_class            VARCHAR NOT NULL,
    role_code               VARCHAR NOT NULL,
    statement_type          VARCHAR NOT NULL,
    label_tr                VARCHAR NOT NULL,
    footnote_ref            VARCHAR,
    period_type             VARCHAR NOT NULL,
    period_label            VARCHAR NOT NULL,
    period_start            DATE,
    period_end              DATE,
    is_comparative          BOOLEAN NOT NULL,
    raw_value               BIGINT NOT NULL,
    scale_unit              VARCHAR NOT NULL,
    scale_multiplier        BIGINT NOT NULL,
    normalized_value_tl     HUGEINT NOT NULL,
    PRIMARY KEY (disclosure_id, row_id, column_class)
);
"""

# Versions are numbered per report: a report that carries the same fact in two columns (e.g. a Q1 report whose
# cumulative and 3-month columns cover the same months) gives one version with two rows. Such rows are listed
# by fact_conflicts when they disagree.
VIEWS_SQL = """
CREATE OR REPLACE VIEW fact_versions AS
WITH keyed AS (
    SELECT
        r.company_code,
        r.consolidation_type,
        f.row_id,
        CASE
            WHEN ends_with(f.period_type, '_TP') THEN 'TP'
            WHEN ends_with(f.period_type, '_YP') THEN 'YP'
            ELSE 'TOTAL'
        END AS currency_part,
        f.period_start,
        f.period_end,
        f.label_tr,
        f.raw_value,
        f.scale_unit,
        f.normalized_value_tl,
        f.disclosure_id,
        f.column_class,
        f.period_label,
        f.is_comparative,
        r.year AS reported_year,
        r.quarter AS reported_quarter,
        r.year || '_' || r.quarter AS as_reported_in
    FROM facts f
    JOIN reports r USING (disclosure_id)
    WHERE f.period_end IS NOT NULL
)
, numbered AS (
    SELECT
        *,
        dense_rank() OVER (
            PARTITION BY company_code, consolidation_type, row_id, currency_part, period_start, period_end
            ORDER BY reported_year, reported_quarter, disclosure_id
        ) AS version_no
    FROM keyed
)
SELECT
    *,
    max(version_no) OVER (
        PARTITION BY company_code, consolidation_type, row_id, currency_part, period_start, period_end
    ) AS version_count
FROM numbered;

CREATE OR REPLACE VIEW facts_first_reported AS
SELECT * FROM fact_versions WHERE version_no = 1;

CREATE OR REPLACE VIEW facts_latest AS
SELECT * FROM fact_versions WHERE version_no = version_count;

CREATE OR REPLACE VIEW fact_conflicts AS
SELECT
    company_code, consolidation_type, row_id, currency_part, period_start, period_end, disclosure_id,
    list(column_class ORDER BY column_class) AS column_classes,
    list(raw_value ORDER BY column_class) AS raw_values
FROM fact_versions
GROUP BY ALL
HAVING count(DISTINCT raw_value) > 1;
"""

SCHEMA_SQL = TABLES_SQL + VIEWS_SQL
