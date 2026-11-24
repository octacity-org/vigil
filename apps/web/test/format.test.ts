/** Turkish number and date formatting for the UI (#174, #363). Expected strings are written by hand. */
import { describe, expect, test } from "bun:test";
import {
  formatAmount,
  formatDate,
  formatDateRange,
  formatPercentage,
  formatPercentagePoints,
  formatPeriod,
} from "../src/lib/format.ts";

describe("formatAmount", () => {
  test("whole TL with Turkish digit grouping", () => {
    expect(formatAmount(189492068n)).toBe("189.492.068 TL");
    expect(formatAmount(0n)).toBe("0 TL");
    expect(formatAmount(999n)).toBe("999 TL");
  });

  test("amounts above Number.MAX_SAFE_INTEGER keep every digit", () => {
    // 2^53 + 1 cannot be held by a JS number.
    expect(formatAmount(9007199254740993n)).toBe("9.007.199.254.740.993 TL");
    expect(formatAmount(123456789012345678901234n)).toBe("123.456.789.012.345.678.901.234 TL");
  });

  test("negatives in every scale", () => {
    expect(formatAmount(-957022643n)).toBe("-957.022.643 TL");
    expect(formatAmount(-957022643n, "thousand")).toBe("-957.022,643 bin TL");
    expect(formatAmount(-957022643n, "million")).toBe("-957,022643 milyon TL");
  });

  test("thousand and million TL drop trailing zeros only, never digits", () => {
    expect(formatAmount(1351403000000n, "million")).toBe("1.351.403 milyon TL");
    expect(formatAmount(1351403000000n, "thousand")).toBe("1.351.403.000 bin TL");
    expect(formatAmount(1500n, "thousand")).toBe("1,5 bin TL");
    expect(formatAmount(5n, "million")).toBe("0,000005 milyon TL");
    expect(formatAmount(-5n, "million")).toBe("-0,000005 milyon TL");
    expect(formatAmount(0n, "million")).toBe("0 milyon TL");
  });
});

describe("formatPercentage", () => {
  test("ratios from docs/API.md", () => {
    expect(formatPercentage("0.215430")).toBe("%21,543");
    expect(formatPercentage("0.475035")).toBe("%47,5035");
  });

  test("whole, negative and above-one ratios", () => {
    expect(formatPercentage("0.5")).toBe("%50");
    expect(formatPercentage("1.5")).toBe("%150");
    expect(formatPercentage("0")).toBe("%0");
    expect(formatPercentage("-0.05")).toBe("-%5");
    expect(formatPercentage("-1.25")).toBe("-%125");
  });

  test("anything but a plain decimal is refused", () => {
    for (const bad of ["", "abc", "0,5", ".5", "5.", "+0.5", "1e-3", " 0.5"]) {
      expect(() => formatPercentage(bad)).toThrow(TypeError);
    }
  });
});

describe("formatPercentagePoints", () => {
  test("basis points as percentage points", () => {
    expect(formatPercentagePoints(-2596n)).toBe("-25,96 yüzde puan");
    expect(formatPercentagePoints(1000n)).toBe("10 yüzde puan");
    expect(formatPercentagePoints(5n)).toBe("0,05 yüzde puan");
    expect(formatPercentagePoints(-5n)).toBe("-0,05 yüzde puan");
    expect(formatPercentagePoints(0n)).toBe("0 yüzde puan");
  });
});

describe("dates", () => {
  test("ISO dates as DD.MM.YYYY", () => {
    expect(formatDate("2026-06-30")).toBe("30.06.2026");
    expect(formatDate("2026-01-01")).toBe("01.01.2026");
    expect(formatDate("2024-02-29")).toBe("29.02.2024");
  });

  test("invalid dates are refused", () => {
    for (const bad of [
      "2025-02-29",
      "2026-13-01",
      "2026-06-31",
      "2026-6-30",
      "30.06.2026",
      "2026-06-30T00:00:00Z",
      "",
    ]) {
      expect(() => formatDate(bad)).toThrow(RangeError);
    }
  });

  test("a date range", () => {
    expect(formatDateRange("2026-01-01", "2026-06-30")).toBe("01.01.2026 – 30.06.2026");
  });
});

describe("formatPeriod", () => {
  test("point in time, cumulative and three-month periods are told apart", () => {
    expect(formatPeriod({ start: null, end: "2026-06-30", type: "point_in_time" })).toBe("30.06.2026 itibarıyla");
    expect(formatPeriod({ start: "2026-01-01", end: "2026-06-30", type: "cumulative" })).toBe(
      "Kümülatif · 01.01.2026 – 30.06.2026",
    );
    expect(formatPeriod({ start: "2026-04-01", end: "2026-06-30", type: "three_month" })).toBe(
      "3 aylık · 01.04.2026 – 30.06.2026",
    );
  });

  test("a flow period without a start date names its end", () => {
    expect(formatPeriod({ start: null, end: "2026-06-30", type: "cumulative" })).toBe(
      "Kümülatif · Dönem sonu 30.06.2026",
    );
  });
});
