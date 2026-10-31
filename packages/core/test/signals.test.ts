/**
 * Parser and findings on real filings (data/raw/2026_2, listed in tests/raw_files.txt). Expected numbers come from
 * tests/golden/, never from parser output (#20); filings without a golden file only get structural checks (#130).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  isRealSectorFiling,
  type ParsedFiling,
  parseKapXls,
  pyRound,
} from "../src/index.ts";
import { GOLDEN_DIR, RAW_DIR, rawFile, readCsv } from "./helpers.ts";

/** value_tl of one hand-copied golden cell. */
function goldenValue(filing: string, rowId: string, column: string): bigint {
  const line = readCsv(join(GOLDEN_DIR, "2026_2", `${filing}.csv`)).find(
    (l) => l.row_id === rowId && l.column === column,
  );
  if (!line) throw new Error(`no golden value for ${filing} ${rowId} ${column}`);
  return BigInt(line.value_tl as string);
}

const have = rawFile("2026_2", "KATMR_1651411_2026_2.xls") !== null;
const load = (name: string): ParsedFiling => parseKapXls(readFileSync(join(RAW_DIR, "2026_2", name)), name);

describe.skipIf(!have)("real filings (raw files)", () => {
  test("KATMR: general 310003, S1 margin change from the golden file", () => {
    const pf = load("KATMR_1651411_2026_2.xls");
    expect([pf.company_code, pf.template_family, pf.scale_unit, pf.scale_multiplier]).toEqual([
      "KATMR",
      "general",
      "TL",
      1n,
    ]);
    expect(pf.role_codes).toContain("310003");
    expect(pf.has_tms29_monetary_item).toBe(true);
    expect(isRealSectorFiling(pf)[0]).toBe(true);

    const golden = (row: number, col: number) =>
      goldenValue("KATMR_1651411", `general_role_310003-row-${row}`, `col-order-class-${col}`);
    const [revC, revP, gpC, gpP] = [golden(3, 6), golden(3, 7), golden(5, 6), golden(5, 7)];
    const expectedDelta = pyRound((Number(gpC) / Number(revC) - Number(gpP) / Number(revP)) * 10_000);

    const sig = detectGrossMarginDeviation(pf);
    expect(sig).not.toBeNull();
    expect(sig?.summary_metrics.current_q_revenue_tl).toBe(revC);
    expect(sig?.summary_metrics.prior_year_q_revenue_restated_tl).toBe(revP);
    expect(sig?.summary_metrics.delta_bps).toBe(expectedDelta);
  });

  test("SANFM: general 310000 with a separate comprehensive income statement", () => {
    const pf = load("SANFM_1650384_2026_2.xls");
    expect([pf.company_code, pf.template_family]).toEqual(["SANFM", "general"]);
    expect(pf.role_codes).toEqual(expect.arrayContaining(["310000", "420000"]));
    expect(isRealSectorFiling(pf)[0]).toBe(true);
    expect(detectGrossMarginDeviation(pf)).not.toBeNull();
  });

  test("A1CAP: a brokerage is excluded from the real-sector margin finding", () => {
    const pf = load("A1CAP-ACP_1645514_2026_2.xls");
    expect([pf.company_code, pf.raw_ticker_group]).toEqual(["A1CAP", "A1CAP-ACP"]);
    expect(isRealSectorFiling(pf)[0]).toBe(false);
    expect(detectGrossMarginDeviation(pf)).toBeNull();
  });

  test("AKBNK: banks template, million TL scale, TP / YP / Toplam columns", () => {
    const pf = load("AKBNK_1637884_2026_2.xls");
    expect([pf.company_code, pf.template_family, pf.scale_unit, pf.scale_multiplier]).toEqual([
      "AKBNK",
      "banks",
      "1.000.000 TL",
      1_000_000n,
    ]);
    const row4 = new Map(
      pf.facts.filter((f) => f.row_id === "banks_role_210011-row-4").map((f) => [f.column_class, f]),
    );
    expect(row4.get("col-order-class-4")?.period_type).toBe("POINT_IN_TIME_TP");
    expect(row4.get("col-order-class-5")?.period_type).toBe("POINT_IN_TIME_YP");
    expect(row4.get("col-order-class-6")?.period_type).toBe("POINT_IN_TIME");
    const total = row4.get("col-order-class-6");
    expect((row4.get("col-order-class-4")?.raw_value ?? 0n) + (row4.get("col-order-class-5")?.raw_value ?? 0n)).toBe(
      total?.raw_value as bigint,
    );
    expect(total?.normalized_value_tl).toBe((total?.raw_value as bigint) * 1_000_000n);
  });

  test("DOHOL: holding template, thousand TL scale", () => {
    const pf = load("DOHOL_1648007_2026_2.xls");
    expect([pf.company_code, pf.template_family, pf.scale_unit, pf.scale_multiplier]).toEqual([
      "DOHOL",
      "holding",
      "1.000 TL",
      1_000n,
    ]);
    const cash = pf.facts.find(
      (f) => f.row_id === "holding_role_210015-row-4" && f.column_class === "col-order-class-4",
    );
    expect(cash?.normalized_value_tl).toBe((cash?.raw_value as bigint) * 1_000n);
  });

  test("AKENR: S2 cash-profit divergence", () => {
    expect(detectCashProfitQualityDivergence(load("AKENR_1649474_2026_2.xls"))).not.toBeNull();
  });

  test("BIOEN: S3 restated third balance sheet column, evidence from the golden file (#25, #130)", () => {
    const sig = detectRestatementTripwire(load("BIOEN_1652232_2026_2.xls"));
    expect(sig).not.toBeNull();
    expect(String(sig?.summary_metrics.third_column_period_label)).toContain("31.12.2024");
    const evidence = new Map(sig?.evidence_chain.map((e) => [`${e.row_id}|${e.column_class}`, e.normalized_value_tl]));
    const rowId = "general_role_210015-row-129";
    for (const column of ["col-order-class-6", "col-order-class-5"]) {
      expect(evidence.get(`${rowId}|${column}`)).toBe(goldenValue("BIOEN_1652232", rowId, column));
    }
  });
});
