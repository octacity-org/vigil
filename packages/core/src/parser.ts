/**
 * Parse a KAP financial statement file (UTF-8 HTML with an .xls extension) into facts.
 * The rules are in docs/kap.md; decisions 0005 (shown number is the value) and #14 (one cell at a time).
 */
import { decodeHTML } from "entities";
import { daysBetween, type IsoDate, isoDate, nextDay } from "./dates.ts";
import { collapseWhitespace, pyRepr, pyReprList, WS } from "./text.ts";

export const SCALE_MAP: Readonly<Record<string, bigint>> = {
  TL: 1n,
  "1 TL": 1n,
  "1.000 TL": 1_000n,
  "BİN TL": 1_000n,
  "1.000.000 TL": 1_000_000n,
  "MİLYON TL": 1_000_000n,
};

/** Template families seen in KAP files (docs/kap.md). `par-banks` (participation banks, ALBRK) has a hyphen (#124). */
export const KNOWN_FAMILIES = ["general", "banks", "par-banks", "finance", "holding", "insurance"] as const;

/** A duration this short is one quarter, not a year-to-date total. */
export const MAX_QUARTER_DAYS = 100;

export type StatementType =
  | "OFF_BALANCE_SHEET"
  | "BALANCE_SHEET"
  | "INCOME_STATEMENT"
  | "COMPREHENSIVE_INCOME"
  | "CASH_FLOW_DIRECT"
  | "CASH_FLOW_INDIRECT"
  | "EQUITY_CHANGES"
  | "OTHER";

export type PeriodType =
  | "POINT_IN_TIME"
  | "POINT_IN_TIME_TP"
  | "POINT_IN_TIME_YP"
  | "YTD_CUMULATIVE"
  | "Q_STANDALONE"
  | "UNKNOWN";

export interface ColumnMeta {
  col_class: string;
  header_text: string;
  period_type: PeriodType;
  is_comparative: boolean;
  /** From the header dates (#36). A point in time has only an end date. */
  period_start: IsoDate | null;
  period_end: IsoDate | null;
}

export interface ParsedFinancialFact {
  company_code: string;
  raw_ticker_group: string;
  disclosure_id: number;
  year: number;
  quarter: number;
  consolidation_type: string;
  template_family: string;
  role_code: string;
  statement_type: StatementType;
  row_id: string;
  label_tr: string;
  footnote_ref: string | null;
  column_class: string;
  period_type: PeriodType;
  period_label: string;
  is_restated_comparative: boolean;
  /** Unscaled value in the reporting unit. */
  raw_value: bigint;
  scale_unit: string;
  scale_multiplier: bigint;
  normalized_value_tl: bigint;
  period_start: IsoDate | null;
  period_end: IsoDate | null;
}

export interface ParsedFiling {
  file_name: string;
  company_code: string;
  raw_ticker_group: string;
  disclosure_id: number;
  year: number;
  quarter: number;
  scale_unit: string;
  scale_multiplier: bigint;
  consolidation_type: string;
  template_family: string;
  role_codes: string[];
  has_tms29_monetary_item: boolean;
  facts: ParsedFinancialFact[];
  /** `Gönderim Tarihi` in the file header, Istanbul time (#157), e.g. `2026-08-17T19:05:18`. Null only for hand-built filings. */
  published_at: string | null;
  /** The reporting period from the header dates, not from the file name (#36). */
  period_start: IsoDate | null;
  period_end: IsoDate | null;
  /** Cells whose `title` is a different number than the shown one; the shown number is used (decision 0005). */
  title_disagreements: number;
  /** Cells with a `title` but no shown number; they are treated as empty. */
  titles_without_text: number;
}

export class ParseError extends Error {
  override name = "ParseError";
}

