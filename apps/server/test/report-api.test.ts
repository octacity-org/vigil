/**
 * `GET /v1/reports/{document_id}` (#219, #396), tested apart from its author (CONTRIBUTING rule 5). The filing below is
 * built so every check result is known by hand: the rules are in docs/SCHEMA.md (`check_results`) and decision 0006
 * (5 units for two single values, one unit per formula component for a subtotal; values × `scale_multiplier` give TL).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Check, ErrorResponse, Report, Value } from "@vigil/api-types";
import { reportRoutes } from "../src/api/reports.ts";
import { rows } from "../src/db.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";
import { type FixtureFiling, GENERAL } from "./fixtures/index.ts";

const BALANCE = ["Cari Dönem <br>30.06.2026", "Önceki Dönem <br>31.12.2025"];

/**
 * Holding template, thousand TL, solo. Current column: assets 400 + 600 = 1.000, liabilities and equity 1.003 (3 apart,
 * within 5). Prior column: assets 805 against 300 + 500 = 800 (5 apart, more than the 2 a two-part subtotal allows).
 */
const REPORT: FixtureFiling = {
  ticker: "TSTRP",
  disclosureId: 9_000_030,
  year: 2026,
  quarter: 2,
  family: "holding",
  unit: "1.000 TL",
  multiplier: 1_000n,
  consolidation: "Konsolide Olmayan",
  published: "19.08.2026 09:30:00",
  tables: [
    {
      role: "210015",
      headers: BALANCE,
      rows: [
        { row: 55, label: "TOPLAM DÖNEN VARLIKLAR", values: { 4: 400, 5: 300 } },
        { row: 128, label: "TOPLAM DURAN VARLIKLAR", values: { 4: 600, 5: 500 } },
        { row: 129, label: "TOPLAM VARLIKLAR", values: { 4: 1_000, 5: 805 } },
        { row: 297, label: "TOPLAM KAYNAKLAR", values: { 4: 1_003, 5: 805 } },
      ],
    },
  ],
};

/** A file the parser found no values in. */
const EMPTY: FixtureFiling = {
  ...GENERAL,
  ticker: "TSTEM",
  disclosureId: 9_000_031,
  tables: GENERAL.tables.slice(0, 1).map((t) => ({ ...t, rows: t.rows.map((r) => ({ ...r, values: {} })) })),
};

const SUBTOTAL = "balance_sheet_row_129_equals_rows_55+128";

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({ filings: [REPORT, EMPTY], routes: (db) => [reportRoutes(db)] });
});
afterAll(() => api.close());

async function report(id = "9000030"): Promise<Report> {
  const r = await api.get<Report>(`/v1/reports/${id}`);
  expect(r.status).toBe(200);
  return r.body;
}

const checksNamed = (r: Report, name: string) => r.checks.filter((c) => c.name === name);
const okValue = (v: Value | null) => {
  if (v === null || v.status !== "ok") throw new Error(`expected an ok value, got ${JSON.stringify(v)}`);
  return v;
};

describe("the report", () => {
  test("metadata as docs/API.md writes it", async () => {
    const { checks: _checks, ...meta } = await report();
    expect(meta as unknown).toEqual({
      document_id: "9000030",
      company_code: "TSTRP",
      year: 2026,
      quarter: 2,
      consolidation: "solo",
      template: "holding",
      scale: "1.000 TL",
      // 19.08.2026 09:30:00 Istanbul (UTC+3).
      published_at: "2026-08-19T06:30:00Z",
      quality: "fail",
      url: "https://www.kap.org.tr/tr/Bildirim/9000030",
    });
  });

  test("checks are listed in the order they ran", async () => {
    const r = await report();
    const [{ n }] = (await rows(api.db, "SELECT count(*) AS n FROM check_results WHERE disclosure_id = 9000030")) as [
      { n: bigint },
    ];
    expect(r.checks).toHaveLength(Number(n));
    expect(r.checks[0]?.name).toBe("total_assets_equal_liabilities_and_equity_current");
  });

  test("a file without values: no_values, no checks", async () => {
    const r = await report("9000031");
    expect(r.quality).toBe("no_values");
    expect(r.checks).toEqual([]);
  });
});

