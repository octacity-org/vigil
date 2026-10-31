/**
 * Per-file data quality (#19): parse status, template, scale and the result of every check.
 * Exit criterion of Phase 0: every file either passes all blocking checks, or the reason it does not is recorded.
 */
import {
  balanceSheetSubtotals,
  type CheckResult,
  cashFlowSubtotals,
  difference,
  incomeStatementSubtotals,
  reconcile,
} from "./checks.ts";
import { KNOWN_FILING_ERRORS, knownErrorKey } from "./known-errors.ts";
import { type ParsedFiling, parseKapXls, periodMatchesQuarter } from "./parser.ts";

export const GROUPS: Record<string, (filing: ParsedFiling) => CheckResult[]> = {
  reconciliation: reconcile,
  income_statement: incomeStatementSubtotals,
  balance_sheet: balanceSheetSubtotals,
  cash_flow: cashFlowSubtotals,
};

export type QualityStatus = "pass" | "fail" | "known_error" | "not_checked" | "no_values" | "parse_error";

export interface FileQuality {
  file: string;
  status: QualityStatus;
  company: string | null;
  disclosure_id: number | null;
  year: number | null;
  quarter: number | null;
  period_start: string | null;
  period_end: string | null;
  /** False when the header period does not cover `quarter` quarters (#36); null without header dates. */
  period_matches_quarter: boolean | null;
  template: string | null;
  scale_unit: string | null;
  facts: number;
  passed: number;
  failed: number;
  not_checked: number;
  informational_differences: number;
  /** Blocking failures confirmed as errors in the filing (known-errors.ts). */
  known_errors: number;
  title_disagreements: number;
  titles_without_text: number;
  first_failure: string;
  error: string;
  counts: Record<string, Record<string, number>>;
}

function emptyRow(file: string, status: QualityStatus): FileQuality {
  return {
    file,
    status,
    company: null,
    disclosure_id: null,
    year: null,
    quarter: null,
    period_start: null,
    period_end: null,
    period_matches_quarter: null,
    template: null,
    scale_unit: null,
    facts: 0,
    passed: 0,
    failed: 0,
    not_checked: 0,
    informational_differences: 0,
    known_errors: 0,
    title_disagreements: 0,
    titles_without_text: 0,
    first_failure: "",
    error: "",
    counts: {},
  };
}

function describe(r: CheckResult): string {
  return `${r.name} at ${r.left_source}: ${r.left} vs ${r.right} (difference ${difference(r)})`;
}

/** Quality of one file, from its contents. Every failure is reported, never skipped. */
export function fileQuality(fileName: string, contents: Uint8Array | string): FileQuality {
  let filing: ParsedFiling;
  try {
    filing = parseKapXls(contents, fileName);
  } catch (e) {
    const err = e as Error;
    return { ...emptyRow(fileName, "parse_error"), error: `${err.name}: ${err.message}` };
  }
  return filingQuality(filing);
}

/** Quality of a parsed filing. */
export function filingQuality(filing: ParsedFiling): FileQuality {
  const row: FileQuality = {
    ...emptyRow(filing.file_name, "not_checked"),
    company: filing.company_code,
    disclosure_id: filing.disclosure_id,
    year: filing.year,
    quarter: filing.quarter,
    period_start: filing.period_start,
    period_end: filing.period_end,
    period_matches_quarter: periodMatchesQuarter(filing),
    template: filing.template_family,
    scale_unit: filing.scale_unit,
    facts: filing.facts.length,
    title_disagreements: filing.title_disagreements,
    titles_without_text: filing.titles_without_text,
  };
  if (filing.facts.length === 0) {
    row.status = "no_values";
    row.error = "the parser found no values in this file";
    return row;
  }

  for (const [group, check] of Object.entries(GROUPS)) {
    const counts: Record<string, number> = {};
    for (const r of check(filing)) {
      const informational = r.severity === "informational" && r.status === "fail";
      const k = informational ? "difference" : r.status;
      counts[k] = (counts[k] ?? 0) + 1;
      if (r.status === "not_checked") {
        row.not_checked += 1;
      } else if (r.severity === "informational") {
        if (r.status === "fail") row.informational_differences += 1;
      } else if (r.status === "pass") {
        row.passed += 1;
      } else {
        const known = KNOWN_FILING_ERRORS.get(knownErrorKey(filing.disclosure_id, r.name));
        if (known !== undefined) {
          row.known_errors += 1;
          row.error = known;
        } else {
          row.failed += 1;
          if (!row.first_failure) row.first_failure = describe(r);
        }
      }
    }
    row.counts[group] = counts;
  }

  if (row.failed) row.status = "fail";
  else if (row.known_errors) row.status = "known_error";
  else if (row.passed) row.status = "pass";
  return row;
}

