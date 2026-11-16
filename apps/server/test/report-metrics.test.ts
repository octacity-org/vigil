/**
 * Computing a report's metrics (#209). Reports are synthetic KAP files (`fixtures/index.ts` format) with values chosen
 * so every metric can be worked out by hand; the CPI series is synthetic (100 at 2025-12, 110 at 2026-06, a factor of
 * 1.1). Expected behaviour: the issue's tasks (the metrics of #59–#65 that exist, stored as values or reasons, computed
 * again when a corrected version arrives) and "a correction updates the affected metrics".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CpiSeries, parseCpiCsv, parseKapXls } from "@vigil/core";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { readMetrics } from "../src/metrics-store.ts";
import { loadInto, processPending } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { rebuildDatabase } from "../src/rebuild.ts";
import { computeReportMetrics, readReportCells, refreshMetrics } from "../src/report-metrics.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore } from "../src/zova.ts";
import { BANK, type FixtureFiling, type FixtureTable, fileName, kapHtml, parseFixture } from "./fixtures/index.ts";

const CPI: CpiSeries = parseCpiCsv(
  [
    "month,index,base,source,series_code,retrieved_at",
    "2025-12,100,2025=100,test,TEST,2026-11-14T00:00:00Z",
    "2026-06,110,2025=100,test,TEST,2026-11-14T00:00:00Z",
  ].join("\n"),
);

const H1 = [
  "Cari Dönem <br>01.01.2026 - 30.06.2026",
  "Önceki Dönem <br>01.01.2025 - 30.06.2025",
  "Cari Dönem 3 Aylık <br>01.04.2026 - 30.06.2026",
  "Önceki Dönem 3 Aylık <br>01.04.2025 - 30.06.2025",
];
const FY = ["Cari Dönem <br>01.01.2025 - 31.12.2025", "Önceki Dönem <br>01.01.2024 - 31.12.2024"];

/** TSTMT 2026/2: every input of every metric, in TL. */
function q2(
  overrides: { disclosureId?: number; ticker?: string; consolidation?: FixtureFiling["consolidation"] } = {},
): FixtureFiling {
  return {
    ticker: overrides.ticker ?? "TSTMT",
    disclosureId: overrides.disclosureId ?? 9_100_002,
    year: 2026,
    quarter: 2,
    family: "general",
    unit: "TL",
    multiplier: 1n,
    consolidation: overrides.consolidation ?? "Konsolide",
    published: "17.08.2026 19:05:18",
    tables: [
      {
        role: "210015",
        headers: ["Cari Dönem <br>30.06.2026", "Önceki Dönem <br>31.12.2025"],
        rows: [
          { row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 100_000, 5: 80_000 } },
          { row: 40, label: "Stoklar", values: { 4: 50_000 } },
          { row: 55, label: "TOPLAM DÖNEN VARLIKLAR", values: { 4: 400_000 } },
          { row: 129, label: "TOPLAM VARLIKLAR", values: { 4: 1_000_000, 5: 900_000 } },
          { row: 132, label: "Kısa Vadeli Borçlanmalar", values: { 4: 150_000 } },
          { row: 143, label: "Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", values: { 4: 0 } },
          { row: 191, label: "TOPLAM KISA VADELİ YÜKÜMLÜLÜKLER", values: { 4: 200_000 } },
          { row: 193, label: "Uzun Vadeli Borçlanmalar", values: { 4: 250_000 } },
          { row: 242, label: "TOPLAM YÜKÜMLÜLÜKLER", values: { 4: 600_000 } },
          { row: 296, label: "TOPLAM ÖZKAYNAKLAR", values: { 4: 400_000 } },
        ],
      },
      {
        role: "310003",
        headers: H1,
        rows: [
          { row: 3, label: "Hasılat", values: { 4: 1_000_000, 5: 800_000, 6: 600_000, 7: 500_000 } },
          { row: 31, label: "BRÜT KAR (ZARAR)", values: { 4: 300_000, 5: 200_000, 6: 150_000, 7: 150_000 } },
          { row: 32, label: "Genel Yönetim Giderleri", values: { 4: -50_000, 5: -40_000 } },
          { row: 33, label: "Pazarlama Giderleri", values: { 4: -30_000, 5: -20_000 } },
          { row: 34, label: "Araştırma ve Geliştirme Giderleri", values: { 4: -20_000, 5: -10_000 } },
          { row: 38, label: "ESAS FAALİYET KARI (ZARARI)", values: { 4: 210_000, 5: 140_000 } },
          { row: 59, label: "DÖNEM KARI (ZARARI)", values: { 4: 120_000, 5: 90_000 } },
        ],
      },
      {
        role: "520003",
        headers: H1.slice(0, 2),
        rows: [
          { row: 2, label: "İŞLETME FAALİYETLERİNDEN NAKİT AKIŞLARI", values: { 4: 80_000, 5: 70_000 } },
          { row: 7, label: "Amortisman ve İtfa Gideri İle İlgili Düzeltmeler", values: { 4: 40_000, 5: 30_000 } },
          { row: 133, label: "Maddi ve Maddi Olmayan Duran Varlıkların Alımı", values: { 4: -60_000, 5: -50_000 } },
        ],
      },
    ],
  };
}

