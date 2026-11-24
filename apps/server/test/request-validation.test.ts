/**
 * Request validation helpers (#214, #367), tested apart from their author (CONTRIBUTING rule 5). Expected values are
 * written by hand from docs/API.md: quarters are `YYYY-Q`, `document_id` is a string, finding ids are
 * `YYYY-Q-CODE-rule`, row ids look like `general_role_310003-row-3`.
 */
import { describe, expect, test } from "bun:test";
import type { ErrorResponse } from "@vigil/api-types";
import { ApiError, createApp, type Routes } from "../src/api/app.ts";
import {
  parseCompanyCode,
  parseDocumentId,
  parseEnumParam,
  parseFindingId,
  parseIntParam,
  parseIsoDateParam,
  parseJsonBody,
  parseOptionalEnumParam,
  parseOptionalIntParam,
  parseOptionalIsoDateParam,
  parseOptionalQuarterParam,
  parseQuarterParam,
  parseRowId,
  parseStatementName,
  parseStatementView,
  parseVersionSelector,
} from "../src/api/validation.ts";

/** The `invalid_request` error `f` throws, checked for the parameter it names. */
function invalid(f: () => unknown, parameter: string): ApiError {
  let thrown: unknown;
  try {
    f();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  const e = thrown as ApiError;
  expect(e.code).toBe("invalid_request");
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.details.parameter).toBe(parameter);
  return e;
}

describe("integers", () => {
  test("whole numbers within the bounds", () => {
    expect(parseIntParam("1", "limit")).toBe(1);
    expect(parseIntParam("200", "limit", { max: 200 })).toBe(200);
    expect(parseIntParam("0", "offset", { min: 0 })).toBe(0);
    expect(parseIntParam("9007199254740991", "n")).toBe(9007199254740991);
  });

  test("missing, malformed and out-of-range values name the parameter", () => {
    for (const raw of [undefined, "", "abc", "1.5", "1e3", "-1", " 1", "01", "0x10"])
      invalid(() => parseIntParam(raw, "limit"), "limit");
    invalid(() => parseIntParam("0", "limit"), "limit");
    invalid(() => parseIntParam("201", "limit", { max: 200 }), "limit");
    invalid(() => parseIntParam("9007199254740992", "limit"), "limit");
  });

  test("an omitted optional integer is undefined; a bad one is still refused", () => {
    expect(parseOptionalIntParam(undefined, "limit")).toBeUndefined();
    expect(parseOptionalIntParam("", "limit")).toBeUndefined();
    expect(parseOptionalIntParam("50", "limit")).toBe(50);
    invalid(() => parseOptionalIntParam("x", "limit"), "limit");
  });
});

describe("enums", () => {
  const sorts = ["size", "-size"] as const;

  test("only the allowed values", () => {
    expect(parseEnumParam("-size", "sort", sorts)).toBe("-size");
    for (const raw of [undefined, "", "SIZE", "size "]) invalid(() => parseEnumParam(raw, "sort", sorts), "sort");
    expect(parseOptionalEnumParam(undefined, "sort", sorts)).toBeUndefined();
    invalid(() => parseOptionalEnumParam("date", "sort", sorts), "sort");
  });

  test("statement names and views from docs/API.md", () => {
    for (const name of ["balance_sheet", "income_statement", "comprehensive_income", "cash_flow", "equity_changes"]) {
      expect(parseStatementName(name)).toBe(name as never);
    }
    invalid(() => parseStatementName("notes"), "statement");
    expect(parseStatementView(undefined)).toBe("cumulative");
    expect(parseStatementView("three_month")).toBe("three_month");
    invalid(() => parseStatementView("yearly"), "view");
  });
});

describe("dates and quarters", () => {
  test("real calendar dates only", () => {
    expect(parseIsoDateParam("2026-06-30", "period_end")).toBe("2026-06-30");
    expect(parseIsoDateParam("2024-02-29", "period_end")).toBe("2024-02-29");
    for (const raw of [
      undefined,
      "",
      "2025-02-29",
      "2026-06-31",
      "2026-13-01",
      "2026-6-30",
      "30.06.2026",
      "2026-06-30T00:00:00Z",
    ]) {
      invalid(() => parseIsoDateParam(raw, "period_end"), "period_end");
    }
    expect(parseOptionalIsoDateParam(undefined, "period_end")).toBeUndefined();
    invalid(() => parseOptionalIsoDateParam("2026-02-30", "period_end"), "period_end");
  });

  test("quarters are YYYY-Q with Q from 1 to 4", () => {
    expect(parseQuarterParam("2026-2")).toEqual({ year: 2026, quarter: 2, value: "2026-2" });
    for (const raw of [undefined, "", "2026-0", "2026-5", "2026-Q2", "2026-02", "26-2", "2026/2"]) {
      invalid(() => parseQuarterParam(raw), "quarter");
    }
    invalid(() => parseQuarterParam("2026-5", "period"), "period");
    expect(parseOptionalQuarterParam(undefined)).toBeUndefined();
    invalid(() => parseOptionalQuarterParam("x", "period"), "period");
  });
});