const S = `[${WS}]`;
const FILENAME_RE = /^([A-Z0-9-]+)_(\d+)_(\d{4})_([1-4])\.xls$/i;
const HEADER_SCALE_RE = new RegExp(`Sunum Para Birimi${S}*</td>${S}*<td[^>]*>${S}*([^<]+?)${S}*</td>`, "s");
const HEADER_PUBLISHED_RE = new RegExp(`Gönderim Tarihi:${S}*([^<]*?)${S}*<`);
const HEADER_CONSOL_RE = new RegExp(`Finansal Tablo Niteli[^<]*</td>${S}*<td[^>]*>${S}*([^<]+?)${S}*</td>`, "s");
// The family is read up to `_role_`, whatever characters it has, so an unknown one is reported rather than missed.
const ROLE_TABLE_RE = new RegExp(`<table[^>]*class="[^"]*tbl_([^"${WS}]+?)_role_(\\d{6})[^"]*"[^>]*>`, "gs");
const ROW_START_RE = new RegExp(
  `<tr${S}+class="([^"${WS}]+?_role_\\d{6}-row-\\d+)${S}+data-input-row[^"]*"[^>]*>`,
  "gs",
);
const LABEL_TR_RE = new RegExp(`class="[^"]*content-tr[^"]*"[^>]*>${S}*(.*?)${S}*</div>`, "s");
const FOOTNOTE_RE = new RegExp(`class="taxonomy-footnote-value"[^>]*>${S}*(.*?)${S}*</div>`, "s");
// One value cell up to its own closing tag. Searching past the cell boundary would take the next cell's value
// and put it in the empty cell's column (#14).
const VALUE_CELL_RE = new RegExp(
  `<td${S}+class="taxonomy-context-value${S}+(col-order-class-\\d+)[^"]*"[^>]*>(.*?)</td>`,
  "gs",
);
const HEADER_CELL_RE = /<td[^>]*>(.*?)<\/td>/gs;
const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})/g;
const VALUE_TITLE_RE = /title="([-+]?\d+(?:[.,]\d+)?)"/;
// Visible text of a value cell: the unscaled number with `.` thousands separators and a leading `-`.
// It is the value: the `title` attribute can sit on the wrong row or hold another number (#148, decision 0005).
const VALUE_TEXT_RE = new RegExp(`>${S}*([^<${WS}][^<]*?)${S}*<`, "g");
const VISIBLE_NUMBER_RE = /^-?\d{1,3}(?:\.\d{3})*$/;
const PUBLISHED_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/;

export function classifyStatementRole(roleCode: string): StatementType {
  if (roleCode.startsWith("2105")) return "OFF_BALANCE_SHEET";
  if (roleCode.startsWith("21")) return "BALANCE_SHEET";
  if (roleCode.startsWith("31")) return "INCOME_STATEMENT";
  if (roleCode.startsWith("41") || roleCode.startsWith("42")) return "COMPREHENSIVE_INCOME";
  if (roleCode.startsWith("51")) return "CASH_FLOW_DIRECT";
  if (roleCode.startsWith("52")) return "CASH_FLOW_INDIRECT";
  if (roleCode.startsWith("61")) return "EQUITY_CHANGES";
  return "OTHER";
}

/** The number shown in a cell, or null for an empty cell. Unknown formats raise. */
export function visibleValue(cellHtml: string): bigint | null {
  const texts = [...`>${cellHtml}<`.matchAll(VALUE_TEXT_RE)].map((m) => m[1] as string);
  if (texts.length === 0) return null;
  const first = texts[0] as string;
  if (texts.length > 1 || !VISIBLE_NUMBER_RE.test(first)) {
    throw new ParseError(`Unexpected value text ${pyReprList(texts)}`);
  }
  return BigInt(first.replaceAll(".", ""));
}

/**
 * Read (start, end) from a column header such as "Cari Dönem 01.01.2026 - 30.06.2026".
 * A header with one date is a point in time: (null, date). Anything else is (null, null).
 */
export function periodDates(periodLabel: string): [IsoDate | null, IsoDate | null] {
  const dates: IsoDate[] = [];
  for (const m of periodLabel.matchAll(DATE_RE)) {
    const d = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d === null) return [null, null];
    dates.push(d);
  }
  if (dates.length === 1) return [null, dates[0] as IsoDate];
  if (dates.length === 2 && (dates[0] as IsoDate) <= (dates[1] as IsoDate))
    return [dates[0] as IsoDate, dates[1] as IsoDate];
  return [null, null];
}

/** Attach the header dates and take the period type from them; keep the guess only without dates. */
function withDates(col: ColumnMeta): ColumnMeta {
  const [start, end] = periodDates(col.header_text);
  col.period_start = start;
  col.period_end = end;
  if (start !== null && end !== null) {
    col.period_type = daysBetween(start, end) + 1 <= MAX_QUARTER_DAYS ? "Q_STANDALONE" : "YTD_CUMULATIVE";
  }
  return col;
}