/** TSTMT 2025/4, the year end: EBITDA A for 2025 is 500 − 90 − 50 − 30 + 70 = 400 thousand (`gross` changes it). */
function fy2025(disclosureId = 9_100_001, gross = 500_000): FixtureFiling {
  return {
    ticker: "TSTMT",
    disclosureId,
    year: 2025,
    quarter: 4,
    family: "general",
    unit: "TL",
    multiplier: 1n,
    consolidation: "Konsolide",
    published: "10.03.2026 18:00:00",
    tables: [
      {
        role: "210015",
        headers: ["Cari Dönem <br>31.12.2025", "Önceki Dönem <br>31.12.2024"],
        rows: [{ row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 80_000, 5: 70_000 } }],
      },
      {
        role: "310003",
        headers: FY,
        rows: [
          { row: 3, label: "Hasılat", values: { 4: 1_800_000, 5: 1_500_000 } },
          { row: 31, label: "BRÜT KAR (ZARAR)", values: { 4: gross, 5: 400_000 } },
          { row: 32, label: "Genel Yönetim Giderleri", values: { 4: -90_000, 5: -80_000 } },
          { row: 33, label: "Pazarlama Giderleri", values: { 4: -50_000, 5: -40_000 } },
          { row: 34, label: "Araştırma ve Geliştirme Giderleri", values: { 4: -30_000, 5: -20_000 } },
        ],
      },
      {
        role: "520003",
        headers: FY,
        rows: [{ row: 7, label: "Amortisman ve İtfa Gideri İle İlgili Düzeltmeler", values: { 4: 70_000, 5: 60_000 } }],
      },
    ],
  };
}

const parse = (f: FixtureFiling) => parseKapXls(kapHtml(f), fileName(f));

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
});
afterEach(() => close(db));

async function load(...filings: FixtureFiling[]) {
  for (const f of filings) await loadFiling(db, parse(f));
}
/** The stored metric as the API would read it: status, value, reason code, formula. */
async function metric(disclosureId: number, code: string, periodType: string, periodEnd?: string) {
  const all = await readMetrics(db, disclosureId);
  return all.find(
    (m) =>
      m.metric_code === code && m.period_type === periodType && (periodEnd === undefined || m.period_end === periodEnd),
  );
}
const num = async (id: number, code: string, type: string, end?: string) =>
  Number((await metric(id, code, type, end))?.value);

