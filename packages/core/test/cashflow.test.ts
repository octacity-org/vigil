/**
 * Cash flow bridge and cash quality metrics (#62) on KATMR 2026/2.
 *
 * Inputs are the visible cell values (decision 0005) of KATMR_1651411_2026_2.xls, read from the raw HTML by hand, in
 * TL: cash flow role 520003 (col-4 = 6M 2026, col-5 = 6M 2025), income statement row 59, total assets row 129.
 * Expected values are `docs/VIGIL.md` §7 ("Nakit akışı köprüsü", "İşletme sermayesi", "Nakit kalitesi"), in mn TL.
 */
import { describe, expect, test } from "bun:test";
import {
  accrualRatio,
  capexToDepreciation,
  cashFlowBridge,
  cfoToEbitda,
  freeCashFlow,
  notReported,
  ok,
  pyRound,
  type Result,
} from "../src/index.ts";

/** Reported rows of the cash flow statement, 6M 2026; empty rows are absent. */
const cf2026 = new Map<number, bigint>([
  [2, -40878967n],
  [3, 318919663n],
  [6, 79271672n],
  [7, 45937129n],
  [65, -453441665n],
  [66, 651771n],
  [68, 289461740n],
  [72, 20768497n],
  [81, 201915791n],
  [83, 368834563n],
  [84, -241256975n],
  [88, -46139950n],
  [93, 8160444n],
  [98, -1056971443n],
  [99, 1133897n],
  [102, -55250330n],
  [114, 12345405n],
  [116, 2025958n],
  [133, -69247061n],
]);
const netProfit2026 = 318664612n; // income statement row 59, col-4
const totalAssets = 14795418421n; // row 129, 30.06.2026
const totalAssetsPriorYearEnd = 16069085451n; // row 129, 31.12.2025
const ebitdaA2026 = 277048821n; // #60
const ebitdaA2025 = 452651667n; // #60, restated comparative

const cfo2025 = -957022643n;
const capex2025 = -34081655n;
const dAndA2025 = 61162417n;

function val<T>(r: Result<T>): T {
  if (r.status !== "ok") throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}
const mn = (r: Result<bigint>) => pyRound(Number(val(r)) / 1e6, 1);
const pct = (r: Result<number>, digits = 1) => pyRound(val(r) * 100, digits);

