/**
 * `GET /v1/companies` (#217, #376), tested apart from its author (CONTRIBUTING rule 5). Runs on the API harness (#229)
 * with the synthetic fixtures (#194). Expected values are written by hand from docs/API.md and docs/SCHEMA.md; a
 * report's quality is compared with `filingQuality`, the quality report's own reference.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Company, ListResponse } from "@vigil/api-types";
import { filingQuality } from "@vigil/core";
import { companyRoutes } from "../src/api/companies.ts";
import { updateCompanies } from "../src/companies.ts";
import { rows } from "../src/db.ts";
import type { Disclosure } from "../src/disclosures.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";
import { BANK, type FixtureFiling, GENERAL, HOLDING, parseFixture } from "./fixtures/index.ts";

// TSTGN also has an earlier quarter, filed late: the latest report is still 2026/2 (report period first).
const GENERAL_Q1_LATE: FixtureFiling = {
  ...GENERAL,
  disclosureId: 9_000_020,
  quarter: 1,
  published: "01.10.2026 10:00:00",
};
// TSTHD corrected its 2026/2 report: same period, published later.
const HOLDING_CORRECTION: FixtureFiling = { ...HOLDING, disclosureId: 9_000_021, published: "25.08.2026 09:30:00" };
// A bank with three codes in its ticker group.
const ISBANK: FixtureFiling = { ...BANK, ticker: "TSTIS-TSTIA-TSTIB", disclosureId: 9_000_022 };
// A file the parser found no values in.
const EMPTY: FixtureFiling = {
  ...GENERAL,
  ticker: "TSTEM",
  disclosureId: 9_000_023,
  tables: GENERAL.tables.slice(0, 1).map((t) => ({ ...t, rows: t.rows.map((r) => ({ ...r, values: {} })) })),
};

const FILINGS = [GENERAL, BANK, HOLDING, GENERAL_Q1_LATE, HOLDING_CORRECTION, ISBANK, EMPTY];

const disclosure = (f: FixtureFiling, title: string, codes: string[]): Disclosure => ({
  disclosure_id: f.disclosureId,
  disclosure_oid: `oid-${f.disclosureId}`,
  published_at: "2026-08-17T19:05:18",
  stock_codes: codes,
  mkk_member_oid: `${f.disclosureId}`.padStart(32, "0"),
  company_title: title,
  title: "Finansal Rapor",
  disclosure_class: "FR",
  year: f.year,
  quarter: f.quarter,
  is_changed: null,
  related_disclosure_oid: null,
  is_late: false,
});

type List = ListResponse<Company>;

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({ filings: FILINGS, routes: (db) => [companyRoutes(db)] });
});
afterAll(() => api.close());

async function list(qs = ""): Promise<List> {
  const r = await api.get<List>(`/v1/companies${qs}`);
  expect(r.status).toBe(200);
  return r.body;
}

const codesOf = (l: List) => l.items.map((c) => c.code);

describe("before the company list is loaded", () => {
  test("every company with a report, sorted by code, metadata null", async () => {
    const l = await list();
    expect(l.total).toBe(5);
    expect(codesOf(l)).toEqual(["TSTBN", "TSTEM", "TSTGN", "TSTHD", "TSTIS"]);
    for (const c of l.items) {
      expect(c.title).toBeNull();
      expect(c.sector).toBeNull();
      expect(c.member_id).toBeNull();
    }
  });

  test("q matches the code only, without case", async () => {
    expect(codesOf(await list("?q=tstgn"))).toEqual(["TSTGN"]);
    expect(codesOf(await list("?q=TSTI"))).toEqual(["TSTIS"]);
    expect((await list("?q=banka")).total).toBe(0);
  });
});

describe("each item", () => {
  test("codes come from the ticker group, code is the first", async () => {
    const [is] = (await list("?q=tstis")).items;
    expect(is?.code).toBe("TSTIS");
    expect(is?.codes).toEqual(["TSTIS", "TSTIA", "TSTIB"]);
    expect(is?.template).toBe("banks");
  });

  test("latest_report: report period first, then publication time", async () => {
    const byCode = Object.fromEntries((await list()).items.map((c) => [c.code, c.latest_report]));
    // 2026/2 beats the 2026/1 report published later.
    expect(byCode.TSTGN).toMatchObject({ document_id: "9000001", year: 2026, quarter: 2 });
    // The correction, published later for the same period, is the latest.
    expect(byCode.TSTHD).toMatchObject({ document_id: "9000021", year: 2026, quarter: 2 });
  });

  test("latest_report.quality is what the quality report gives the file", async () => {
    const byCode = Object.fromEntries((await list()).items.map((c) => [c.code, c.latest_report?.quality]));
    for (const [code, f] of [
      ["TSTGN", GENERAL],
      ["TSTBN", BANK],
      ["TSTHD", HOLDING_CORRECTION],
      ["TSTIS", ISBANK],
      ["TSTEM", EMPTY],
    ] as const) {
      expect(`${code}: ${byCode[code]}`).toBe(`${code}: ${filingQuality(parseFixture(f)).status}`);
    }
    expect(byCode.TSTEM).toBe("no_values");
  });
});

describe("Turkish search, after the company list is loaded", () => {
  beforeAll(async () => {
    await updateCompanies(
      api.db,
      [
        disclosure(ISBANK, "TÜRKİYE İŞ BANKASI A.Ş.", ["TSTIS", "TSTIA", "TSTIB"]),
        disclosure(GENERAL, "IŞIKLAR ENERJİ VE YAPI HOLDİNG A.Ş.", ["TSTGN"]),
        // TSTGN's metadata is read from its latest published report, the late 2026/1 one (#189).
        disclosure(GENERAL_Q1_LATE, "IŞIKLAR ENERJİ VE YAPI HOLDİNG A.Ş.", ["TSTGN"]),
        disclosure(HOLDING_CORRECTION, "ÇELİK HOLDİNG A.Ş.", ["TSTHD"]),
      ],
      null,
    );
  });

  test("işbank, ISBANK, İş Bank and is bankasi find TÜRKİYE İŞ BANKASI A.Ş.", async () => {
    for (const q of ["işbank", "ISBANK", "İş Bank", "is bankasi", "İŞ BANKASI", "türkiye iş"]) {
      const l = await list(`?q=${encodeURIComponent(q)}`);
      expect(`${q}: ${codesOf(l).join(",")}`).toBe(`${q}: TSTIS`);
    }
    const [is] = (await list("?q=isbank")).items;
    expect(is?.title).toBe("TÜRKİYE İŞ BANKASI A.Ş.");
    expect(is?.member_id).toBe("9000022".padStart(32, "0"));
  });

  test("dotless ı and Ç fold too", async () => {
    expect(codesOf(await list(`?q=${encodeURIComponent("ışıklar")}`))).toEqual(["TSTGN"]);
    expect(codesOf(await list("?q=isiklar"))).toEqual(["TSTGN"]);
    expect(codesOf(await list(`?q=${encodeURIComponent("çelik")}`))).toEqual(["TSTHD"]);
    expect(codesOf(await list("?q=celik"))).toEqual(["TSTHD"]);
  });

  test("any code of the group matches", async () => {
    expect(codesOf(await list("?q=tstib"))).toEqual(["TSTIS"]);
  });

  test("a query that matches nothing is an empty list", async () => {
    expect(await list("?q=zzz")).toEqual({ items: [], next_cursor: null, total: 0 });
  });

  test("a query with SQL in it is only text", async () => {
    expect((await list(`?q=${encodeURIComponent("' OR 1=1 --")}`)).total).toBe(0);
    expect((await list()).total).toBe(5);
  });

  test("companies without a title come last in both directions", async () => {
    expect(codesOf(await list("?sort=title")).slice(3)).toEqual(["TSTBN", "TSTEM"]);
    expect(codesOf(await list("?sort=-title")).slice(3)).toEqual(["TSTBN", "TSTEM"]);
  });

  // Fails until #378: titles are ordered by their bytes, so ÇELİK comes after TÜRKİYE. Remove `.failing` with the fix.
  test.failing("sort by title in Turkish order (#378)", async () => {
    expect(codesOf(await list("?sort=title"))).toEqual(["TSTHD", "TSTGN", "TSTIS", "TSTBN", "TSTEM"]);
    expect(codesOf(await list("?sort=-title"))).toEqual(["TSTIS", "TSTGN", "TSTHD", "TSTBN", "TSTEM"]);
  });
});

describe("paging and sorting", () => {
  test("pages of two return every company once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const l = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(l.total).toBe(5);
      seen.push(...codesOf(l));
      cursor = l.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(["TSTBN", "TSTEM", "TSTGN", "TSTHD", "TSTIS"]);
  });

  test("sort=-code reverses", async () => {
    expect(codesOf(await list("?sort=-code"))).toEqual(["TSTIS", "TSTHD", "TSTGN", "TSTEM", "TSTBN"]);
  });

  test("a field the list does not have, a bad limit or cursor is a 400", async () => {
    expect((await api.getError("/v1/companies?sort=size", 400)).details.parameter).toBe("sort");
    expect((await api.getError("/v1/companies?limit=0", 400)).details.parameter).toBe("limit");
    expect((await api.getError("/v1/companies?cursor=abc", 400)).details.parameter).toBe("cursor");
  });
});

describe("quality of the latest report from the stored check results", () => {
  const quality = async (code: string) => (await list(`?q=${code.toLowerCase()}`)).items[0]?.latest_report?.quality;
  const blockingFailures = async (id: number) =>
    rows(
      api.db,
      "SELECT count(*) AS n FROM check_results WHERE disclosure_id = $1 AND severity = 'blocking' AND status = 'fail'",
      [id],
    );

  test("a blocking failure confirmed as a filing error is known_error; with none left it is pass", async () => {
    const [{ n }] = (await blockingFailures(GENERAL.disclosureId)) as [{ n: bigint }];
    expect(n).toBeGreaterThan(0n);
    expect(await quality("TSTGN")).toBe("fail");

    await rows(
      api.db,
      "UPDATE check_results SET known_error = 'test' WHERE disclosure_id = $1 AND severity = 'blocking' AND status = 'fail'",
      [GENERAL.disclosureId],
    );
    expect(await quality("TSTGN")).toBe("known_error");

    await rows(
      api.db,
      "UPDATE check_results SET status = 'pass', known_error = NULL WHERE disclosure_id = $1 AND severity = 'blocking' AND status = 'fail'",
      [GENERAL.disclosureId],
    );
    expect(await quality("TSTGN")).toBe("pass");
  });

  test("informational differences do not change it", async () => {
    await rows(
      api.db,
      "UPDATE check_results SET status = 'fail' WHERE disclosure_id = $1 AND severity = 'informational'",
      [GENERAL.disclosureId],
    );
    expect(await quality("TSTGN")).toBe("pass");
  });

  test("no request became an internal error", () => {
    expect(api.internalErrors).toEqual([]);
  });
});
