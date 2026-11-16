/**
 * Provenance (#72). Expected values: the KATMR 2026/2 S1 example in `docs/API.md` (its inputs are in the hand-checked
 * golden file `tests/golden/2026_2/KATMR_1651411.csv`), read from the document itself so the two cannot drift apart;
 * the publication time is the file header's `Gönderim Tarihi` 17.08.2026 19:05:18 (Istanbul).
 * "Done when": every value used by the KATMR S1 finding carries a complete source reference in the API's shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  consolidation,
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  istanbulToUtc,
  kapUrl,
  type ParsedFiling,
  ProvenanceError,
  parseKapXls,
  periodOf,
  readValue,
  type SignalObject,
  type Source,
  type Step,
  shownValue,
} from "../src/index.ts";
import { CONFIG, fact, filing, katmrFromGolden, periodFromLabel, RAW_DIR, REPO, rawFile } from "./helpers.ts";

/** The finding JSON of `docs/API.md`'s "Example: KATMR 2026/2, gross margin change (S1)". */
function apiExample() {
  const doc = readFileSync(join(REPO, "docs", "API.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Example: KATMR 2026/2, gross margin change (S1)"));
  const block = /```json\n([\s\S]*?)\n```/.exec(section.replaceAll("\r\n", "\n"));
  if (block === null) throw new Error("no JSON example in docs/API.md");
  return JSON.parse(block[1] as string);
}

const SOURCE_FIELDS = [
  "system",
  "document_id",
  "company_code",
  "report",
  "table",
  "row",
  "row_label",
  "column",
  "period_label",
  "shown_value",
  "scale",
  "published_at",
  "url",
] as const;

/** Every field of a source is there and filled; only `published_at` and `consolidation` may be null by definition. */
function expectComplete(s: Source) {
  expect(Object.keys(s).sort()).toEqual([...SOURCE_FIELDS].sort());
  for (const k of SOURCE_FIELDS) {
    if (k === "published_at" || k === "report") continue;
    expect(typeof s[k] === "string" && s[k] !== "").toBe(true);
  }
  expect(s.report.year).toBeGreaterThan(2000);
  expect(s.report.quarter).toBeGreaterThanOrEqual(1);
}

const read = (steps: Step[]) => steps.filter((s): s is Extract<Step, { value: unknown }> => "value" in s);

describe("KATMR 2026/2 S1 (done when)", () => {
  const sig = detectGrossMarginDeviation(katmrFromGolden(), CONFIG) as SignalObject;
  const example = apiExample();

  test("the calculation is docs/API.md's example: formula, definition, step ids, labels and results", () => {
    expect(sig.calculation.formula).toBe(example.calculation.formula);
    expect(sig.calculation.definition).toEqual(example.calculation.definition);
    expect(sig.calculation.steps.map((s) => [s.id, s.label])).toEqual(
      example.calculation.steps.map((s: Step) => [s.id, s.label]),
    );
    const computed = sig.calculation.steps.filter((s) => "formula" in s);
    expect(computed).toEqual(example.calculation.steps.filter((s: Step) => "formula" in s));
  });

  test("the first input is the example's full value, every field", () => {
    expect(sig.calculation.steps[0]).toEqual(example.calculation.steps[0]);
  });

  test("the other inputs match the example's fields and are complete", () => {
    const steps = read(sig.calculation.steps);
    expect(steps).toHaveLength(4);
    example.calculation.steps.slice(1, 4).forEach((s: Step, i: number) => {
      expect(steps[i + 1]).toMatchObject(s);
    });
    for (const s of steps) {
      expectComplete(s.value.source);
      expect(s.value.source.published_at).toBe("2026-08-17T16:05:18Z");
      expect(s.value.source.report).toEqual({ year: 2026, quarter: 2, consolidation: "consolidated" });
    }
  });

  test("the result can be redone from the steps alone", () => {
    const v = Object.fromEntries(read(sig.calculation.steps).map((s) => [s.id, Number(s.value.value)]));
    const m = Object.fromEntries(sig.calculation.steps.filter((s) => "result" in s).map((s) => [s.id, s.result]));
    expect((v.gross_profit_q as number) / (v.revenue_q as number)).toBeCloseTo(Number(m.margin_q), 6);
    expect((v.gross_profit_q_prior as number) / (v.revenue_q_prior as number)).toBeCloseTo(Number(m.margin_q_prior), 6);
    expect(Math.round((Number(m.margin_q) - Number(m.margin_q_prior)) * 10_000)).toBe(Number(m.change_bps));
    expect(m.change_bps).toBe(String(sig.summary_metrics.delta_bps));
  });
});

