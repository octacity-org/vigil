/**
 * Company metadata (#189). Reports are the synthetic fixtures; disclosures and sectors are built here in the shape of
 * `disclosures.ts` and `sectors.ts`. Expected behaviour: the issue's columns, matching by disclosure id and member id
 * (decision 0017: never by ticker), and Turkish-aware search.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { companyRows, latestReports, publicationRange, turkishSearchKey, updateCompanies } from "../src/companies.ts";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import type { Disclosure } from "../src/disclosures.ts";
import { migrate } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";
import type { CompanySector } from "../src/sectors.ts";
import { BANK, GENERAL, HOLDING, parseFixture } from "./fixtures/index.ts";

function disclosure(id: number, oid: string, codes: string[], title: string): Disclosure {
  return {
    disclosure_id: id,
    disclosure_oid: `d-${id}`,
    published_at: "2026-08-17T19:05:18",
    stock_codes: codes,
    mkk_member_oid: oid,
    company_title: title,
    title: "Finansal Rapor",
    disclosure_class: "FR",
    year: 2026,
    quarter: 2,
    is_changed: null,
    related_disclosure_oid: null,
    is_late: false,
  };
}
function sector(oid: string, shownAs: string, main: string, sub: string | null): CompanySector {
  return {
    mkk_member_oid: oid,
    stock_codes: shownAs,
    title: shownAs,
    main_sector_no: `${main.length}.`,
    main_sector_name: main,
    main_sector_oid: `M-${main}`,
    sector_no: sub === null ? null : `${main.length}.${sub.length}.`,
    sector_name: sub,
    sector_oid: sub === null ? null : `S-${sub}`,
  };
}

const DISCLOSURES = [
  disclosure(GENERAL.disclosureId, "oid-general", ["TSTGN", "TSTGX"], "TEST GENEL SANAYİ VE TİCARET A.Ş."),
  disclosure(HOLDING.disclosureId, "oid-holding", ["TSTHD"], "IŞIK HOLDİNG A.Ş."),
  disclosure(BANK.disclosureId, "oid-bank", [], "TEST BANKASI A.Ş."),
];
// The page shows the general company under another ticker: it is still matched, by member id.
const SECTORS = {
  read_at: "2026-11-16T01:00:00.000Z",
  companies: [
    sector("oid-general", "OTHER", "İMALAT", "ANA METAL SANAYİ"),
    sector("oid-holding", "TSTHD", "MALİ KURULUŞLAR", null),
  ],
};

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
  for (const f of [GENERAL, HOLDING, BANK]) await loadFiling(db, parseFixture(f));
});
afterEach(() => close(db));

const company = async (code: string) =>
  (await rows(db, "SELECT * EXCLUDE (company_code) FROM companies WHERE company_code = $1", [code]))[0];

describe("turkishSearchKey", () => {
  test("folds Turkish letters both ways, so any spelling finds the company", () => {
    for (const s of ["IŞIK", "ışık", "Işık", "isik", "ISIK"]) expect(turkishSearchKey(s)).toBe("isik");
    expect(turkishSearchKey("İSTANBUL")).toBe("istanbul");
    expect(turkishSearchKey("ÇĞÖŞÜ çğöşü")).toBe("cgosu cgosu");
  });

  test("keeps letters and digits, one space between words", () => {
    expect(turkishSearchKey("KATMERCİLER ARAÇ ÜSTÜ EKİPMAN A.Ş.")).toBe("katmerciler arac ustu ekipman a s");
    expect(turkishSearchKey("  A1CAP, ACP  ")).toBe("a1cap acp");
    expect(turkishSearchKey("Hâlâ Kâr")).toBe("hala kar");
  });
});

describe("latestReports", () => {
  test("one per company: the latest publication, then the larger disclosure id", async () => {
    // A later report of the general company, and one published at the same time with a larger id.
    const later = { ...parseFixture(GENERAL), disclosure_id: 9_000_101, published_at: "2026-09-01T10:00:00" };
    const tie = { ...parseFixture(GENERAL), disclosure_id: 9_000_102, published_at: "2026-09-01T10:00:00" };
    for (const f of [later, tie]) {
      await loadFiling(db, { ...f, facts: f.facts.map((x) => ({ ...x, disclosure_id: f.disclosure_id })) });
    }
    const latest = await latestReports(db);
    expect(latest.map((r) => [r.company_code, r.disclosure_id])).toEqual([
      ["TSTBN", BANK.disclosureId],
      ["TSTGN", 9_000_102],
      ["TSTHD", HOLDING.disclosureId],
    ]);
    expect(latest.find((r) => r.company_code === "TSTGN")?.published_at).toBe("2026-09-01T10:00:00");

    // Publication time comes first: a later report with a smaller id is the latest one.
    const corrected = { ...parseFixture(GENERAL), disclosure_id: 9_000_050, published_at: "2026-10-01T10:00:00" };
    await loadFiling(db, {
      ...corrected,
      facts: corrected.facts.map((x) => ({ ...x, disclosure_id: corrected.disclosure_id })),
    });
    expect((await latestReports(db)).find((r) => r.company_code === "TSTGN")?.disclosure_id).toBe(9_000_050);
  });
});

describe("companyRows", () => {
  test("member id, codes and title from the disclosure; sector by member id; template from the report", async () => {
    const u = companyRows(await latestReports(db), DISCLOSURES, SECTORS.companies);
    expect(u.rows.find((r) => r.company_code === "TSTGN")).toEqual({
      company_code: "TSTGN",
      mkk_member_oid: "oid-general",
      stock_codes: ["TSTGN", "TSTGX"],
      title: "TEST GENEL SANAYİ VE TİCARET A.Ş.",
      template_family: "general",
      main_sector_no: "6.",
      main_sector_name: "İMALAT",
      sector_no: "6.16.",
      sector_name: "ANA METAL SANAYİ",
      search_key: "tstgn tstgx test genel sanayi ve ticaret a s",
    });
    // A disclosure without codes falls back to the code from the file name.
    expect(u.rows.find((r) => r.company_code === "TSTBN")?.stock_codes).toEqual(["TSTBN"]);
    expect(u.without_sector).toEqual(["TSTBN"]);
    expect(u.missing).toEqual([]);
  });

  test("a company whose latest report is not in the list is missing, not guessed", async () => {
    const u = companyRows(await latestReports(db), DISCLOSURES.slice(0, 2), SECTORS.companies);
    expect(u.missing).toEqual(["TSTBN"]);
    expect(u.rows.map((r) => r.company_code)).toEqual(["TSTGN", "TSTHD"]);
  });

  test("a ticker on the sector page is never used to match", async () => {
    const wrong = [sector("someone-else", "TSTGN", "TİCARET", "PERAKENDE")];
    const u = companyRows(await latestReports(db), DISCLOSURES, wrong);
    expect(u.rows.find((r) => r.company_code === "TSTGN")?.main_sector_name).toBeNull();
  });
});

describe("updateCompanies", () => {
  test("writes every company's metadata, with the time of the sector reading", async () => {
    const u = await updateCompanies(db, DISCLOSURES, SECTORS);
    expect(u.rows).toHaveLength(3);
    expect(await company("TSTHD")).toEqual({
      mkk_member_oid: "oid-holding",
      stock_codes: ["TSTHD"],
      title: "IŞIK HOLDİNG A.Ş.",
      template_family: "holding",
      main_sector_no: "15.",
      main_sector_name: "MALİ KURULUŞLAR",
      sector_no: null,
      sector_name: null,
      sectors_read_at: new Date("2026-11-16T01:00:00.000Z"),
      search_key: "tsthd isik holding a s",
    });
  });

  test("search finds a company by any spelling of its title or by a code", async () => {
    await updateCompanies(db, DISCLOSURES, SECTORS);
    const find = async (q: string) =>
      (
        await rows(db, "SELECT company_code FROM companies WHERE search_key LIKE '%' || $1 || '%' ORDER BY 1", [
          turkishSearchKey(q),
        ])
      ).map((r) => r.company_code);
    expect(await find("ışık")).toEqual(["TSTHD"]);
    expect(await find("ISIK")).toEqual(["TSTHD"]);
    expect(await find("tstgx")).toEqual(["TSTGN"]);
    expect(await find("A.Ş.")).toEqual(["TSTBN", "TSTGN", "TSTHD"]);
  });

  test("without a sector reading the sector columns stay empty", async () => {
    await updateCompanies(db, DISCLOSURES, null);
    expect(await company("TSTGN")).toMatchObject({
      mkk_member_oid: "oid-general",
      main_sector_name: null,
      sectors_read_at: null,
    });
  });

  test("a company missing from a later list keeps what it had; running again changes nothing", async () => {
    await updateCompanies(db, DISCLOSURES, SECTORS);
    const before = await rows(db, "SELECT * FROM companies ORDER BY company_code");
    const u = await updateCompanies(db, DISCLOSURES.slice(0, 2), SECTORS);
    expect(u.missing).toEqual(["TSTBN"]);
    expect(await rows(db, "SELECT * FROM companies ORDER BY company_code")).toEqual(before);
  });

  test("reloading a report keeps the company's metadata", async () => {
    await updateCompanies(db, DISCLOSURES, SECTORS);
    const before = await company("TSTGN");
    await loadFiling(db, parseFixture(GENERAL));
    expect(await company("TSTGN")).toEqual(before);
  });
});

test("publicationRange spans the days of the latest reports", () => {
  const r = (code: string, at: string | null) => ({
    company_code: code,
    disclosure_id: 1,
    template_family: "general",
    published_at: at,
  });
  expect(publicationRange([r("A", "2026-08-17T19:05:18"), r("B", "2026-07-30T09:00:00"), r("C", null)])).toEqual({
    from: "2026-07-30",
    to: "2026-08-17",
  });
  expect(publicationRange([r("C", null)])).toBeNull();
});

test("migration 5 adds the columns to a version 4 database and keeps its companies", async () => {
  const con = await (await DuckDBInstance.create(":memory:")).connect();
  await migrate(
    con,
    MIGRATIONS.filter((m) => m.version <= 4),
  );
  await con.run("INSERT INTO companies VALUES ('KATMR')");
  expect(await migrate(con)).toEqual([5]);
  const read = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJS();
  expect(await read("SELECT company_code, mkk_member_oid, stock_codes, search_key FROM companies")).toEqual([
    { company_code: "KATMR", mkk_member_oid: null, stock_codes: null, search_key: null },
  ]);
});
