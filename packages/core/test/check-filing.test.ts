/**
 * `checkFiling` and the tolerance of each check (#183, decision 0006). The filing is KATMR 2026/2 built from its
 * hand-checked golden file, not from the parser. Expected values are the golden numbers and the rules of decision
 * 0006: 5 units for two single values, one unit per formula component for a subtotal; a known filing error keeps
 * the status `fail` and only adds the reason.
 */
import { describe, expect, test } from "bun:test";
import { blockingFailures, checkFiling, type FilingCheck, filingQuality, type ParsedFiling } from "../src/index.ts";
import { filing, katmrFromGolden } from "./helpers.ts";

const AKTVK = 1647085; // the disclosure listed in known-errors.ts

function withValue(f: ParsedFiling, rowId: string, column: string, delta: bigint): ParsedFiling {
  let found = false;
  const facts = f.facts.map((x) => {
    if (x.row_id !== rowId || x.column_class !== column) return x;
    found = true;
    return { ...x, raw_value: x.raw_value + delta, normalized_value_tl: x.normalized_value_tl + delta };
  });
  if (!found) throw new Error(`no fact ${rowId} ${column}`);
  return { ...f, facts };
}
const asDisclosure = (f: ParsedFiling, id: number): ParsedFiling => ({
  ...f,
  disclosure_id: id,
  facts: f.facts.map((x) => ({ ...x, disclosure_id: id })),
});

const ROW5 = "income_statement_row_5_equals_rows_3+4";
const row5 = (checks: FilingCheck[], column: string) =>
  checks.find((c) => c.name === ROW5 && c.left_source === `general_role_310003-row-5 ${column}`) as FilingCheck;
const PARENT_PROFIT = "balance_sheet_profit_equals_parent_profit";

describe("checkFiling", () => {
  test("groups run in a fixed order: reconciliation, income statement, balance sheet, cash flow", () => {
    const groups = checkFiling(katmrFromGolden()).map((c) => c.group);
    const order = groups.filter((g, i) => g !== groups[i - 1]);
    expect(order).toEqual(["reconciliation", "income_statement", "balance_sheet", "cash_flow"]);
  });

  test("the same filing gives the same results in the same order", () => {
    expect(checkFiling(katmrFromGolden())).toEqual(checkFiling(katmrFromGolden()));
  });

  test("a filing without values has no checks", () => {
    expect(checkFiling(filing())).toEqual([]);
  });

  test("a subtotal check has one row per column, told apart by left_source", () => {
    const sources = checkFiling(katmrFromGolden())
      .filter((c) => c.name === ROW5)
      .map((c) => c.left_source);
    expect(sources).toEqual([
      "general_role_310003-row-5 col-order-class-4",
      "general_role_310003-row-5 col-order-class-5",
      "general_role_310003-row-5 col-order-class-6",
      "general_role_310003-row-5 col-order-class-7",
    ]);
  });

  test("a check that is not run still names its row and column, and has no tolerance", () => {
    const notChecked = checkFiling(katmrFromGolden()).filter((c) => c.status === "not_checked");
    expect(notChecked.length).toBeGreaterThan(0);
    for (const c of notChecked) {
      expect(c.tolerance).toBeNull();
      expect(c.reason).not.toBeNull();
      if (c.name.includes("_row_")) expect(c.left_source).toMatch(/-row-\d+ col-order-class-\d+$/);
    }
  });
});

describe("tolerance (decision 0006)", () => {
  test("five units for two single values", () => {
    const c = checkFiling(katmrFromGolden()).find(
      (x) => x.name === "total_assets_equal_liabilities_and_equity_current",
    );
    expect(c).toMatchObject({ left: 14795418421n, right: 14795418421n, status: "pass", tolerance: 5n });
  });

  test("one unit per formula component for a subtotal, reported or not", () => {
    const checks = checkFiling(katmrFromGolden());
    expect(row5(checks, "col-order-class-4")).toMatchObject({ left: 518267459n, right: 518267459n, tolerance: 2n });
    // Row 38 has seven components; the golden file has only row 31 of them, and the tolerance is still 7.
    const row38 = checks.find((c) => c.name === "income_statement_row_38_equals_rows_31+32+33+34+35+36+37");
    expect(row38).toMatchObject({ right_source: "general_role_310003-row-31", tolerance: 7n });
  });

  test("a subtotal passes at exactly its tolerance and fails one unit beyond", () => {
    const at = (delta: bigint) =>
      row5(
        checkFiling(withValue(katmrFromGolden(), "general_role_310003-row-5", "col-order-class-4", delta)),
        "col-order-class-4",
      ).status;
    expect([at(-2n), at(2n)]).toEqual(["pass", "pass"]);
    expect([at(-3n), at(3n)]).toEqual(["fail", "fail"]);
  });

  test("checked results always carry their tolerance", () => {
    for (const c of checkFiling(katmrFromGolden()).filter((x) => x.status !== "not_checked")) {
      expect(c.tolerance).not.toBeNull();
    }
  });
});

describe("known filing errors", () => {
  const broken = () =>
    asDisclosure(withValue(katmrFromGolden(), "general_role_210015-row-294", "col-order-class-4", 1000n), AKTVK);

  test("a listed blocking failure keeps status fail and gets the reason", () => {
    const c = checkFiling(broken()).find((x) => x.name === PARENT_PROFIT) as FilingCheck;
    expect(c.status).toBe("fail");
    expect(c.severity).toBe("blocking");
    expect(c.known_error).toContain("AKTVK 2026/2");
  });

  test("the report stays blocked", () => {
    expect(blockingFailures(checkFiling(broken())).map((c) => c.name)).toContain(PARENT_PROFIT);
  });

  test("only the listed check of the listed disclosure gets a reason", () => {
    const checks = checkFiling(broken());
    // Row 38 fails in the golden file (its components are not all in it): a blocking failure, but not listed.
    const others = checks.filter((c) => c.name !== PARENT_PROFIT);
    expect(others.some((c) => c.severity === "blocking" && c.status === "fail")).toBe(true);
    expect(others.every((c) => c.known_error === null)).toBe(true);
    // The same failure in another disclosure is not a known error.
    const elsewhere = checkFiling(
      withValue(katmrFromGolden(), "general_role_210015-row-294", "col-order-class-4", 1000n),
    );
    expect(elsewhere.find((c) => c.name === PARENT_PROFIT)).toMatchObject({ status: "fail", known_error: null });
    // The listed check passing has no reason.
    const passing = checkFiling(asDisclosure(katmrFromGolden(), AKTVK));
    expect(passing.find((c) => c.name === PARENT_PROFIT)).toMatchObject({ status: "pass", known_error: null });
  });

  test("the quality report counts it as a known error, not a failure", () => {
    const q = filingQuality(broken());
    const failures = checkFiling(broken()).filter(
      (c) => c.severity === "blocking" && c.status === "fail" && c.known_error === null,
    ).length;
    expect(q.known_errors).toBe(1);
    expect(q.failed).toBe(failures);
    expect(q.error).toContain("AKTVK 2026/2");
  });
});