describe("done when: a correction updates the affected metrics", () => {
  test("a corrected year-end report changes the next year's TTM metrics; its own metrics are computed", async () => {
    const store = memoryStore();
    migrateStore(store);
    const queue = new WriteQueue();
    const put = (f: FixtureFiling, at: string) =>
      storeRawFile(
        store,
        new TextEncoder().encode(kapHtml(f)),
        { fileName: fileName(f), sourceUrl: `file:///${fileName(f)}`, downloadedAt: new Date(at) },
        {
          onStored: (s, x) =>
            emit(s, "report_stored", x.object_id, { disclosure_id: x.disclosure_id, file_name: x.file_name }),
        },
      );
    const handle = loadInto(db, { cpi: CPI });
    put(fy2025(), "2026-03-11T08:00:00Z");
    put(q2(), "2026-08-18T08:00:00Z");
    await processPending(store, queue, { handle });

    // 240 + 400 × 1.1 − 160 = 520 thousand.
    expect(await num(9_100_002, "ebitda_a_ttm", "ttm")).toBe(520_000);
    expect(String((await metric(9_100_002, "ebitda_a_ttm", "ttm"))?.formula)).toEndWith(
      "(previous year end: disclosure 9100001)",
    );

    // The correction of 2025/4: gross profit 560 instead of 500, so EBITDA A 2025 is 460.
    put(fy2025(9_100_005, 560_000), "2026-09-01T08:00:00Z");
    await processPending(store, queue, { handle });
    expect(await num(9_100_005, "ebitda_a", "cumulative")).toBe(460_000);
    // 240 + 460 × 1.1 − 160 = 586 thousand; net debt / TTM EBITDA follows.
    expect(await num(9_100_002, "ebitda_a_ttm", "ttm")).toBe(586_000);
    expect(String((await metric(9_100_002, "ebitda_a_ttm", "ttm"))?.formula)).toEndWith(
      "(previous year end: disclosure 9100005)",
    );
    expect(await num(9_100_002, "net_debt_to_ebitda", "ttm")).toBeCloseTo(300_000 / 586_000, 12);
    // The original keeps its own numbers.
    expect(await num(9_100_001, "ebitda_a", "cumulative")).toBe(400_000);
    await queue.close();
    store.close();
  });
});

