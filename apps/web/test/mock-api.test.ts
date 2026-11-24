/**
 * The development mock API (#233, #364). Expected values come from the golden file tests/golden/2026_2 and the worked
 * example in docs/API.md, not from the fixtures module.
 */
import { describe, expect, test } from "bun:test";
import { ERROR_STATUS, type ErrorResponse } from "@vigil/api-types";
import { handleMockRequest } from "../src/lib/mock-api.ts";

const BASE = "http://127.0.0.1/api/mock/v1";

async function call(path: string, init?: RequestInit) {
  const response = await handleMockRequest(new Request(`${BASE}${path}`, init));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const r = await call(path);
  expect(r.status).toBe(200);
  return r.body as T;
}

async function expectError(path: string, code: keyof typeof ERROR_STATUS, init?: RequestInit) {
  const r = await call(path, init);
  expect(r.status).toBe(ERROR_STATUS[code]);
  expect((r.body as ErrorResponse).error.code).toBe(code);
  return (r.body as ErrorResponse).error;
}

describe("every GET route answers", () => {
  for (const path of [
    "/health",
    "/ready",
    "/meta",
    "/companies",
    "/companies/KATMR",
    "/companies/KATMR/metrics",
    "/companies/KATMR/facts/general_role_310003-row-3/versions",
    "/reports/1651411",
    "/reports/1651411/statements/income_statement",
    "/findings",
    "/findings/2026-2-KATMR-gross_margin_change",
    "/quality",
    "/settings",
    "/openapi.json",
  ]) {
    test(path, async () => {
      const r = await call(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("Vigil-Tier")).toBe("local");
    });
  }
});

describe("values trace to the golden file and docs/API.md", () => {
  test("the finding is the worked example in docs/API.md", async () => {
    const f = await get<{
      company_code: string;
      document_id: string;
      size: { value: string; unit: string };
      calculation: { steps: ({ id: string; value: { value: string } } | { id: string; result: string })[] };
    }>("/findings/2026-2-KATMR-gross_margin_change");
    expect(f.company_code).toBe("KATMR");
    expect(f.document_id).toBe("1651411");
    expect(f.size).toEqual({ value: "-2596", unit: "bps", status: "ok" } as never);
    const steps = Object.fromEntries(f.calculation.steps.map((s) => [s.id, "result" in s ? s.result : s.value.value]));
    expect(steps).toEqual({
      gross_profit_q: "189492068",
      revenue_q: "879599263",
      margin_q: "0.215430",
      gross_profit_q_prior: "330145727",
      revenue_q_prior: "694991758",
      margin_q_prior: "0.475035",
      change_bps: "-2596",
    });
  });

  test("KATMR revenue, current and prior cumulative (golden row general_role_310003-row-3)", async () => {
    const s = await get<{ rows: { row: string; values: Record<string, { value: string }> }[] }>(
      "/reports/1651411/statements/income_statement",
    );
    const revenue = s.rows.find((r) => r.row === "general_role_310003-row-3");
    expect(revenue?.values["col-order-class-4"]?.value).toBe("1558895376");
    expect(revenue?.values["col-order-class-5"]?.value).toBe("1434008001");
  });

  test("AKBNK amounts are whole TL after the 1.000.000 TL scale (golden banks_role_210011-row-4)", async () => {
    const s = await get<{
      rows: { row: string; values: Record<string, { value: string; source: { shown_value: string } }> }[];
    }>("/reports/1637884/statements/balance_sheet");
    const cell = s.rows.find((r) => r.row === "banks_role_210011-row-4")?.values["col-order-class-6"];
    expect(cell?.value).toBe("1351403000000");
    // The cell text as filed, before scaling, written like docs/API.md ("189.492.068").
    expect(cell?.source.shown_value).toBe("1.351.403");
  });

  test("a value that cannot be computed says why, with no number", async () => {
    const m = await get<{ metrics: { value: { value: unknown; status: string; reason: { code: string } } }[] }>(
      "/companies/AKBNK/metrics",
    );
    expect(m.metrics[0]?.value.value).toBeNull();
    expect(m.metrics[0]?.value.status).toBe("not_computable");
    expect(m.metrics[0]?.value.reason.code).toBe("not_applicable");
  });
});

