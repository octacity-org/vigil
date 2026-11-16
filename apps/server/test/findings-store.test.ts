/**
 * The findings table (#185). S1 comes from the real detector on KATMR 2026/2's hand-checked golden filing (the API
 * example: -2596 bps); S2 and S3 are signal objects in the detectors' shape. Expected behaviour: the issue's columns,
 * one finding per rule, report and config version, and "a rerun creates no duplicates".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { detectGrossMarginDeviation, type SignalObject } from "@vigil/core";
import { CONFIG, katmrFromGolden } from "../../../packages/core/test/helpers.ts";
import { close, connect, type Database, loadFiling, removeReport, rows } from "../src/db.ts";
import { findingRow, writeFindings } from "../src/findings-store.ts";
import { migrate } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";

const KATMR = 1651411;
const V = CONFIG.version;
const s1 = () => detectGrossMarginDeviation(katmrFromGolden(), CONFIG) as SignalObject;

function signal(type: SignalObject["signal_type"], disclosure: number, summary: SignalObject["summary_metrics"]) {
  return {
    signal_id: `sig_${type}_${disclosure}`,
    company_code: "TSTGN",
    raw_ticker_group: "TSTGN",
    period: "2026-Q2",
    disclosure_id: disclosure,
    signal_type: type,
    neutral_title: `title ${type}`,
    severity_rank_score: 1.5,
    summary_metrics: summary,
    evidence_chain: [],
    formula: `formula ${type}`,
    calculation: { formula: `formula ${type}`, definition: { id: type, version: V, url: "" }, steps: [] },
    llm_constraints: { allow_price_commentary: false, allow_external_causal_claims: false },
  } satisfies SignalObject;
}
const s2 = (id = 9_000_001) =>
  signal("CASH_PROFIT_QUALITY_DIVERGENCE", id, {
    net_profit_ytd_tl: 250_000_000n,
    operating_cash_flow_ytd_tl: -150_000_000n,
    profit_minus_ocf_gap_tl: 400_000_000n,
    profit_driven_by_non_cash_monetary_gain: false,
  });
const s3 = (id = 9_000_001) =>
  signal("RETROSPECTIVE_RESTATEMENT_TRIPWIRE", id, {
    restated_balance_sheet_line_count: 12,
    third_column_period_label: "Bir Önceki Dönem 31.12.2025",
  });

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
});
afterEach(() => close(db));

/** writeFindings under the repository's config version unless the test names another. */
const write = (ids: number[], signals: SignalObject[], options: { configVersion?: string; now?: Date } = {}) =>
  writeFindings(db, ids, signals, { configVersion: V, ...options });
const all = () => rows(db, "SELECT * FROM findings ORDER BY rule, disclosure_id, config_version");

describe("findingRow", () => {
  test("S1 for KATMR 2026/2 is the API's example: -2596 bps", () => {
    const f = findingRow(s1());
    expect(f).toMatchObject({
      id: "2026-2-KATMR-gross_margin_change",
      rule: "gross_margin_change",
      company_code: "KATMR",
      disclosure_id: KATMR,
      year: 2026,
      quarter: 2,
      size_value: "-2596",
      size_unit: "bps",
    });
    // The summary keeps every number; amounts stay exact as text.
    expect(JSON.parse(f.summary)).toMatchObject({ delta_bps: -2596, current_q_revenue_tl: expect.any(String) });
  });

  test("S2 is sized in TL by profit minus operating cash flow, S3 by the restated lines", () => {
    expect(findingRow(s2())).toMatchObject({
      id: "2026-2-TSTGN-profit_cash_divergence",
      size_value: "400000000",
      size_unit: "TRY",
    });
    expect(JSON.parse(findingRow(s2()).summary).net_profit_ytd_tl).toBe("250000000");
    expect(findingRow(s3())).toMatchObject({ rule: "restated_comparatives", size_value: "12", size_unit: "count" });
  });

  test("a signal without its size or with another period form is refused", () => {
    expect(() => findingRow({ ...s3(), summary_metrics: {} })).toThrow("restated_balance_sheet_line_count");
    expect(() => findingRow({ ...s3(), period: "2026/2" })).toThrow("YYYY-Qn");
  });
});