describe("the metrics of a report", () => {
  test("every metric of a general report, by hand", async () => {
    await load(q2());
    await refreshMetrics(db, 9_100_002, { cpi: CPI });
    const id = 9_100_002;
    expect(await num(id, "current_ratio", "point_in_time")).toBe(2);
    expect(await num(id, "quick_ratio", "point_in_time")).toBe(1.75);
    expect(await num(id, "cash_ratio", "point_in_time")).toBe(0.5);
    expect(await num(id, "net_debt", "point_in_time")).toBe(300_000); // 150 + 0 + 250 − 100
    expect(await num(id, "net_debt_to_equity", "point_in_time")).toBe(0.75);
    expect(await num(id, "liabilities_to_assets", "point_in_time")).toBe(0.6);
    expect(await num(id, "gross_margin", "cumulative")).toBe(0.3);
    expect(await num(id, "ebitda_a", "cumulative")).toBe(240_000);
    expect(await num(id, "ebitda_b", "cumulative")).toBe(250_000);
    expect(await num(id, "ebitda_b_minus_a", "cumulative")).toBe(10_000);
    expect(await num(id, "fcf", "cumulative")).toBe(20_000);
    expect(await num(id, "cfo_to_ebitda", "cumulative")).toBeCloseTo(1 / 3, 15);
    expect(await num(id, "capex_to_d_and_a", "cumulative")).toBe(1.5);
    expect(await num(id, "accrual_ratio", "cumulative")).toBeCloseTo(80 / 1900, 15);
    expect(await num(id, "gross_margin", "three_month", "2026-06-30")).toBe(0.25);
    expect(await num(id, "gross_margin", "three_month", "2025-06-30")).toBe(0.3);
    expect(await num(id, "gross_margin_change", "three_month")).toBeCloseTo(-500, 9);
    // No 2025 year-end report loaded: TTM is not computable, and says what is missing.
    expect(await metric(id, "ebitda_a_ttm", "ttm")).toMatchObject({
      status: "not_computable",
      reason_code: "missing_input",
      needs: ["ebitda_a:prior_full_year"],
    });
    expect(await metric(id, "net_debt_to_ebitda", "ttm")).toMatchObject({ status: "not_computable" });
  });

  test("periods and units are stored with each metric", async () => {
    await load(q2());
    await refreshMetrics(db, 9_100_002, { cpi: CPI });
    const all = await readMetrics(db, 9_100_002);
    const by = (code: string, type: string) => all.filter((m) => m.metric_code === code && m.period_type === type);
    expect(by("current_ratio", "point_in_time")[0]).toMatchObject({
      period_start: null,
      period_end: "2026-06-30",
      unit: "ratio",
    });
    expect(by("ebitda_a", "cumulative")[0]).toMatchObject({
      period_start: "2026-01-01",
      period_end: "2026-06-30",
      unit: "TRY",
    });
    expect(by("gross_margin", "three_month").map((m) => [m.period_start, m.period_end])).toEqual([
      ["2025-04-01", "2025-06-30"],
      ["2026-04-01", "2026-06-30"],
    ]);
    expect(by("gross_margin_change", "three_month")[0]?.unit).toBe("bps");
    expect(all.map((m) => m.definition_version)).toEqual(all.map(() => "2026-11-01"));
  });

  test("every input names the cell it was read from", async () => {
    await load(q2());
    await refreshMetrics(db, 9_100_002, { cpi: CPI });
    expect((await metric(9_100_002, "quick_ratio", "point_in_time"))?.inputs).toEqual([
      expect.objectContaining({
        input_code: "current_assets",
        value: "400000",
        source_row_id: "general_role_210015-row-55",
        source_column_class: "col-order-class-4",
        source_disclosure_id: 9_100_002n,
      }),
      expect.objectContaining({
        input_code: "inventories",
        value: "50000",
        source_row_id: "general_role_210015-row-40",
      }),
      expect.objectContaining({
        input_code: "current_liabilities",
        value: "200000",
        source_row_id: "general_role_210015-row-191",
      }),
    ]);
    const net = await metric(9_100_002, "net_debt", "point_in_time");
    expect((net?.inputs as Record<string, unknown>[]).map((i) => [i.input_code, i.status, i.source_row_id])).toEqual([
      ["financial_debt:short_term", "ok", "general_role_210015-row-132"],
      ["financial_debt:current_portion", "ok", "general_role_210015-row-143"],
      ["financial_debt:long_term", "ok", "general_role_210015-row-193"],
      ["cash", "ok", "general_role_210015-row-4"],
    ]);
    const q = await metric(9_100_002, "gross_margin", "three_month", "2026-06-30");
    expect((q?.inputs as Record<string, unknown>[]).map((i) => [i.input_code, i.source_column_class])).toEqual([
      ["gross_profit:three_month", "col-order-class-6"],
      ["revenue:three_month", "col-order-class-6"],
    ]);
    const prior = await metric(9_100_002, "accrual_ratio", "cumulative");
    expect((prior?.inputs as Record<string, unknown>[])[3]).toMatchObject({
      input_code: "total_assets:prior_year_end",
      source_column_class: "col-order-class-5",
    });
  });

  test("a year-end report's TTM is its own full year", async () => {
    await load(fy2025());
    await refreshMetrics(db, 9_100_001, { cpi: CPI });
    expect(await num(9_100_001, "ebitda_a_ttm", "ttm", "2025-12-31")).toBe(400_000);
    expect((await metric(9_100_001, "ebitda_a_ttm", "ttm"))?.formula).toBe("ebitda_a (the report covers a full year)");
  });

  test("a template without these rows: every metric is not applicable", async () => {
    await loadFiling(db, parseFixture(BANK));
    await refreshMetrics(db, BANK.disclosureId, { cpi: CPI });
    const all = await readMetrics(db, BANK.disclosureId);
    expect(all.length).toBeGreaterThan(10);
    expect(new Set(all.map((m) => `${m.status} ${m.reason_code}`))).toEqual(new Set(["not_computable not_applicable"]));
  });
});

