/**
 * Three-month gross margin and its year-on-year change (#61). Expected values: docs/VIGIL.md's worked example (KATMR
 * 2nd quarter 2026: 21.5% vs 47.5%, −26.0 points), from the hand-checked golden file
 * `tests/golden/2026_2/KATMR_1651411.csv`: 189,492,068 / 879,599,263 and 330,145,727 / 694,991,758.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  grossMargin,
  marginChangePoints,
  notReported,
  ok,
  type ParsedFiling,
  type ParsedFinancialFact,
  parseKapXls,
  threeMonthGrossMargin,
} from "../src/index.ts";
import { fact, filing, katmrFromGolden, periodFromLabel, RAW_DIR, rawFile } from "./helpers.ts";

const ROLE = "310003";

/** An income statement cell. */
function cell(row: number, column: string, label: string, value: bigint): ParsedFinancialFact {
  return fact({
    role_code: ROLE,
    statement_type: "INCOME_STATEMENT",
    row_id: `general_role_${ROLE}-row-${row}`,
    column_class: column,
    period_label: label,
    ...periodFromLabel(label),
    is_restated_comparative: label.includes("Önceki Dönem"),
    raw_value: value,
    normalized_value_tl: value,
  });
}

function report(facts: ParsedFinancialFact[], fields: Partial<ParsedFiling> = {}): ParsedFiling {
  return filing({ role_codes: [ROLE], period_start: "2026-01-01", period_end: "2026-06-30", facts, ...fields });
}

describe("KATMR 2026/2 (done when)", () => {
  const m = threeMonthGrossMargin(katmrFromGolden());

  test("2nd quarter 21.5% vs 47.5%, from the 3-month columns", () => {
    expect(m.columns).toEqual({ current: "col-order-class-6", prior_year: "col-order-class-7" });
    expect(m.current).toEqual(ok(189_492_068 / 879_599_263));
    expect(m.prior_year).toEqual(ok(330_145_727 / 694_991_758));
    expect(m.current.status === "ok" && (m.current.value * 100).toFixed(1)).toBe("21.5");
    expect(m.prior_year.status === "ok" && (m.prior_year.value * 100).toFixed(1)).toBe("47.5");
  });

  test("the change is −26.0 points (−2,596 bps, as S1)", () => {
    expect(m.change_points.status).toBe("ok");
    const points = m.change_points.status === "ok" ? m.change_points.value : Number.NaN;
    expect(points.toFixed(1)).toBe("-26.0");
    expect(Math.round(points * 100)).toBe(-2596);
  });

  test("the cumulative 6-month margin (33.2% vs 46.2%) is not what it returns", () => {
    const cumulative = grossMargin(518_267_459n, 1_558_895_376n);
    expect(cumulative.status === "ok" && (cumulative.value * 100).toFixed(1)).toBe("33.2");
    expect(m.current).not.toEqual(cumulative);
  });
});

describe("which columns", () => {
  test("1st quarter: the cumulative columns are the quarter", () => {
    const cur = "Cari Dönem 01.01.2026 - 31.03.2026";
    const prior = "Önceki Dönem 01.01.2025 - 31.03.2025";
    const m = threeMonthGrossMargin(
      report(
        [
          cell(3, "col-order-class-4", cur, 1_000n),
          cell(31, "col-order-class-4", cur, 484n),
          cell(3, "col-order-class-5", prior, 1_000n),
          cell(31, "col-order-class-5", prior, 449n),
        ],
        { quarter: 1, period_end: "2026-03-31" },
      ),
    );
    expect(m.columns).toEqual({ current: "col-order-class-4", prior_year: "col-order-class-5" });
    expect(m.change_points.status === "ok" && m.change_points.value.toFixed(1)).toBe("3.5");
  });

  test("a report without 3-month columns (year end) is not computable, naming what derivation needs (#48)", () => {
    const cur = "Cari Dönem 01.01.2025 - 31.12.2025";
    const m = threeMonthGrossMargin(
      report([cell(3, "col-order-class-4", cur, 1_000n), cell(31, "col-order-class-4", cur, 400n)], {
        quarter: 4,
        period_end: "2025-12-31",
      }),
    );
    expect(m.columns).toEqual({ current: null, prior_year: null });
    expect(m.current).toMatchObject({
      status: "not_computable",
      reason: { code: "period_mismatch", needs: ["gross_profit:three_month", "revenue:three_month"] },
    });
    expect(m.change_points).toMatchObject({ status: "not_computable", reason: { code: "missing_input" } });
  });

  test("a 3-month column of another period is not taken for this quarter", () => {
    // The current 3-month column ends at 31.03, not at the report's period end.
    const m = threeMonthGrossMargin(
      report([
        cell(3, "col-order-class-6", "Cari Dönem 3 Aylık 01.01.2026 - 31.03.2026", 1_000n),
        cell(31, "col-order-class-6", "Cari Dönem 3 Aylık 01.01.2026 - 31.03.2026", 400n),
      ]),
    );
    expect(m.columns.current).toBeNull();
  });
});

describe("not computable, never 0", () => {
  const cur = "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026";
  const prior = "Önceki Dönem 3 Aylık 01.04.2025 - 30.06.2025";

  test("gross profit left empty: missing input, gross_profit", () => {
    const m = threeMonthGrossMargin(
      report([
        cell(3, "col-order-class-6", cur, 1_000n),
        cell(3, "col-order-class-7", prior, 1_000n),
        cell(31, "col-order-class-7", prior, 400n),
      ]),
    );
    expect(m.current).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["gross_profit"] },
    });
    expect(m.prior_year).toEqual(ok(0.4));
    expect(m.change_points.status).toBe("not_computable");
  });

  test("zero revenue: zero denominator", () => {
    const m = threeMonthGrossMargin(
      report([cell(3, "col-order-class-6", cur, 0n), cell(31, "col-order-class-6", cur, 5n)]),
    );
    expect(m.current).toMatchObject({ status: "not_computable", reason: { code: "zero_denominator" } });
  });

  test("a bank has no gross margin: not applicable", () => {
    const m = threeMonthGrossMargin(filing({ template_family: "banks" }));
    expect(m.current).toMatchObject({ status: "not_computable", reason: { code: "not_applicable" } });
    expect(m.change_points).toMatchObject({ status: "not_computable", reason: { code: "not_applicable" } });
  });

  test("marginChangePoints names the missing side", () => {
    expect(marginChangePoints(0.2, notReported())).toMatchObject({
      status: "not_computable",
      reason: { needs: ["gross_margin:prior_year"] },
    });
    expect(marginChangePoints(0.25, 0.2)).toEqual(ok((0.25 - 0.2) * 100));
  });
});

const have = rawFile("2026_2", "KATMR_1651411_2026_2.xls") !== null;
test.skipIf(!have)("KATMR's KAP file gives the same −26.0 points as its golden file", () => {
  const name = "KATMR_1651411_2026_2.xls";
  const m = threeMonthGrossMargin(parseKapXls(readFileSync(join(RAW_DIR, "2026_2", name)), name));
  expect(m).toEqual(threeMonthGrossMargin(katmrFromGolden()));
});
