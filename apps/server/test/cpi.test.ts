/**
 * The CPI series that ships with Vigil (#47, tests #304). Expected values come from outside the code: a 2025=100
 * index averages 100 over 2025 by definition, and decision 0018 measured June 2026 / December 2025 = 1.1776 from
 * restated balance sheets.
 */
import { describe, expect, test } from "bun:test";
import { cpiFactor, fractionToDecimal, parseIndex } from "@vigil/core";
import { CPI_FILE, readCpiFile } from "../src/cpi.ts";

describe("shipped CPI series", () => {
  const series = readCpiFile(CPI_FILE);
  const months = [...series.values.keys()].sort();

  test("is one 2025=100 series from TÜİK", () => {
    expect(series.base).toBe("2025=100");
    for (const v of series.values.values()) {
      expect(v.source).toBe("TÜİK");
      expect(v.series_code).toBe("DF_TUFE_SDMX_TT10");
    }
  });

  test("has every month from its first to its last", () => {
    const first = months[0] as string;
    const last = months[months.length - 1] as string;
    const [y0, m0] = first.split("-").map(Number) as [number, number];
    const [y1, m1] = last.split("-").map(Number) as [number, number];
    expect(months.length).toBe((y1 - y0) * 12 + (m1 - m0) + 1);
    expect(first <= "2024-12").toBe(true);
  });

  test("averages 100 over 2025", () => {
    const year = months.filter((m) => m.startsWith("2025-"));
    expect(year.length).toBe(12);
    // Sum of the twelve values as one exact fraction, compared with 1,200 to six decimals.
    let num = 0n;
    let den = 1n;
    for (const m of year) {
      const f = parseIndex(series.values.get(m)?.index ?? "") as { numerator: bigint; denominator: bigint };
      num = num * f.denominator + f.numerator * den;
      den *= f.denominator;
    }
    expect(fractionToDecimal({ numerator: num, denominator: den * 12n }, 4)).toBe("100.0000");
  });

  test("gives the factor that decision 0018 measured from the filings", () => {
    const f = cpiFactor(series, "2026-06-30", "2025-12-31");
    expect(f.status).toBe("ok");
    if (f.status === "ok") expect(fractionToDecimal(f.factor, 4)).toBe("1.1776");
  });
});
