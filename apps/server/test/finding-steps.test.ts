/**
 * Finding steps and inputs (#186). Expected values: KATMR 2026/2's S1 from its hand-checked golden filing (the
 * `docs/API.md` example: 189,492,068 / 879,599,263 vs 330,145,727 / 694,991,758, -2596 bps). "Done when": the KATMR
 * S1 finding can be recomputed from these rows alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  type ParsedFiling,
  type SignalObject,
} from "@vigil/core";
import { CONFIG, fact, filing, katmrFromGolden, periodFromLabel } from "../../../packages/core/test/helpers.ts";
import { close, connect, type Database, loadFiling, removeReport, rows } from "../src/db.ts";
import { readCalculation, writeFindings } from "../src/findings-store.ts";
import { migrate } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";

const KATMR = 1651411;
const V = CONFIG.version;
const S1_KEY = { rule: "gross_margin_change", disclosure_id: KATMR, config_version: V } as const;
const s1 = () => detectGrossMarginDeviation(katmrFromGolden(), CONFIG) as SignalObject;

/** A report with S2 (profit 250 mn, operating cash flow -150 mn, monetary gain 300 mn, in thousands) and S3. */
function otherReport(): ParsedFiling {
  const ytd = "Cari Dönem 01.01.2026 - 30.06.2026";
  const opening = "Bir Önceki Dönem 01.01.2025";
  const inc = "310003";
  const cf = "520003";
  const at = (label: string) => ({ period_label: label, ...periodFromLabel(label) });
  const base = { disclosure_id: 9_000_001, company_code: "TSTGN", raw_ticker_group: "TSTGN", scale_unit: "BİN TL" };
  return filing({
    ...base,
    role_codes: [inc, cf, "210015"],
    published_at: "2026-08-10T18:30:00",
    facts: [
      fact({
        ...base,
        role_code: inc,
        statement_type: "INCOME_STATEMENT",
        row_id: `general_role_${inc}-row-59`,
        label_tr: "DÖNEM KARI (ZARARI)",
        raw_value: 250_000n,
        normalized_value_tl: 250_000_000n,
        ...at(ytd),
      }),
      fact({
        ...base,
        role_code: cf,
        statement_type: "CASH_FLOW_INDIRECT",
        row_id: `general_role_${cf}-row-2`,
        label_tr: "İşletme Faaliyetlerinden Nakit Akışları",
        raw_value: -150_000n,
        normalized_value_tl: -150_000_000n,
        ...at(ytd),
      }),
      fact({
        ...base,
        role_code: inc,
        statement_type: "INCOME_STATEMENT",
        row_id: `general_role_${inc}-row-52`,
        label_tr: "Net Parasal Pozisyon Kazançları (Kayıpları)",
        raw_value: 300_000n,
        normalized_value_tl: 300_000_000n,
        ...at(ytd),
      }),
      fact({
        ...base,
        statement_type: "BALANCE_SHEET",
        row_id: "general_role_210015-row-129",
        label_tr: "TOPLAM VARLIKLAR",
        column_class: "col-order-class-6",
        raw_value: 9_000n,
        normalized_value_tl: 9_000_000n,
        ...at(opening),
      }),
    ],
  });
}

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
});
afterEach(() => close(db));

const write = (ids: number[], signals: SignalObject[]) => writeFindings(db, ids, signals, { configVersion: V });
const count = async (table: string) => Number((await rows(db, `SELECT count(*) AS n FROM ${table}`))[0]?.n);

/** Evaluate a step formula (+ − × ÷, parentheses, numbers) over earlier steps' values. */
function evaluate(formula: string, values: Record<string, number>): number {
  const expr = formula.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
    if (!(id in values)) throw new Error(`unknown step ${id}`);
    return `(${values[id]})`;
  });
  if (!/^[\d\s.()+\-*/e]+$/.test(expr)) throw new Error(`not arithmetic: ${expr}`);
  return Function(`"use strict"; return (${expr});`)() as number;
}