function column(col_class: string, header_text: string, period_type: PeriodType, is_comparative: boolean): ColumnMeta {
  return { col_class, header_text, period_type, is_comparative, period_start: null, period_end: null };
}

/** The current-period duration column that starts earliest: the year to date. */
function reportingPeriod(columns: readonly ColumnMeta[]): [IsoDate | null, IsoDate | null] {
  let best: [IsoDate, IsoDate] | null = null;
  for (const c of columns) {
    if (c.period_start === null || !c.period_end) continue;
    const span: [IsoDate, IsoDate] = [c.period_start, c.period_end];
    if (best === null || span[0] < best[0] || (span[0] === best[0] && span[1] < best[1])) best = span;
  }
  return best ?? [null, null];
}

export function parseFilename(fileName: string): {
  company_code: string;
  raw_ticker_group: string;
  disclosure_id: number;
  year: number;
  quarter: number;
} {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const m = FILENAME_RE.exec(base);
  if (!m) throw new ParseError(`Unexpected KAP filename format: ${base}`);
  const raw_ticker_group = (m[1] as string).toUpperCase();
  return {
    company_code: raw_ticker_group.split("-")[0] as string,
    raw_ticker_group,
    disclosure_id: Number(m[2]),
    year: Number(m[3]),
    quarter: Number(m[4]),
  };
}

function cleanText(s: string): string {
  return collapseWhitespace(decodeHTML(s.replace(/<[^>]+>/g, " ")));
}

/** Column metadata for a statement table, from the header cells before its first row. */
function buildColumns(statementType: StatementType, tableHead: string, quarter: number): Map<string, ColumnMeta> {
  const headerCells = [...tableHead.matchAll(HEADER_CELL_RE)].map((m) => cleanText(m[1] as string));
  const periodHeaders = headerCells.filter((c) => c.includes("Cari Dönem") || c.includes("Önceki Dönem"));
  const header = (i: number, fallback: string) => periodHeaders[i] ?? fallback;
  const cols = new Map<string, ColumnMeta>();

  if (statementType === "BALANCE_SHEET" || statementType === "OFF_BALANCE_SHEET") {
    const hasTpYp = headerCells.includes("TP") && headerCells.includes("YP") && headerCells.includes("Toplam");
    const current = header(0, "Cari Dönem");
    const prior = header(1, "Önceki Dönem");
    if (hasTpYp) {
      // One TP / YP / Toplam group per period header, from column 4. A third period ("Bir Önceki Dönem") holds
      // restated comparatives in columns 10-12 (EXIMB, VDFAS; #125).
      const labels = [current, prior, ...periodHeaders.slice(2)];
      const parts: [string, PeriodType][] = [
        ["TP", "POINT_IN_TIME_TP"],
        ["YP", "POINT_IN_TIME_YP"],
        ["Toplam", "POINT_IN_TIME"],
      ];
      labels.forEach((label, period) => {
        parts.forEach(([name, ptype], part) => {
          const col = `col-order-class-${4 + 3 * period + part}`;
          cols.set(col, column(col, `${label} (${name})`, ptype, period > 0));
        });
      });
    } else {
      cols.set("col-order-class-4", column("col-order-class-4", current, "POINT_IN_TIME", false));
      cols.set("col-order-class-5", column("col-order-class-5", prior, "POINT_IN_TIME", true));
      cols.set("col-order-class-6", column("col-order-class-6", header(2, "Bir Önceki Dönem"), "POINT_IN_TIME", true));
    }
  } else if (statementType === "INCOME_STATEMENT" || statementType === "COMPREHENSIVE_INCOME") {
    const main: PeriodType = quarter === 1 ? "Q_STANDALONE" : "YTD_CUMULATIVE";
    cols.set("col-order-class-4", column("col-order-class-4", header(0, "Cari Dönem"), main, false));
    cols.set("col-order-class-5", column("col-order-class-5", header(1, "Önceki Dönem"), main, true));
    cols.set("col-order-class-6", column("col-order-class-6", header(2, "Cari Dönem 3 Aylık"), "Q_STANDALONE", false));
    cols.set("col-order-class-7", column("col-order-class-7", header(3, "Önceki Dönem 3 Aylık"), "Q_STANDALONE", true));
  } else {
    // Cash flow statements (51xxxx / 52xxxx) are cumulative.
    const cf: PeriodType = quarter === 1 ? "Q_STANDALONE" : "YTD_CUMULATIVE";
    cols.set("col-order-class-4", column("col-order-class-4", header(0, "Cari Dönem"), cf, false));
    cols.set("col-order-class-5", column("col-order-class-5", header(1, "Önceki Dönem"), cf, true));
  }
  for (const c of cols.values()) withDates(c);
  return cols;
}

