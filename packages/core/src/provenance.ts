/**
 * Provenance (#72): every number a finding uses carries where it was read, so a reader can find the cell in the filing
 * by hand and redo the calculation. The shapes are `docs/API.md`'s `Value`, `Period`, `Source` and `Calculation`;
 * names are market-neutral and the source system is a field value (`"system": "KAP"`).
 *
 * A value has either a source (read from a filing) or is a step computed from earlier steps, never both.
 */
import type { ParsedFiling, ParsedFinancialFact } from "./parser.ts";

export interface Source {
  system: "KAP";
  /** The KAP disclosure index, as a string so other systems' ids fit. */
  document_id: string;
  company_code: string;
  report: { year: number; quarter: number; consolidation: "consolidated" | "standalone" | null };
  /** The statement table, e.g. `general_role_310003`. */
  table: string;
  row: string;
  row_label: string;
  column: string;
  /** The column header as filed. */
  period_label: string;
  /** The number as shown in the cell, before scaling (decision 0005), e.g. `189.492.068`. */
  shown_value: string;
  /** The reporting unit as filed (`Sunum Para Birimi`), e.g. `TL`, `BİN TL`. */
  scale: string;
  /** `Gönderim Tarihi` in UTC; null when the filing has none. */
  published_at: string | null;
  url: string;
}

export interface Period {
  start: string | null;
  end: string;
  type: "point_in_time" | "cumulative" | "three_month";
  label: string;
  currency_part: "total" | "tp" | "yp";
}

/** A value read from a filing: whole TL after scaling, with its period and source. */
export interface SourcedValue {
  value: string;
  unit: "TRY";
  status: "ok";
  period: Period;
  source: Source;
}

/** A step of a calculation: a value read from a filing, or a formula over earlier steps with its result. */
export type Step =
  | { id: string; label: string; value: SourcedValue }
  | { id: string; label: string; formula: string; result: string };

export interface Calculation {
  formula: string;
  definition: { id: string; version: string; url: string };
  steps: Step[];
}

export class ProvenanceError extends Error {
  override name = "ProvenanceError";
}

/** The public page of a KAP disclosure. */
export function kapUrl(documentId: number | string): string {
  return `https://www.kap.org.tr/tr/Bildirim/${documentId}`;
}

/** `Finansal Tablo Niteliği` as an API value; null for anything not recognised. */
export function consolidation(asFiled: string): Source["report"]["consolidation"] {
  if (asFiled === "Konsolide") return "consolidated";
  if (["Konsolide Olmayan", "Konsolide Değil", "Solo", "Bireysel"].includes(asFiled)) return "standalone";
  return null;
}

/** The number as shown in a KAP cell: digits grouped by dots, a leading minus (the parser's visible-number form). */
export function shownValue(raw: bigint): string {
  const digits = (raw < 0n ? -raw : raw).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return raw < 0n ? `-${digits}` : digits;
}

/** Istanbul local time (`2026-08-17T19:05:18`, UTC+3 since 2016) as UTC (`2026-08-17T16:05:18Z`). */
export function istanbulToUtc(local: string): string {
  const t = Date.parse(`${local}+03:00`);
  if (Number.isNaN(t)) throw new ProvenanceError(`not an Istanbul time: ${local}`);
  return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

/** The period a fact describes. Throws for a column whose period the parser could not tell. */
export function periodOf(f: ParsedFinancialFact): Period {
  const where = `${f.disclosure_id} ${f.row_id} ${f.column_class}`;
  if (f.period_end === null) throw new ProvenanceError(`${where}: no period end in "${f.period_label}"`);
  const currency_part = f.period_type.endsWith("_TP") ? "tp" : f.period_type.endsWith("_YP") ? "yp" : "total";
  if (f.period_type.startsWith("POINT_IN_TIME")) {
    return { start: null, end: f.period_end, type: "point_in_time", label: f.period_label, currency_part };
  }
  const type =
    f.period_type === "Q_STANDALONE" ? "three_month" : f.period_type === "YTD_CUMULATIVE" ? "cumulative" : null;
  if (type === null || f.period_start === null) {
    throw new ProvenanceError(`${where}: period type ${f.period_type} in "${f.period_label}"`);
  }
  return { start: f.period_start, end: f.period_end, type, label: f.period_label, currency_part };
}

/** Where a fact was read. */
export function sourceOf(filing: ParsedFiling, f: ParsedFinancialFact): Source {
  const table = f.row_id.replace(/-row-\d+$/, "");
  if (table === f.row_id) throw new ProvenanceError(`${f.disclosure_id}: row id ${f.row_id} has no table`);
  return {
    system: "KAP",
    document_id: String(f.disclosure_id),
    company_code: f.company_code,
    report: { year: f.year, quarter: f.quarter, consolidation: consolidation(f.consolidation_type) },
    table,
    row: f.row_id,
    row_label: f.label_tr,
    column: f.column_class,
    period_label: f.period_label,
    shown_value: shownValue(f.raw_value),
    scale: f.scale_unit,
    published_at: filing.published_at === null ? null : istanbulToUtc(filing.published_at),
    url: kapUrl(f.disclosure_id),
  };
}

/** A fact as a value with its period and source. */
export function readValue(filing: ParsedFiling, f: ParsedFinancialFact): SourcedValue {
  return {
    value: f.normalized_value_tl.toString(),
    unit: "TRY",
    status: "ok",
    period: periodOf(f),
    source: sourceOf(filing, f),
  };
}