describe("statements", () => {
  test("the view selects three-month or cumulative columns", async () => {
    type S = { columns: { period: { type: string } }[] };
    const q = await get<S>("/reports/1651411/statements/income_statement?view=three_month");
    expect(q.columns.map((c) => c.period.type)).toEqual(["three_month", "three_month"]);
    const c = await get<S>("/reports/1651411/statements/income_statement");
    expect(c.columns.map((c) => c.period.type)).toEqual(["cumulative", "cumulative"]);
  });

  test("bad statement, view or report", async () => {
    expect((await expectError("/reports/1651411/statements/notes", "invalid_request")).details).toEqual({
      parameter: "statement",
    });
    expect(
      (await expectError("/reports/1651411/statements/income_statement?view=yearly", "invalid_request")).details,
    ).toEqual({
      parameter: "view",
    });
    await expectError("/reports/999/statements/income_statement", "not_found");
    await expectError("/reports/constructor/statements/income_statement", "not_found");
  });
});

describe("pagination", () => {
  type L = { items: { code: string }[]; next_cursor: string | null; total: number };

  test("limit and next_cursor walk the whole list", async () => {
    const first = await get<L>("/companies?limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await get<L>(`/companies?limit=1&cursor=${encodeURIComponent(first.next_cursor ?? "")}`);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect([first.items[0]?.code, second.items[0]?.code].sort()).toEqual(["AKBNK", "KATMR"]);
  });

  test("limit must be a whole number from 1 to 200", async () => {
    for (const limit of ["0", "201", "1.5", "abc", "-1"]) {
      expect((await expectError(`/companies?limit=${limit}`, "invalid_request")).details).toEqual({
        parameter: "limit",
      });
    }
    expect((await get<L>("/companies?limit=200")).items).toHaveLength(2);
  });

  test("a cursor that was not issued is refused", async () => {
    for (const cursor of ["!!!", btoa("x"), btoa("-1"), btoa("99")]) {
      expect((await expectError(`/companies?cursor=${encodeURIComponent(cursor)}`, "invalid_request")).details).toEqual(
        {
          parameter: "cursor",
        },
      );
    }
  });
});

describe("lookups", () => {
  test("company codes match regardless of case and Turkish letters", async () => {
    for (const code of ["katmr", "KATMR", "Katmr"]) {
      expect((await get<{ code: string }>(`/companies/${code}`)).code).toBe("KATMR");
    }
    expect((await get<{ items: { code: string }[] }>("/companies?q=katmerci")).items.map((c) => c.code)).toEqual([
      "KATMR",
    ]);
    // "İ" in the title matches a plain "i".
    expect((await get<{ items: unknown[] }>("/companies?q=KATMERCILER")).items).toHaveLength(1);
  });

  test("unknown company, finding, report and path", async () => {
    await expectError("/companies/NOPE", "not_found");
    await expectError("/companies/NOPE/metrics", "not_found");
    await expectError("/companies/KATMR/facts/no-such-row/versions", "not_found");
    await expectError("/findings/2026-2-NOPE-gross_margin_change", "not_found");
    await expectError("/reports/1", "not_found");
    await expectError("/no-such-path", "not_found");
  });

  test("findings filter by rule, company and quarter", async () => {
    type L = { items: { id: string }[] };
    expect((await get<L>("/findings?company=katmr&quarter=2026-2&rule=gross_margin_change")).items).toHaveLength(1);
    expect((await get<L>("/findings?company=AKBNK")).items).toHaveLength(0);
    expect((await get<L>("/findings?quarter=2026-1")).items).toHaveLength(0);
    expect((await get<L>("/findings?rule=restated_comparatives")).items).toHaveLength(0);
  });
});

describe("settings and downloads", () => {
  test("a bad settings body is refused and leaves the settings as they were", async () => {
    const before = await get("/settings");
    const put = (body: string) => ({ method: "PUT", body, headers: { "Content-Type": "application/json" } });
    await expectError("/settings", "invalid_request", put("{"));
    await expectError("/settings", "invalid_request", put("[]"));
    await expectError("/settings", "invalid_request", put(JSON.stringify({ quarters: ["2026-5"] })));
    await expectError(
      "/settings",
      "invalid_request",
      put(JSON.stringify({ llm: { provider: "openai_compatible", model: "m" } })),
    );
    const after = await get("/settings");
    expect(after).toEqual(before);
  });

  test("an API key is never echoed back", async () => {
    const r = await call("/settings", {
      method: "PUT",
      body: JSON.stringify({ llm: { provider: "anthropic", model: "m", api_key: "secret-value" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("secret-value");
    expect((r.body as { llm: { api_key_set: boolean } }).llm.api_key_set).toBe(true);
    await call("/settings", { method: "PUT", body: JSON.stringify({ llm: null }) });
  });

  test("a download needs at least one valid quarter", async () => {
    const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
    await expectError("/downloads", "invalid_request", post({ quarters: [] }));
    await expectError("/downloads", "invalid_request", post({ quarters: ["2026-Q2"] }));
    const r = await call("/downloads", post({ quarters: ["2026-2", "2026-2"] }));
    expect(r.body).toEqual({ started: ["2026-2"] });
  });
});
