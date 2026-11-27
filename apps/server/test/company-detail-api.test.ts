/**
 * `GET /v1/companies/{code}` (#218, #395), tested apart from its author (CONTRIBUTING rule 5). Expected values are
 * written by hand from docs/API.md ("Company"): any code of the company resolves to it, `codes` is the latest ticker
 * group, `reports` lists every report newest first (report period, then publication time); times are UTC.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CompanyDetail, ErrorResponse } from "@vigil/api-types";
import { filingQuality } from "@vigil/core";
import { companyRoutes } from "../src/api/companies.ts";
import { updateCompanies } from "../src/companies.ts";
import type { Disclosure } from "../src/disclosures.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";
import { BANK, type FixtureFiling, GENERAL, HOLDING, parseFixture } from "./fixtures/index.ts";

// TSTGN's 2026/1 report, published after its 2026/2 one.
const GENERAL_Q1_LATE: FixtureFiling = {
  ...GENERAL,
  disclosureId: 9_000_020,
  quarter: 1,
  published: "01.10.2026 10:00:00",
};
// TSTHD corrected its 2026/2 report: same period, published later.
const HOLDING_CORRECTION: FixtureFiling = { ...HOLDING, disclosureId: 9_000_021, published: "25.08.2026 09:30:00" };
// TSTHD's 2026/1 report, filed under a ticker group it no longer uses.
const HOLDING_OLD: FixtureFiling = {
  ...HOLDING,
  ticker: "TSTHD-TSTHX",
  disclosureId: 9_000_024,
  quarter: 1,
  published: "20.05.2026 18:00:00",
};
// A bank with three codes in its ticker group.
const ISBANK: FixtureFiling = { ...BANK, ticker: "TSTIS-TSTIA-TSTIB", disclosureId: 9_000_022 };

const FILINGS = [GENERAL, GENERAL_Q1_LATE, HOLDING, HOLDING_CORRECTION, HOLDING_OLD, ISBANK];

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

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({ filings: FILINGS, routes: (db) => [companyRoutes(db)] });
});
afterAll(() => api.close());

async function company(code: string): Promise<CompanyDetail> {
  const r = await api.get<CompanyDetail>(`/v1/companies/${encodeURIComponent(code)}`);
  expect(r.status).toBe(200);
  return r.body;
}

const quality = (f: FixtureFiling) => filingQuality(parseFixture(f)).status;

describe("reports", () => {
  test("TSTGN: 2026/2 before the 2026/1 report published later; times in UTC", async () => {
    const c = await company("TSTGN");
    expect(c.code).toBe("TSTGN");
    expect(c.reports).toEqual([
      {
        document_id: "9000001",
        year: 2026,
        quarter: 2,
        consolidation: "consolidated",
        // 17.08.2026 19:05:18 Istanbul (UTC+3), the docs/API.md example time.
        published_at: "2026-08-17T16:05:18Z",
        quality: quality(GENERAL),
        corrects: null,
      },
      {
        document_id: "9000020",
        year: 2026,
        quarter: 1,
        consolidation: "consolidated",
        published_at: "2026-10-01T07:00:00Z",
        quality: quality(GENERAL_Q1_LATE),
        corrects: null,
      },
    ]);
  });

  test("TSTHD: the correction before the report it corrects, then the earlier period", async () => {
    const c = await company("TSTHD");
    expect(c.reports.map((r) => [r.document_id, r.year, r.quarter, r.published_at])).toEqual([
      ["9000021", 2026, 2, "2026-08-25T06:30:00Z"],
      ["9000003", 2026, 2, "2026-08-19T06:30:00Z"],
      ["9000024", 2026, 1, "2026-05-20T15:00:00Z"],
    ]);
    expect(c.latest_report?.document_id).toBe("9000021");
  });

  test("a solo filing is solo", async () => {
    expect((await company("TSTIS")).reports.map((r) => r.consolidation)).toEqual(["solo"]);
  });

  test("the list item's fields are the same as in GET /v1/companies", async () => {
    const detail = await company("TSTGN");
    const list = await api.get<{ items: Omit<CompanyDetail, "reports">[] }>("/v1/companies?q=tstgn");
    const { reports: _reports, ...item } = detail;
    expect(item).toEqual(list.body.items[0] as typeof item);
  });
});

describe("any code of the company resolves to it", () => {
  test("every code of the ticker group, without case", async () => {
    for (const code of ["TSTIS", "tstia", "TstIb"]) {
      const c = await company(code);
      expect(`${code}: ${c.code} ${c.codes.join(",")}`).toBe(`${code}: TSTIS TSTIS,TSTIA,TSTIB`);
    }
  });

  test("a code from an earlier report's ticker group; codes stay the latest group", async () => {
    const c = await company("TSTHX");
    expect(c.code).toBe("TSTHD");
    expect(c.codes).toEqual(["TSTHD"]);
  });

  test("a code from the company list; codes still come from the ticker group (docs/API.md)", async () => {
    // TSTGN's metadata is read from its latest published report, the late 2026/1 one (#189).
    await updateCompanies(
      api.db,
      [
        disclosure(GENERAL, "IŞIKLAR HOLDİNG A.Ş.", ["TSTGN", "TSTGY"]),
        disclosure(GENERAL_Q1_LATE, "IŞIKLAR HOLDİNG A.Ş.", ["TSTGN", "TSTGY"]),
      ],
      null,
    );
    const c = await company("TSTGY");
    expect(c.code).toBe("TSTGN");
    expect(c.codes).toEqual(["TSTGN"]);
  });
});

describe("errors", () => {
  test("a malformed code is a 400 naming code", async () => {
    for (const code of ["KAT MR", "KATMR;", "a/b"]) {
      const e = await api.getError(`/v1/companies/${encodeURIComponent(code)}`, 400);
      expect(`${code}: ${e.code} ${e.details.parameter}`).toBe(`${code}: invalid_request code`);
    }
  });

  test("a company without a loaded report is a 404", async () => {
    for (const code of ["NOPE", "TSTI", "TST"]) {
      const r = await api.get<ErrorResponse>(`/v1/companies/${code}`);
      expect(`${code}: ${r.status} ${r.body.error.code}`).toBe(`${code}: 404 not_found`);
    }
  });

  test("no request became an internal error", () => {
    expect(api.internalErrors).toEqual([]);
  });
});
