/**
 * The metrics tables (#184). Results come from `packages/core`'s metric functions on the synthetic fixtures, so a
 * not-computable metric carries the reason the core gives; expected values are the fixture numbers. Expected
 * behaviour: the issue's columns, inputs with their sources, and "a report with a missing row stores a
 * not-computable metric with its reason".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { cashRatio, currentRatio, liabilitiesToAssets, notReported, ok } from "@vigil/core";
import { close, connect, type Database, loadFiling, removeReport, rows } from "../src/db.ts";
import {
  METRIC_DEFINITIONS_VERSION,
  type MetricValue,
  readMetrics,
  valueText,
  writeMetrics,
} from "../src/metrics-store.ts";
import { migrate } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { GENERAL, HOLDING, parseFixture } from "./fixtures/index.ts";

const ID = GENERAL.disclosureId;
const REPORT = { disclosure_id: ID, company_code: "TSTGN" };
const COL = "col-order-class-4";
const CASH = { disclosure_id: ID, row_id: "general_role_210015-row-4", column_class: COL };
const TOTAL_ASSETS = { disclosure_id: ID, row_id: "general_role_210015-row-129", column_class: COL };

/** Cash 120,000 over total assets 1,000,000 at 30.06.2026 (the GENERAL fixture), as a stored metric. */
function cashToAssets(): MetricValue {
  return {
    metric_code: "cash_to_total_assets",
    period_type: "point_in_time",
    period_start: null,
    period_end: "2026-06-30",
    result: liabilitiesToAssets(120_000n, 1_000_000n),
    unit: "ratio",
    formula: "cash / total_assets",
    inputs: [
      { code: "cash", result: ok(120_000n), unit: "TRY", source: CASH },
      { code: "total_assets", result: ok(1_000_000n), unit: "TRY", source: TOTAL_ASSETS },
    ],
  };
}

/** The current ratio: the fixture has neither current assets nor current liabilities. */
function currentRatioMissing(): MetricValue {
  return {
    metric_code: "current_ratio",
    period_type: "point_in_time",
    period_start: null,
    period_end: "2026-06-30",
    result: currentRatio(undefined, undefined),
    unit: "ratio",
    formula: "current_assets / current_liabilities",
    inputs: [
      { code: "current_assets", result: currentRatio(undefined, 1n), unit: "TRY", source: null },
      { code: "current_liabilities", result: notReported(), unit: "TRY", source: null },
    ],
  };
}

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
  await loadFiling(db, parseFixture(GENERAL));
  await loadFiling(db, parseFixture(HOLDING));
});
afterEach(() => close(db));

const count = async (table: string, id = ID) =>
  Number((await rows(db, `SELECT count(*) AS n FROM ${table} WHERE disclosure_id = ${id}`))[0]?.n);

