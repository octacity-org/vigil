/**
 * The CPI series that ships with Vigil (#47) and its DuckDB table (#188); tests #304. Expected values come from
 * outside the code: a 2025=100 index averages 100 over 2025 by definition, decision 0018 measured June 2026 /
 * December 2025 = 1.1776 from restated balance sheets, and the small series below are written by hand.
 */
import { describe, expect, test } from "bun:test";
import { CPI_CSV_HEADER, type CpiSeries, cpiFactor, fractionToDecimal, parseCpiCsv, parseIndex } from "@vigil/core";
import { CPI_FILE, cpiSummary, loadCpiSeries, readCpiFile } from "../src/cpi.ts";
import { close, connect, type Database, rows } from "../src/db.ts";

const T0 = "2026-11-01T10:00:00Z";
const T1 = "2026-12-01T10:00:00Z";

function series(...lines: string[]): CpiSeries {
  return parseCpiCsv(`${[CPI_CSV_HEADER, ...lines].join("\n")}\n`);
}
const row = (month: string, index: string, at = T0, base = "2025=100") =>
  `${month},${index},${base},TÜİK,DF_TUFE_SDMX_TT10,${at}`;

async function table(db: Database): Promise<Record<string, unknown>[]> {
  return rows(
    db,
    `SELECT strftime(month, '%Y-%m-%d') AS month, index_value::VARCHAR AS index_value, base, source, series_code,
            strftime(retrieved_at, '%Y-%m-%d %H:%M:%S') AS retrieved_at
     FROM cpi_monthly ORDER BY month`,
  );
}

async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = await connect(":memory:");
  try {
    await fn(db);
  } finally {
    close(db);
  }
}

describe("loadCpiSeries", () => {
  const three = series(row("2025-12", "110.386963"), row("2026-01", "115.73"), row("2026-02", "119.16"));

  test("writes one row per month with the value as published and the retrieval time in UTC", async () => {
    await withDb(async (db) => {
      expect(await loadCpiSeries(db, three)).toBe(3);
      const t = await table(db);
      expect(t.map((r) => r.month)).toEqual(["2025-12-01", "2026-01-01", "2026-02-01"]);
      expect(t[0]).toEqual({
        month: "2025-12-01",
        index_value: "110.386963",
        base: "2025=100",
        source: "TÜİK",
        series_code: "DF_TUFE_SDMX_TT10",
        retrieved_at: "2026-11-01 10:00:00",
      });
      // DECIMAL(18, 6) pads to six decimals; the value is the published 115.73.
      expect(t[1]?.index_value).toBe("115.730000");
      expect(await cpiSummary(db)).toEqual({ months: 3, first: "2025-12", last: "2026-02" });
    });
  });

  test("loading the same series twice gives the same table", async () => {
    await withDb(async (db) => {
      await loadCpiSeries(db, three);
      const first = await table(db);
      await loadCpiSeries(db, three);
      expect(await table(db)).toEqual(first);
    });
  });

  test("a new series replaces the old one: dropped months go, new and revised values come in", async () => {
    await withDb(async (db) => {
      await loadCpiSeries(db, three);
      await loadCpiSeries(
        db,
        series(row("2026-01", "115.73"), row("2026-02", "119.20", T1), row("2026-03", "121.47", T1)),
      );
      const t = await table(db);
      expect(t.map((r) => r.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
      expect(t[1]?.index_value).toBe("119.200000");
      expect(t[1]?.retrieved_at).toBe("2026-12-01 10:00:00");
    });
  });

  test("a series in another base leaves no value of the old base", async () => {
    await withDb(async (db) => {
      await loadCpiSeries(db, three);
      await loadCpiSeries(db, series(row("2026-01", "3700.5", T1, "2003=100")));
      expect((await table(db)).map((r) => r.base)).toEqual(["2003=100"]);
    });
  });

  test("a failing insert keeps the previous table", async () => {
    await withDb(async (db) => {
      await loadCpiSeries(db, three);
      const before = await table(db);
      // Built by hand, not through parseCpiCsv: 13 integer digits do not fit DECIMAL(18, 6).
      const bad: CpiSeries = {
        base: "2025=100",
        values: new Map([
          [
            "2026-01",
            { month: "2026-01", index: "116", base: "2025=100", source: "TÜİK", series_code: "X", retrieved_at: T1 },
          ],
          [
            "2026-02",
            {
              month: "2026-02",
              index: "1234567890123.5",
              base: "2025=100",
              source: "TÜİK",
              series_code: "X",
              retrieved_at: T1,
            },
          ],
        ]),
      };
      await expect(loadCpiSeries(db, bad)).rejects.toThrow();
      expect(await table(db)).toEqual(before);
    });
  });

  test("an empty table gives zero months", async () => {
    await withDb(async (db) => {
      expect(await cpiSummary(db)).toEqual({ months: 0, first: null, last: null });
    });
  });
});

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