describe("two single values", () => {
  test("current: 1.000 against 1.003 thousand TL passes within 5 units, in TL with both sources", async () => {
    const [c] = checksNamed(await report(), "total_assets_equal_liabilities_and_equity_current") as [Check];
    expect([c.group, c.severity, c.status, c.tolerance, c.known_error]).toEqual([
      "reconciliation",
      "blocking",
      "pass",
      "5000",
      null,
    ]);
    const left = okValue(c.left);
    const right = okValue(c.right);
    expect([left.value, left.unit, right.value]).toEqual(["1000000", "TRY", "1003000"]);
    expect(left.source).toMatchObject({
      system: "KAP",
      document_id: "9000030",
      company_code: "TSTRP",
      report: { year: 2026, quarter: 2, consolidation: "solo" },
      table: "holding_role_210015",
      row: "holding_role_210015-row-129",
      row_label: "TOPLAM VARLIKLAR",
      column: "col-order-class-4",
      shown_value: "1.000",
      scale: "1.000 TL",
      published_at: "2026-08-19T06:30:00Z",
      url: "https://www.kap.org.tr/tr/Bildirim/9000030",
    });
    expect(right.source).toMatchObject({ row: "holding_role_210015-row-297", shown_value: "1.003" });
    expect(left.period).toMatchObject({ start: null, end: "2026-06-30", type: "point_in_time" });
  });

  test("prior: 805 against 805 passes, dated 31.12.2025", async () => {
    const [c] = checksNamed(await report(), "total_assets_equal_liabilities_and_equity_prior") as [Check];
    expect(c.status).toBe("pass");
    expect([okValue(c.left).value, okValue(c.right).value]).toEqual(["805000", "805000"]);
    expect(okValue(c.left).period).toMatchObject({ end: "2025-12-31", type: "point_in_time" });
  });
});

describe("a subtotal", () => {
  test("current: 400 + 600 = 1.000 passes; tolerance 2 units; the components are calculation steps", async () => {
    const [current] = checksNamed(await report(), SUBTOTAL) as [Check];
    expect([current.group, current.status, current.tolerance]).toEqual(["balance_sheet", "pass", "2000"]);
    expect(okValue(current.left).value).toBe("1000000");
    const right = okValue(current.right);
    expect(right.value).toBe("1000000");
    const steps = right.calculation?.steps ?? [];
    expect(steps.map((s) => ("value" in s ? [s.id, okValue(s.value).value] : [s.id, s.result]))).toEqual([
      ["holding_role_210015-row-55", "400000"],
      ["holding_role_210015-row-128", "600000"],
      ["sum", "1000000"],
    ]);
    for (const s of steps) {
      if ("value" in s) expect(okValue(s.value).source?.column).toBe("col-order-class-4");
    }
  });

  test("prior: 805 against 300 + 500 = 800 fails, 5 apart with 2 allowed", async () => {
    const [, prior] = checksNamed(await report(), SUBTOTAL) as [Check, Check];
    expect(prior.status).toBe("fail");
    expect([okValue(prior.left).value, okValue(prior.right).value, prior.tolerance]).toEqual([
      "805000",
      "800000",
      "2000",
    ]);
    expect(okValue(prior.left).source?.column).toBe("col-order-class-5");
  });

  test("a total whose components were not reported is not_checked, with no values", async () => {
    const notChecked = (await report()).checks.filter((c) => c.status === "not_checked");
    expect(notChecked.length).toBeGreaterThan(0);
    for (const c of notChecked) {
      expect(c.left).toBeNull();
      expect(c.right).toBeNull();
    }
  });
});

describe("known filing errors (decision 0006)", () => {
  test("the failure confirmed as a filing error keeps fail, gives its reason, and the report is known_error", async () => {
    await rows(
      api.db,
      `UPDATE check_results SET known_error = 'Şirket önceki dönem toplamını hatalı bildirdi (test)'
       WHERE disclosure_id = 9000030 AND status = 'fail'`,
    );
    const r = await report();
    const [, prior] = checksNamed(r, SUBTOTAL) as [Check, Check];
    expect(prior.status).toBe("fail");
    expect(prior.known_error).toBe("Şirket önceki dönem toplamını hatalı bildirdi (test)");
    expect(r.quality).toBe("known_error");
    expect(r.checks.filter((c) => c.status !== "fail").every((c) => c.known_error === null)).toBe(true);
  });

  test("with no blocking failure left, the report passes", async () => {
    await rows(
      api.db,
      "UPDATE check_results SET status = 'pass', known_error = NULL WHERE disclosure_id = 9000030 AND status = 'fail'",
    );
    expect((await report()).quality).toBe("pass");
  });
});

describe("ids", () => {
  test("a malformed id is a 400 naming document_id", async () => {
    for (const id of ["abc", "-1", "1.5", "9000030x"]) {
      const e = await api.getError(`/v1/reports/${id}`, 400);
      expect(`${id}: ${e.code} ${e.details.parameter}`).toBe(`${id}: invalid_request document_id`);
    }
  });

  test("a report that is not loaded is a 404", async () => {
    const r = await api.get<ErrorResponse>("/v1/reports/1");
    expect([r.status, r.body.error.code]).toEqual([404, "not_found"]);
  });

  test("no request became an internal error", () => {
    expect(api.internalErrors).toEqual([]);
  });
});
