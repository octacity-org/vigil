/**
 * The configuration file (#69). Expected values are those of decisions 0011 (EBITDA A), 0015 (X = 1,000 bps, Z = 1%
 * of total assets) and the S1/S2 prototype floors (100 mn TL); "done when": no threshold literal in the rule code.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  isRealSectorFiling,
  parseConfig,
} from "../src/index.ts";
import { CONFIG, fact, filing, katmrFromGolden, REPO } from "./helpers.ts";

const TEXT = readFileSync(join(REPO, "config", "vigil.json"), "utf8");
const raw = () => JSON.parse(TEXT);
const parse = (o: unknown) => parseConfig(JSON.stringify(o), "test.json");

describe("the repository's config/vigil.json", () => {
  test("holds the decided values", () => {
    expect(CONFIG).toEqual({
      version: "2026-11-01",
      ebitda_definition: "A",
      real_sector: { max_financial_row_share_of_revenue: 0.05 },
      s1_gross_margin: {
        x_min_abs_delta_bps: 1000,
        z_min_share_of_denominator: 0.01,
        denominator: "total_assets",
        min_three_month_revenue_tl: 100_000_000n,
      },
      s2_profit_cash: { min_net_profit_ytd_tl: 100_000_000n, max_operating_cash_flow_ytd_tl: -100_000_000n },
    });
  });
});

describe("parseConfig refuses, naming the key", () => {
  test.each([
    ["not JSON", "{", "not valid JSON"],
    [
      "a missing key",
      (() => {
        const o = raw();
        delete o.s1_gross_margin.x_min_abs_delta_bps;
        return o;
      })(),
      's1_gross_margin: missing "x_min_abs_delta_bps"',
    ],
    ["an unknown key (a typo)", { ...raw(), s1_gross_margn: {} }, 'unknown key "s1_gross_margn"'],
    ["an empty version", { ...raw(), version: " " }, "version must be a non-empty string"],
    ["another EBITDA definition", { ...raw(), ebitda_definition: "C" }, "ebitda_definition must be one of"],
    [
      "another denominator",
      { ...raw(), s1_gross_margin: { ...raw().s1_gross_margin, denominator: "revenue" } },
      "denominator",
    ],
    [
      "X as text",
      { ...raw(), s1_gross_margin: { ...raw().s1_gross_margin, x_min_abs_delta_bps: "1000" } },
      "x_min_abs_delta_bps must be a positive whole number",
    ],
    [
      "Z as a percentage",
      { ...raw(), s1_gross_margin: { ...raw().s1_gross_margin, z_min_share_of_denominator: 1 } },
      "z_min_share_of_denominator must be a number between 0 and 1",
    ],
    [
      "a fractional amount",
      { ...raw(), s2_profit_cash: { ...raw().s2_profit_cash, min_net_profit_ytd_tl: 1.5 } },
      "min_net_profit_ytd_tl",
    ],
    [
      "a positive cash flow ceiling",
      { ...raw(), s2_profit_cash: { ...raw().s2_profit_cash, max_operating_cash_flow_ytd_tl: 5 } },
      "must be a negative whole number",
    ],
    ["a section that is not an object", { ...raw(), real_sector: [] }, "real_sector must be an object"],
  ])("%s", (_name, input, message) => {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    expect(() => parseConfig(text, "test.json")).toThrow(ConfigError);
    expect(() => parseConfig(text, "test.json")).toThrow(message);
  });
});

describe("the detectors use the configured values", () => {
  const katmr = katmrFromGolden(); // -2596 bps on 2026/2

  test("S1 fires on KATMR at X = 1,000 bps but not at X = 3,000", () => {
    expect(detectGrossMarginDeviation(katmr, CONFIG)?.summary_metrics.delta_bps).toBe(-2596);
    const strict = parse({ ...raw(), s1_gross_margin: { ...raw().s1_gross_margin, x_min_abs_delta_bps: 3000 } });
    expect(detectGrossMarginDeviation(katmr, strict)).toBeNull();
    const at = parse({ ...raw(), s1_gross_margin: { ...raw().s1_gross_margin, x_min_abs_delta_bps: 2596 } });
    expect(detectGrossMarginDeviation(katmr, at)).not.toBeNull();
  });

  test("S1's revenue floor comes from the config", () => {
    const high = parse({
      ...raw(),
      s1_gross_margin: { ...raw().s1_gross_margin, min_three_month_revenue_tl: 1_000_000_000_000 },
    });
    expect(detectGrossMarginDeviation(katmr, high)).toBeNull();
  });

  test("S2's profit floor and cash flow ceiling come from the config", () => {
    // Year-to-date net profit 250 mn TL, operating cash flow -150 mn TL.
    const role = "310003";
    const cf = "520003";
    const f = filing({
      role_codes: [role, cf],
      facts: [
        fact({
          role_code: role,
          statement_type: "INCOME_STATEMENT",
          row_id: `general_role_${role}-row-59`,
          normalized_value_tl: 250_000_000n,
          raw_value: 250_000_000n,
        }),
        fact({
          role_code: cf,
          statement_type: "CASH_FLOW_INDIRECT",
          row_id: `general_role_${cf}-row-2`,
          normalized_value_tl: -150_000_000n,
          raw_value: -150_000_000n,
        }),
      ],
    });
    expect(detectCashProfitQualityDivergence(f, CONFIG)?.summary_metrics.profit_minus_ocf_gap_tl).toBe(400_000_000n);
    const s2 = raw().s2_profit_cash;
    expect(
      detectCashProfitQualityDivergence(
        f,
        parse({ ...raw(), s2_profit_cash: { ...s2, min_net_profit_ytd_tl: 300_000_000 } }),
      ),
    ).toBeNull();
    expect(
      detectCashProfitQualityDivergence(
        f,
        parse({ ...raw(), s2_profit_cash: { ...s2, max_operating_cash_flow_ytd_tl: -200_000_000 } }),
      ),
    ).toBeNull();
  });

  test("the financial-row share deciding a real-sector filing comes from the config", () => {
    // Revenue 1,000; financial-sector revenue 60 (6%).
    const role = "310003";
    const f = filing({
      role_codes: [role],
      facts: [
        fact({
          role_code: role,
          statement_type: "INCOME_STATEMENT",
          row_id: `general_role_${role}-row-3`,
          normalized_value_tl: 1_000n,
        }),
        fact({
          role_code: role,
          statement_type: "INCOME_STATEMENT",
          row_id: `general_role_${role}-row-6`,
          normalized_value_tl: 60n,
        }),
      ],
    });
    expect(isRealSectorFiling(f, CONFIG)).toEqual([false, "material_financial_sector_revenue_row_6"]);
    const loose = parse({ ...raw(), real_sector: { max_financial_row_share_of_revenue: 0.1 } });
    expect(isRealSectorFiling(f, loose)).toEqual([true, "real_sector"]);
  });
});

test("done when: no threshold literals in the rule code", () => {
  // Code lines only. TL amounts would be bigint literals: only 0n (a sign test) may remain. No detector parameter has
  // a default value. The rank scores' scaling (/ 1000, / 1e9) orders findings and triggers nothing (decision 0015).
  const code = readFileSync(join(REPO, "packages", "core", "src", "signals.ts"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  expect(code.match(/\b(?!0n\b)\d[\d_]*n\b/g)).toBeNull();
  expect(code).not.toContain("0.05");
  expect(code).not.toMatch(/\b(min|max)[A-Za-z]*\s*=\s*-?\d/);
});
