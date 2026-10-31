/**
 * Bitemporal schema and DuckDB loader (#121, #122; tests from #123, publication order from #157).
 * Filings are built by hand and loaded into an in-memory database, so the tests run in CI without KAP data.
 * Expected values are written in the tests, not taken from the loader's output.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ParsedFiling, ParsedFinancialFact } from "@vigil/core";
import { fact as baseFact, filing as baseFiling, PUBLISHED } from "../../../packages/core/test/helpers.ts";
import {
  close,
  connect,
  countMismatches,
  type Database,
  failedFiles,
  loadFiling,
  loadFilings,
  parseDirectory,
  rows,
  staleReports,
} from "../src/db.ts";

function fact(raw: number, fields: Partial<ParsedFinancialFact> = {}): ParsedFinancialFact {
  return baseFact({
    column_class: "col-order-class-5",
    period_label: "Önceki Dönem 31.12.2025",
    is_restated_comparative: true,
    raw_value: BigInt(raw),
    normalized_value_tl: BigInt(raw),
    period_end: "2025-12-31",
    ...fields,
  });
}

function filing(
  disclosureId: number,
  year: number,
  quarter: number,
  facts: ParsedFinancialFact[],
  fields: Partial<ParsedFiling> = {},
): ParsedFiling {
  const consolidation = fields.consolidation_type ?? "Konsolide";
  return baseFiling({
    file_name: `TEST_${disclosureId}_${year}_${quarter}.xls`,
    disclosure_id: disclosureId,
    year,
    quarter,
    role_codes: ["210015"],
    facts: facts.map((f) => ({ ...f, disclosure_id: disclosureId, year, quarter, consolidation_type: consolidation })),
    ...fields,
  });
}

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
});
afterEach(() => close(db));

const q = (sql: string) => rows(db, sql);
const count = async (table: string) => Number((await q(`SELECT count(*) AS n FROM ${table}`))[0]?.n);
const plain = (r: Record<string, unknown>[]) =>
  r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));

describe("versions", () => {
  test("the same fact in two reports gets versions 1 and 2", async () => {
    // 31.12.2025 cash: 100 as first reported in 2026/1, restated to 110 in 2026/2.
    await loadFiling(db, filing(2, 2026, 2, [fact(110)]));
    await loadFiling(db, filing(1, 2026, 1, [fact(100)]));
    expect(plain(await q("SELECT disclosure_id, version_no, version_count FROM fact_versions ORDER BY 1"))).toEqual([
      { disclosure_id: 1, version_no: 1, version_count: 2 },
      { disclosure_id: 2, version_no: 2, version_count: 2 },
    ]);
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts_first_reported"))).toEqual([
      { disclosure_id: 1, raw_value: 100 },
    ]);
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts_latest"))).toEqual([
      { disclosure_id: 2, raw_value: 110 },
    ]);
  });

  test("versions follow the report period, not the load order", async () => {
    await loadFiling(db, filing(3, 2026, 2, [fact(120)]));
    await loadFiling(db, filing(2, 2026, 1, [fact(110)]));
    await loadFiling(db, filing(1, 2025, 4, [fact(100)]));
    expect(plain(await q("SELECT reported_year, reported_quarter, version_no FROM fact_versions ORDER BY 3"))).toEqual([
      { reported_year: 2025, reported_quarter: 4, version_no: 1 },
      { reported_year: 2026, reported_quarter: 1, version_no: 2 },
      { reported_year: 2026, reported_quarter: 2, version_no: 3 },
    ]);
  });

  test("within one period, publication order beats the disclosure id (#157)", async () => {
    // Disclosure 10 was published before disclosure 9.
    await loadFiling(db, filing(9, 2026, 2, [fact(100)], { published_at: "2026-08-18T10:00:00" }));
    await loadFiling(db, filing(10, 2026, 2, [fact(110)], { published_at: "2026-08-17T19:00:00" }));
    expect(plain(await q("SELECT disclosure_id, version_no FROM fact_versions ORDER BY version_no"))).toEqual([
      { disclosure_id: 10, version_no: 1 },
      { disclosure_id: 9, version_no: 2 },
    ]);
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts_latest"))).toEqual([
      { disclosure_id: 9, raw_value: 100 },
    ]);
  });

  test("the report period still comes first", async () => {
    // A 2026/1 report published after the 2026/2 one stays the earlier version.
    await loadFiling(db, filing(2, 2026, 2, [fact(120)], { published_at: "2026-08-17T19:00:00" }));
    await loadFiling(db, filing(1, 2026, 1, [fact(110)], { published_at: "2026-09-01T12:00:00" }));
    expect(plain(await q("SELECT disclosure_id, version_no FROM fact_versions ORDER BY version_no"))).toEqual([
      { disclosure_id: 1, version_no: 1 },
      { disclosure_id: 2, version_no: 2 },
    ]);
  });

  test("the disclosure id breaks ties, and unknown publication times come last", async () => {
    const same = "2026-08-17T19:00:00";
    await loadFiling(db, filing(8, 2026, 2, [fact(100)]));
    await loadFiling(db, filing(7, 2026, 2, [fact(100)], { published_at: same }));
    await loadFiling(db, filing(6, 2026, 2, [fact(100)], { published_at: same }));
    expect(plain(await q("SELECT disclosure_id, version_no FROM fact_versions ORDER BY version_no"))).toEqual([
      { disclosure_id: 6, version_no: 1 },
      { disclosure_id: 7, version_no: 2 },
      { disclosure_id: 8, version_no: 3 },
    ]);
  });
});

describe("fact identity", () => {
  test("TP, YP and TOTAL are separate facts", async () => {
    await loadFiling(
      db,
      filing(1, 2026, 1, [
        fact(60, { column_class: "col-order-class-4", period_type: "POINT_IN_TIME_TP" }),
        fact(40, { column_class: "col-order-class-5", period_type: "POINT_IN_TIME_YP" }),
        fact(100, { column_class: "col-order-class-6", period_type: "POINT_IN_TIME" }),
      ]),
    );
    // The next report carries only the total, so only the total gets a second version.
    await loadFiling(db, filing(2, 2026, 2, [fact(100, { column_class: "col-order-class-6" })]));
    expect(
      plain(
        await q(
          "SELECT currency_part, disclosure_id, raw_value, version_no, version_count FROM fact_versions ORDER BY 1, 2",
        ),
      ),
    ).toEqual([
      { currency_part: "TOTAL", disclosure_id: 1, raw_value: 100, version_no: 1, version_count: 2 },
      { currency_part: "TOTAL", disclosure_id: 2, raw_value: 100, version_no: 2, version_count: 2 },
      { currency_part: "TP", disclosure_id: 1, raw_value: 60, version_no: 1, version_count: 1 },
      { currency_part: "YP", disclosure_id: 1, raw_value: 40, version_no: 1, version_count: 1 },
    ]);
    expect(await count("fact_conflicts")).toBe(0);
  });

  test("consolidated and solo are separate facts", async () => {
    await loadFiling(db, filing(1, 2026, 2, [fact(100)], { consolidation_type: "Konsolide" }));
    await loadFiling(db, filing(2, 2026, 2, [fact(70)], { consolidation_type: "Konsolide Olmayan" }));
    expect(plain(await q("SELECT consolidation_type, raw_value, version_no FROM fact_versions ORDER BY 1"))).toEqual([
      { consolidation_type: "Konsolide", raw_value: 100, version_no: 1 },
      { consolidation_type: "Konsolide Olmayan", raw_value: 70, version_no: 1 },
    ]);
  });

  test("a NULL period_end is kept in facts but not versioned", async () => {
    await loadFiling(
      db,
      filing(1, 2026, 2, [fact(100), fact(5, { column_class: "col-order-class-10", period_end: null })]),
    );
    expect(await count("facts")).toBe(2);
    for (const view of ["fact_versions", "facts_first_reported", "facts_latest"]) {
      expect(await q(`SELECT column_class FROM ${view}`)).toEqual([{ column_class: "col-order-class-5" }]);
    }
  });
});

describe("fact_conflicts", () => {
  // In a Q1 report the cumulative and the 3-month column cover the same months.
  const q1Income = (cumulative: number, threeMonth: number) => {
    const row_id = "general_role_310003-row-3";
    const span = { row_id, period_type: "Q_STANDALONE" as const, period_start: "2026-01-01", period_end: "2026-03-31" };
    return [
      fact(cumulative, { ...span, column_class: "col-order-class-4" }),
      fact(threeMonth, { ...span, column_class: "col-order-class-6" }),
    ];
  };

  test("listed when one report has two values", async () => {
    await loadFiling(db, filing(1, 2026, 1, q1Income(500, 450)));
    const conflicts = await q("SELECT disclosure_id, column_classes, raw_values FROM fact_conflicts");
    expect(
      conflicts.map((r) => [Number(r.disclosure_id), r.column_classes, (r.raw_values as bigint[]).map(Number)]),
    ).toEqual([[1, ["col-order-class-4", "col-order-class-6"], [500, 450]]]);
    // Both rows belong to the same version.
    expect(plain(await q("SELECT DISTINCT version_no, version_count FROM fact_versions"))).toEqual([
      { version_no: 1, version_count: 1 },
    ]);
  });

  test("not listed when the values are equal", async () => {
    await loadFiling(db, filing(1, 2026, 1, q1Income(500, 500)));
    expect(await count("fact_conflicts")).toBe(0);
  });

  test("a restatement across reports is not a conflict", async () => {
    await loadFiling(db, filing(1, 2026, 1, [fact(100)]));
    await loadFiling(db, filing(2, 2026, 2, [fact(110)]));
    expect(await count("fact_conflicts")).toBe(0);
  });
});

describe("idempotency and rollback", () => {
  test("loading the same filing twice gives the same counts", async () => {
    const f = filing(1, 2026, 2, [
      fact(100),
      fact(200, { column_class: "col-order-class-4", period_end: "2026-06-30" }),
    ]);
    await loadFiling(db, f);
    await loadFiling(db, f);
    expect([await count("companies"), await count("reports"), await count("facts")]).toEqual([1, 1, 2]);
    expect(plain(await q("SELECT fact_count FROM reports"))).toEqual([{ fact_count: 2 }]);
  });

  test("a failing insert keeps the previous version", async () => {
    await loadFiling(db, filing(1, 2026, 2, [fact(100)]));
    // Two facts with the same (row_id, column_class) break the facts primary key in the middle of the load.
    await expect(loadFiling(db, filing(1, 2026, 2, [fact(999), fact(999)]))).rejects.toThrow();
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts"))).toEqual([
      { disclosure_id: 1, raw_value: 100 },
    ]);
    expect(plain(await q("SELECT disclosure_id, fact_count FROM reports"))).toEqual([
      { disclosure_id: 1, fact_count: 1 },
    ]);
  });
});

// --- parse report and stale reports --------------------------------------------------------------------------------

describe("parse report", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vigil-db-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const kapHtml = (rowsHtml: string, unit: string | null = "TL") =>
    `<html><body>${PUBLISHED}<table>${unit ? `<tr><td>Sunum Para Birimi</td><td>${unit}</td></tr>` : ""}</table>` +
    '<table class="financial-table tbl_general_role_210015" border="1">' +
    '<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>' +
    `${rowsHtml}</table></body></html>`;
  const kapRow = (n: number, value: number) =>
    `<tr class="general_role_210015-row-${n} data-input-row presentation-enabled">` +
    '<td><div class="gwt-Label multi-language-content content-tr">Satır</div></td>' +
    `<td class="taxonomy-context-value col-order-class-4"><div><div title="${value}">${value}</div></div></td></tr>`;
  const statuses = (files: { filepath: string; status: string }[]) =>
    files.map((f) => [basename(f.filepath), f.status]).sort();

  test("a duplicate disclosure and duplicate keys are reported, not loaded", async () => {
    writeFileSync(join(dir, "AAA_1001_2026_2.xls"), kapHtml(kapRow(4, 100)));
    writeFileSync(join(dir, "BBB_1001_2026_2.xls"), kapHtml(kapRow(4, 200))); // same disclosure id as AAA
    writeFileSync(join(dir, "CCC_1002_2026_2.xls"), kapHtml(kapRow(4, 300) + kapRow(4, 301))); // same cell twice
    const [filings, report] = parseDirectory(dir);
    await loadFilings(db, filings, report);
    expect(statuses(report.files)).toEqual([
      ["AAA_1001_2026_2.xls", "ok"],
      ["BBB_1001_2026_2.xls", "duplicate_disclosure"],
      ["CCC_1002_2026_2.xls", "duplicate_facts"],
    ]);
    expect(failedFiles(report).map((f) => f.disclosure_id)).toEqual([1001, 1002]);
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts"))).toEqual([
      { disclosure_id: 1001, raw_value: 100 },
    ]);
    expect(await countMismatches(db, report)).toEqual([]);
  });

  test("a file that fails on the next run is flagged as stale", async () => {
    const path = join(dir, "AAA_1001_2026_2.xls");
    writeFileSync(path, kapHtml(kapRow(4, 100)));
    let [filings, report] = parseDirectory(dir);
    await loadFilings(db, filings, report);
    expect(await staleReports(db, report)).toEqual([]);

    writeFileSync(path, kapHtml(kapRow(4, 100), null)); // reporting unit removed: the parser now raises
    [filings, report] = parseDirectory(dir);
    await loadFilings(db, filings, report);
    expect(statuses(report.files)).toEqual([["AAA_1001_2026_2.xls", "parse_error"]]);
    expect(await staleReports(db, report)).toEqual([[path, 1001]]);
    // The rows from the first run are still there; flagging them is the point.
    expect(plain(await q("SELECT disclosure_id, raw_value FROM facts"))).toEqual([
      { disclosure_id: 1001, raw_value: 100 },
    ]);
  });
});

test("a database from before #157 gets the published_at column", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-old-"));
  const path = join(dir, "old.duckdb");
  try {
    const old = await DuckDBInstance.create(path);
    const con = await old.connect();
    await con.run(
      "CREATE TABLE reports (disclosure_id BIGINT PRIMARY KEY, company_code VARCHAR NOT NULL, " +
        "raw_ticker_group VARCHAR NOT NULL, year INTEGER NOT NULL, quarter INTEGER NOT NULL, " +
        "consolidation_type VARCHAR NOT NULL, template_family VARCHAR NOT NULL, scale_unit VARCHAR NOT NULL, " +
        "scale_multiplier BIGINT NOT NULL, has_tms29_monetary_item BOOLEAN NOT NULL, filepath VARCHAR NOT NULL, " +
        "fact_count INTEGER NOT NULL, loaded_at TIMESTAMP NOT NULL)",
    );
    con.closeSync();
    old.closeSync();

    const upgraded = await connect(path);
    await loadFiling(upgraded, filing(1, 2026, 2, [fact(100)], { published_at: "2026-08-17T19:05:18" }));
    const got = await rows(upgraded, "SELECT CAST(published_at AS VARCHAR) AS p FROM reports");
    expect(got).toEqual([{ p: "2026-08-17 19:05:18" }]);
    close(upgraded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
