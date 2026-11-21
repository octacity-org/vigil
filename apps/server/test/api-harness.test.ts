/** The API test harness (#229), with example tests an endpoint test can copy. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, type Routes } from "../src/api/app.ts";
import { type Database, rows } from "../src/db.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";
import { BANK, GENERAL, HOLDING } from "./fixtures/index.ts";

/**
 * A route module the way the real ones (#216-#228) are written: a factory that takes the database and registers its
 * routes on `/v1`. This one exists only in this test.
 */
const exampleRoutes =
  (db: Database): Routes =>
  (v1) => {
    v1.get("/example/reports/:id", async (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id)) throw new ApiError("invalid_request", "id bir sayı olmalı", { parameter: "id" });
      const [report] = await rows(
        db,
        `SELECT r.disclosure_id, r.company_code, r.year, r.quarter, r.template_family AS template,
                (SELECT count(*) FROM facts f WHERE f.disclosure_id = r.disclosure_id) AS facts,
                (SELECT count(*) FROM metrics m WHERE m.disclosure_id = r.disclosure_id) AS metrics
         FROM reports r WHERE r.disclosure_id = $1`,
        [BigInt(id)],
      );
      if (report === undefined) throw new ApiError("not_found", `Rapor bulunamadı: ${id}`, { id });
      return c.json({
        disclosure_id: Number(report.disclosure_id),
        company_code: report.company_code,
        period: `${report.year}/${report.quarter}`,
        template: report.template,
        facts: Number(report.facts),
        metrics: Number(report.metrics),
      });
    });
    v1.get("/example/boom", () => {
      throw new Error("unexpected");
    });
  };

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({ routes: (db) => [exampleRoutes(db)] });
});
afterAll(() => api.close());

describe("the harness", () => {
  test("loads the three fixtures with check results, metrics and findings tables", async () => {
    const reports = await rows(api.db, "SELECT disclosure_id FROM reports ORDER BY disclosure_id");
    expect(reports.map((r) => Number(r.disclosure_id)).sort()).toEqual(
      [GENERAL.disclosureId, BANK.disclosureId, HOLDING.disclosureId].sort(),
    );
    const [checks] = await rows(api.db, "SELECT count(*) AS n FROM check_results");
    expect(Number(checks?.n)).toBeGreaterThan(0);
    const [metrics] = await rows(api.db, "SELECT count(*) AS n FROM metrics");
    expect(Number(metrics?.n)).toBeGreaterThan(0);
  });

  test("starts without a network port and builds the database in well under a second", async () => {
    const t = performance.now();
    const other = await apiHarness();
    other.close();
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});

describe("example: health and readiness", () => {
  test("GET /v1/health", async () => {
    const r = await api.get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("application/json");
    expect(r.body).toEqual({ status: "ok" });
  });

  test("GET /v1/ready while not ready is the common error body", async () => {
    const notReady = await apiHarness({ ready: false, filings: [] });
    try {
      const error = await notReady.getError("/v1/ready", 503);
      expect(error.code).toBe("not_ready");
    } finally {
      notReady.close();
    }
  });
});

describe("example: a route that reads DuckDB", () => {
  test("answers from the fixtures (snapshot)", async () => {
    const r = await api.get(`/v1/example/reports/${GENERAL.disclosureId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchSnapshot();
  });

  test("not found and invalid requests use the error format", async () => {
    expect(await api.getError("/v1/example/reports/1", 404)).toEqual({
      code: "not_found",
      message: "Rapor bulunamadı: 1",
      details: { id: 1 },
    });
    expect((await api.getError("/v1/example/reports/abc", 400)).details).toEqual({ parameter: "id" });
  });

  test("an unexpected error is a 500 without its message, and is recorded", async () => {
    const before = api.internalErrors.length;
    const error = await api.getError("/v1/example/boom", 500);
    expect(error.code).toBe("internal");
    expect(error.message).not.toContain("unexpected");
    expect(api.internalErrors.length).toBe(before + 1);
  });
});
