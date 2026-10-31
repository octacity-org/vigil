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
  pyRound,
  quickRatio,
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

const r2 = (v: number | null) => pyRound(v as number, 2);

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
    expect(pyRound(nd2026 as number, 1)).toBe(2193.0);
    expect(r2(netDebtToEquity(nd2026, katmr2026.equity))).toBe(0.21);
    const nd2025 = netDebt(katmr2025.borrowings, katmr2025.cash);
    expect(pyRound(nd2025 as number, 1)).toBe(2009.6);
    expect(r2(netDebtToEquity(nd2025, katmr2025.equity))).toBe(0.2);
  });

  test("liabilities to assets", () => {
    expect(r2(liabilitiesToAssets(katmr2026.total_liabilities, katmr2026.total_assets))).toBe(0.29);
    expect(r2(liabilitiesToAssets(katmr2025.total_liabilities, katmr2025.total_assets))).toBe(0.37);
  });

  test("integers in TL (bigint) work too", () => {
    expect(currentRatio(1290360n, 389710n)).toBeCloseTo(3.311, 3);
    expect(netDebt(231380n, 12080n)).toBe(219300);
  });
});

test("missing inputs and zero denominators are not computable (null), never 0", () => {
  expect(currentRatio(null, 100)).toBeNull();
  expect(currentRatio(100, null)).toBeNull();
  expect(quickRatio(100, null, 50)).toBeNull();
  expect(cashRatio(null, 50)).toBeNull();
  expect(netDebt(null, 50)).toBeNull();
  expect(netDebtToEquity(null, 100)).toBeNull();
  expect(liabilitiesToAssets(100, null)).toBeNull();

  expect(currentRatio(100, 0)).toBeNull();
  expect(quickRatio(100, 20, 0)).toBeNull();
  expect(cashRatio(10, 0)).toBeNull();
  expect(netDebtToEquity(50, 0)).toBeNull();
  expect(liabilitiesToAssets(50, 0)).toBeNull();
  expect(currentRatio(100n, 0n)).toBeNull();
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
  expect(pyRound(derived.net_debt as number, 1)).toBe(2193.0);
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
