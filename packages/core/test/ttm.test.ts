/**
 * EBITDA A and B (#60, decision 0011) and trailing-twelve-month flows (#93, decision 0014) on KATMR.
 *
 * Inputs are the visible cell values (decision 0005) of the raw KAP files, read by hand, in TL:
 * - KATMR_1651411_2026_2.xls: period 01.01.2026-30.06.2026; col-4 = 6M 2026, col-5 = 6M 2025 (restated).
 * - KATMR_1557851_2025_4.xls: period 01.01.2025-31.12.2025; col-4 = full year 2025.
 * Income statement role 310003 rows 31-34 and 38, cash flow role 520003 row 7, balance sheet role 210015.
 *
 * Expected values do not come from the code under test:
 * - 6M EBITDA A = 277.0 and B = 495.8 mn TL are `docs/VIGIL.md` §7.
 * - The TTM was worked out by hand:
 *   - full year 2025 EBITDA A × 129990000 / 110386963 (TÜİK CPI June 2026 / December 2025)
 *     = 714,089,453.501 → 714,089,454;
 *   - 277,048,821 + 714,089,454 − 452,651,667 = 538,486,608.
 * - Net debt 2,193,025,857 / 538,486,608 = 4.0726.
 */
import { describe, expect, test } from "bun:test";
import {
  applyFactor,
  type CpiSeries,
  ebitda,
  ebitdaA,
  ebitdaB,
  isFullYear,
  netDebt,
  netDebtToEbitda,
  notReported,
  ok,
  pyRound,
  type Result,
  ttmFlow,
} from "../src/index.ts";

const katmr6m2026 = {
  gross_profit: 518267459n,
  g_and_a: -141799425n,
  selling_expenses: -129836440n,
  r_and_d: -15519902n,
  operating_profit: 449826025n,
  d_and_a: 45937129n,
};
const katmr6m2025 = {
  gross_profit: 662081978n,
  g_and_a: -119301430n,
  selling_expenses: -104433377n,
  r_and_d: -46857921n,
  operating_profit: 638324259n,
  d_and_a: 61162417n,
};
const katmrFy2025 = {
  gross_profit: 1019056811n,
  g_and_a: -209863175n,
  selling_expenses: -257983357n,
  r_and_d: -53514970n,
  operating_profit: 865126759n,
  d_and_a: 108706461n,
};
// Balance sheet 30.06.2026: short-term borrowings (132), current part of long-term (143), long-term (193), cash (4).
const katmrBorrowings = 1868838129n + 290183023n + 154763778n;
const katmrCash = 120759073n;

const cpi: CpiSeries = {
  base: "2025=100",
  values: new Map([
    ["2025-12", cpiValue("2025-12", "110.386963")],
    ["2026-06", cpiValue("2026-06", "129.99")],
  ]),
};
function cpiValue(month: string, index: string) {
  return {
    month,
    index,
    base: "2025=100",
    source: "TÜİK",
    series_code: "DF_TUFE_SDMX_TT10",
    retrieved_at: "2026-11-14T20:56:43Z",
  };
}

function val<T>(r: Result<T>): T {
  if (r.status !== "ok") throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}
const mn = (v: bigint) => pyRound(Number(v) / 1e6, 1);

describe("EBITDA (#60)", () => {
  test("KATMR 6M 2026: A = 277.0 and B = 495.8 mn TL, as in docs/VIGIL.md", () => {
    const e = ebitda(katmr6m2026);
    expect(val(e.a)).toBe(277048821n);
    expect(mn(val(e.a))).toBe(277.0);
    expect(mn(val(e.b))).toBe(495.8);
    expect(val(e.b_minus_a)).toBe(495763154n - 277048821n);
  });

  test("missing D&A is not computable, never computed with zero D&A", () => {
    const { d_and_a: _, ...noDa } = katmr6m2026;
    expect(ebitdaA(noDa)).toMatchObject({ status: "not_computable", reason: { needs: ["d_and_a"] } });
    expect(ebitdaB(noDa)).toMatchObject({ status: "not_computable", reason: { needs: ["d_and_a"] } });
    expect(ebitda(noDa).b_minus_a).toMatchObject({ reason: { needs: ["d_and_a"] } });
  });

  test("an empty expense cell is not computable too", () => {
    expect(ebitdaA({ ...katmr6m2026, r_and_d: notReported() })).toMatchObject({
      reason: { code: "missing_input", needs: ["r_and_d"] },
    });
  });
});

