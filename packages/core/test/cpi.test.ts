/**
 * CPI series and factor (#47, tests #304). Expected values come from outside the code: TÜİK's published indices
 * (June 2026 129.99, December 2025 110.386963 in 2025=100), decision 0018 (1.1776 measured from restated balance
 * sheets), the calendar, and small series written by hand.
 */
import { describe, expect, test } from "bun:test";
import {
  CPI_CSV_HEADER,
  type CpiSeries,
  type CpiValue,
  cpiFactor,
  formatCpiCsv,
  fractionToDecimal,
  monthEnding,
  parseCpiCsv,
  parseIndex,
  parseTuikCpiCsv,
  updateCpiSeries,
} from "../src/index.ts";

const T0 = "2026-11-01T10:00:00Z";
const T1 = "2026-12-01T10:00:00Z";

function value(month: string, index: string, retrieved_at = T0, base = "2025=100"): CpiValue {
  return { month, index, base, source: "TÜİK", series_code: "DF_TUFE_SDMX_TT10", retrieved_at };
}

function series(...values: CpiValue[]): CpiSeries {
  return { base: values[0]?.base ?? "2025=100", values: new Map(values.map((v) => [v.month, v])) };
}

function csv(...rows: string[]): string {
  return `${[CPI_CSV_HEADER, ...rows].join("\n")}\n`;
}

const row = (month: string, index: string, base = "2025=100", at = T0) =>
  `${month},${index},${base},TÜİK,DF_TUFE_SDMX_TT10,${at}`;

describe("parseIndex", () => {
  test("a published value is an exact fraction", () => {
    expect(parseIndex("129.99")).toEqual({ numerator: 12999n, denominator: 100n });
    expect(parseIndex("110.386963")).toEqual({ numerator: 110386963n, denominator: 1000000n });
    expect(parseIndex("100")).toEqual({ numerator: 100n, denominator: 1n });
  });

  test("zero, negatives, commas and more than six decimals are refused", () => {
    for (const bad of ["0", "0.000", "-1.5", "129,99", "1.1234567", "", "abc", "1e3"]) {
      expect(parseIndex(bad)).toBeNull();
    }
  });
});

describe("monthEnding", () => {
  test("the last day of a month gives the month", () => {
    expect(monthEnding("2026-06-30")).toBe("2026-06");
    expect(monthEnding("2025-12-31")).toBe("2025-12");
    expect(monthEnding("2026-02-28")).toBe("2026-02");
    expect(monthEnding("2024-02-29")).toBe("2024-02");
  });

  test("any other day, or an impossible date, gives null", () => {
    expect(monthEnding("2026-06-29")).toBeNull();
    expect(monthEnding("2024-02-28")).toBeNull();
    expect(monthEnding("2026-02-29")).toBeNull();
    expect(monthEnding("2026-04-31")).toBeNull();
  });
});

describe("cpiFactor", () => {
  const s = series(value("2025-12", "110.386963"), value("2026-06", "129.99"));

  test("June 2026 / December 2025 is 129.99 / 110.386963, the 1.1776 of decision 0018", () => {
    const f = cpiFactor(s, "2026-06-30", "2025-12-31");
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    // 12999/100 ÷ 110386963/10^6 = 129990000 / 110386963; the two have no common factor.
    expect(f.factor).toEqual({ numerator: 129990000n, denominator: 110386963n });
    expect(fractionToDecimal(f.factor, 4)).toBe("1.1776");
    expect(f.to.month).toBe("2026-06");
    expect(f.from.month).toBe("2025-12");
    expect(f.from.source).toBe("TÜİK");
  });

  test("the factor the other way round is the inverse, and a month to itself is 1", () => {
    const back = cpiFactor(s, "2025-12-31", "2026-06-30");
    expect(back.status === "ok" && back.factor).toEqual({ numerator: 110386963n, denominator: 129990000n });
    const same = cpiFactor(s, "2026-06-30", "2026-06-30");
    expect(same.status === "ok" && same.factor).toEqual({ numerator: 1n, denominator: 1n });
  });

  test("a date that is not a month end is not computable", () => {
    const f = cpiFactor(s, "2026-06-29", "2025-12-31");
    expect(f.status).toBe("not_computable");
    if (f.status !== "not_computable") return;
    expect(f.reason.code).toBe("period_mismatch");
    expect(f.reason.message).toContain("2026-06-29");
    expect(f.reason.needs).toEqual([]);
  });

  test("a month missing from the series is not computable and names the month", () => {
    const f = cpiFactor(s, "2026-09-30", "2025-12-31");
    expect(f.status).toBe("not_computable");
    if (f.status !== "not_computable") return;
    expect(f.reason.code).toBe("missing_input");
    expect(f.reason.needs).toEqual(["cpi:2026-09"]);
    expect(f.reason.message).toContain("2026-09");
  });

  test("two missing months are both named, a month missing twice once", () => {
    const both = cpiFactor(s, "2026-09-30", "2024-12-31");
    expect(both.status === "not_computable" && both.reason.needs).toEqual(["cpi:2026-09", "cpi:2024-12"]);
    const twice = cpiFactor(s, "2026-09-30", "2026-09-30");
    expect(twice.status === "not_computable" && twice.reason.needs).toEqual(["cpi:2026-09"]);
  });
});

