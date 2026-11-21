/**
 * Three-month values from cumulative figures (#48).
 *
 * Expected values do not come from the code under test:
 * - KATMR 2026/2, income statement role 310003 of the hand-checked golden file `tests/golden/2026_2/KATMR_1651411.csv`:
 *   revenue (row 3) 6M 1,558,895,376 / Q2 879,599,263, 6M 2025 1,434,008,001 / Q2 2025 694,991,758; gross profit
 *   (row 31) 6M 518,267,459 / Q2 189,492,068, 6M 2025 662,081,978 / Q2 2025 330,145,727. `docs/VIGIL.md` §7 gives
 *   the 1st quarter gross margin derived from them: 48.4% in 2026, 44.9% in 2025.
 * - Across reports, worked out by hand with TÜİK CPI (`apps/server/reference/cpi-tr.csv`) December 2025 110.386963
 *   and September 2025 105.780006: 600,000,000 × 110386963 / 105780006 = 626,131,348.489 → 626,131,348, so
 *   Q4 = 1,000,000,000 − 626,131,348 = 373,868,652.
 */
import { describe, expect, test } from "bun:test";
import {
  type CpiSeries,
  type CpiValue,
  earlierMonthsWithinReport,
  grossMargin,
  monthEndBefore,
  monthsCovered,
  notReported,
  pyRound,
  type Result,
  threeMonthFlow,
} from "../src/index.ts";

function val<T>(r: Result<T>): T {
  if (r.status !== "ok") throw new Error(`expected a value, got ${JSON.stringify(r)}`);
  return r.value;
}

const cpiValue = (month: string, index: string): CpiValue => ({
  month,
  index,
  base: "2025=100",
  source: "TÜİK",
  series_code: "DF_TUFE_SDMX_TT10",
  retrieved_at: "2026-11-14T20:56:43Z",
});
const cpi: CpiSeries = {
  base: "2025=100",
  values: new Map([
    ["2025-09", cpiValue("2025-09", "105.780006")],
    ["2025-12", cpiValue("2025-12", "110.386963")],
  ]),
};

const half2026 = { start: "2026-01-01", end: "2026-06-30" };
const half2025 = { start: "2025-01-01", end: "2025-06-30" };
const year2025 = { start: "2025-01-01", end: "2025-12-31" };

describe("dates", () => {
  test("month end before", () => {
    expect(monthEndBefore("2026-06-30", 3)).toBe("2026-03-31");
    expect(monthEndBefore("2025-12-31", 3)).toBe("2025-09-30");
    expect(monthEndBefore("2026-03-31", 3)).toBe("2025-12-31");
    expect(monthEndBefore("2024-05-31", 3)).toBe("2024-02-29");
  });

  test("months covered", () => {
    expect(monthsCovered(half2026)).toBe(6);
    expect(monthsCovered(year2025)).toBe(12);
    expect(monthsCovered({ start: "2025-07-01", end: "2026-03-31" })).toBe(9); // special fiscal year (MAVI)
    expect(monthsCovered({ start: "2026-01-15", end: "2026-06-30" })).toBeNull();
  });
});

describe("done when: KATMR's 1st quarter gross margin derives to 48.4% (#48)", () => {
  test("2026: 6M − Q2 within the 6-month report", () => {
    const revenue = val(
      earlierMonthsWithinReport({ name: "revenue", period: half2026, current: 1558895376n, threeMonth: 879599263n }),
    );
    const gross = val(
      earlierMonthsWithinReport({
        name: "gross_profit",
        period: half2026,
        current: 518267459n,
        threeMonth: 189492068n,
      }),
    );
    expect(revenue).toEqual({
      value: 679296113n,
      period: { start: "2026-01-01", end: "2026-03-31" },
      source: "derived_within_report",
      derived: true,
      cpi_factor: null,
      previous_adjusted: null,
    });
    expect(gross.value).toBe(328775391n);
    expect(pyRound(val(grossMargin(gross.value, revenue.value)) * 100, 1)).toBe(48.4);
  });

  test("2025, from the restated comparative columns of the same report: 44.9%", () => {
    const revenue = val(
      earlierMonthsWithinReport({ name: "revenue", period: half2025, current: 1434008001n, threeMonth: 694991758n }),
    );
    const gross = val(
      earlierMonthsWithinReport({
        name: "gross_profit",
        period: half2025,
        current: 662081978n,
        threeMonth: 330145727n,
      }),
    );
    expect(pyRound(val(grossMargin(gross.value, revenue.value)) * 100, 1)).toBe(44.9);
  });

  test("the months before the quarter need a 6, 9 or 12-month report and both values", () => {
    const q1 = { start: "2026-01-01", end: "2026-03-31" };
    expect(earlierMonthsWithinReport({ name: "revenue", period: q1, current: 1n, threeMonth: 1n }).status).toBe(
      "not_computable",
    );
    const missing = earlierMonthsWithinReport({
      name: "revenue",
      period: half2026,
      current: 1558895376n,
      threeMonth: notReported(),
    });
    expect(missing.status === "not_computable" && missing.reason.needs).toEqual(["revenue:three_month"]);
  });
});

