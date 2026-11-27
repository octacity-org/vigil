/**
 * `GET /v1/reports/{document_id}` (#219, docs/API.md "Report"): report metadata, quality status and every consistency
 * check result (`check_results`, #183), including known filing errors with their reasons (decision 0006) and source
 * references back to the filed cells in `facts` (#72).
 */
import type {
  Calculation,
  CalculationStep,
  Check,
  Consolidation,
  CurrencyPart,
  Period,
  Quality,
  Report,
  Source,
  Template,
  Value,
} from "@vigil/api-types";
import { consolidation, istanbulToUtc, kapUrl, shownValue } from "@vigil/core";
import { type Database, rows } from "../db.ts";
import { ApiError, type Routes } from "./app.ts";
import { parseDocumentId } from "./validation.ts";

interface StoredFact {
  row_id: string;
  column_class: string;
  label_tr: string;
  period_type: string;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  raw_value: bigint;
  scale_unit: string;
  normalized_value_tl: bigint;
}

interface ReportMeta {
  document_id: string;
  company_code: string;
  year: number;
  quarter: number;
  consolidation: Consolidation;
  template: Template;
  scale: string;
  scale_multiplier: bigint;
  fact_count: number;
  published_at: string | null;
  url: string;
}

function apiConsolidation(asFiled: string): Consolidation {
  return consolidation(asFiled) === "consolidated" ? "consolidated" : "solo";
}

function factPeriod(f: StoredFact): Period | undefined {
  if (f.period_end === null) return undefined;
  const currency_part: CurrencyPart = f.period_type.endsWith("_TP")
    ? "tp"
    : f.period_type.endsWith("_YP")
      ? "yp"
      : "total";
  if (f.period_type.startsWith("POINT_IN_TIME")) {
    return { start: null, end: f.period_end, type: "point_in_time", label: f.period_label, currency_part };
  }
  if (f.period_type === "Q_STANDALONE" || f.period_type === "YTD_CUMULATIVE") {
    return {
      start: f.period_start,
      end: f.period_end,
      type: f.period_type === "Q_STANDALONE" ? "three_month" : "cumulative",
      label: f.period_label,
      currency_part,
    };
  }
  return undefined;
}

function factSource(meta: ReportMeta, f: StoredFact): Source {
  const table = f.row_id.replace(/-row-\d+$/, "");
  return {
    system: "KAP",
    document_id: meta.document_id,
    company_code: meta.company_code,
    report: { year: meta.year, quarter: meta.quarter, consolidation: meta.consolidation },
    table,
    row: f.row_id,
    row_label: f.label_tr,
    column: f.column_class,
    period_label: f.period_label,
    shown_value: shownValue(f.raw_value),
    scale: f.scale_unit,
    published_at: meta.published_at,
    url: meta.url,
  };
}

function factValue(meta: ReportMeta, f: StoredFact): Value {
  const period = factPeriod(f);
  return {
    status: "ok",
    value: f.normalized_value_tl.toString(),
    unit: "TRY",
    ...(period ? { period } : {}),
    source: factSource(meta, f),
  };
}

/** Parse `"row_id column_class"` into `[row_id, column_class]`, or null for subtotal component lists. */
function parseCellSource(source: string | null): [string, string] | null {
  if (source === null || source.includes(",")) return null;
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  return [parts[0] as string, parts[1] as string];
}

function buildRightValue(
  meta: ReportMeta,
  checkName: string,
  rawRight: bigint,
  rightSource: string | null,
  leftColumn: string | null,
  leftPeriod: Period | undefined,
  factMap: Map<string, StoredFact>,
): Value {
  const valueTl = (rawRight * meta.scale_multiplier).toString();
  const single = parseCellSource(rightSource);
  if (single !== null) {
    const f = factMap.get(`${single[0]}|${single[1]}`);
    if (f !== undefined) {
      const period = factPeriod(f);
      return {
        status: "ok",
        value: valueTl,
        unit: "TRY",
        ...(period ? { period } : {}),
        source: factSource(meta, f),
      };
    }
  }

  // Subtotal check: right_source lists component row ids in the same column as left_source.
  if (rightSource !== null && leftColumn !== null) {
    const rowIds = rightSource
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const components = rowIds
      .map((rowId) => factMap.get(`${rowId}|${leftColumn}`))
      .filter((f): f is StoredFact => f !== undefined);
    if (components.length > 0) {
      const steps: CalculationStep[] = components.map((f) => ({
        id: f.row_id,
        label: f.label_tr,
        value: factValue(meta, f),
      }));
      steps.push({
        id: "sum",
        label: "Bileşenler toplamı",
        formula: components.map((f) => f.row_id).join(" + "),
        result: valueTl,
      });
      const calculation: Calculation = {
        formula: components.map((f) => f.row_id).join(" + "),
        definition: { id: checkName, version: "1", url: `/methodology/checks` },
        steps,
      };
      return {
        status: "ok",
        value: valueTl,
        unit: "TRY",
        ...(leftPeriod ? { period: leftPeriod } : {}),
        calculation,
      };
    }
  }

  return {
    status: "ok",
    value: valueTl,
    unit: "TRY",
    ...(leftPeriod ? { period: leftPeriod } : {}),
  };
}

