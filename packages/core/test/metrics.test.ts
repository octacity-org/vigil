/**
 * Balance sheet ratios with the KATMR reference numbers from docs/VIGIL.md §7 (million TL, June 2026 purchasing power).
 */
import { describe, expect, test } from "bun:test";
import {
  calculateBalanceSheetRatios,
  cashRatio,
  currentRatio,
  liabilitiesToAssets,
  netDebt,
  netDebtToEquity,
  notReported,
  ok,
  pyRound,
  quickRatio,
  type Result,
} from "../src/index.ts";

const katmr2026 = {
  cash: 120.8,
  current_assets: 12903.6,
  total_assets: 14795.4,
  inventories: 8989.1,
  borrowings: 2313.8,
  current_liabilities: 3897.1,
  equity: 10499.9,
  total_liabilities: 14795.4 - 10499.9, // 4295.5
};
// 31.12.2025, the prior year-end comparative.
const katmr2025 = {
  cash: 450.9,
  current_assets: 14263.3,
  total_assets: 16069.1,
  inventories: 9191.0,
  borrowings: 2460.5,
  current_liabilities: 5174.7,
  equity: 10181.0,
  total_liabilities: 16069.1 - 10181.0, // 5888.1
};

/** The value of an ok result; anything else fails the test with the result in the message. */
function val(r: Result<number | bigint>): number {
  if (r.status !== "ok")
    throw new Error(`expected a value, got ${JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? String(x) : x))}`);
  return Number(r.value);
}
const r2 = (r: Result<number | bigint>) => pyRound(val(r), 2);

describe("KATMR ratios", () => {
  test("current ratio", () => {
    expect(r2(currentRatio(katmr2026.current_assets, katmr2026.current_liabilities))).toBe(3.31);
    expect(r2(currentRatio(katmr2025.current_assets, katmr2025.current_liabilities))).toBe(2.76);
  });

  test("quick ratio", () => {
    expect(r2(quickRatio(katmr2026.current_assets, katmr2026.inventories, katmr2026.current_liabilities))).toBe(1.0);
    expect(r2(quickRatio(katmr2025.current_assets, katmr2025.inventories, katmr2025.current_liabilities))).toBe(0.98);
  });

  test("cash ratio", () => {
    expect(r2(cashRatio(katmr2026.cash, katmr2026.current_liabilities))).toBe(0.03);
    expect(r2(cashRatio(katmr2025.cash, katmr2025.current_liabilities))).toBe(0.09);
  });

  test("net debt and net debt to equity", () => {
    const nd2026 = netDebt(katmr2026.borrowings, katmr2026.cash);
    expect(pyRound(val(nd2026), 1)).toBe(2193.0);
    expect(r2(netDebtToEquity(nd2026, katmr2026.equity))).toBe(0.21);
    const nd2025 = netDebt(katmr2025.borrowings, katmr2025.cash);
    expect(pyRound(val(nd2025), 1)).toBe(2009.6);
    expect(r2(netDebtToEquity(nd2025, katmr2025.equity))).toBe(0.2);
  });

  test("liabilities to assets", () => {
    expect(r2(liabilitiesToAssets(katmr2026.total_liabilities, katmr2026.total_assets))).toBe(0.29);
    expect(r2(liabilitiesToAssets(katmr2025.total_liabilities, katmr2025.total_assets))).toBe(0.37);
  });

  test("integers in TL (bigint) work too", () => {
    expect(val(currentRatio(1290360n, 389710n))).toBeCloseTo(3.311, 3);
    // Amounts stay exact: 231,380 - 12,080 = 219,300 as a bigint.
    expect(netDebt(231380n, 12080n)).toEqual(ok(219300n));
  });
});