describe("S2 and S3 carry their inputs too", () => {
  const YTD = "Cari Dönem 01.01.2026 - 30.06.2026";
  const ytd = { period_label: YTD, ...periodFromLabel(YTD) };
  const inc = "310003";
  const cf = "520003";
  const s2Filing = (monetary: boolean) =>
    filing({
      role_codes: [inc, cf],
      published_at: "2026-08-17T19:05:18",
      facts: [
        fact({
          role_code: inc,
          row_id: `general_role_${inc}-row-59`,
          label_tr: "DÖNEM KARI (ZARARI)",
          raw_value: 250_000n,
          scale_unit: "BİN TL",
          normalized_value_tl: 250_000_000n,
          ...ytd,
        }),
        fact({
          role_code: cf,
          row_id: `general_role_${cf}-row-2`,
          label_tr: "İşletme Faaliyetlerinden Nakit Akışları",
          raw_value: -150_000n,
          scale_unit: "BİN TL",
          normalized_value_tl: -150_000_000n,
          ...ytd,
        }),
        ...(monetary
          ? [
              fact({
                role_code: inc,
                row_id: `general_role_${inc}-row-52`,
                label_tr: "Net Parasal Pozisyon Kazançları (Kayıpları)",
                raw_value: 300_000n,
                scale_unit: "BİN TL",
                normalized_value_tl: 300_000_000n,
                ...ytd,
              }),
            ]
          : []),
      ],
    });

  test("S2: profit, cash flow and the net monetary gain with their sources; the bridge redone", () => {
    const sig = detectCashProfitQualityDivergence(s2Filing(true), CONFIG) as SignalObject;
    expect(sig.calculation.definition).toEqual({
      id: "profit_cash_divergence",
      version: CONFIG.version,
      url: "/methodology/profit_cash_divergence",
    });
    const steps = sig.calculation.steps;
    expect(steps.map((s) => s.id)).toEqual([
      "net_profit_ytd",
      "operating_cash_flow_ytd",
      "profit_minus_ocf",
      "net_monetary_position_ytd",
      "profit_excluding_monetary_gain",
    ]);
    expect(
      read(steps).map((s) => [s.value.value, s.value.source.shown_value, s.value.source.scale, s.value.period.type]),
    ).toEqual([
      ["250000000", "250.000", "BİN TL", "cumulative"],
      ["-150000000", "-150.000", "BİN TL", "cumulative"],
      ["300000000", "300.000", "BİN TL", "cumulative"],
    ]);
    expect(steps.filter((s) => "result" in s).map((s) => [s.id, "result" in s && s.result])).toEqual([
      ["profit_minus_ocf", "400000000"],
      ["profit_excluding_monetary_gain", "-50000000"],
    ]);
    for (const s of read(steps)) expectComplete(s.value.source);
  });

  test("S2 without the monetary row has no step for it", () => {
    const sig = detectCashProfitQualityDivergence(s2Filing(false), CONFIG) as SignalObject;
    expect(sig.calculation.steps.map((s) => s.id)).toEqual([
      "net_profit_ytd",
      "operating_cash_flow_ytd",
      "profit_minus_ocf",
    ]);
  });

  test("S3: every restated line is an input; the count is redone from them", () => {
    const at = "Bir Önceki Dönem 01.01.2025";
    const prior = "Önceki Dönem 31.12.2025";
    const bs = (row: number, col: string, label: string, v: bigint, period: string) =>
      fact({
        statement_type: "BALANCE_SHEET",
        row_id: `general_role_210015-row-${row}`,
        label_tr: label,
        column_class: col,
        raw_value: v,
        normalized_value_tl: v,
        period_label: period,
        ...periodFromLabel(period),
      });
    const f = filing({
      facts: [
        bs(4, "col-order-class-6", "Nakit ve Nakit Benzerleri", 10n, at),
        bs(129, "col-order-class-6", "TOPLAM VARLIKLAR", 1_000n, at),
        bs(129, "col-order-class-5", "TOPLAM VARLIKLAR", 1_200n, prior),
      ],
    });
    const sig = detectRestatementTripwire(f, CONFIG) as SignalObject;
    expect(sig.calculation.steps.map((s) => s.id)).toEqual([
      "restated_4",
      "restated_129",
      "total_assets_prior_period",
      "restated_line_count",
    ]);
    const restated = read(sig.calculation.steps).filter((s) => s.id.startsWith("restated_"));
    expect(sig.calculation.steps.at(-1)).toMatchObject({ result: String(restated.length) });
    expect(restated[1]?.value.period).toEqual({
      start: null,
      end: "2025-01-01",
      type: "point_in_time",
      label: at,
      currency_part: "total",
    });
  });
});

