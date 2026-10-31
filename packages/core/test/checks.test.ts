/**
 * Cross-statement reconciliation (#18) and subtotals (#15, #16, #17). Facts are built by hand or from the
 * hand-checked golden file, not from parser output, so the tests run in CI without KAP data.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BALANCE_SHEET_SUBTOTALS,
  balanceSheetSubtotals,
  blockingFailures,
  CASH_FLOW_SUBTOTALS,
  type CheckResult,
  cashFlowSubtotals,
  difference,
  INCOME_STATEMENT_SUBTOTALS,
  incomeStatementSubtotals,
  type ParsedFiling,
  parseKapXls,
  reconcile,
} from "../src/index.ts";
import { fact, filing, katmrFromGolden, rawFile } from "./helpers.ts";

const byName = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.name, r]));

function withValue(f: ParsedFiling, rowId: string, column: string, value: bigint): ParsedFiling {
  return {
    ...f,
    facts: f.facts.map((x) => (x.row_id === rowId && x.column_class === column ? { ...x, raw_value: value } : x)),
  };
}

describe("reconciliation", () => {
  test("KATMR passes all checks", () => {
    const results = reconcile(katmrFromGolden());
    expect(results.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(blockingFailures(results)).toEqual([]);
    const profit = byName(results).balance_sheet_profit_equals_parent_profit;
    expect([profit?.left, profit?.right]).toEqual([318919663n, 318919663n]);
  });

  test("an unbalanced balance sheet is a blocking failure", () => {
    const results = reconcile(
      withValue(katmrFromGolden(), "general_role_210015-row-297", "col-order-class-4", 14795418421n + 1000n),
    );
    const check = byName(results).total_assets_equal_liabilities_and_equity_current as CheckResult;
    expect([check.status, check.severity, difference(check)]).toEqual(["fail", "blocking", -1000n]);
    expect(blockingFailures(results).map((r) => r.name)).toEqual(["total_assets_equal_liabilities_and_equity_current"]);
  });

  test("a cash difference is informational", () => {
    const results = reconcile(
      withValue(katmrFromGolden(), "general_role_210015-row-4", "col-order-class-4", 120759073n + 53000n),
    );
    const check = byName(results).cash_flow_end_cash_equals_balance_sheet_cash as CheckResult;
    expect([check.status, check.severity]).toEqual(["fail", "informational"]);
    expect(blockingFailures(results)).toEqual([]);
  });

  test("a one-unit difference is rounding", () => {
    const check = byName(
      reconcile(withValue(katmrFromGolden(), "general_role_210015-row-4", "col-order-class-5", 450940942n + 1n)),
    ).cash_flow_begin_cash_equals_prior_balance_sheet_cash as CheckResult;
    expect(check.status).toBe("pass");
    expect(difference(check)).toBe(-1n);
  });

  test("the single-value tolerance is five units (#148, decision 0006)", () => {
    // GEREL, USAK, ARMGD, BVSAN differ by 2 to 4 units.
    const status = (delta: bigint) =>
      byName(
        reconcile(withValue(katmrFromGolden(), "general_role_210015-row-294", "col-order-class-4", 318919663n + delta)),
      ).balance_sheet_profit_equals_parent_profit?.status;
    expect([-5n, -4n, 4n, 5n].map(status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect([-6n, 6n].map(status)).toEqual(["fail", "fail"]);
  });

  test("an unsupported template is not checked", () => {
    const results = reconcile({ ...katmrFromGolden(), template_family: "banks" });
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["not_checked"]));
    expect(results[0]?.reason).toContain("banks");
  });

  test("an unexpected label is not checked", () => {
    const f = katmrFromGolden();
    const facts = f.facts.map((x) =>
      x.row_id === "general_role_210015-row-129" ? { ...x, label_tr: "Başka Bir Kalem" } : x,
    );
    const check = byName(reconcile({ ...f, facts })).total_assets_equal_liabilities_and_equity_current as CheckResult;
    expect(check.status).toBe("not_checked");
    expect(check.reason).toContain("Başka Bir Kalem");
  });
});

// --- subtotals -----------------------------------------------------------------------------------------------------

const labelsOf = (formulas: readonly (readonly [number, string, readonly number[]])[]) =>
  new Map(formulas.map(([row, label]) => [row, label]));
const IS_LABELS = labelsOf(INCOME_STATEMENT_SUBTOTALS);
const BS_LABELS = labelsOf(BALANCE_SHEET_SUBTOTALS);
const CF_LABELS = labelsOf(CASH_FLOW_SUBTOTALS);
const COL = "col-order-class-4";

function makeFiling(
  values: Record<number, number>,
  family = "general",
  role = "310003",
  labels = IS_LABELS,
): ParsedFiling {
  const facts = Object.entries(values).map(([row, value]) =>
    fact({
      template_family: family,
      role_code: role,
      statement_type: "INCOME_STATEMENT",
      row_id: `${family}_role_${role}-row-${row}`,
      label_tr: labels.get(Number(row)) ?? `row ${row}`,
      column_class: COL,
      period_type: "YTD_CUMULATIVE",
      raw_value: BigInt(value),
      normalized_value_tl: BigInt(value),
    }),
  );
  return filing({ template_family: family, role_codes: [role], has_tms29_monetary_item: true, facts });
}

const statuses = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));

// A consistent income statement (values in TL, costs negative). Rows not listed are unreported.
const CONSISTENT: Record<number, number> = {
  3: 1000, // revenue
  4: -600, // cost of sales
  5: 400, // commercial gross profit
  31: 400, // gross profit
  32: -100, // general administrative expenses
  33: -50, // marketing expenses
  35: 30, // other operating income
  38: 280, // operating profit
  41: 20, // income from investing activities
  42: -36, // expenses from investing activities (KATMR row 42 in miniature)
  49: 264, // operating profit before finance
  51: -64, // finance expenses
  52: 10, // net monetary position
  53: 210, // profit before tax
  55: -40, // current tax
  56: 5, // deferred tax
  54: -35, // tax
  57: 175, // profit from continuing operations
  59: 175, // profit
  61: 5, // non-controlling interests
  62: 170, // parent
};

describe("income statement subtotals", () => {
  test("a consistent statement passes", () => {
    const results = incomeStatementSubtotals(makeFiling(CONSISTENT));
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["pass"]));
  });

  test("a moved value breaks the subtotal (#14 in miniature)", () => {
    const values = { ...CONSISTENT };
    delete values[42];
    values[43] = -36;
    expect(new Set(incomeStatementSubtotals(makeFiling(values)).map((r) => r.status))).toEqual(new Set(["pass"]));
    delete values[43];
    const failed = incomeStatementSubtotals(makeFiling(values)).filter((r) => r.status === "fail");
    expect(failed.map((r) => r.name)).toEqual(["income_statement_row_49_equals_rows_38+39+40+41+42+43+44+45+46+47+48"]);
    expect(difference(failed[0] as CheckResult)).toBe(-36n);
  });

  test("rounding within the number of components", () => {
    // 3 + 4 = 400; two components allow a difference of 2.
    expect(
      statuses(incomeStatementSubtotals(makeFiling({ ...CONSISTENT, 5: 401 })))[
        "income_statement_row_5_equals_rows_3+4"
      ],
    ).toBe("pass");
    expect(
      statuses(incomeStatementSubtotals(makeFiling({ ...CONSISTENT, 5: 403 })))[
        "income_statement_row_5_equals_rows_3+4"
      ],
    ).toBe("fail");
  });

  test("a total without components is not checked", () => {
    // Finance sector revenue and cost reported without their breakdown (rows 7-16 and 18-28 empty).
    const results = incomeStatementSubtotals(makeFiling({ ...CONSISTENT, 6: 50, 17: -50, 29: 0 })).filter((r) =>
      r.name.startsWith("income_statement_row_6_"),
    );
    expect(results.map((r) => r.status)).toEqual(["not_checked"]);
    expect(results[0]?.reason).toContain("components not reported");
  });

  test("an unexpected label is not checked", () => {
    const f = makeFiling(CONSISTENT);
    const facts = f.facts.map((x) => (x.row_id.endsWith("-row-38") ? { ...x, label_tr: "Başka Bir Kalem" } : x));
    expect(
      statuses(incomeStatementSubtotals({ ...f, facts }))["income_statement_row_38_equals_rows_31+32+33+34+35+36+37"],
    ).toBe("not_checked");
  });

  test("other templates and empty filings are not checked", () => {
    const bank = incomeStatementSubtotals(makeFiling(CONSISTENT, "banks", "310017"));
    expect(bank.map((r) => r.status)).toEqual(["not_checked"]);
    const empty = incomeStatementSubtotals(makeFiling({}));
    expect(empty.map((r) => r.status)).toEqual(["not_checked"]);
    expect(empty[0]?.reason).toContain("no income statement values");
  });
});

// A consistent balance sheet: cash 100, trade receivables 50, PP&E 300; trade payables 80, deferred tax 20;
// paid-in capital 300 and profit 50.
const BALANCE_SHEET: Record<number, number> = {
  4: 100,
  24: 50,
  22: 50,
  52: 150,
  55: 150,
  95: 300,
  128: 300,
  129: 450,
  160: 80,
  158: 80,
  188: 80,
  191: 80,
  237: 20,
  241: 20,
  242: 100,
  245: 300,
  294: 50,
  244: 350,
  296: 350,
  297: 450,
};
const balanceSheet = (values: Record<number, number>, family = "general") =>
  makeFiling(values, family, "210015", BS_LABELS);

describe("balance sheet subtotals", () => {
  test("a consistent balance sheet passes", () => {
    for (const family of ["general", "holding"]) {
      const results = balanceSheetSubtotals(balanceSheet(BALANCE_SHEET, family));
      expect(new Set(results.map((r) => r.status))).toEqual(new Set(["pass", "not_checked"]));
    }
    const names = new Set(
      balanceSheetSubtotals(balanceSheet(BALANCE_SHEET))
        .filter((r) => r.status === "pass")
        .map((r) => r.name),
    );
    expect(names.has("balance_sheet_row_297_equals_rows_242+296")).toBe(true);
    expect(names.has("balance_sheet_row_129_equals_rows_55+128")).toBe(true);
  });

  test("a component mismatch fails only its group", () => {
    // The receivables breakdown no longer adds up to row 22.
    const failed = balanceSheetSubtotals(balanceSheet({ ...BALANCE_SHEET, 24: 60 })).filter((r) => r.status === "fail");
    expect(failed.map((r) => [r.name, difference(r)])).toEqual([["balance_sheet_row_22_equals_rows_23+24", -10n]]);
  });

  test("other templates are not checked", () => {
    const bank = balanceSheetSubtotals(makeFiling(BALANCE_SHEET, "banks", "210011", BS_LABELS));
    expect(bank.map((r) => r.status)).toEqual(["not_checked"]);
  });
});

// A consistent cash flow statement. Row 60 (disposal of associates) sits directly under row 6, and row 53 (disposal
// of non-current assets) is left empty, as in ODAS and CANTE 2026/2.
const CASH_FLOW: Record<number, number> = {
  4: 100,
  3: 100,
  7: 20,
  60: -10,
  6: 10,
  81: 30,
  65: 30,
  102: 140,
  2: 140,
  134: -50,
  133: -50,
  120: -50,
  179: 40,
  178: 40,
  184: -60,
  183: -60,
  195: -10,
  162: -30,
  204: 60,
  205: -5,
  206: 55,
  207: 100,
  209: 155,
};
const cashFlow = (values: Record<number, number>) => makeFiling(values, "general", "520003", CF_LABELS);

describe("cash flow subtotals", () => {
  test("a consistent cash flow statement passes", () => {
    const results = cashFlowSubtotals(cashFlow(CASH_FLOW));
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    const names = new Set(results.filter((r) => r.status === "pass").map((r) => r.name));
    expect(names.has("cash_flow_row_102_equals_rows_3+6+65")).toBe(true);
    expect(names.has("cash_flow_row_209_equals_rows_206+207+208")).toBe(true);
    expect(results.filter((r) => r.name.startsWith("cash_flow_row_53_"))).toEqual([]);
  });

  test("an unreported group total counts through its components", () => {
    const values = { ...CASH_FLOW };
    delete values[133]; // capex reported only in its breakdown (row 134)
    const results = cashFlowSubtotals(cashFlow(values));
    const capex = byName(results)["cash_flow_row_133_equals_rows_134+135"] as CheckResult;
    expect(capex.status).toBe("not_checked");
    expect(capex.reason).toContain("total not reported");
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
  });

  test("a mismatch fails", () => {
    const failed = cashFlowSubtotals(cashFlow({ ...CASH_FLOW, 209: 160 })).filter((r) => r.status === "fail");
    expect(failed.map((r) => [r.name, difference(r)])).toEqual([["cash_flow_row_209_equals_rows_206+207+208", 5n]]);
  });
});

const katmr = rawFile("2026_2", "KATMR_1651411_2026_2.xls");

test.skipIf(katmr === null)("KATMR subtotals pass (raw file)", () => {
  const f = parseKapXls(readFileSync(katmr as string), "KATMR_1651411_2026_2.xls");
  const results = incomeStatementSubtotals(f);
  expect(results).toHaveLength(36);
  expect(new Set(results.map((r) => r.status))).toEqual(new Set(["pass"]));
  expect(balanceSheetSubtotals(f).filter((r) => r.status === "fail")).toEqual([]);
  expect(cashFlowSubtotals(f).filter((r) => r.status === "fail")).toEqual([]);
});