describe("KATMR 2026/2 S1 (done when)", () => {
  test("recomputed from finding_steps and finding_inputs alone", async () => {
    await write([KATMR], [s1()]);
    // Only the two tables; nothing from the detector, the filing or facts.
    const steps = await rows(
      db,
      `SELECT s.step_id, s.formula, s.result, i.value, i.row_id, i.column_class, i.period_label, i.document_id
       FROM finding_steps s LEFT JOIN finding_inputs i USING (rule, disclosure_id, config_version, position)
       WHERE s.rule = 'gross_margin_change' AND s.disclosure_id = ${KATMR} ORDER BY s.position`,
    );
    expect(steps.map((s) => [s.step_id, s.row_id ?? null, s.column_class ?? null, s.value ?? null])).toEqual([
      ["gross_profit_q", "general_role_310003-row-5", "col-order-class-6", "189492068"],
      ["revenue_q", "general_role_310003-row-3", "col-order-class-6", "879599263"],
      ["gross_profit_q_prior", "general_role_310003-row-5", "col-order-class-7", "330145727"],
      ["revenue_q_prior", "general_role_310003-row-3", "col-order-class-7", "694991758"],
      ["margin_q", null, null, null],
      ["margin_q_prior", null, null, null],
      ["change_bps", null, null, null],
    ]);
    expect(steps.slice(0, 4).every((s) => s.document_id === String(KATMR) && s.period_label !== "")).toBe(true);

    const values: Record<string, number> = {};
    for (const s of steps) {
      if (s.formula === null) {
        expect(s.result).toBe(s.value as string); // a value read is its own result
        values[s.step_id as string] = Number(s.value);
        continue;
      }
      const recomputed = evaluate(s.formula as string, values);
      // Each result is stored as shown: margins to 6 decimals, the change in whole bps.
      const decimals = (s.result as string).split(".")[1]?.length ?? 0;
      expect(recomputed.toFixed(decimals)).toBe(s.result as string);
      values[s.step_id as string] = Number(s.result);
    }
    expect(values.change_bps).toBe(-2596);
    const [f] = await rows(db, "SELECT size_value, calculation_formula FROM findings");
    expect(f?.size_value).toBe("-2596");
  });

  test("the stored rows give back the calculation the rule produced, field for field", async () => {
    const sig = s1();
    await write([KATMR], [sig]);
    expect(await readCalculation(db, S1_KEY)).toEqual(sig.calculation);
  });

  test("each input points at a stored cell of the report with the same value", async () => {
    await loadFiling(db, katmrFromGolden());
    await write([KATMR], [s1()]);
    const joined = await rows(
      db,
      `SELECT i.row_id, i.value, f.normalized_value_tl, f.label_tr = i.row_label AS same_label
       FROM finding_inputs i JOIN facts f
         ON f.disclosure_id = CAST(i.document_id AS BIGINT) AND f.row_id = i.row_id AND f.column_class = i.column_class`,
    );
    expect(joined).toHaveLength(4);
    for (const j of joined) {
      expect(String(j.normalized_value_tl)).toBe(j.value as string);
      expect(j.same_label).toBe(true);
    }
  });
});

test("a bank's TP / YP column part is kept", async () => {
  const sig = s1();
  const [first, ...rest] = sig.calculation.steps;
  if (first === undefined || !("value" in first)) throw new Error("no first input");
  const tp = { ...first, value: { ...first.value, period: { ...first.value.period, currency_part: "tp" as const } } };
  const withTp = { ...sig, calculation: { ...sig.calculation, steps: [tp, ...rest] } };
  await write([KATMR], [withTp]);
  expect(await readCalculation(db, S1_KEY)).toEqual(withTp.calculation);
});