describe("pieces", () => {
  test("shownValue rebuilds the cell text: dot groups, leading minus", () => {
    expect([0n, 7n, 999n, 1_000n, 189_492_068n, -55_300n, -1n].map(shownValue)).toEqual([
      "0",
      "7",
      "999",
      "1.000",
      "189.492.068",
      "-55.300",
      "-1",
    ]);
  });

  test("publication time: Istanbul (UTC+3) to UTC", () => {
    expect(istanbulToUtc("2026-08-17T19:05:18")).toBe("2026-08-17T16:05:18Z");
    expect(istanbulToUtc("2026-01-01T01:00:00")).toBe("2025-12-31T22:00:00Z");
    expect(() => istanbulToUtc("17.08.2026")).toThrow(ProvenanceError);
  });

  test("consolidation, URL", () => {
    expect(consolidation("Konsolide")).toBe("consolidated");
    expect(consolidation("Konsolide Olmayan")).toBe("standalone");
    expect(consolidation("Bilinmiyor")).toBeNull();
    expect(kapUrl(1651411)).toBe("https://www.kap.org.tr/tr/Bildirim/1651411");
  });

  test("periods: bank TP / YP columns keep their part; a column without dates is refused", () => {
    const tp = fact({
      period_type: "POINT_IN_TIME_TP",
      period_end: "2026-06-30",
      period_label: "Cari Dönem 30.06.2026",
    });
    expect(periodOf(tp)).toMatchObject({ type: "point_in_time", currency_part: "tp" });
    expect(periodOf({ ...tp, period_type: "POINT_IN_TIME_YP" }).currency_part).toBe("yp");
    expect(() => periodOf(fact({ period_type: "UNKNOWN", period_end: "2026-06-30" }))).toThrow(ProvenanceError);
    expect(() => periodOf(fact({ period_end: null }))).toThrow("no period end");
    expect(() => periodOf(fact({ period_type: "Q_STANDALONE", period_end: "2026-06-30" }))).toThrow(ProvenanceError);
  });

  test("a fact without a table in its row id is refused", () => {
    const f = fact({ row_id: "row4", period_end: "2026-06-30" });
    expect(() => readValue(filing(), f)).toThrow("has no table");
  });
});

// On the real filings, when present: every finding's every input has a complete source, read from the file.
const have = rawFile("2026_2", "KATMR_1651411_2026_2.xls") !== null;
test.skipIf(!have)("on 2026/2, every input of every finding has a complete source", () => {
  const dir = join(RAW_DIR, "2026_2");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  let inputs = 0;
  for (const name of readdirSync(dir).filter((n: string) => n.endsWith(".xls"))) {
    const pf: ParsedFiling = parseKapXls(readFileSync(join(dir, name)), name);
    for (const sig of [
      detectGrossMarginDeviation(pf, CONFIG),
      detectCashProfitQualityDivergence(pf, CONFIG),
      detectRestatementTripwire(pf, CONFIG),
    ]) {
      for (const s of read(sig?.calculation.steps ?? [])) {
        expectComplete(s.value.source);
        expect(s.value.source.published_at).not.toBeNull();
        inputs += 1;
      }
    }
  }
  expect(inputs).toBeGreaterThan(200);
});
