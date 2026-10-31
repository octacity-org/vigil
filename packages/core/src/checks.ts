/**
 * Consistency checks on one filing (#15-#18, decisions 0003 and 0006).
 *
 * Every check compares values from the same filing, so both are in the same reporting unit and purchasing power.
 * Supported templates: `general` and `holding`, which share the balance sheet and cash flow layout. Other
 * templates are reported as `not_checked` with the reason; nothing is guessed.
 *
 * - `blocking`: the balance sheet balances, its profit equals the parent-company profit, and every subtotal equals
 *   the sum of its components. A filing that fails one of these produces no findings.
 * - `informational`: cash in the cash flow statement versus cash in the balance sheet (IAS 7 allows a different
 *   definition of cash; the difference is reported but does not block the filing).
 */
import {
  BALANCE_SHEET_COLUMNS,
  BALANCE_SHEET_ROLES,
  BALANCE_SHEET_SUBTOTALS,
  CASH_FLOW_COLUMNS,
  CASH_FLOW_ROLES,
  CASH_FLOW_SUBTOTALS,
  type Formula,
  INCOME_STATEMENT_COLUMNS,
  INCOME_STATEMENT_ROLES,
  INCOME_STATEMENT_SUBTOTALS,
} from "./formulas.ts";
import type { ParsedFiling, ParsedFinancialFact } from "./parser.ts";
import { pyRepr } from "./text.ts";

export const SUPPORTED_FAMILIES = ["general", "holding"] as const;
export const CURRENT = "col-order-class-4";
export const PRIOR = "col-order-class-5";

/** One unit of the reporting unit (1 TL, 1,000 TL or 1,000,000 TL) per component of a subtotal. */
export const ROUNDING_TOLERANCE = 1n;
/**
 * Two reported figures compared directly (e.g. balance sheet profit vs parent-company profit) may each be the result
 * of several rounded amounts; 2026/1-2 show differences of 2 to 4 units (#148, decision 0006).
 */
export const SINGLE_VALUE_TOLERANCE = 5n;

export type Severity = "blocking" | "informational";
export type CheckStatus = "pass" | "fail" | "not_checked";

export interface CheckResult {
  name: string;
  severity: Severity;
  status: CheckStatus;
  /** Raw values, in the filing's reporting unit. */
  left: bigint | null;
  right: bigint | null;
  /** "row_id column" */
  left_source: string | null;
  right_source: string | null;
  reason: string | null;
}

export function result(
  name: string,
  severity: Severity,
  status: CheckStatus,
  fields: Partial<Pick<CheckResult, "left" | "right" | "left_source" | "right_source" | "reason">> = {},
): CheckResult {
  return {
    name,
    severity,
    status,
    left: fields.left ?? null,
    right: fields.right ?? null,
    left_source: fields.left_source ?? null,
    right_source: fields.right_source ?? null,
    reason: fields.reason ?? null,
  };
}