/** UTF-8, or Windows-1254 (Turkish) for files that are not valid UTF-8. */
export function decodeKapFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Bun supports the WHATWG legacy encodings; the DOM typings list only UTF-8.
    return new TextDecoder("windows-1254" as "utf-8").decode(bytes);
  }
}

function publishedAt(text: string, fileName: string): string {
  const m = PUBLISHED_RE.exec(text);
  const [, d, mo, y, h, mi, s] = (m ?? []).map(Number);
  const date = m ? isoDate(y as number, mo as number, d as number) : null;
  if (date === null || (h as number) > 23 || (mi as number) > 59 || (s as number) > 61) {
    throw new ParseError(`Unexpected publication time ${pyRepr(text)} in ${fileName}`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(h as number)}:${pad(mi as number)}:${pad(s as number)}`;
}

/** Parse one KAP file. `fileName` is the original file name, which carries the company, disclosure id and period. */
export function parseKapXls(bytes: Uint8Array | string, fileName: string): ParsedFiling {
  const meta = parseFilename(fileName);
  const html = typeof bytes === "string" ? bytes : decodeKapFile(bytes);

  // Values are unscaled; guessing the unit would make every value off by 1,000x or 1,000,000x (#132).
  const scaleMatch = HEADER_SCALE_RE.exec(html);
  if (!scaleMatch) throw new ParseError(`Reporting unit (Sunum Para Birimi) not found in ${fileName}`);
  const scale_unit = cleanText(scaleMatch[1] as string);
  const scale_multiplier = SCALE_MAP[scale_unit.toUpperCase()] ?? SCALE_MAP[scale_unit];
  if (scale_multiplier === undefined)
    throw new ParseError(`Unknown reporting unit ${pyRepr(scale_unit)} in ${fileName}`);

  const publishedMatch = HEADER_PUBLISHED_RE.exec(html);
  if (!publishedMatch) throw new ParseError(`Publication time (Gönderim Tarihi) not found in ${fileName}`);
  const published_at = publishedAt(publishedMatch[1] as string, fileName);

  const consolMatch = HEADER_CONSOL_RE.exec(html);
  const consolidation_type = consolMatch ? cleanText(consolMatch[1] as string) : "Bilinmiyor";

  const roleMatches = [...html.matchAll(ROLE_TABLE_RE)];
  if (roleMatches.length === 0) throw new ParseError(`No XBRL role tables found in ${fileName}`);
  const known = new Set<string>(KNOWN_FAMILIES);
  const unknown = [...new Set(roleMatches.map((m) => m[1] as string))].filter((f) => !known.has(f)).sort();
  if (unknown.length > 0) throw new ParseError(`Unknown template family ${unknown.join(", ")} in ${fileName}`);

  const role_codes: string[] = [];
  const facts: ParsedFinancialFact[] = [];
  const currentColumns: ColumnMeta[] = [];
  let has_tms29_monetary_item = false;
  let title_disagreements = 0;
  let titles_without_text = 0;

  roleMatches.forEach((rm, idx) => {
    const family = rm[1] as string;
    const role_code = rm[2] as string;
    if (!role_codes.includes(role_code)) role_codes.push(role_code);
    const statement_type = classifyStatementRole(role_code);
    // The statement of changes in equity is a matrix of equity components; not extracted as line items yet.
    if (statement_type === "EQUITY_CHANGES") return;

    const start = rm.index as number;
    const end = idx + 1 < roleMatches.length ? (roleMatches[idx + 1]?.index as number) : html.length;
    const table = html.slice(start, end);
    const colMap = buildColumns(statement_type, table.slice(0, 3500), meta.quarter);
    for (const c of colMap.values()) if (!c.is_comparative) currentColumns.push(c);

    const rowMatches = [...table.matchAll(ROW_START_RE)];
    rowMatches.forEach((row, rIdx) => {
      const row_id = row[1] as string;
      const rowEnd = rIdx + 1 < rowMatches.length ? (rowMatches[rIdx + 1]?.index as number) : table.length;
      const chunk = table.slice(row.index as number, rowEnd);

      const label = LABEL_TR_RE.exec(chunk);
      if (!label) return;
      const label_tr = cleanText(label[1] as string);
      if (label_tr.toLowerCase().includes("parasal pozisyon")) has_tms29_monetary_item = true;

      const footnote = FOOTNOTE_RE.exec(chunk);
      let footnote_ref: string | null = footnote ? cleanText(footnote[1] as string) : null;
      if (footnote_ref === "") footnote_ref = null;

      for (const cell of chunk.matchAll(VALUE_CELL_RE)) {
        const col_class = cell[1] as string;
        const inner = cell[2] as string;
        let shown: bigint | null;
        try {
          shown = visibleValue(inner);
        } catch (e) {
          throw new ParseError(`${(e as Error).message} in ${row_id} ${col_class} of ${fileName}`);
        }
        const title = VALUE_TITLE_RE.exec(inner);
        if (title && shown === null) titles_without_text += 1;
        else if (title && BigInt(Math.trunc(Number((title[1] as string).replace(",", ".")))) !== shown) {
          title_disagreements += 1;
        }
        if (shown === null) continue; // empty cell

        const colMeta =
          colMap.get(col_class) ??
          column(
            col_class,
            col_class,
            "UNKNOWN",
            col_class === "col-order-class-5" || col_class === "col-order-class-7",
          );
        facts.push({
          company_code: meta.company_code,
          raw_ticker_group: meta.raw_ticker_group,
          disclosure_id: meta.disclosure_id,
          year: meta.year,
          quarter: meta.quarter,
          consolidation_type,
          template_family: family,
          role_code,
          statement_type,
          row_id,
          label_tr,
          footnote_ref,
          column_class: col_class,
          period_type: colMeta.period_type,
          period_label: colMeta.header_text,
          is_restated_comparative: colMeta.is_comparative,
          raw_value: shown,
          scale_unit,
          scale_multiplier,
          normalized_value_tl: shown * scale_multiplier,
          period_start: colMeta.period_start,
          period_end: colMeta.period_end,
        });
      }
    });
  });

  const [period_start, period_end] = reportingPeriod(currentColumns);
  return {
    file_name: fileName.split(/[\\/]/).pop() ?? fileName,
    company_code: meta.company_code,
    raw_ticker_group: meta.raw_ticker_group,
    disclosure_id: meta.disclosure_id,
    year: meta.year,
    quarter: meta.quarter,
    scale_unit,
    scale_multiplier,
    consolidation_type,
    template_family: roleMatches[0]?.[1] as string,
    role_codes,
    has_tms29_monetary_item,
    facts,
    published_at,
    period_start,
    period_end,
    title_disagreements,
    titles_without_text,
  };
}

/** Length of the reporting period in whole months, or null without header dates. */
export function periodMonths(f: Pick<ParsedFiling, "period_start" | "period_end">): number | null {
  if (f.period_start === null || f.period_end === null) return null;
  const after = nextDay(f.period_end);
  const [ay, am] = after.split("-").map(Number) as [number, number];
  const [sy, sm] = f.period_start.split("-").map(Number) as [number, number];
  return (ay - sy) * 12 + am - sm;
}

/** True when the fiscal year does not start on 1 January (MAVI). */
export function specialFiscalPeriod(f: Pick<ParsedFiling, "period_start">): boolean {
  return f.period_start !== null && !f.period_start.endsWith("-01-01");
}

/** Whether the header period covers `quarter` quarters, as the file name says. */
export function periodMatchesQuarter(f: Pick<ParsedFiling, "period_start" | "period_end" | "quarter">): boolean | null {
  const months = periodMonths(f);
  return months === null ? null : months === 3 * f.quarter;
}
