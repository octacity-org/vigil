/**
 * `GET /v1/findings` (#223, #381), tested apart from its author (CONTRIBUTING rule 5). Runs on the API harness (#229).
 * The fixtures produce no findings, so the findings are written here as rows of the `findings` table (docs/SCHEMA.md),
 * with hand-picked sizes and summaries; expected values are written by hand from docs/API.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, ListResponse } from "@vigil/api-types";
import { createApp } from "../src/api/app.ts";
import { findingRoutes } from "../src/api/findings.ts";
import { rows } from "../src/db.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";
import { BANK, type FixtureFiling, GENERAL, HOLDING } from "./fixtures/index.ts";

// TSTGN's 2026/1 report, published after its 2026/2 one.
const GENERAL_Q1: FixtureFiling = { ...GENERAL, disclosureId: 9_000_020, quarter: 1, published: "01.10.2026 10:00:00" };
// A bank with three codes in its ticker group, published at the same time as TSTBN.
const ISBANK: FixtureFiling = { ...BANK, ticker: "TSTIS-TSTIA-TSTIB", disclosureId: 9_000_022 };

const CONFIG = "v-test";

interface Row {
  rule: Finding["rule"];
  code: string;
  filing: FixtureFiling;
  size: string;
  unit: "bps" | "TRY" | "count";
  rank: number;
  summary: Record<string, unknown>;
  config?: string;
}

const ROWS: Row[] = [
  // The docs/API.md example's margins: 47,5035% a year ago, 21,543% now.
  {
    rule: "gross_margin_change",
    code: "TSTGN",
    filing: GENERAL,
    size: "-2596",
    unit: "bps",
    rank: 2.6,
    summary: {
      current_q_standalone_margin: 0.21543,
      prior_year_q_standalone_restated_margin: 0.475035,
      delta_bps: -2596,
    },
  },
  // A negative margin a year ago.
  {
    rule: "gross_margin_change",
    code: "TSTHD",
    filing: HOLDING,
    size: "1353",
    unit: "bps",
    rank: 1.35,
    summary: { current_q_standalone_margin: 0.05, prior_year_q_standalone_restated_margin: -0.0853, delta_bps: 1353 },
  },
  {
    rule: "gross_margin_change",
    code: "TSTGN",
    filing: GENERAL_Q1,
    size: "-1200",
    unit: "bps",
    rank: 1.2,
    summary: { current_q_standalone_margin: 0.3, prior_year_q_standalone_restated_margin: 0.42, delta_bps: -1200 },
  },
  {
    rule: "profit_cash_divergence",
    code: "TSTBN",
    filing: BANK,
    size: "1234567890",
    unit: "TRY",
    rank: 1.23,
    summary: { profit_minus_ocf_gap_tl: "1234567890" },
  },
  {
    rule: "restated_comparatives",
    code: "TSTIS",
    filing: ISBANK,
    size: "12",
    unit: "count",
    rank: 12,
    summary: { restated_balance_sheet_line_count: 12 },
  },
  // Found under an older configuration: not listed.
  {
    rule: "gross_margin_change",
    code: "TSTBN",
    filing: BANK,
    size: "-3000",
    unit: "bps",
    rank: 3,
    summary: { current_q_standalone_margin: 0.1, prior_year_q_standalone_restated_margin: 0.4, delta_bps: -3000 },
    config: "v-old",
  },
];

const idOf = (r: Row) => `${r.filing.year}-${r.filing.quarter}-${r.code}-${r.rule}`;
const GN2 = "2026-2-TSTGN-gross_margin_change";
const GN1 = "2026-1-TSTGN-gross_margin_change";
const HD = "2026-2-TSTHD-gross_margin_change";
const BN = "2026-2-TSTBN-profit_cash_divergence";
const IS = "2026-2-TSTIS-restated_comparatives";

async function insert(api: ApiHarness, r: Row) {
  await rows(
    api.db,
    `INSERT INTO findings (id, rule, company_code, disclosure_id, year, quarter, title, size_value, size_unit,
       rank_score, summary, formula, config_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'f', $12, TIMESTAMP '2026-11-01 12:00:00')`,
    [
      idOf(r),
      r.rule,
      r.code,
      r.filing.disclosureId,
      r.filing.year,
      r.filing.quarter,
      `Başlık ${r.code}`,
      r.size,
      r.unit,
      r.rank,
      JSON.stringify(r.summary),
      r.config ?? CONFIG,
    ],
  );
}

type List = ListResponse<Finding>;

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({
    filings: [GENERAL, BANK, HOLDING, GENERAL_Q1, ISBANK],
    routes: (db) => [findingRoutes(db, { configVersion: CONFIG })],
  });
  // The harness computes findings from the fixtures; there should be none, so the list holds only the rows below.
  const [{ n }] = (await rows(api.db, "SELECT count(*) AS n FROM findings")) as [{ n: bigint }];
  expect(n).toBe(0n);
  for (const r of ROWS) await insert(api, r);
});
afterAll(() => api.close());

async function list(qs = ""): Promise<List> {
  const r = await api.get<List>(`/v1/findings${qs}`);
  expect(r.status).toBe(200);
  return r.body;
}
const ids = (l: List) => l.items.map((f) => f.id);
const byId = async (id: string) => (await list()).items.find((f) => f.id === id);

describe("the list", () => {
  test("only the configuration in force", async () => {
    const l = await list();
    expect(l.total).toBe(5);
    expect([...ids(l)].sort()).toEqual([GN1, BN, GN2, HD, IS].sort());
    expect(l.items.every((f) => f.config_version === CONFIG)).toBe(true);
  });

  test("a list item as docs/API.md writes it, without the steps", async () => {
    const f = (await byId(GN2)) as Finding & Record<string, unknown>;
    const { headline, ...rest } = f;
    expect(rest as unknown).toEqual({
      id: GN2,
      rule: "gross_margin_change",
      title: "Başlık TSTGN",
      company_code: "TSTGN",
      document_id: "9000001",
      year: 2026,
      quarter: 2,
      template: "general",
      size: { value: "-2596", unit: "bps", status: "ok" },
      config_version: CONFIG,
      created_at: "2026-11-01T12:00:00Z",
    });
    expect(typeof headline).toBe("string");
    expect(f.calculation).toBeUndefined();
  });

  test("template comes from the report; sizes keep their units", async () => {
    const l = await list();
    const of = (id: string) => l.items.find((f) => f.id === id);
    expect(of(BN)?.template).toBe("banks");
    expect(of(BN)?.size).toEqual({ value: "1234567890", unit: "TRY", status: "ok" });
    expect(of(IS)?.template).toBe("banks");
    expect(of(IS)?.size).toEqual({ value: "12", unit: "count", status: "ok" });
    expect(of(HD)?.template).toBe("holding");
  });

  test("by default the configuration file's version is listed", async () => {
    const version = (
      JSON.parse(readFileSync(join(import.meta.dir, "../../../config/vigil.json"), "utf8")) as {
        version: string;
      }
    ).version;
    // The harness app lists CONFIG; a route without the option reads config/vigil.json.
    const db = api.db;
    await insert(api, { ...(ROWS[0] as Row), config: version });
    const app = createApp({ routes: [findingRoutes(db)] });
    const body = (await (await app.request("/v1/findings")).json()) as List;
    expect(body.total).toBe(1);
    expect(body.items[0]?.config_version).toBe(version);
    await rows(db, "DELETE FROM findings WHERE config_version = $1", [version]);
  });
});

describe("filters", () => {
  test("rule", async () => {
    expect([...ids(await list("?rule=gross_margin_change"))].sort()).toEqual([GN1, GN2, HD].sort());
    expect(ids(await list("?rule=profit_cash_divergence"))).toEqual([BN]);
    expect(ids(await list("?rule=restated_comparatives"))).toEqual([IS]);
  });

  test("template", async () => {
    expect([...ids(await list("?template=banks"))].sort()).toEqual([BN, IS].sort());
    expect(ids(await list("?template=holding"))).toEqual([HD]);
    expect((await list("?template=insurance")).total).toBe(0);
  });

  test("quarter", async () => {
    expect(ids(await list("?quarter=2026-1"))).toEqual([GN1]);
    expect((await list("?quarter=2026-2")).total).toBe(4);
    expect((await list("?quarter=2025-4")).total).toBe(0);
  });

  test("company: any code of the ticker group, without case", async () => {
    for (const code of ["TSTIS", "tstia", "TSTIB"]) expect(ids(await list(`?company=${code}`))).toEqual([IS]);
    expect([...ids(await list("?company=tstgn"))].sort()).toEqual([GN1, GN2].sort());
    // A code is matched whole, not as part of another.
    expect((await list("?company=TSTI")).total).toBe(0);
    expect((await list("?company=TSTGN-TSTHD")).total).toBe(0);
  });

  test("filters combine with AND; total counts the filtered list", async () => {
    const l = await list("?rule=gross_margin_change&quarter=2026-2&company=TSTGN");
    expect(ids(l)).toEqual([GN2]);
    expect(l.total).toBe(1);
    expect((await list("?rule=profit_cash_divergence&template=holding")).total).toBe(0);
  });

  test("an empty filter is no filter", async () => {
    expect((await list("?rule=&template=&quarter=&company=")).total).toBe(5);
  });

  test("bad values are a 400 naming the parameter", async () => {
    for (const [qs, parameter] of [
      ["rule=buy_signal", "rule"],
      ["rule=GROSS_MARGIN_DEVIATION", "rule"],
      ["template=bank", "template"],
      ["quarter=2026-5", "quarter"],
      ["quarter=2026-Q2", "quarter"],
      ["company=KAT%20MR", "company"],
      ["company=TSTGN%3B", "company"],
      ["sort=title", "sort"],
      ["limit=0", "limit"],
      ["cursor=abc", "cursor"],
    ] as const) {
      const e = await api.getError(`/v1/findings?${qs}`, 400);
      expect(`${qs}: ${e.code} ${e.details.parameter}`).toBe(`${qs}: invalid_request ${parameter}`);
    }
  });
});

describe("sorting and paging", () => {
  test("default -size: the largest first within a rule", async () => {
    expect(ids(await list("?rule=gross_margin_change"))).toEqual([GN2, HD, GN1]);
    expect(ids(await list("?rule=gross_margin_change&sort=size"))).toEqual([GN1, HD, GN2]);
  });

  test("date is the report's publication time; equal times by id", async () => {
    // TSTGN 2026/2 17.08, TSTBN and TSTIS 18.08, TSTHD 19.08, TSTGN 2026/1 01.10.
    expect(ids(await list("?sort=date"))).toEqual([GN2, BN, IS, HD, GN1]);
    expect(ids(await list("?sort=-date"))).toEqual([GN1, HD, BN, IS, GN2]);
  });

  test("pages of two return every finding once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const l = await list(`?sort=date&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(l.total).toBe(5);
      seen.push(...ids(l));
      cursor = l.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([GN2, BN, IS, HD, GN1]);
  });

  test("no findings is an empty list", async () => {
    expect(await list("?quarter=2020-1")).toEqual({ items: [], next_cursor: null, total: 0 });
  });
});

describe("headline", () => {
  const headlineOf = async (id: string) => (await byId(id))?.headline ?? "";

  test("S1 is the docs/API.md example sentence", async () => {
    expect(await headlineOf(GN2)).toBe(
      "3 aylık brüt marj bir yıl önceki %47,50 seviyesinden %21,54 seviyesine geriledi.",
    );
  });

  test("a negative margin keeps its sign before %", async () => {
    const h = await headlineOf(HD);
    expect(h).toContain("-%8,53");
    expect(h).toContain("%5,00");
    expect(h).toContain("yükseldi");
  });

  test("S2 gives the gap in TL with Turkish digit grouping", async () => {
    expect(await headlineOf(BN)).toContain("1.234.567.890 TL");
  });

  test("S3 gives the number of restated lines", async () => {
    expect(await headlineOf(IS)).toContain("12");
  });

  test("a headline only states the change; it never says what to do (docs/legal.md)", async () => {
    for (const f of (await list()).items) {
      expect(f.headline).not.toMatch(/\b(al|sat|tut)\b|öneri|tavsiye|fırsat|almalı|satmalı/i);
    }
  });

  test("no request became an internal error", () => {
    expect(api.internalErrors).toEqual([]);
  });
});
