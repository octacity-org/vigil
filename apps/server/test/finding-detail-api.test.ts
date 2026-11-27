/**
 * `GET /v1/findings/{id}` (#224, #390), tested apart from its author (CONTRIBUTING rule 5). The expected response is
 * the worked example in docs/API.md ("Example: KATMR 2026/2"), read from the document itself; its inputs are the
 * hand-checked golden file `tests/golden/2026_2/KATMR_1651411.csv` (#20).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorResponse, FindingDetail } from "@vigil/api-types";
import { detectGrossMarginDeviation, type SignalObject } from "@vigil/core";
import { CONFIG, katmrFromGolden } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/api/app.ts";
import { findingRoutes } from "../src/api/findings.ts";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { writeFindings } from "../src/findings-store.ts";
import { prepareFindingsConfig } from "../src/report-findings.ts";

const ID = "2026-2-KATMR-gross_margin_change";
const NOW = new Date("2026-11-01T12:00:00Z");

/** The JSON block under "## Example: KATMR 2026/2" in docs/API.md. */
function documentedExample(): Record<string, unknown> {
  const doc = readFileSync(join(import.meta.dir, "../../../docs/API.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Example: KATMR 2026/2"));
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(section);
  if (block === null) throw new Error("no JSON example under 'Example: KATMR 2026/2' in docs/API.md");
  return JSON.parse(block[1] as string) as Record<string, unknown>;
}

let db: Database;
let app: ReturnType<typeof createApp>;
const internal: unknown[] = [];

beforeAll(async () => {
  db = await connect(":memory:");
  await prepareFindingsConfig(db, { config: CONFIG, now: NOW });
  const katmr = katmrFromGolden();
  await loadFiling(db, katmr);
  const s1 = detectGrossMarginDeviation(katmr, CONFIG) as SignalObject;
  await writeFindings(db, [katmr.disclosure_id], [s1], { configVersion: CONFIG.version, now: NOW });
  app = createApp({
    routes: [findingRoutes(db, { configVersion: CONFIG.version })],
    onInternalError: (e) => internal.push(e),
  });
});
afterAll(() => close(db));

async function call(path: string) {
  const r = await app.request(`/v1${path}`);
  return { status: r.status, body: (await r.json()) as FindingDetail & ErrorResponse };
}

describe("KATMR 2026/2 S1, the docs/API.md example", () => {
  test("the config version is the example's", () => {
    expect(CONFIG.version).toBe("2026-11-01");
  });

  test("every field in the example but the title, with the same values", async () => {
    const r = await call(`/findings/${ID}`);
    expect(r.status).toBe(200);
    const { title: _title, ...example } = documentedExample();
    expect(r.body).toMatchObject(example);
  });

  // Fails until #392: the API returns the rule's internal title. Remove `.failing` with the fix.
  test.failing("the title is the example's (#392)", async () => {
    expect((await call(`/findings/${ID}`)).body.title).toBe(documentedExample().title as string);
  });

  test("the four inputs carry their full source: golden row, column and shown value", async () => {
    const { body } = await call(`/findings/${ID}`);
    // Every input read from the filing is an "ok" value with a source; a value without one fails here.
    const inputs = body.calculation.steps.flatMap((s) =>
      "value" in s && s.value.status === "ok" && s.value.source !== undefined
        ? [{ id: s.id, source: s.value.source }]
        : [],
    );
    expect(inputs.map((s) => [s.id, s.source.row, s.source.column, s.source.shown_value])).toEqual([
      ["gross_profit_q", "general_role_310003-row-5", "col-order-class-6", "189.492.068"],
      ["revenue_q", "general_role_310003-row-3", "col-order-class-6", "879.599.263"],
      ["gross_profit_q_prior", "general_role_310003-row-5", "col-order-class-7", "330.145.727"],
      ["revenue_q_prior", "general_role_310003-row-3", "col-order-class-7", "694.991.758"],
    ]);
    for (const s of inputs) {
      expect(s.source.report).toEqual({ year: 2026, quarter: 2, consolidation: "consolidated" });
      expect(s.source.url).toBe("https://www.kap.org.tr/tr/Bildirim/1651411");
    }
  });

  test("thresholds are those of the finding's config version, not the file on disk", async () => {
    const changed = { ...CONFIG, version: "2026-12-01" } as typeof CONFIG;
    changed.s1_gross_margin = { ...CONFIG.s1_gross_margin, x_min_abs_delta_bps: 1500 };
    await prepareFindingsConfig(db, { config: changed, now: NOW });
    const s1 = detectGrossMarginDeviation(katmrFromGolden(), changed) as SignalObject;
    await writeFindings(db, [1651411], [s1], { configVersion: changed.version, now: NOW });
    const later = createApp({ routes: [findingRoutes(db, { configVersion: changed.version })] });
    const body = (await (await later.request(`/v1/findings/${ID}`)).json()) as FindingDetail;
    expect(body.config_version).toBe("2026-12-01");
    expect(body.thresholds).toEqual({ min_revenue_try: "100000000", min_abs_change_bps: 1500 });
    // The route for the first version still answers with its own thresholds.
    expect((await call(`/findings/${ID}`)).body.thresholds).toEqual({
      min_revenue_try: "100000000",
      min_abs_change_bps: 1000,
    });
    await rows(db, "DELETE FROM findings WHERE config_version = '2026-12-01'");
  });
});

describe("ids", () => {
  test("the company code in an id is matched without case", async () => {
    expect((await call("/findings/2026-2-katmr-gross_margin_change")).body.id).toBe(ID);
  });

  test("a malformed id is a 400", async () => {
    for (const id of ["2026-2-KATMR", "2026-5-KATMR-gross_margin_change", "2026-2-KATMR-buy_signal", "x"]) {
      const r = await call(`/findings/${id}`);
      expect(`${id}: ${r.status} ${r.body.error?.code} ${r.body.error?.details.parameter}`).toBe(
        `${id}: 400 invalid_request id`,
      );
    }
  });

  test("an id with no finding is a 404", async () => {
    for (const id of [
      "2026-2-KATMR-profit_cash_divergence",
      "2026-1-KATMR-gross_margin_change",
      "2026-2-SANFM-gross_margin_change",
    ]) {
      const r = await call(`/findings/${id}`);
      expect(`${id}: ${r.status} ${r.body.error?.code}`).toBe(`${id}: 404 not_found`);
    }
  });

  test("a finding under another config version is not found", async () => {
    const other = createApp({ routes: [findingRoutes(db, { configVersion: "2025-01-01" })] });
    expect((await other.request(`/v1/findings/${ID}`)).status).toBe(404);
  });

  test("no request became an internal error", () => {
    expect(internal).toEqual([]);
  });
});