describe("cash flow bridge (KATMR 6M 2026)", () => {
  const b = cashFlowBridge(cf2026, netProfit2026);

  test("profit 318.9 + non-cash 79.3 + working capital −453.4 = −55.3; + 14.4 = operating cash flow −40.9", () => {
    expect(mn(b.profit_in_cash_flow.value)).toBe(318.9);
    expect(mn(b.non_cash_adjustments.value)).toBe(79.3);
    expect(mn(b.working_capital_change.value)).toBe(-453.4);
    expect(mn(b.cash_from_operations.value)).toBe(-55.3);
    const payments = b.payments.reduce((s, p) => s + val(p.value), 0n);
    expect(pyRound(Number(payments) / 1e6, 1)).toBe(14.4);
    expect(mn(b.operating_cash_flow.value)).toBe(-40.9);
    expect(b.closes).toBe(true);
  });

  test("D&A is shown separately inside the non-cash adjustments", () => {
    expect(mn(b.d_and_a.value)).toBe(45.9);
  });

  test("the cash flow statement starts from a different profit than row 59; the difference is its own line", () => {
    expect(val(b.net_profit)).toBe(318664612n);
    expect(val(b.profit_difference)).toBe(318919663n - 318664612n);
  });

  test("working capital by component (decision 0013), with the rest as other", () => {
    const byCode = Object.fromEntries(b.working_capital_components.map((c) => [c.code, c.value]));
    expect(mn(byCode.customer_advances as Result<bigint>)).toBe(-1057.0);
    expect(mn(byCode.prepaid_expenses as Result<bigint>)).toBe(368.8);
    expect(mn(byCode.trade_receivables as Result<bigint>)).toBe(289.5);
    expect(mn(byCode.inventories as Result<bigint>)).toBe(201.9);
    expect(mn(byCode.trade_payables as Result<bigint>)).toBe(-241.3);
    expect(mn(b.working_capital_other)).toBe(-15.4);
    // Rows 75 and 89 are empty in this filing: shown as not reported, not as zero.
    expect(byCode.contract_assets).toEqual(notReported());
    expect(byCode.contract_liabilities).toEqual(notReported());
    // Core items come first.
    expect(b.working_capital_components.slice(0, 3).map((c) => c.code)).toEqual([
      "trade_receivables",
      "inventories",
      "trade_payables",
    ]);
  });

  test("only reported payment rows are listed, in row order", () => {
    expect(b.payments.map((p) => p.row)).toEqual([114, 116]);
    expect(b.inflation_effect.value).toEqual(notReported());
  });

  test("a bridge whose filed subtotals do not add up says so", () => {
    const broken = new Map(cf2026);
    broken.set(102, -55250331n);
    expect(cashFlowBridge(broken, netProfit2026).closes).toBe(false);
  });

  test("the second step is checked too: payments and the inflation effect must lead from row 102 to row 2", () => {
    const missingPayment = new Map(cf2026);
    missingPayment.delete(116); // row 102 still adds up, but 102 + 114 no longer equals row 2
    expect(cashFlowBridge(missingPayment, netProfit2026).closes).toBe(false);
    const withInflation = new Map(cf2026);
    withInflation.set(119, 5n);
    withInflation.set(2, -40878962n);
    expect(cashFlowBridge(withInflation, netProfit2026).closes).toBe(true);
  });

  test("without a subtotal the closing check cannot be made", () => {
    const noTotal = new Map(cf2026);
    noTotal.delete(65);
    const nb = cashFlowBridge(noTotal, netProfit2026);
    expect(nb.closes).toBeNull();
    expect(nb.working_capital_other).toMatchObject({
      status: "not_computable",
      reason: { needs: ["working_capital_change"] },
    });
  });

  test("without net profit the difference line is not computable", () => {
    expect(cashFlowBridge(cf2026, null).profit_difference).toMatchObject({
      status: "not_computable",
      reason: { needs: ["net_profit"] },
    });
  });
});

describe("cash quality (KATMR, 6M 2026 and 6M 2025)", () => {
  test("free cash flow −110.1 and −991.1", () => {
    expect(mn(freeCashFlow(cf2026.get(2), cf2026.get(133)))).toBe(-110.1);
    expect(mn(freeCashFlow(cfo2025, capex2025))).toBe(-991.1);
  });

  test("operating cash flow / EBITDA A −14.8% and −211.4%", () => {
    expect(pct(cfoToEbitda(cf2026.get(2), ebitdaA2026))).toBe(-14.8);
    expect(pct(cfoToEbitda(cfo2025, ebitdaA2025))).toBe(-211.4);
  });

  test("capex / D&A 1.51 and 0.56", () => {
    expect(pyRound(val(capexToDepreciation(cf2026.get(133), cf2026.get(7))), 2)).toBe(1.51);
    expect(pyRound(val(capexToDepreciation(capex2025, dAndA2025)), 2)).toBe(0.56);
  });

  test("accrual ratio on average total assets 2.33%", () => {
    expect(pct(accrualRatio(netProfit2026, cf2026.get(2), totalAssets, totalAssetsPriorYearEnd), 2)).toBe(2.33);
  });

  test("missing inputs are not computable, never 0", () => {
    expect(freeCashFlow(-1n, undefined)).toMatchObject({ reason: { needs: ["capex"] } });
    expect(capexToDepreciation(-1n, 0n)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(accrualRatio(1n, 1n, 10n, null)).toMatchObject({
      reason: { code: "missing_input", needs: ["total_assets:prior_year_end"] },
    });
    expect(accrualRatio(1n, 1n, 0n, 0n)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(cfoToEbitda(ok(5n), 0n)).toMatchObject({ reason: { code: "zero_denominator" } });
  });
});