export const CSV_COLUMNS = [
  "file",
  "status",
  "company",
  "disclosure_id",
  "year",
  "quarter",
  "period_start",
  "period_end",
  "period_matches_quarter",
  "template",
  "scale_unit",
  "facts",
  "passed",
  "failed",
  "not_checked",
  "informational_differences",
  "known_errors",
  "title_disagreements",
  "titles_without_text",
  "first_failure",
  "error",
] as const satisfies readonly (keyof FileQuality)[];

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The report as CSV, one row per file. */
export function toCsv(rows: readonly FileQuality[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** A Markdown summary of the report. */
export function markdownSummary(rows: readonly FileQuality[], title: string): string {
  const byStatus = (s: QualityStatus) => rows.filter((r) => r.status === s).length;
  const lines = [
    `# Data quality: ${title}`,
    "",
    `${rows.length} files.`,
    "",
    "| Status | Files | Meaning |",
    "|---|---|---|",
    `| pass | ${byStatus("pass")} | every blocking check that could run passed |`,
    `| fail | ${byStatus("fail")} | at least one blocking check failed |`,
    `| known_error | ${byStatus("known_error")} | failures confirmed as errors in the filing (still blocked) |`,
    `| not_checked | ${byStatus("not_checked")} | template not supported by the checks yet |`,
    `| no_values | ${byStatus("no_values")} | parsed, but no values found |`,
    `| parse_error | ${byStatus("parse_error")} | the parser raised an error |`,
    "",
    "| Checks | Pass | Fail | Not checked | Informational difference |",
    "|---|---|---|---|---|",
  ];
  for (const group of Object.keys(GROUPS)) {
    const c = (k: string) => rows.reduce((n, r) => n + (r.counts[group]?.[k] ?? 0), 0);
    lines.push(`| ${group} | ${c("pass")} | ${c("fail")} | ${c("not_checked")} | ${c("difference")} |`);
  }
  const sum = (f: (r: FileQuality) => number) => rows.reduce((n, r) => n + f(r), 0);
  const filesWith = (f: (r: FileQuality) => number) => rows.filter((r) => f(r) > 0).length;
  lines.push(
    "",
    "Cash differences between the cash flow statement and the balance sheet (informational, decision 0003): " +
      `${sum((r) => r.informational_differences)} in ${filesWith((r) => r.informational_differences)} files.`,
    "",
    "Cells whose `title` is a different number than the visible text (the text is used, decision 0005): " +
      `${sum((r) => r.title_disagreements)} in ${filesWith((r) => r.title_disagreements)} files.`,
    "",
    "Cells with a `title` but no visible text (treated as empty): " +
      `${sum((r) => r.titles_without_text)} in ${filesWith((r) => r.titles_without_text)} files.`,
  );
  const special = rows.filter((r) => r.period_start && !r.period_start.endsWith("-01-01"));
  if (special.length > 0) {
    const items = special.map((r) => `${r.company} (${r.period_start} to ${r.period_end})`);
    lines.push("", `Fiscal year not starting on 1 January: ${items.join(", ")}.`);
  }
  const mismatched = rows.filter((r) => r.period_matches_quarter === false);
  const undated = rows.filter((r) => r.status !== "parse_error" && r.period_end === null);
  if (mismatched.length > 0 || undated.length > 0) {
    const items = [
      ...mismatched.map((r) => `${r.file} (header ${r.period_start} to ${r.period_end}, file name Q${r.quarter})`),
      ...undated.map((r) => `${r.file} (no header dates)`),
    ];
    lines.push("", `Period to check by hand: ${items.join(", ")}.`);
  }
  const problems = rows.filter((r) => ["fail", "known_error", "no_values", "parse_error"].includes(r.status));
  if (problems.length > 0) {
    lines.push("", "| File | Status | Detail |", "|---|---|---|");
    for (const r of problems) lines.push(`| ${r.file} | ${r.status} | ${r.first_failure || r.error} |`);
  }
  return `${lines.join("\n")}\n`;
}