describe("writeFindings", () => {
  test("stores each finding with the config version and when it was found", async () => {
    const w = await write([KATMR, 9_000_001], [s1(), s2(), s3()], {
      now: new Date("2026-11-16T08:00:00Z"),
    });
    expect(w).toEqual({ added: 3, kept: 0, removed: 0 });
    const stored = await all();
    expect(stored.map((f) => [f.id, f.size_value, f.size_unit, f.config_version])).toEqual([
      ["2026-2-KATMR-gross_margin_change", "-2596", "bps", V],
      ["2026-2-TSTGN-profit_cash_divergence", "400000000", "TRY", V],
      ["2026-2-TSTGN-restated_comparatives", "12", "count", V],
    ]);
    expect(stored[0]?.created_at).toEqual(new Date("2026-11-16T08:00:00Z"));
    expect(stored[0]?.title).toBe(s1().neutral_title);
  });

  test("a rerun creates no duplicates and keeps when each finding was first found", async () => {
    await write([KATMR, 9_000_001], [s1(), s2()], { now: new Date("2026-11-16T08:00:00Z") });
    const w = await write([KATMR, 9_000_001], [s1(), s2()], { now: new Date("2026-11-17T08:00:00Z") });
    expect(w).toEqual({ added: 0, kept: 2, removed: 0 });
    const stored = await all();
    expect(stored).toHaveLength(2);
    expect(stored.map((f) => f.created_at)).toEqual([
      new Date("2026-11-16T08:00:00Z"),
      new Date("2026-11-16T08:00:00Z"),
    ]);
  });

  test("a finding no longer found in a report of the run is removed; reports outside the run are left alone", async () => {
    await write([KATMR, 9_000_001, 9_000_002], [s1(), s2(), s2(9_000_002)]);
    const w = await write([KATMR, 9_000_001], [s1()]);
    expect(w).toEqual({ added: 0, kept: 1, removed: 1 });
    expect((await all()).map((f) => [f.rule, Number(f.disclosure_id)])).toEqual([
      ["gross_margin_change", KATMR],
      ["profit_cash_divergence", 9_000_002],
    ]);
  });

  test("under another config version a finding is stored next to the earlier one", async () => {
    await write([KATMR], [s1()]);
    await write([KATMR], [s1()], { configVersion: "2027-01-01" });
    expect((await all()).map((f) => f.config_version)).toEqual([V, "2027-01-01"]);
    // Removing under the new config leaves the old one.
    await write([KATMR], [], { configVersion: "2027-01-01" });
    expect((await all()).map((f) => f.config_version)).toEqual([V]);
  });

  test("a finding outside the run or listed twice writes nothing", async () => {
    await write([KATMR], [s1()]);
    const before = await all();
    await expect(write([9_000_001], [s1()])).rejects.toThrow("not in this run");
    await expect(write([KATMR], [s1(), s1()])).rejects.toThrow("listed twice");
    expect(await all()).toEqual(before);
  });

  test("loading the report again, or removing it, removes its findings", async () => {
    const katmr = katmrFromGolden();
    await loadFiling(db, katmr);
    await write([KATMR], [s1()]);
    await loadFiling(db, katmr);
    expect(await all()).toEqual([]);
    await write([KATMR], [s1()]);
    await removeReport(db, KATMR);
    expect(await all()).toEqual([]);
  });

  test("the key is (rule, report, config version)", async () => {
    await write([KATMR], [s1()]);
    await expect(db.con.run(`INSERT INTO findings SELECT * REPLACE ('other' AS id) FROM findings`)).rejects.toThrow();
  });
});

test("migration 7 adds an empty findings table to a version 6 database", async () => {
  const con = await (await DuckDBInstance.create(":memory:")).connect();
  await migrate(
    con,
    MIGRATIONS.filter((m) => m.version <= 6),
  );
  expect(await migrate(con)).toEqual(MIGRATIONS.filter((m) => m.version > 6).map((m) => m.version));
  expect((await con.runAndReadAll("SELECT count(*) AS n FROM findings")).getRowObjectsJS()).toEqual([{ n: 0n }]);
});