describe("fractionToDecimal", () => {
  test("rounds half away from zero", () => {
    expect(fractionToDecimal({ numerator: 1n, denominator: 8n }, 2)).toBe("0.13");
    expect(fractionToDecimal({ numerator: -1n, denominator: 8n }, 2)).toBe("-0.13");
    expect(fractionToDecimal({ numerator: 1n, denominator: 3n }, 4)).toBe("0.3333");
    expect(fractionToDecimal({ numerator: 2n, denominator: 3n }, 0)).toBe("1");
    expect(fractionToDecimal({ numerator: 1n, denominator: -4n }, 1)).toBe("-0.3");
  });

  test("a value that rounds to zero has no minus sign", () => {
    expect(fractionToDecimal({ numerator: -1n, denominator: 1000n }, 2)).toBe("0.00");
  });
});

describe("parseCpiCsv and formatCpiCsv", () => {
  test("reads a file and writes it back the same, oldest month first", () => {
    const text = csv(row("2025-12", "110.386963"), row("2026-01", "115.73"));
    const s = parseCpiCsv(text);
    expect(s.base).toBe("2025=100");
    expect([...s.values.keys()]).toEqual(["2025-12", "2026-01"]);
    expect(s.values.get("2026-01")).toEqual(value("2026-01", "115.73"));
    expect(formatCpiCsv(s)).toBe(text);
    const reversed = parseCpiCsv(csv(row("2026-01", "115.73"), row("2025-12", "110.386963")));
    expect(formatCpiCsv(reversed)).toBe(text);
  });

  test("a byte order mark and Windows line endings are accepted", () => {
    const s = parseCpiCsv(`﻿${CPI_CSV_HEADER}\r\n${row("2026-01", "115.73")}\r\n`);
    expect(s.values.size).toBe(1);
  });

  const refused: [string, string, RegExp][] = [
    ["a bad header", "month,index\n2026-01,115.73\n", /header/],
    ["no rows", csv(), /no rows/],
    ["a month listed twice", csv(row("2026-01", "115.73"), row("2026-01", "115.73")), /line 3.*twice/],
    ["two base years", csv(row("2026-01", "115.73"), row("2026-02", "3500.1", "2003=100")), /line 3.*base/],
    ["a bad month", csv(row("2026-13", "115.73")), /line 2.*month/],
    ["a bad index", csv(row("2026-01", "115,73")), /line 2/],
    ["a zero index", csv(row("2026-01", "0")), /line 2.*index/],
    ["a timestamp without Z", csv(row("2026-01", "115.73", "2025=100", "2026-11-01T10:00:00")), /line 2.*retrieved_at/],
    ["an impossible timestamp", csv(row("2026-01", "115.73", "2025=100", "2026-02-30T10:00:00Z")), /line 2/],
    ["an empty field", csv("2026-01,115.73,2025=100,,DF_TUFE_SDMX_TT10,2026-11-01T10:00:00Z"), /line 2/],
    ["a quoted field", csv('2026-01,"115.73",2025=100,TÜİK,DF_TUFE_SDMX_TT10,2026-11-01T10:00:00Z'), /line 2/],
    ["a missing field", csv("2026-01,115.73,2025=100,TÜİK,DF_TUFE_SDMX_TT10"), /line 2.*6 fields/],
  ];
  for (const [what, text, message] of refused) {
    test(`refuses ${what}`, () => {
      expect(() => parseCpiCsv(text)).toThrow(message);
    });
  }
});