describe("not computable (#65): never 0, NaN or a fallback", () => {
  test("a missing input names the input", () => {
    expect(currentRatio(null, 100)).toEqual({
      status: "not_computable",
      reason: {
        code: "missing_input",
        message: "Hesaplanamaz: Dönen varlıklar raporda yok veya hesaplanamadı.",
        needs: ["current_assets"],
      },
    });
    expect(currentRatio(100, undefined)).toMatchObject({ reason: { needs: ["current_liabilities"] } });
    expect(cashRatio(null, 50)).toMatchObject({ reason: { needs: ["cash"] } });
    expect(netDebt(null, 50)).toMatchObject({ reason: { needs: ["financial_debt"] } });
    expect(liabilitiesToAssets(100, null)).toMatchObject({ reason: { needs: ["total_assets"] } });
  });

  test("every missing input is named, in order", () => {
    expect(quickRatio(null, null, 50)).toEqual({
      status: "not_computable",
      reason: {
        code: "missing_input",
        message: "Hesaplanamaz: Dönen varlıklar, Stoklar raporda yok veya hesaplanamadı.",
        needs: ["current_assets", "inventories"],
      },
    });
  });

  test("a cell the company left empty is not computable too", () => {
    expect(currentRatio(notReported(), 100)).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["current_assets"] },
    });
  });

  test("a not computable input passes its own needs on", () => {
    // Net debt is missing because borrowings are; net debt / equity then needs financial_debt, not net_debt.
    expect(netDebtToEquity(netDebt(null, 50), 100)).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["financial_debt"] },
    });
    expect(netDebtToEquity(netDebt(null, null), null)).toMatchObject({
      reason: { needs: ["financial_debt", "cash", "equity"] },
    });
  });

  test("an ok result is used as its value", () => {
    expect(val(netDebtToEquity(ok(50), ok(100)))).toBe(0.5);
  });

  test("a zero denominator is not computable and names the denominator", () => {
    expect(currentRatio(100, 0)).toEqual({
      status: "not_computable",
      reason: { code: "zero_denominator", message: "Hesaplanamaz: Kısa vadeli yükümlülükler sıfır.", needs: [] },
    });
    expect(currentRatio(100n, 0n)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(quickRatio(100, 20, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(cashRatio(10, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(netDebtToEquity(50, 0)).toMatchObject({
      reason: { code: "zero_denominator", message: "Hesaplanamaz: Özkaynaklar sıfır." },
    });
    expect(liabilitiesToAssets(50, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
  });

  test("a zero numerator is a value, not a missing input", () => {
    expect(val(cashRatio(0, 50))).toBe(0);
    expect(netDebt(0n, 0n)).toEqual(ok(0n));
  });

  test("no ratio is NaN or Infinity, whatever the inputs", () => {
    const inputs = [null, undefined, 0, 0n, notReported<number>()];
    for (const a of inputs) {
      for (const b of inputs) {
        for (const r of [currentRatio(a, b), cashRatio(a, b), liabilitiesToAssets(a, b), quickRatio(a, b, a)]) {
          if (r.status === "ok") expect(Number.isFinite(r.value)).toBe(true);
          else expect(r.status).toBe("not_computable");
        }
      }
    }
  });

  test("calculateBalanceSheetRatios with no inputs gives a reason for every ratio", () => {
    const all = calculateBalanceSheetRatios();
    for (const r of [all.current_ratio, all.quick_ratio, all.cash_ratio, all.net_debt, all.net_debt_to_equity]) {
      expect(r.status).toBe("not_computable");
    }
    expect(all.liabilities_to_assets).toMatchObject({ reason: { needs: ["total_liabilities", "total_assets"] } });
    expect(all.liabilities_derived).toBe(false);
  });
});

test("calculateBalanceSheetRatios derives liabilities only when they are missing", () => {
  const derived = calculateBalanceSheetRatios({
    current_assets: katmr2026.current_assets,
    current_liabilities: katmr2026.current_liabilities,
    inventories: katmr2026.inventories,
    cash_and_equivalents: katmr2026.cash,
    borrowings: katmr2026.borrowings,
    equity: katmr2026.equity,
    total_assets: katmr2026.total_assets,
  });
  expect(r2(derived.current_ratio)).toBe(3.31);
  expect(r2(derived.quick_ratio)).toBe(1.0);
  expect(r2(derived.cash_ratio)).toBe(0.03);
  expect(pyRound(val(derived.net_debt), 1)).toBe(2193.0);
  expect(r2(derived.net_debt_to_equity)).toBe(0.21);
  expect(r2(derived.liabilities_to_assets)).toBe(0.29);
  expect(derived.liabilities_derived).toBe(true);

  const explicit = calculateBalanceSheetRatios({
    current_assets: katmr2026.current_assets,
    current_liabilities: katmr2026.current_liabilities,
    total_assets: katmr2026.total_assets,
    total_liabilities: katmr2026.total_liabilities,
  });
  expect(r2(explicit.liabilities_to_assets)).toBe(0.29);
  expect(explicit.liabilities_derived).toBe(false);
});

describe("pyRound matches Python's round()", () => {
  test.each([
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-2.5, 0, -2],
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.675, 2, 2.67], // 2.675 is 2.67499999... in binary
    [1.005, 2, 1.0],
    [-0.4, 0, -0],
    [0.215429998603807, 6, 0.21543],
  ])("round(%p, %p) = %p", (x, n, expected) => {
    expect(pyRound(x, n)).toBe(expected);
  });
});
