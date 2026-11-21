/**
 * API test harness (#229): the Hono app on the fixture filings (#194) and an in-memory DuckDB, without a network
 * port and without raw KAP files. Endpoint tests (#216-#228) start one per file:
 *
 *   const api = await apiHarness({ routes: (db) => [companyRoutes(db)] });
 *   afterAll(() => api.close());
 *   const r = await api.get("/v1/companies/KATMR");
 *   expect(r.status).toBe(200);
 *   expect(r.body).toMatchSnapshot();
 *
 * The database is built as the server process builds it: each fixture is parsed, checked and loaded with its check
 * results, then the CPI series, the metrics and the findings are added (the same steps as `rebuildDatabase`).
 */
import type { ErrorResponse } from "@vigil/api-types";
import { checkFiling } from "@vigil/core";
import type { Hono } from "hono";
import { createApp, type Routes } from "../src/api/app.ts";
import { CPI_FILE, loadCpiSeries, readCpiFile } from "../src/cpi.ts";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { computeAndStoreFindings, prepareFindingsConfig } from "../src/report-findings.ts";
import { computeAndStore } from "../src/report-metrics.ts";
import { FIXTURES, type FixtureFiling, parseFixture } from "./fixtures/index.ts";

export interface HarnessOptions {
  /** The filings to load; the three fixtures (general, bank, holding) by default. */
  filings?: readonly FixtureFiling[];
  /** The route modules under test, given the database. */
  routes?: (db: Database) => Routes[];
  /** What `/v1/ready` answers; ready by default. */
  ready?: boolean;
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface ApiHarness {
  app: Hono;
  db: Database;
  /** Errors that became `internal` (500); a test can assert there were none. */
  internalErrors: unknown[];
  /** Send a request to the app in process. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** GET a path and parse its JSON body. */
  get<T = unknown>(path: string): Promise<JsonResponse<T>>;
  /** GET a path that must fail with `status`; returns the error object of the common error body. */
  getError(path: string, status: number): Promise<ErrorResponse["error"]>;
  close(): void;
}

/** Load the filings into an in-memory DuckDB with check results, CPI, metrics and findings. */
export async function harnessDatabase(filings: readonly FixtureFiling[] = FIXTURES): Promise<Database> {
  const db = await connect(":memory:");
  try {
    const config = await prepareFindingsConfig(db, { now: new Date("2026-11-01T00:00:00Z") });
    const cpi = readCpiFile(CPI_FILE);
    await loadCpiSeries(db, cpi);
    for (const f of filings) {
      const filing = parseFixture(f);
      await loadFiling(db, filing, { checks: checkFiling(filing) });
    }
    for (const r of await rows(db, "SELECT disclosure_id FROM reports ORDER BY disclosure_id")) {
      const id = Number(r.disclosure_id);
      await computeAndStore(db, id, { cpi, computedAt: new Date("2026-11-01T00:00:00Z") });
      await computeAndStoreFindings(db, id, { config, storeConfig: false, now: new Date("2026-11-01T00:00:00Z") });
    }
    return db;
  } catch (e) {
    close(db);
    throw e;
  }
}

export async function apiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const db = await harnessDatabase(options.filings);
  const internalErrors: unknown[] = [];
  const app = createApp({
    routes: options.routes?.(db) ?? [],
    isReady: () => options.ready ?? true,
    onInternalError: (e) => internalErrors.push(e),
  });
  const request = async (path: string, init?: RequestInit) => app.fetch(new Request(`http://127.0.0.1${path}`, init));
  const get = async <T>(path: string): Promise<JsonResponse<T>> => {
    const r = await request(path);
    const text = await r.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      throw new Error(`GET ${path} answered ${r.status} with a body that is not JSON: ${text.slice(0, 200)}`);
    }
    return { status: r.status, headers: r.headers, body };
  };
  return {
    app,
    db,
    internalErrors,
    request,
    get,
    getError: async (path, status) => {
      const r = await get<ErrorResponse>(path);
      if (r.status !== status) {
        throw new Error(`GET ${path}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
      }
      return r.body.error;
    },
    close: () => close(db),
  };
}