describe("parseTuikCpiCsv", () => {
  const HEADER = [
    "Coğrafi Kapsam",
    "Gözlem Sıklığı",
    "Sınıflama Düzeyi",
    "Endeks-Değişim",
    "Temel Dönem/Yıl",
    "Zaman",
    "Gözlem Değeri",
  ];
  const INDEX = "Endeks";
  const CHANGE = "Bir önceki aya göre değişim oranı (%)";
  const line = (fields: string[]) => fields.map((f) => `"${f}"`).join(";");
  const tuik = (month: string, measure: string, v: string, base = "2025", area = "Türkiye") =>
    line([area, "Aylık", "TÜFE", measure, base, month, v]);
  const tuikFile = (...rows: string[]) => `${[line(HEADER), ...rows].join("\n")}\n`;

  // Index 100 → 101 → 102.01: +1.00% each month.
  const good = [
    tuik("2026-01", INDEX, "100"),
    tuik("2026-02", INDEX, "101"),
    tuik("2026-02", CHANGE, "1,00"),
    tuik("2026-03", INDEX, "102,01"),
    tuik("2026-03", CHANGE, "1,00"),
  ];

  test("reads a complete export into a series and checks every monthly change", () => {
    const r = parseTuikCpiCsv(tuikFile(...good), T0);
    expect(r.series.base).toBe("2025=100");
    expect([...r.series.values.keys()]).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(r.series.values.get("2026-03")).toEqual(value("2026-03", "102.01"));
    expect(r.checked_months).toBe(2);
    expect(r.largest_gap).toEqual({ numerator: 0n, denominator: 1n });
  });

  test("rows for other areas or measures are ignored", () => {
    const r = parseTuikCpiCsv(
      tuikFile(...good, tuik("2026-03", INDEX, "999", "2025", "İstanbul"), tuik("2026-03", "Yıllık", "30,00")),
      T0,
    );
    expect(r.series.values.get("2026-03")?.index).toBe("102.01");
  });

  test("a published change within rounding passes and is reported as the largest gap", () => {
    // 102.01 / 101 - 1 = exactly 1%; the published 1.01 is 0.01 points off.
    const rows = [...good.slice(0, 4), tuik("2026-03", CHANGE, "1,01")];
    const r = parseTuikCpiCsv(tuikFile(...rows), T0);
    expect(fractionToDecimal(r.largest_gap, 2)).toBe("0.01");
  });

  test("refuses a change that the index does not reproduce", () => {
    const rows = [...good.slice(0, 4), tuik("2026-03", CHANGE, "1,50")];
    expect(() => parseTuikCpiCsv(tuikFile(...rows), T0)).toThrow(/not one chain/);
  });

  test("refuses a missing month", () => {
    const rows = [tuik("2026-01", INDEX, "100"), tuik("2026-03", INDEX, "102,01"), tuik("2026-03", CHANGE, "1,00")];
    expect(() => parseTuikCpiCsv(tuikFile(...rows), T0)).toThrow(/no index for 2026-02/);
  });

  test("refuses a month without its published change (cut off)", () => {
    expect(() => parseTuikCpiCsv(tuikFile(...good.slice(0, 2)), T0)).toThrow(/no monthly change for 2026-02/);
  });

  test("refuses a change without its index (cut off)", () => {
    expect(() => parseTuikCpiCsv(tuikFile(...good.slice(0, 3), tuik("2026-04", CHANGE, "1,00")), T0)).toThrow(
      /without an index for 2026-04/,
    );
  });

  test("refuses two base years", () => {
    const rows = [...good, tuik("2026-04", INDEX, "3500", "2003"), tuik("2026-04", CHANGE, "1,00")];
    expect(() => parseTuikCpiCsv(tuikFile(...rows), T0)).toThrow(/base year 2003/);
  });

  test("refuses an index listed twice, an unquoted field and a missing column", () => {
    expect(() => parseTuikCpiCsv(tuikFile(...good, tuik("2026-03", INDEX, "102,01")), T0)).toThrow(/twice/);
    expect(() => parseTuikCpiCsv(`${tuikFile(...good)}Türkiye;Aylık\n`, T0)).toThrow(/not a quoted value/);
    const noTime = `${line(HEADER.filter((h) => h !== "Zaman"))}\n`;
    expect(() => parseTuikCpiCsv(noTime, T0)).toThrow(/Zaman/);
  });

  test("refuses an export without index rows and a bad retrieval time", () => {
    expect(() => parseTuikCpiCsv(tuikFile(), T0)).toThrow(/no index rows/);
    expect(() => parseTuikCpiCsv(tuikFile(...good), "2026-11-01")).toThrow(/retrieved_at/);
  });
});

describe("updateCpiSeries", () => {
  const previous = series(value("2026-01", "115.73"), value("2026-02", "119.16"));

  test("a new month is added; unchanged months keep their retrieval time", () => {
    const next = series(value("2026-01", "115.73", T1), value("2026-02", "119.16", T1), value("2026-03", "121.47", T1));
    const u = updateCpiSeries(previous, next);
    expect(u.added).toEqual(["2026-03"]);
    expect(u.revised).toEqual([]);
    expect(u.missing).toEqual([]);
    expect(u.series.values.get("2026-01")?.retrieved_at).toBe(T0);
    expect(u.series.values.get("2026-03")?.retrieved_at).toBe(T1);
  });

  test("a revised month is listed and takes the new retrieval time", () => {
    const next = series(value("2026-01", "115.73", T1), value("2026-02", "119.20", T1));
    const u = updateCpiSeries(previous, next);
    expect(u.revised).toEqual(["2026-02"]);
    expect(u.series.values.get("2026-02")).toEqual(value("2026-02", "119.20", T1));
  });

  test("a month the new series lacks is reported as missing", () => {
    const u = updateCpiSeries(previous, series(value("2026-02", "119.16", T1)));
    expect(u.missing).toEqual(["2026-01"]);
  });

  test("a new base year revises every month", () => {
    const next = series(value("2026-01", "3700.5", T1, "2003=100"), value("2026-02", "3810.2", T1, "2003=100"));
    const u = updateCpiSeries(previous, next);
    expect(u.series.base).toBe("2003=100");
    expect(u.revised).toEqual(["2026-01", "2026-02"]);
    expect(u.series.values.get("2026-01")?.retrieved_at).toBe(T1);
  });
});