describe("S2 and S3", () => {
  test("their calculations round-trip too, with scale, shown text and publication time", async () => {
    const r = otherReport();
    const s2 = detectCashProfitQualityDivergence(r, CONFIG) as SignalObject;
    const s3 = detectRestatementTripwire(r, CONFIG) as SignalObject;
    await write([9_000_001], [s2, s3]);
    const key = { disclosure_id: 9_000_001, config_version: V };
    expect(await readCalculation(db, { ...key, rule: "profit_cash_divergence" })).toEqual(s2.calculation);
    expect(await readCalculation(db, { ...key, rule: "restated_comparatives" })).toEqual(s3.calculation);
    const [i] = await rows(db, "SELECT shown_value, scale, published_at FROM finding_inputs ORDER BY rule, position");
    expect([i?.shown_value, i?.scale, i?.published_at]).toEqual([
      "250.000",
      "BİN TL",
      new Date("2026-08-10T15:30:00Z"),
    ]);
  });
});

describe("kept with the finding", () => {
  test("a rerun replaces the steps, never adds", async () => {
    await write([KATMR], [s1()]);
    await write([KATMR], [s1()]);
    expect([await count("finding_steps"), await count("finding_inputs")]).toEqual([7, 4]);
  });

  test("a finding no longer found loses its steps; other reports keep theirs", async () => {
    const r = otherReport();
    await write([KATMR, 9_000_001], [s1(), detectRestatementTripwire(r, CONFIG) as SignalObject]);
    await write([KATMR], []);
    expect(await readCalculation(db, S1_KEY)).toBeNull();
    expect(await count("finding_steps")).toBe(2); // S3: one restated line and the count
  });

  test("another config version keeps its own steps", async () => {
    await write([KATMR], [s1()]);
    const other = detectGrossMarginDeviation(katmrFromGolden(), { ...CONFIG, version: "2027-01-01" }) as SignalObject;
    await writeFindings(db, [KATMR], [other], { configVersion: "2027-01-01" });
    await writeFindings(db, [KATMR], [], { configVersion: "2027-01-01" });
    expect(await readCalculation(db, S1_KEY)).toEqual(s1().calculation);
    expect(await count("finding_steps")).toBe(7);
  });

  test("loading the report again, or removing it, removes the steps", async () => {
    const k = katmrFromGolden();
    await loadFiling(db, k);
    await write([KATMR], [s1()]);
    await loadFiling(db, k);
    expect([await count("finding_steps"), await count("finding_inputs")]).toEqual([0, 0]);
    await write([KATMR], [s1()]);
    await removeReport(db, KATMR);
    expect([await count("finding_steps"), await count("finding_inputs")]).toEqual([0, 0]);
  });

  test("a failed write leaves the earlier steps", async () => {
    await write([KATMR], [s1()]);
    await expect(write([KATMR], [s1(), s1()])).rejects.toThrow("listed twice");
    const bad = {
      ...s1(),
      calculation: { ...s1().calculation, definition: { ...s1().calculation.definition, version: "x" } },
    };
    await expect(write([KATMR], [bad])).rejects.toThrow("computed under config x");
    expect(await readCalculation(db, S1_KEY)).toEqual(s1().calculation);
  });

  test("a step id is unique within a finding", async () => {
    await write([KATMR], [s1()]);
    await expect(
      db.con.run(
        `INSERT INTO finding_steps SELECT * REPLACE (99 AS position) FROM finding_steps WHERE step_id = 'margin_q'`,
      ),
    ).rejects.toThrow();
  });
});

test("migration 8 adds the tables; a finding stored before it has no calculation", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const con = await instance.connect();
  await migrate(
    con,
    MIGRATIONS.filter((m) => m.version <= 7),
  );
  await con.run(
    `INSERT INTO findings VALUES ('2026-2-KATMR-gross_margin_change', 'gross_margin_change', 'KATMR', ${KATMR}, 2026, 2,
       't', '-2596', 'bps', 2.6, '{}', 'f', '${V}', TIMESTAMP '2026-11-01 12:00:00')`,
  );
  expect(await migrate(con)).toEqual(MIGRATIONS.filter((m) => m.version > 7).map((m) => m.version));
  const old = { con } as unknown as Database;
  expect(await readCalculation(old, S1_KEY)).toBeNull();
  const read = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJS();
  expect(
    await read("SELECT (SELECT count(*) FROM finding_steps) AS s, (SELECT count(*) FROM finding_inputs) AS i"),
  ).toEqual([{ s: 0n, i: 0n }]);
});