describe("writeMetrics", () => {
  test("a computed metric is stored with its value, definition version and inputs in order", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()], { computedAt: new Date("2026-11-16T08:00:00Z") });
    expect(await readMetrics(db, ID)).toEqual([
      {
        disclosure_id: BigInt(ID),
        company_code: "TSTGN",
        metric_code: "cash_to_total_assets",
        period_type: "point_in_time",
        period_start: null,
        period_end: "2026-06-30",
        status: "ok",
        value: "0.12",
        unit: "ratio",
        reason_code: null,
        reason_message: null,
        needs: null,
        formula: "cash / total_assets",
        definition_version: METRIC_DEFINITIONS_VERSION,
        inputs: [
          {
            input_code: "cash",
            status: "ok",
            value: "120000",
            unit: "TRY",
            source_disclosure_id: BigInt(ID),
            source_row_id: CASH.row_id,
            source_column_class: COL,
          },
          {
            input_code: "total_assets",
            status: "ok",
            value: "1000000",
            unit: "TRY",
            source_disclosure_id: BigInt(ID),
            source_row_id: TOTAL_ASSETS.row_id,
            source_column_class: COL,
          },
        ],
      },
    ]);
    const [t] = await rows(db, "SELECT strftime(computed_at, '%Y-%m-%dT%H:%M:%S') AS t FROM metrics");
    expect(t?.t).toBe("2026-11-16T08:00:00");
  });

  test("each input's source finds its cell in facts: label, period and the value as filed", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()]);
    const joined = await rows(
      db,
      `SELECT i.input_code, f.label_tr, f.period_label, f.raw_value, i.value
       FROM metric_inputs i JOIN facts f
         ON f.disclosure_id = i.source_disclosure_id AND f.row_id = i.source_row_id
        AND f.column_class = i.source_column_class
       ORDER BY i.position`,
    );
    expect(joined.map((r) => [r.input_code, r.label_tr, String(r.raw_value), r.value])).toEqual([
      ["cash", "Nakit ve Nakit Benzerleri", "120000", "120000"],
      ["total_assets", "TOPLAM VARLIKLAR", "1000000", "1000000"],
    ]);
    expect(joined.every((r) => typeof r.period_label === "string" && r.period_label !== "")).toBe(true);
  });

  test("a report with a missing row stores a not-computable metric with its reason", async () => {
    await writeMetrics(db, REPORT, [currentRatioMissing()]);
    const [m] = await readMetrics(db, ID);
    expect(m).toMatchObject({
      metric_code: "current_ratio",
      status: "not_computable",
      value: null,
      reason_code: "missing_input",
      needs: ["current_assets", "current_liabilities"],
    });
    expect(String(m?.reason_message)).toContain("Dönen varlıklar");
    expect(
      (m?.inputs as Record<string, unknown>[]).map((i) => [i.input_code, i.status, i.value, i.source_row_id]),
    ).toEqual([
      ["current_assets", "not_computable", null, null],
      ["current_liabilities", "not_reported", null, null],
    ]);
  });

  test("a zero denominator and a value the company left empty are stored as such", async () => {
    const zero: MetricValue = { ...cashToAssets(), metric_code: "cash_ratio", result: cashRatio(1n, 0n), inputs: [] };
    const empty: MetricValue = {
      ...cashToAssets(),
      metric_code: "total_assets",
      result: notReported(),
      unit: "TRY",
      inputs: [],
    };
    await writeMetrics(db, REPORT, [zero, empty]);
    const stored = await readMetrics(db, ID);
    expect(stored.map((m) => [m.metric_code, m.status, m.value, m.reason_code, m.needs])).toEqual([
      ["cash_ratio", "not_computable", null, "zero_denominator", []], // no input would help
      ["total_assets", "not_reported", null, null, null],
    ]);
  });

  test("periods: the same metric for another period or period type is another row", async () => {
    const q2 = { ...cashToAssets(), metric_code: "revenue", unit: "TRY" as const, result: ok(1_000_000n), inputs: [] };
    await writeMetrics(db, REPORT, [
      { ...q2, period_type: "cumulative", period_start: "2026-01-01" },
      { ...q2, period_type: "three_month", period_start: "2026-04-01", result: ok(600_000n) },
      { ...q2, period_type: "cumulative", period_start: "2025-01-01", period_end: "2025-06-30", result: ok(800_000n) },
    ]);
    const stored = await readMetrics(db, ID);
    expect(stored.map((m) => [m.period_type, m.period_start, m.period_end, m.value])).toEqual([
      ["cumulative", "2025-01-01", "2025-06-30", "800000"],
      ["cumulative", "2026-01-01", "2026-06-30", "1000000"],
      ["three_month", "2026-04-01", "2026-06-30", "600000"],
    ]);
  });

  test("writing again replaces the report's metrics and inputs; other reports are left alone", async () => {
    await writeMetrics(db, REPORT, [cashToAssets(), currentRatioMissing()]);
    await writeMetrics(db, { disclosure_id: HOLDING.disclosureId, company_code: "TSTHD" }, [cashToAssets()]);
    await writeMetrics(db, REPORT, [currentRatioMissing()]);
    expect([await count("metrics"), await count("metric_inputs")]).toEqual([1, 2]);
    expect([await count("metrics", HOLDING.disclosureId), await count("metric_inputs", HOLDING.disclosureId)]).toEqual([
      1, 2,
    ]);
  });

  test("a metric listed twice, or a value that is not finite, writes nothing and keeps the earlier metrics", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()]);
    const before = await readMetrics(db, ID);
    await expect(writeMetrics(db, REPORT, [currentRatioMissing(), currentRatioMissing()])).rejects.toThrow(
      "listed twice",
    );
    await expect(writeMetrics(db, REPORT, [{ ...currentRatioMissing(), result: ok(Number.NaN) }])).rejects.toThrow(
      "not a finite value",
    );
    expect(await readMetrics(db, ID)).toEqual(before);
  });

  test("another definition version is recorded", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()], { definitionVersion: "2027-01-01" });
    expect((await readMetrics(db, ID))[0]?.definition_version).toBe("2027-01-01");
  });
});

describe("with the report", () => {
  test("loading the report again removes its metrics, computed from the old facts", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()]);
    await loadFiling(db, parseFixture(GENERAL));
    expect([await count("metrics"), await count("metric_inputs")]).toEqual([0, 0]);
  });

  test("removing the report removes its metrics", async () => {
    await writeMetrics(db, REPORT, [cashToAssets()]);
    await removeReport(db, ID);
    expect([await count("metrics"), await count("metric_inputs")]).toEqual([0, 0]);
  });
});

test("valueText is exact: whole TL as digits, a ratio as the shortest text that reads back the same", () => {
  expect(valueText(12_345_678_901_234_567_890n)).toBe("12345678901234567890");
  expect(valueText(-5n)).toBe("-5");
  expect(valueText(0.1 + 0.2)).toBe("0.30000000000000004");
  expect(Number(valueText(1 / 3))).toBe(1 / 3);
  expect(valueText(-0)).toBe("0");
  expect(() => valueText(Number.POSITIVE_INFINITY)).toThrow(RangeError);
});

test("migration 6 adds empty metrics tables to a version 5 database", async () => {
  const con = await (await DuckDBInstance.create(":memory:")).connect();
  await migrate(
    con,
    MIGRATIONS.filter((m) => m.version <= 5),
  );
  expect(await migrate(con)).toEqual(MIGRATIONS.filter((m) => m.version > 5).map((m) => m.version));
  const read = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJS();
  expect(await read("SELECT (SELECT count(*) FROM metrics) AS m, (SELECT count(*) FROM metric_inputs) AS i")).toEqual([
    { m: 0n, i: 0n },
  ]);
});
