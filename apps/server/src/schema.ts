/**
 * Bitemporal storage schema for parsed KAP facts (issue #45, decision 0002, docs/SCHEMA.md).
 *
 * Under IAS 29 (TMS 29) every report restates its comparative columns, so one fact exists more than once:
 * as first reported, and restated in each later report. Nothing is overwritten; every report's value is a row.
 *
 * - knowledge time: the report a value comes from (`reports.year`, `reports.quarter`, `reports.disclosure_id`)
 * - valid time: the period the value describes (`facts.period_start`, `facts.period_end`), read from the
 *   column header dates. Balance sheet values are points in time: `period_start` is NULL.
 *
 * One fact is identified by (company_code, consolidation_type, row_id, currency_part, period_start, period_end).
 * Facts whose header has no dates cannot be matched across reports and stay out of the version views.
 *
 * The links reports -> companies and facts -> reports are not declared as foreign keys: DuckDB checks them
 * against the state before the transaction, so replacing a report (delete facts, delete report) fails.
 */

/** Migration 1: the tables of #45. `IF NOT EXISTS`, so it also runs on databases made before versioning. */
const BASE_TABLES_SQL = `
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
`;

/**
 * Migration 3: the monthly CPI (TÜFE) series (#188; the series file and the factor are #47). The table holds one
 * series: loading replaces it as a whole, so values of two base years never mix.
 */
const CPI_TABLE_SQL = `
CREATE TABLE cpi_monthly (
    month                   DATE PRIMARY KEY,         -- first day of the month
    index_value             DECIMAL(18, 6) NOT NULL,  -- as published
    base                    VARCHAR NOT NULL,         -- e.g. 2025=100
    source                  VARCHAR NOT NULL,
    series_code             VARCHAR NOT NULL,
    retrieved_at            TIMESTAMP NOT NULL        -- UTC
);
`;

/**
 * Migration 4: the consistency check results of each report (#183; checks in `packages/core` `checks.ts`, decisions
 * 0003 and 0006). One row per check result, in the order the checks ran; a check name repeats for each column, so
 * the key is the position. Values are raw, in the report's reporting unit, like `facts.raw_value`. Written and
 * replaced together with the report.
 */
/**
 * Migration 6 (#184): every metric of a report, as a value or the reason it cannot be computed, with the inputs it
 * used and where each input was read. Written by `writeMetrics` (metrics-store.ts) and replaced with the report.
 */
const METRICS_SQL = `
CREATE TABLE metrics (
    disclosure_id       BIGINT NOT NULL,          -- reports.disclosure_id
    company_code        VARCHAR NOT NULL,
    metric_code         VARCHAR NOT NULL,         -- e.g. gross_margin (docs/glossary.md)
    period_type         VARCHAR NOT NULL CHECK (period_type IN ('point_in_time', 'cumulative', 'three_month', 'ttm')),
    period_start        DATE,                     -- NULL for a point in time
    period_end          DATE NOT NULL,
    status              VARCHAR NOT NULL CHECK (status IN ('ok', 'not_reported', 'not_computable')),
    value               VARCHAR,                  -- exact decimal text, as in the API; NULL unless status is ok
    unit                VARCHAR NOT NULL CHECK (unit IN ('TRY', 'ratio', 'bps', 'days', 'count')),
    reason_code         VARCHAR,                  -- only when not_computable
    reason_message      VARCHAR,                  -- Turkish, for the UI
    needs               VARCHAR[],                -- inputs that would make it computable (glossary codes)
    formula             VARCHAR,                  -- e.g. gross_profit / revenue
    definition_version  VARCHAR NOT NULL,         -- version of the metric definitions it was computed under
    computed_at         TIMESTAMP NOT NULL,       -- UTC
    PRIMARY KEY (disclosure_id, metric_code, period_type, period_end),
    CHECK ((status = 'ok') = (value IS NOT NULL)),
    CHECK ((status = 'not_computable') = (reason_code IS NOT NULL))
);

CREATE TABLE metric_inputs (
    disclosure_id        BIGINT NOT NULL,
    metric_code          VARCHAR NOT NULL,
    period_type          VARCHAR NOT NULL,
    period_end           DATE NOT NULL,
    position             INTEGER NOT NULL,        -- order of the inputs in the formula, from 0
    input_code           VARCHAR NOT NULL,        -- glossary code, e.g. revenue
    status               VARCHAR NOT NULL CHECK (status IN ('ok', 'not_reported', 'not_computable')),
    value                VARCHAR,
    unit                 VARCHAR NOT NULL,
    source_disclosure_id BIGINT,                  -- the fact it was read from: facts (disclosure_id, row_id, column_class)
    source_row_id        VARCHAR,
    source_column_class  VARCHAR,
    PRIMARY KEY (disclosure_id, metric_code, period_type, period_end, position)
);
`;

