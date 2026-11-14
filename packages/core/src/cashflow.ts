/**
 * The bridge from profit to operating cash flow (#62; decisions 0013 and 0018), read from the indirect-method cash
 * flow statement (role 520003, general and holding templates).
 *
 *   net profit (income statement row 59)
 *   profit in the cash flow statement (row 3); a difference from row 59 is shown as its own line
 *   + non-cash adjustments (row 6), with D&A (row 7) shown separately
 *   + working capital changes (row 65), by component (decision 0013)
 *   = cash from operations (row 102)
 *   + payments and receipts (rows 103-118), each reported row shown
 *   + inflation effect (row 119)
 *   = operating cash flow (row 2)
 *
 * A row the company left empty is "not reported", never zero. The bridge says whether it closes with the filed
 * subtotals; it does not repair a filing that does not.
 */
import type { ParsedFiling } from "./parser.ts";
import { collect, type Input, notReported, ok, type Result } from "./result.ts";

export const CASH_FLOW_ROLE = "520003";

/**
 * The values of one column of one statement, by row number. Rows the company left empty are absent: the parser
 * does not emit empty cells.
 */
export function rowValues(filing: ParsedFiling, role: string, column: string): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const f of filing.facts) {
    if (f.role_code !== role || f.column_class !== column) continue;
    out.set(Number(f.row_id.split("-").pop()), f.normalized_value_tl);
  }
  return out;
}

/** Working capital rows of the cash flow statement named by decision 0013, core items first. */
export const WORKING_CAPITAL_COMPONENTS = [
  { code: "trade_receivables", row: 68, core: true },
  { code: "inventories", row: 81, core: true },
  { code: "trade_payables", row: 84, core: true },
  { code: "contract_assets", row: 75, core: false },
  { code: "prepaid_expenses", row: 83, core: false },
  { code: "contract_liabilities", row: 89, core: false },
  { code: "customer_advances", row: 98, core: false },
] as const;

/** Payment and receipt rows between cash from operations (102) and the inflation effect (119). */
export const OPERATING_PAYMENT_ROWS: readonly number[] = Array.from({ length: 16 }, (_, k) => 103 + k);

export interface BridgeLine {
  /** Cash flow statement row, or null for a line computed by Vigil. */
  row: number | null;
  code: string;
  value: Result<bigint>;
}

export interface CashFlowBridge {
  net_profit: Result<bigint>;
  profit_in_cash_flow: BridgeLine;
  /** Row 3 − income statement row 59; 0 when they agree. */
  profit_difference: Result<bigint>;
  non_cash_adjustments: BridgeLine;
  d_and_a: BridgeLine;
  working_capital_change: BridgeLine;
  /** Decision 0013 components; each one not reported when its row is empty. */
  working_capital_components: BridgeLine[];
  /** Row 65 − the reported components: the rows decision 0013 calls "other". */
  working_capital_other: Result<bigint>;
  cash_from_operations: BridgeLine;
  /** Reported rows 103-118, in row order. */
  payments: BridgeLine[];
  inflation_effect: BridgeLine;
  operating_cash_flow: BridgeLine;
  /**
   * Whether the filed subtotals add up: row 3 + 6 + 65 = 102 and 102 + Σ103-119 = 2, with empty rows counting as
   * nothing. Null when row 3, 6, 65, 102 or 2 is not reported.
   */
  closes: boolean | null;
}

const line = (cf: ReadonlyMap<number, bigint>, row: number, code: string): BridgeLine => {
  const v = cf.get(row);
  return { row, code, value: v === undefined ? notReported() : ok(v) };
};

/** The bridge for one column of the cash flow statement and the net profit of the same period. */
export function cashFlowBridge(cf: ReadonlyMap<number, bigint>, netProfit: Input<bigint>): CashFlowBridge {
  const np = collect({ net_profit: netProfit });
  const net_profit: Result<bigint> = "values" in np ? ok(np.values.net_profit) : np;
  const profit = line(cf, 3, "profit_in_cash_flow");
  const diff = collect({ profit_in_cash_flow: profit.value, net_profit });
  const wc = line(cf, 65, "working_capital_change");
  const components = WORKING_CAPITAL_COMPONENTS.map((c) => line(cf, c.row, c.code));
  const wcTotal = collect({ working_capital_change: wc.value });
  const named = components.reduce((s, c) => s + (c.value.status === "ok" ? c.value.value : 0n), 0n);

  const sub = [3, 6, 65, 102, 2].map((r) => cf.get(r));
  let closes: boolean | null = null;
  if (sub.every((v) => v !== undefined)) {
    const [p, adj, w, cfo102, cfo] = sub as [bigint, bigint, bigint, bigint, bigint];
    const rest = [...OPERATING_PAYMENT_ROWS, 119].reduce((s, r) => s + (cf.get(r) ?? 0n), 0n);
    closes = p + adj + w === cfo102 && cfo102 + rest === cfo;
  }

  return {
    net_profit,
    profit_in_cash_flow: profit,
    profit_difference: "values" in diff ? ok(diff.values.profit_in_cash_flow - diff.values.net_profit) : diff,
    non_cash_adjustments: line(cf, 6, "non_cash_adjustments"),
    d_and_a: line(cf, 7, "d_and_a"),
    working_capital_change: wc,
    working_capital_components: components,
    working_capital_other: "values" in wcTotal ? ok(wcTotal.values.working_capital_change - named) : wcTotal,
    cash_from_operations: line(cf, 102, "cash_from_operations"),
    payments: OPERATING_PAYMENT_ROWS.filter((r) => cf.has(r)).map((r) => line(cf, r, `operating_cash_flow_row_${r}`)),
    inflation_effect: line(cf, 119, "inflation_effect"),
    operating_cash_flow: line(cf, 2, "cfo"),
    closes,
  };
}
