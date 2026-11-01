/**
 * The shared API types (#213) match docs/API.md: its full example parses and type checks as a FindingDetail,
 * and every Value in it follows the Value rules.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { amount, ERROR_STATUS, type FindingDetail, parseAmount, type Value } from "../src/index.ts";

// Git may check the file out with CRLF line endings on Windows.
const API_MD = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "API.md"), "utf8").replaceAll("\r\n", "\n");

/** The JSON block of the full example in docs/API.md. */
function example(): FindingDetail {
  const section = API_MD.slice(API_MD.indexOf("## Example: KATMR"));
  const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (!block) throw new Error("no example in docs/API.md");
  return JSON.parse(block) as FindingDetail;
}

/** Every Value found anywhere in an object. */
function values(x: unknown, out: Value[] = []): Value[] {
  if (Array.isArray(x)) for (const v of x) values(v, out);
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.status === "string" && "unit" in o && "value" in o) out.push(o as unknown as Value);
    for (const v of Object.values(o)) values(v, out);
  }
  return out;
}

test("the docs example is a finding with a calculation", () => {
  const f = example();
  expect(f.rule).toBe("gross_margin_change");
  expect(f.calculation.steps.map((s) => s.id)).toEqual([
    "gross_profit_q",
    "revenue_q",
    "gross_profit_q_prior",
    "revenue_q_prior",
    "margin_q",
    "margin_q_prior",
    "change_bps",
  ]);
});

test("every Value in the example follows the rules", () => {
  const all = values(example());
  expect(all.length).toBe(5); // size + four inputs
  for (const v of all) {
    expect(["ok", "not_reported", "not_computable"]).toContain(v.status);
    expect(["TRY", "ratio", "bps", "days", "count"]).toContain(v.unit);
    if (v.status === "ok") expect(typeof v.value).toBe("string");
    else expect(v.value).toBeNull();
    if (v.unit === "TRY" || v.unit === "bps") parseAmount(v.value as string);
    const o = v as unknown as Record<string, unknown>;
    expect("source" in o && "calculation" in o).toBe(false);
  }
});

test("the example's result can be recomputed from its inputs", () => {
  const steps = Object.fromEntries(
    example()
      .calculation.steps.filter((s) => "value" in s)
      .map((s) => ["value" in s ? s.id : "", parseAmount(("value" in s ? s.value.value : "") as string)]),
  );
  const margin = (gp: bigint, rev: bigint) => Number(gp) / Number(rev);
  const change = Math.round(
    (margin(steps.gross_profit_q as bigint, steps.revenue_q as bigint) -
      margin(steps.gross_profit_q_prior as bigint, steps.revenue_q_prior as bigint)) *
      10_000,
  );
  expect(String(change)).toBe(example().size.value as string);
});

test("amounts keep precision above 2^53", () => {
  const big = 9_007_199_254_740_993n;
  expect(parseAmount(amount(big))).toBe(big);
  expect(amount(-5n)).toBe("-5");
  for (const bad of ["1.5", "1e3", " 1", "01", "", "abc"]) expect(() => parseAmount(bad)).toThrow(TypeError);
});

test("every error code has an HTTP status", () => {
  expect(ERROR_STATUS).toEqual({ invalid_request: 400, not_found: 404, conflict: 409, not_ready: 503, internal: 500 });
});

// Type-level checks: these lines fail `tsc` if the types drift from the contract.
const _notComputable: Value = {
  status: "not_computable",
  value: null,
  unit: "ratio",
  reason: { code: "missing_input", message: "Satışların maliyeti raporda yok.", needs: ["cost_of_sales"] },
};
// @ts-expect-error an ok value must carry a string, not a number
const _badNumber: Value = { status: "ok", value: 5, unit: "TRY" };
// @ts-expect-error not_computable requires a reason
const _noReason: Value = { status: "not_computable", value: null, unit: "ratio" };
void [_notComputable, _badNumber, _noReason];