const CHECK_RESULTS_SQL = `
CREATE TABLE check_results (
    disclosure_id           BIGINT NOT NULL,          -- reports.disclosure_id
    position                INTEGER NOT NULL,         -- order the checks ran in, from 0
    check_group             VARCHAR NOT NULL,         -- reconciliation, income_statement, balance_sheet, cash_flow
    name                    VARCHAR NOT NULL,
    severity                VARCHAR NOT NULL CHECK (severity IN ('blocking', 'informational')),
    status                  VARCHAR NOT NULL CHECK (status IN ('pass', 'fail', 'not_checked')),
    left_value              BIGINT,
    right_value             BIGINT,
    left_source             VARCHAR,                  -- "row_id column"
    right_source            VARCHAR,                  -- "row_id column", or the component row ids of a subtotal
    tolerance               BIGINT,                   -- largest difference accepted as a pass; NULL when not checked
    reason                  VARCHAR,                  -- why a check is not_checked
    known_error             VARCHAR,                  -- a blocking failure confirmed as an error in the filing
    PRIMARY KEY (disclosure_id, position)
);
`;

// Versions are numbered per report: a report that carries the same fact in two columns (e.g. a Q1 report whose
// cumulative and 3-month columns cover the same months) gives one version with two rows. Such rows are listed
// by fact_conflicts when they disagree.
export const VIEWS_SQL = `
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
        r.year || '_' || r.quarter AS as_reported_in,
        r.published_at
    FROM facts f
    JOIN reports r USING (disclosure_id)
    WHERE f.period_end IS NOT NULL
)
, numbered AS (
    SELECT
        *,
        dense_rank() OVER (
            PARTITION BY company_code, consolidation_type, row_id, currency_part, period_start, period_end
            ORDER BY reported_year, reported_quarter, published_at NULLS LAST, disclosure_id
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
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered schema changes (#182). Append only: never edit or reorder a released step. Each runs once, in its own
 * transaction, and is recorded in `schema_version`. Steps must also be safe on databases created before
 * versioning existed (2026), which have no `schema_version` table; `IF NOT EXISTS` covers that.
 * Views are not migrations: they are recreated on every start.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "companies, reports and facts (#45)", sql: BASE_TABLES_SQL },
  {
    version: 2,
    name: "reports.published_at (#157)",
    // `Gönderim Tarihi`, Istanbul time.
    sql: "ALTER TABLE reports ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;",
  },
  { version: 3, name: "cpi_monthly (#188)", sql: CPI_TABLE_SQL },
  { version: 4, name: "check_results (#183)", sql: CHECK_RESULTS_SQL },
  {
    version: 5,
    name: "company metadata (#189)",
    // Filled by `updateCompanies` (companies.ts) from KAP's disclosure list and sector classification.
    sql: `
ALTER TABLE companies ADD COLUMN IF NOT EXISTS mkk_member_oid VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stock_codes VARCHAR[];
ALTER TABLE companies ADD COLUMN IF NOT EXISTS title VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS template_family VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS main_sector_no VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS main_sector_name VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_no VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_name VARCHAR;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sectors_read_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS search_key VARCHAR;
`,
  },
  { version: 6, name: "metrics and metric_inputs (#184)", sql: METRICS_SQL },
];

export const SCHEMA_VERSION_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    name        VARCHAR NOT NULL,
    applied_at  TIMESTAMP NOT NULL
);
`;