export function difference(r: Pick<CheckResult, "left" | "right">): bigint | null {
  return r.left === null || r.right === null ? null : r.left - r.right;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/** (role code, row number) candidates and the label that must be on that row. */
type RowSpec = readonly [readonly (readonly [string, number])[], string];

// The label guards against a template that renumbers its rows: a different label gives `not_checked`.
const TOTAL_ASSETS: RowSpec = [[["210015", 129]], "TOPLAM VARLIKLAR"];
const TOTAL_LIABILITIES_AND_EQUITY: RowSpec = [[["210015", 297]], "TOPLAM KAYNAKLAR"];
const BS_NET_PROFIT: RowSpec = [[["210015", 294]], "Net Dönem Karı veya Zararı"];
const BS_CASH: RowSpec = [[["210015", 4]], "Nakit ve Nakit Benzerleri"];
const PARENT_PROFIT: RowSpec = [
  [
    ["310003", 62],
    ["310000", 62],
    ["310002", 62],
    ["310004", 64],
  ],
  "Ana Ortaklık Payları",
];
const CF_CASH_END: RowSpec = [
  [
    ["520003", 209],
    ["510011", 121],
  ],
  "DÖNEM SONU NAKİT VE NAKİT BENZERLERİ",
];
const CF_CASH_BEGIN: RowSpec = [
  [
    ["520003", 207],
    ["510011", 119],
  ],
  "DÖNEM BAŞI NAKİT VE NAKİT BENZERLERİ",
];

type FactIndex = Map<string, ParsedFinancialFact>;
const key = (rowId: string, column: string) => `${rowId}|${column}`;

function index(facts: readonly ParsedFinancialFact[]): FactIndex {
  const out: FactIndex = new Map();
  for (const f of facts) out.set(key(f.row_id, f.column_class), f);
  return out;
}

function find(
  facts: FactIndex,
  family: string,
  spec: RowSpec,
  column: string,
): [ParsedFinancialFact | null, string | null] {
  const [candidates, label] = spec;
  for (const [role, row] of candidates) {
    const fact = facts.get(key(`${family}_role_${role}-row-${row}`, column));
    if (fact === undefined) continue;
    if (fact.label_tr !== label) return [null, `${fact.row_id} is ${pyRepr(fact.label_tr)}, expected ${pyRepr(label)}`];
    return [fact, null];
  }
  const rows = candidates.map(([role, row]) => `${role}-row-${row}`).join(", ");
  return [null, `no value for ${pyRepr(label)} (${rows}) in ${column}`];
}

function compare(
  name: string,
  severity: Severity,
  facts: FactIndex,
  family: string,
  left: RowSpec,
  leftColumn: string,
  right: RowSpec,
  rightColumn: string,
): CheckResult {
  const [lf, lReason] = find(facts, family, left, leftColumn);
  const [rf, rReason] = find(facts, family, right, rightColumn);
  if (lf === null || rf === null) {
    return result(name, severity, "not_checked", { reason: [lReason, rReason].filter((r) => r).join("; ") });
  }
  return result(name, severity, abs(lf.raw_value - rf.raw_value) <= SINGLE_VALUE_TOLERANCE ? "pass" : "fail", {
    left: lf.raw_value,
    right: rf.raw_value,
    left_source: `${lf.row_id} ${leftColumn}`,
    right_source: `${rf.row_id} ${rightColumn}`,
  });
}

const CHECKS: readonly (readonly [string, Severity, RowSpec, string, RowSpec, string])[] = [
  [
    "total_assets_equal_liabilities_and_equity_current",
    "blocking",
    TOTAL_ASSETS,
    CURRENT,
    TOTAL_LIABILITIES_AND_EQUITY,
    CURRENT,
  ],
  [
    "total_assets_equal_liabilities_and_equity_prior",
    "blocking",
    TOTAL_ASSETS,
    PRIOR,
    TOTAL_LIABILITIES_AND_EQUITY,
    PRIOR,
  ],
  ["balance_sheet_profit_equals_parent_profit", "blocking", BS_NET_PROFIT, CURRENT, PARENT_PROFIT, CURRENT],
  ["cash_flow_end_cash_equals_balance_sheet_cash", "informational", CF_CASH_END, CURRENT, BS_CASH, CURRENT],
  ["cash_flow_begin_cash_equals_prior_balance_sheet_cash", "informational", CF_CASH_BEGIN, CURRENT, BS_CASH, PRIOR],
];

/** Cross-statement checks on one filing (#18). Unsupported templates give `not_checked`. */
export function reconcile(filing: ParsedFiling): CheckResult[] {
  if (!(SUPPORTED_FAMILIES as readonly string[]).includes(filing.template_family)) {
    const reason = `template ${pyRepr(filing.template_family)} is not supported yet`;
    return CHECKS.map(([name, severity]) => result(name, severity, "not_checked", { reason }));
  }
  const facts = index(filing.facts);
  return CHECKS.map(([name, severity, l, lc, r, rc]) =>
    compare(name, severity, facts, filing.template_family, l, lc, r, rc),
  );
}

/** Blocking checks that failed. A filing with any of these produces no findings. */
export function blockingFailures(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((r) => r.severity === "blocking" && r.status === "fail");
}

/** Recompute each income statement subtotal from its components, per column (#15). */
export function incomeStatementSubtotals(filing: ParsedFiling): CheckResult[] {
  return subtotals(
    filing,
    "income_statement",
    ["general"],
    INCOME_STATEMENT_ROLES,
    INCOME_STATEMENT_COLUMNS,
    INCOME_STATEMENT_SUBTOTALS,
  );
}

/** Recompute each balance sheet subtotal from its components, per column (#16). */
export function balanceSheetSubtotals(filing: ParsedFiling): CheckResult[] {
  return subtotals(
    filing,
    "balance_sheet",
    SUPPORTED_FAMILIES,
    BALANCE_SHEET_ROLES,
    BALANCE_SHEET_COLUMNS,
    BALANCE_SHEET_SUBTOTALS,
  );
}

/** Recompute each cash flow statement subtotal from its components, per column (#17). */
export function cashFlowSubtotals(filing: ParsedFiling): CheckResult[] {
  return subtotals(filing, "cash_flow", SUPPORTED_FAMILIES, CASH_FLOW_ROLES, CASH_FLOW_COLUMNS, CASH_FLOW_SUBTOTALS);
}

/**
 * Recompute subtotals from their components, per column.
 *
 * - A subtotal whose components are all unreported is `not_checked`: the company gave only the total.
 * - Each component may be rounded by one reporting unit, so the tolerance is the number of components.
 * - A group total left empty while its components are filled still counts in the group above it: its value is then
 *   the sum of its own components (a company may fill a breakdown without the total).
 */
function subtotals(
  filing: ParsedFiling,
  statement: string,
  families: readonly string[],
  roles: readonly string[],
  columns: readonly string[],
  formulas: readonly Formula[],
): CheckResult[] {
  const family = filing.template_family;
  const role = roles.find((r) => filing.role_codes.includes(r));
  if (!families.includes(family) || role === undefined) {
    const reason = `${statement} subtotals are defined for ${families.join("/")} (${roles.join(", ")})`;
    return [result(`${statement}_subtotals`, "blocking", "not_checked", { reason })];
  }
  const facts = index(filing.facts.filter((f) => f.role_code === role));
  if (facts.size === 0) {
    const reason = `no ${statement.replaceAll("_", " ")} values were parsed for ${role}`;
    return [result(`${statement}_subtotals`, "blocking", "not_checked", { reason })];
  }

  const rowId = (n: number) => `${family}_role_${role}-row-${n}`;
  const groups = new Map<number, readonly number[]>();
  for (const [total, , parts] of formulas) if (!groups.has(total)) groups.set(total, parts);

  const value = (n: number, column: string): bigint | null => {
    const fact = facts.get(key(rowId(n), column));
    if (fact !== undefined) return fact.raw_value;
    const parts = groups.get(n);
    if (parts === undefined) return null;
    const values = parts.map((p) => value(p, column)).filter((v): v is bigint => v !== null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0n) : null;
  };

  const results: CheckResult[] = [];
  for (const [totalRow, label, parts] of formulas) {
    const name = `${statement}_row_${totalRow}_equals_rows_${parts.join("+")}`;
    for (const column of columns) {
      const components = new Map<number, bigint>();
      for (const p of parts) {
        const v = value(p, column);
        if (v !== null && !components.has(p)) components.set(p, v);
      }
      const total = facts.get(key(rowId(totalRow), column));
      const source = `${rowId(totalRow)} ${column}`;
      if (components.size === 0) {
        if (total !== undefined) {
          results.push(result(name, "blocking", "not_checked", { reason: `${source}: components not reported` }));
        }
        continue;
      }
      if (total === undefined) {
        const reason = `${source}: total not reported; its components count in the group above`;
        results.push(result(name, "blocking", "not_checked", { reason }));
        continue;
      }
      if (total.label_tr !== label) {
        const reason = `${total.row_id} is ${pyRepr(total.label_tr)}, expected ${pyRepr(label)}`;
        results.push(result(name, "blocking", "not_checked", { reason }));
        continue;
      }
      const sum = [...components.values()].reduce((a, b) => a + b, 0n);
      results.push(
        result(
          name,
          "blocking",
          abs(total.raw_value - sum) <= ROUNDING_TOLERANCE * BigInt(parts.length) ? "pass" : "fail",
          {
            left: total.raw_value,
            right: sum,
            left_source: source,
            right_source: [...components.keys()].map(rowId).join(", "),
          },
        ),
      );
    }
  }
  return results;
}