describe("ids", () => {
  test("company codes are upper-cased; anything but letters, digits and '-' is refused", () => {
    expect(parseCompanyCode("katmr")).toBe("KATMR");
    expect(parseCompanyCode("A1CAP")).toBe("A1CAP");
    for (const raw of [undefined, "", "   ", "KAT MR", "KATMR/x", "../etc", "KATMR;"])
      invalid(() => parseCompanyCode(raw), "code");
  });

  test("document_id stays a string (docs/API.md)", () => {
    expect(parseDocumentId("1651411")).toBe("1651411" as never);
    for (const raw of [undefined, "", "abc", "-1", "1.5", "1651411x"])
      invalid(() => parseDocumentId(raw), "document_id");
  });

  test("row ids as the golden files write them", () => {
    for (const row of ["general_role_310003-row-3", "banks_role_210011-row-4", "holding_role_210015-row-12"]) {
      expect(parseRowId(row)).toBe(row);
    }
    for (const raw of [undefined, "", "row-3", "general_role_310003", "general_role_310003-row-x"])
      invalid(() => parseRowId(raw), "row");
  });

  test("version selectors", () => {
    expect(parseVersionSelector(undefined)).toBe("latest");
    expect(parseVersionSelector("first")).toBe("first");
    expect(parseVersionSelector("report:1651411")).toBe("report:1651411");
    for (const raw of ["newest", "report:", "report:abc", "report:-1"])
      invalid(() => parseVersionSelector(raw), "version");
  });

  test("finding ids name a known rule; the company code is upper-cased", () => {
    expect(parseFindingId("2026-2-KATMR-gross_margin_change")).toBe("2026-2-KATMR-gross_margin_change");
    expect(parseFindingId("2026-2-katmr-gross_margin_change")).toBe("2026-2-KATMR-gross_margin_change");
    for (const raw of [undefined, "", "2026-2-KATMR", "2026-5-KATMR-gross_margin_change", "2026-2-KATMR-buy_signal"]) {
      invalid(() => parseFindingId(raw), "id");
    }
  });
});

describe("through the API", () => {
  const routes: Routes = (v1) => {
    v1.get("/t/:code/:statement", (c) =>
      c.json({
        code: parseCompanyCode(c.req.param("code")),
        statement: parseStatementName(c.req.param("statement")),
        quarter: parseOptionalQuarterParam(c.req.query("quarter"))?.value ?? null,
        limit: parseOptionalIntParam(c.req.query("limit"), "limit", { max: 200 }) ?? 50,
      }),
    );
    v1.put("/t", async (c) => c.json(await parseJsonBody(c)));
  };
  const internal: unknown[] = [];
  const app = createApp({ routes: [routes], onInternalError: (e) => internal.push(e) });

  async function error(path: string, init?: RequestInit) {
    const r = await app.request(`/v1${path}`, init);
    expect(r.status).toBe(400);
    return ((await r.json()) as ErrorResponse).error;
  }

  test("valid input passes through", async () => {
    const r = await app.request("/v1/t/katmr/income_statement?quarter=2026-2&limit=10");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ code: "KATMR", statement: "income_statement", quarter: "2026-2", limit: 10 });
  });

  test("a bad path or query value is a 400 in the common error format", async () => {
    expect((await error("/t/KATMR/notes")).details.parameter).toBe("statement");
    expect((await error("/t/KAT%20MR/income_statement")).details.parameter).toBe("code");
    expect((await error("/t/KATMR/income_statement?quarter=2026-5")).details.parameter).toBe("quarter");
    const e = await error("/t/KATMR/income_statement?limit=500");
    expect(e.code).toBe("invalid_request");
    expect(e.details.parameter).toBe("limit");
    expect(e.message.length).toBeGreaterThan(0);
  });

  test("a body that is not a JSON object is a 400, not a 500", async () => {
    const put = (body: string) => ({ method: "PUT", body, headers: { "Content-Type": "application/json" } });
    for (const body of ["{", "", "[]", "null", "42", '"text"']) {
      expect((await error("/t", put(body))).details.parameter).toBe("body");
    }
    const ok = await app.request("/v1/t", put('{"quarters":["2026-2"]}'));
    expect(await ok.json()).toEqual({ quarters: ["2026-2"] });
  });

  test("nothing became an internal error", () => {
    expect(internal).toEqual([]);
  });
});