describe("the last quarter", () => {
  test("a 3-month column in the report is used as reported", () => {
    const q2 = val(threeMonthFlow({ name: "revenue", period: half2026, current: 1558895376n, reported: 879599263n }));
    expect(q2).toEqual({
      value: 879599263n,
      period: { start: "2026-04-01", end: "2026-06-30" },
      source: "reported",
      derived: false,
      cpi_factor: null,
      previous_adjusted: null,
    });
  });

  test("a 3-month report is its own quarter", () => {
    const q1 = val(
      threeMonthFlow({ name: "revenue", period: { start: "2026-01-01", end: "2026-03-31" }, current: 5n }),
    );
    expect(q1.value).toBe(5n);
    expect(q1.source).toBe("reported");
  });

  test("an empty 3-month cell is not reported, never derived instead", () => {
    const r = threeMonthFlow({
      name: "revenue",
      period: half2026,
      current: 1558895376n,
      reported: notReported(),
      previous: 600000000n,
      previousEnd: "2026-03-31",
      cpi,
    });
    expect(r.status).toBe("not_computable");
  });

  test("Q4 = 12M − 9M × CPI(December) / CPI(September)", () => {
    const q4 = val(
      threeMonthFlow({
        name: "revenue",
        period: year2025,
        current: 1000000000n,
        previous: 600000000n,
        previousEnd: "2025-09-30",
        cpi,
      }),
    );
    expect(q4).toEqual({
      value: 373868652n,
      period: { start: "2025-10-01", end: "2025-12-31" },
      source: "derived_with_cpi",
      derived: true,
      cpi_factor: { numerator: 110386963n, denominator: 105780006n },
      previous_adjusted: 626131348n,
    });
  });

  test("without the previous report, the right one, or CPI it is not computable with what is missing", () => {
    const base = { name: "revenue", period: year2025, current: 1000000000n };
    const noReport = threeMonthFlow({ ...base, cpi });
    expect(noReport.status === "not_computable" && noReport.reason.needs).toEqual(["revenue:previous_year_to_date"]);
    expect(noReport.status === "not_computable" && noReport.reason.message).toContain("2025-09-30");

    const wrong = threeMonthFlow({ ...base, previous: 1n, previousEnd: "2025-06-30", cpi });
    expect(wrong.status === "not_computable" && wrong.reason.code).toBe("period_mismatch");

    const noCpi = threeMonthFlow({ ...base, previous: 1n, previousEnd: "2025-09-30" });
    expect(noCpi.status === "not_computable" && noCpi.reason.needs).toEqual(["cpi:2025-12", "cpi:2025-09"]);

    const gap = threeMonthFlow({
      ...base,
      previous: 1n,
      previousEnd: "2025-09-30",
      cpi: { base: "2025=100", values: new Map([["2025-12", cpiValue("2025-12", "110.386963")]]) },
    });
    expect(gap.status === "not_computable" && gap.reason.needs).toEqual(["cpi:2025-09"]);
  });

  test("a period that does not end a quarter is refused", () => {
    const r = threeMonthFlow({ name: "revenue", period: { start: "2026-01-01", end: "2026-05-31" }, current: 1n });
    expect(r.status === "not_computable" && r.reason.code).toBe("period_mismatch");
  });
});