describe("net debt (decision 0012)", () => {
  const cellsWith = async (drop: number[]) => {
    const f = q2();
    (f.tables[0] as FixtureTable).rows = (f.tables[0] as FixtureTable).rows.filter((r) => !drop.includes(r.row));
    await load(f);
    return (await readReportCells(db, f.disclosureId)) as NonNullable<Awaited<ReturnType<typeof readReportCells>>>;
  };
  const net = (ms: ReturnType<typeof computeReportMetrics>) => ms.find((m) => m.metric_code === "net_debt")?.result;

  test("an empty borrowing row is no borrowings only when the balance sheet reconciles", async () => {
    const r = await cellsWith([143]);
    expect(net(computeReportMetrics(r, { priorYearEnd: null, cpi: CPI, balanceSheetComplete: true }))).toEqual({
      status: "ok",
      value: 300_000n,
    });
    expect(net(computeReportMetrics(r, { priorYearEnd: null, cpi: CPI, balanceSheetComplete: false }))).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["financial_debt:current_portion"] },
    });
  });

  test("without cash, net debt and what uses it are not computable", async () => {
    const ms = computeReportMetrics(await cellsWith([4]), { priorYearEnd: null, cpi: CPI, balanceSheetComplete: true });
    expect(net(ms)).toMatchObject({ status: "not_computable", reason: { needs: ["cash"] } });
    expect(ms.find((m) => m.metric_code === "net_debt_to_equity")?.result).toMatchObject({
      status: "not_computable",
      reason: { needs: ["cash"] },
    });
  });

  test("without total liabilities, they are total assets − equity", async () => {
    const ms = computeReportMetrics(await cellsWith([242]), {
      priorYearEnd: null,
      cpi: CPI,
      balanceSheetComplete: true,
    });
    const m = ms.find((x) => x.metric_code === "liabilities_to_assets");
    expect([m?.result, m?.formula]).toEqual([{ status: "ok", value: 0.6 }, "(total_assets - equity) / total_assets"]);
  });

  test("the reconciliation checks decide whether the balance sheet is complete", async () => {
    const f = q2();
    (f.tables[0] as FixtureTable).rows = (f.tables[0] as FixtureTable).rows.filter((r) => r.row !== 143);
    await load(f);
    await refreshMetrics(db, 9_100_002, { cpi: CPI });
    const fails = Number(
      (
        await rows(
          db,
          "SELECT count(*) AS n FROM check_results WHERE disclosure_id = 9100002 AND status = 'fail' AND check_group IN ('reconciliation', 'balance_sheet')",
        )
      )[0]?.n,
    );
    const m = await metric(9_100_002, "net_debt", "point_in_time");
    expect(m?.status).toBe(fails === 0 ? "ok" : "not_computable");
  });
});

describe("affected periods", () => {
  test("loading a year-end report recomputes the next year's quarters 1 to 3 of the same company and consolidation", async () => {
    const solo = q2({ disclosureId: 9_100_003, consolidation: "Konsolide Olmayan" });
    const other = q2({ disclosureId: 9_100_004, ticker: "TSTOT" });
    await load(q2(), solo, other, fy2025());
    expect(await refreshMetrics(db, 9_100_001, { cpi: CPI })).toEqual([9_100_001, 9_100_002]);
    expect(await num(9_100_002, "ebitda_a_ttm", "ttm")).toBe(520_000);
    expect(await readMetrics(db, 9_100_003)).toEqual([]);
    expect(await readMetrics(db, 9_100_004)).toEqual([]);
  });

  test("a quarter report does not recompute others", async () => {
    await load(fy2025(), q2());
    expect(await refreshMetrics(db, 9_100_002, { cpi: CPI })).toEqual([9_100_002]);
  });

  test("when the latest version of a year-end report fails, the next year's TTM becomes not computable", async () => {
    await load(fy2025(), q2());
    await refreshMetrics(db, 9_100_001, { cpi: CPI });
    expect(await num(9_100_002, "ebitda_a_ttm", "ttm")).toBe(520_000);
    const handle = loadInto(db, { cpi: CPI });
    await handle(
      {
        status: "failed",
        reason: "ParseError: broken",
        file: { disclosure_id: 9_100_001 } as never,
      } as never,
      {} as never,
    );
    expect(await metric(9_100_002, "ebitda_a_ttm", "ttm")).toMatchObject({ status: "not_computable" });
  });

  test("the latest of two year-end reports for the period is used: a correction once it is loaded", async () => {
    await load(fy2025(), fy2025(9_100_005, 560_000), q2());
    await refreshMetrics(db, 9_100_002, { cpi: CPI });
    expect(await num(9_100_002, "ebitda_a_ttm", "ttm")).toBe(586_000);
  });
});

test("the rebuild computes every report's metrics once all are loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-metrics-"));
  const store = memoryStore();
  migrateStore(store);
  for (const f of [q2(), fy2025()]) {
    storeRawFile(store, new TextEncoder().encode(kapHtml(f)), { fileName: fileName(f), sourceUrl: "file:///x" });
  }
  const path = join(dir, "vigil.duckdb");
  const s = await rebuildDatabase(store, path);
  expect(s.metric_reports).toBe(2);
  const rebuilt = await connect(path);
  // The shipped CPI series is used: the TTM is computed, with the 2025 year end found although loaded second.
  const ttm = (await readMetrics(rebuilt, 9_100_002)).find((m) => m.metric_code === "ebitda_a_ttm");
  expect(ttm?.status).toBe("ok");
  close(rebuilt);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