describe("TTM (#93)", () => {
  const half = { start: "2026-01-01", end: "2026-06-30" };

  test("KATMR EBITDA A: 6M 2026 + full year 2025 in June 2026 prices − 6M 2025", () => {
    const t = val(
      ttmFlow({
        name: "ebitda_a",
        current: ebitdaA(katmr6m2026),
        period: half,
        priorYearToDate: ebitdaA(katmr6m2025),
        priorFullYear: ebitdaA(katmrFy2025),
        priorFullYearEnd: "2025-12-31",
        cpi,
      }),
    );
    expect(val(ebitdaA(katmr6m2025))).toBe(452651667n);
    expect(val(ebitdaA(katmrFy2025))).toBe(606401770n);
    expect(t.cpi_factor).toEqual({ numerator: 129990000n, denominator: 110386963n });
    expect(t.prior_full_year_adjusted).toBe(714089454n);
    expect(t.value).toBe(538486608n);
    expect(t.from_full_year_report).toBe(false);
  });

  test("KATMR net debt / TTM EBITDA A = 4.07", () => {
    const nd = netDebt(katmrBorrowings, katmrCash);
    expect(nd).toEqual(ok(2193025857n));
    const t = ttmFlow({
      name: "ebitda_a",
      current: ebitdaA(katmr6m2026),
      period: half,
      priorYearToDate: ebitdaA(katmr6m2025),
      priorFullYear: ebitdaA(katmrFy2025),
      priorFullYearEnd: "2025-12-31",
      cpi,
    });
    expect(pyRound(val(netDebtToEbitda(nd, ok(val(t).value))), 4)).toBe(4.0726);
  });

  test("in a year-end report the TTM is the reported full year, with no CPI", () => {
    const t = val(
      ttmFlow({
        name: "ebitda_a",
        current: ebitdaA(katmrFy2025),
        period: { start: "2025-01-01", end: "2025-12-31" },
        priorYearToDate: null,
        priorFullYear: null,
        priorFullYearEnd: null,
        cpi: { base: "2025=100", values: new Map() },
      }),
    );
    expect(t).toEqual({
      value: 606401770n,
      from_full_year_report: true,
      cpi_factor: null,
      prior_full_year_adjusted: null,
    });
  });

  test("a fiscal year that is not the calendar year works the same way", () => {
    expect(isFullYear("2025-07-01", "2026-06-30")).toBe(true);
    expect(isFullYear("2026-01-01", "2026-06-30")).toBe(false);
    expect(isFullYear("2024-03-01", "2025-02-28")).toBe(true);
    // Six months of a fiscal year starting 1 July 2025: the previous year end is 30 June 2025.
    const series: CpiSeries = {
      base: "2025=100",
      values: new Map([
        ["2025-06", cpiValue("2025-06", "100")],
        ["2025-12", cpiValue("2025-12", "110")],
      ]),
    };
    const t = val(
      ttmFlow({
        name: "revenue",
        current: 600n,
        period: { start: "2025-07-01", end: "2025-12-31" },
        priorYearToDate: 500n,
        priorFullYear: 1000n,
        priorFullYearEnd: "2025-06-30",
        cpi: series,
      }),
    );
    // 600 + 1000 × 110/100 − 500 = 1200.
    expect(t.value).toBe(1200n);
  });

  test("without the previous year-end report it is not computable and says what is needed", () => {
    const r = ttmFlow({
      name: "ebitda_a",
      current: 1n,
      period: half,
      priorYearToDate: 1n,
      priorFullYear: null,
      priorFullYearEnd: null,
      cpi,
    });
    expect(r).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["ebitda_a:prior_full_year"] },
    });
    if (r.status === "not_computable") expect(r.reason.message).toContain("önceki yıl sonu raporu yok");
  });

  test("a missing comparative or current value names it; a not computable input passes its needs on", () => {
    const r = ttmFlow({
      name: "ebitda_a",
      current: ebitdaA({ ...katmr6m2026, d_and_a: null }),
      period: half,
      priorYearToDate: undefined,
      priorFullYear: 5n,
      priorFullYearEnd: "2025-12-31",
      cpi,
    });
    expect(r).toMatchObject({ reason: { needs: ["d_and_a", "ebitda_a:prior_year_to_date"] } });
  });

  test("a previous year-end report for the wrong date is a period mismatch", () => {
    const r = ttmFlow({
      name: "ebitda_a",
      current: 1n,
      period: half,
      priorYearToDate: 1n,
      priorFullYear: 1n,
      priorFullYearEnd: "2024-12-31",
      cpi,
    });
    expect(r).toMatchObject({
      status: "not_computable",
      reason: { code: "period_mismatch", needs: ["ebitda_a:prior_full_year"] },
    });
  });

  test("a CPI month missing from the series is not computable and names the month", () => {
    const r = ttmFlow({
      name: "ebitda_a",
      current: 1n,
      period: { start: "2026-01-01", end: "2026-09-30" },
      priorYearToDate: 1n,
      priorFullYear: 1n,
      priorFullYearEnd: "2025-12-31",
      cpi,
    });
    expect(r).toMatchObject({ status: "not_computable", reason: { code: "missing_input", needs: ["cpi:2026-09"] } });
  });

  test("the adjusted full year rounds to whole TL, half away from zero", () => {
    const half3 = { numerator: 3n, denominator: 2n };
    expect(applyFactor(5n, half3)).toBe(8n); // 7.5 → 8
    expect(applyFactor(-5n, half3)).toBe(-8n); // −7.5 → −8
    expect(applyFactor(4n, { numerator: 1n, denominator: 3n })).toBe(1n); // 1.33 → 1
    expect(applyFactor(5n, { numerator: 1n, denominator: 3n })).toBe(2n); // 1.67 → 2
    expect(applyFactor(0n, half3)).toBe(0n);
  });
});
