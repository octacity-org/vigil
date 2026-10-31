/** Shared test helpers: hand-built facts and filings, golden files, raw file paths. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedFiling, ParsedFinancialFact } from "../src/index.ts";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const GOLDEN_DIR = join(REPO, "tests", "golden");
export const RAW_DIR = join(REPO, "data", "raw");

/** First line of every synthetic KAP file: the publication time (#157). */
export const PUBLISHED = "<div> Gönderim Tarihi:17.08.2026 19:05:18 </div>";

export function fact(fields: Partial<ParsedFinancialFact> = {}): ParsedFinancialFact {
  return {
    company_code: "TEST",
    raw_ticker_group: "TEST",
    disclosure_id: 1,
    year: 2026,
    quarter: 2,
    consolidation_type: "Konsolide",
    template_family: "general",
    role_code: "210015",
    statement_type: "BALANCE_SHEET",
    row_id: "general_role_210015-row-4",
    label_tr: "Nakit ve Nakit Benzerleri",
    footnote_ref: null,
    column_class: "col-order-class-4",
    period_type: "POINT_IN_TIME",
    period_label: "",
    is_restated_comparative: false,
    raw_value: 0n,
    scale_unit: "TL",
    scale_multiplier: 1n,
    normalized_value_tl: 0n,
    period_start: null,
    period_end: null,
    ...fields,
  };
}

export function filing(fields: Partial<ParsedFiling> = {}): ParsedFiling {
  return {
    file_name: "TEST_1_2026_2.xls",
    company_code: "TEST",
    raw_ticker_group: "TEST",
    disclosure_id: 1,
    year: 2026,
    quarter: 2,
    scale_unit: "TL",
    scale_multiplier: 1n,
    consolidation_type: "Konsolide",
    template_family: "general",
    role_codes: [],
    has_tms29_monetary_item: false,
    facts: [],
    published_at: null,
    period_start: null,
    period_end: null,
    title_disagreements: 0,
    titles_without_text: 0,
    ...fields,
  };
}

/** Parse a CSV with a header row (golden files: UTF-8, comma-separated, quoted fields). */
export function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body
    .filter((r) => r.length > 1 || r[0])
    .map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i] ?? ""])));
}

/** Every golden CSV: [quarter folder, file name, rows]. */
export function goldenFiles(): [string, string, Record<string, string>[]][] {
  const out: [string, string, Record<string, string>[]][] = [];
  for (const quarter of readdirSync(GOLDEN_DIR).sort()) {
    const dir = join(GOLDEN_DIR, quarter);
    if (!existsSync(dir) || quarter.includes(".")) continue;
    for (const name of readdirSync(dir).sort())
      if (name.endsWith(".csv")) out.push([quarter, name, readCsv(join(dir, name))]);
  }
  return out;
}

/** Path of a raw KAP file under data/raw, or null when it has not been downloaded. */
export function rawFile(quarter: string, name: string): string | null {
  const path = join(RAW_DIR, quarter, name);
  return existsSync(path) ? path : null;
}

/** The KATMR 2026/2 filing built from its golden file, not from the parser, so tests run without KAP data. */
export function katmrFromGolden(): ParsedFiling {
  const facts = readCsv(join(GOLDEN_DIR, "2026_2", "KATMR_1651411.csv"))
    .filter((line) => line.raw_value !== "")
    .map((line) =>
      fact({
        company_code: line.company,
        raw_ticker_group: line.company,
        disclosure_id: Number(line.disclosure_id),
        year: Number(line.year),
        quarter: Number(line.quarter),
        consolidation_type: line.consolidation,
        template_family: line.template,
        role_code: (line.table_id as string).split("_").pop() as string,
        statement_type: line.statement as ParsedFinancialFact["statement_type"],
        row_id: line.row_id,
        label_tr: line.row_label,
        column_class: line.column,
        period_type: "UNKNOWN",
        period_label: line.period_label,
        raw_value: BigInt(line.raw_value as string),
        scale_unit: line.scale_unit,
        normalized_value_tl: BigInt(line.value_tl as string),
      }),
    );
  return filing({
    company_code: "KATMR",
    raw_ticker_group: "KATMR",
    disclosure_id: 1651411,
    role_codes: ["210015", "310003", "520003"],
    has_tms29_monetary_item: true,
    facts,
  });
}
