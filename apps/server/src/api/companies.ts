/**
 * `GET /v1/companies?q=&limit=&cursor=&sort=` (#217) and `GET /v1/companies/{code}` (#218, docs/API.md "Company"):
 * companies with a loaded report, found by code or title. `q` is folded the Turkish way (`turkishSearchKey`, #189)
 * and matched without spaces, so `işbank`, `ISBANK` and `İş Bank` all find `TÜRKİYE İŞ BANKASI A.Ş.`. Paging and
 * sorting use the shared helper (#215). Single-company lookup accepts any code of the company (its primary code,
 * ticker group or KAP `stock_codes`) and returns its reports newest first.
 */
import type { Company, CompanyDetail, CompanyReport, Consolidation, Quality, Template } from "@vigil/api-types";
import { consolidation, istanbulToUtc } from "@vigil/core";
import { turkishSearchKey } from "../companies.ts";
import { correctionOf } from "../corrections.ts";
import { type Database, rows } from "../db.ts";
import type { Store } from "../zova.ts";
import { ApiError, type Routes } from "./app.ts";
import { listResponse, pageSql, parseListQuery } from "./paging.ts";
import { parseCompanyCode } from "./validation.ts";

const SORT_FIELDS = ["code", "title"] as const;

const QUALITY_SQL = `
CASE
    WHEN fact_count = 0 THEN 'no_values'
    WHEN coalesce(k.failed, 0) > 0 THEN 'fail'
    WHEN coalesce(k.known_errors, 0) > 0 THEN 'known_error'
    WHEN coalesce(k.passed, 0) > 0 THEN 'pass'
    ELSE 'not_checked'
END`;

const CHECKS_CTE = `
checks AS (
    SELECT disclosure_id,
        count(*) FILTER (severity = 'blocking' AND status = 'fail' AND known_error IS NULL) AS failed,
        count(*) FILTER (severity = 'blocking' AND status = 'fail' AND known_error IS NOT NULL) AS known_errors,
        count(*) FILTER (severity = 'blocking' AND status = 'pass') AS passed
    FROM check_results GROUP BY disclosure_id
)`;

/**
 * Each company with its latest report (report period, then publication time, then document id; docs/SCHEMA.md) and
 * that report's quality, worked out from `check_results` as `filingQuality` does in the quality report.
 */
const COMPANIES_SQL = `
WITH latest AS (
    SELECT company_code, disclosure_id, raw_ticker_group, year, quarter, template_family, fact_count
    FROM reports
    QUALIFY row_number() OVER (
        PARTITION BY company_code ORDER BY year DESC, quarter DESC, published_at DESC NULLS LAST, disclosure_id DESC
    ) = 1
), ${CHECKS_CTE}
SELECT
    l.company_code AS code,
    l.raw_ticker_group,
    c.stock_codes,
    c.title,
    l.template_family,
    coalesce(c.sector_name, c.main_sector_name) AS sector,
    c.mkk_member_oid,
    l.disclosure_id,
    l.year,
    l.quarter,
    ${QUALITY_SQL.replaceAll("fact_count", "l.fact_count")} AS quality,
    -- Before the company list is loaded (#163) there is no search key: the code is all there is to match.
    replace(coalesce(c.search_key, lower(l.company_code)), ' ', '') AS search_key
FROM latest l
JOIN companies c USING (company_code)
LEFT JOIN checks k USING (disclosure_id)
`;

const COMPANY_REPORTS_SQL = `
WITH ${CHECKS_CTE}
SELECT
    r.disclosure_id,
    r.year,
    r.quarter,
    r.consolidation_type,
    strftime(r.published_at, '%Y-%m-%dT%H:%M:%S') AS published_at,
    ${QUALITY_SQL.replaceAll("fact_count", "r.fact_count")} AS quality
FROM reports r
LEFT JOIN checks k USING (disclosure_id)
WHERE r.company_code = $1
ORDER BY r.year DESC, r.quarter DESC, r.published_at DESC NULLS LAST, r.disclosure_id DESC
`;

function toCompany(r: Record<string, unknown>): Company {
  return {
    code: String(r.code),
    codes: String(r.raw_ticker_group).split("-"),
    title: r.title === null ? null : String(r.title),
    template: String(r.template_family) as Template,
    sector: r.sector === null ? null : String(r.sector),
    member_id: r.mkk_member_oid === null ? null : String(r.mkk_member_oid),
    latest_report: {
      document_id: String(r.disclosure_id),
      year: Number(r.year),
      quarter: Number(r.quarter),
      quality: String(r.quality) as Quality,
    },
  };
}

function apiConsolidation(asFiled: string): Consolidation {
  return consolidation(asFiled) === "consolidated" ? "consolidated" : "solo";
}

function toCompanyReport(r: Record<string, unknown>, store?: Store): CompanyReport {
  const id = Number(r.disclosure_id);
  const original = store ? (correctionOf(store, id)?.original_disclosure_id ?? null) : null;
  return {
    document_id: String(r.disclosure_id),
    year: Number(r.year),
    quarter: Number(r.quarter),
    consolidation: apiConsolidation(String(r.consolidation_type)),
    published_at: r.published_at === null ? null : istanbulToUtc(String(r.published_at)),
    quality: String(r.quality) as Quality,
    corrects: original === null ? null : String(original),
  };
}

export interface CompanyRoutesOptions {
  /** Optional Zova store for looking up report correction links (`corrections`, #204). */
  store?: Store;
}

export function companyRoutes(db: Database, options: CompanyRoutesOptions = {}): Routes {
  return (v1) => {
    v1.get("/companies", async (c) => {
      const query = parseListQuery(c, SORT_FIELDS, "code");
      const q = turkishSearchKey(c.req.query("q") ?? "").replaceAll(" ", "");
      const where = q === "" ? "" : "WHERE contains(search_key, $1)";
      const values = q === "" ? [] : [q];
      const [count] = await rows(db, `SELECT count(*) AS n FROM (${COMPANIES_SQL}) ${where}`, values);
      const page = await rows(
        db,
        `SELECT * FROM (${COMPANIES_SQL}) ${where} ${pageSql(query, { code: "code", title: "title COLLATE tr" }, "code")}`,
        values,
      );
      return c.json(listResponse(page.map(toCompany), Number(count?.n ?? 0), query));
    });

    v1.get("/companies/:code", async (c) => {
      const code = parseCompanyCode(c.req.param("code"));
      const [companyRow] = await rows(
        db,
        `SELECT * FROM (${COMPANIES_SQL}) AS co
         WHERE co.code = $1
            OR list_contains(string_split(co.raw_ticker_group, '-'), $1)
            OR (co.stock_codes IS NOT NULL AND list_contains(co.stock_codes, $1))
            OR EXISTS (
                SELECT 1 FROM reports r2
                WHERE r2.company_code = co.code AND list_contains(string_split(r2.raw_ticker_group, '-'), $1)
            )
         ORDER BY CASE WHEN co.code = $1 THEN 0 ELSE 1 END, co.code
         LIMIT 1`,
        [code],
      );
      if (companyRow === undefined) {
        throw new ApiError("not_found", `Şirket bulunamadı: ${code}`, { code });
      }
      const company = toCompany(companyRow);
      const reportRows = await rows(db, COMPANY_REPORTS_SQL, [company.code]);
      const detail: CompanyDetail = {
        ...company,
        reports: reportRows.map((r) => toCompanyReport(r, options.store)),
      };
      return c.json(detail);
    });
  };
}