function reportQuality(factCount: number, checks: readonly Check[]): Quality {
  if (factCount === 0) return "no_values";
  if (checks.some((c) => c.severity === "blocking" && c.status === "fail" && c.known_error === null)) return "fail";
  if (checks.some((c) => c.severity === "blocking" && c.status === "fail" && c.known_error !== null)) {
    return "known_error";
  }
  if (checks.some((c) => c.severity === "blocking" && c.status === "pass")) return "pass";
  return "not_checked";
}

export function reportRoutes(db: Database): Routes {
  return (v1) => {
    v1.get("/reports/:document_id", async (c) => {
      const documentId = parseDocumentId(c.req.param("document_id"));
      const id = BigInt(documentId);
      const [reportRow] = await rows(
        db,
        `SELECT disclosure_id, company_code, year, quarter, consolidation_type, template_family, scale_unit,
                scale_multiplier::VARCHAR AS scale_multiplier, fact_count,
                strftime(published_at, '%Y-%m-%dT%H:%M:%S') AS published_at
         FROM reports WHERE disclosure_id = $1`,
        [id],
      );
      if (reportRow === undefined) {
        throw new ApiError("not_found", `Rapor bulunamadı: ${documentId}`, { document_id: documentId });
      }

      const meta: ReportMeta = {
        document_id: String(reportRow.disclosure_id),
        company_code: String(reportRow.company_code),
        year: Number(reportRow.year),
        quarter: Number(reportRow.quarter),
        consolidation: apiConsolidation(String(reportRow.consolidation_type)),
        template: String(reportRow.template_family) as Template,
        scale: String(reportRow.scale_unit),
        scale_multiplier: BigInt(String(reportRow.scale_multiplier)),
        fact_count: Number(reportRow.fact_count),
        published_at: reportRow.published_at === null ? null : istanbulToUtc(String(reportRow.published_at)),
        url: kapUrl(documentId),
      };

      const checkRows = await rows(
        db,
        `SELECT check_group, name, severity, status, left_value::VARCHAR AS left_value,
                right_value::VARCHAR AS right_value, left_source, right_source,
                tolerance::VARCHAR AS tolerance, known_error
         FROM check_results
         WHERE disclosure_id = $1
         ORDER BY position`,
        [id],
      );

      const factRows = await rows(
        db,
        `SELECT row_id, column_class, label_tr, period_type, period_label,
                strftime(period_start, '%Y-%m-%d') AS period_start,
                strftime(period_end, '%Y-%m-%d') AS period_end,
                raw_value::VARCHAR AS raw_value, scale_unit,
                normalized_value_tl::VARCHAR AS normalized_value_tl
         FROM facts WHERE disclosure_id = $1`,
        [id],
      );
      const factMap = new Map<string, StoredFact>();
      for (const f of factRows) {
        const stored: StoredFact = {
          row_id: String(f.row_id),
          column_class: String(f.column_class),
          label_tr: String(f.label_tr),
          period_type: String(f.period_type),
          period_label: String(f.period_label),
          period_start: f.period_start === null ? null : String(f.period_start),
          period_end: f.period_end === null ? null : String(f.period_end),
          raw_value: BigInt(String(f.raw_value)),
          scale_unit: String(f.scale_unit),
          normalized_value_tl: BigInt(String(f.normalized_value_tl)),
        };
        factMap.set(`${stored.row_id}|${stored.column_class}`, stored);
      }

      const checks: Check[] = checkRows.map((r) => {
        const leftSource = r.left_source === null ? null : String(r.left_source);
        const rightSource = r.right_source === null ? null : String(r.right_source);
        const leftCell = parseCellSource(leftSource);
        const leftFact = leftCell ? factMap.get(`${leftCell[0]}|${leftCell[1]}`) : undefined;
        const leftPeriod = leftFact ? factPeriod(leftFact) : undefined;

        let left: Value | null = null;
        if (r.left_value !== null) {
          const leftTl = (BigInt(String(r.left_value)) * meta.scale_multiplier).toString();
          left =
            leftFact !== undefined
              ? {
                  status: "ok",
                  value: leftTl,
                  unit: "TRY",
                  ...(leftPeriod ? { period: leftPeriod } : {}),
                  source: factSource(meta, leftFact),
                }
              : { status: "ok", value: leftTl, unit: "TRY" };
        }

        const right: Value | null =
          r.right_value === null
            ? null
            : buildRightValue(
                meta,
                String(r.name),
                BigInt(String(r.right_value)),
                rightSource,
                leftCell?.[1] ?? null,
                leftPeriod,
                factMap,
              );

        const tolerance = r.tolerance === null ? "0" : (BigInt(String(r.tolerance)) * meta.scale_multiplier).toString();

        return {
          name: String(r.name),
          group: String(r.check_group),
          severity: String(r.severity) as Check["severity"],
          status: String(r.status) as Check["status"],
          left,
          right,
          tolerance,
          known_error: r.known_error === null ? null : String(r.known_error),
        };
      });

      const report: Report = {
        document_id: meta.document_id,
        company_code: meta.company_code,
        year: meta.year,
        quarter: meta.quarter,
        consolidation: meta.consolidation,
        template: meta.template,
        scale: meta.scale,
        published_at: meta.published_at,
        quality: reportQuality(meta.fact_count, checks),
        checks,
        url: meta.url,
      };
      return c.json(report);
    });
  };
}
