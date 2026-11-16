/**
 * Resolving disclosures (#202). The fixture `fixtures/kap/fr-2026-08-17.json` is KAP's real answer for class `FR` on
 * 17.08.2026 (225 disclosures, 72 of them `Finansal Rapor`), recorded on 16.11.2026 with only each entry's long
 * `summary` text removed. Expected values are from that answer and from KAP's bulk file names for 2026/2
 * (`ATA-ATAYM_1651692_2026_2.xls`, `TAE-TRBNK_1651563_2026_2.xls`, `KATMR_1651411_2026_2.xls`).
 * "Done when": every disclosure in a recorded day resolves or gives a clear reason.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Disclosure, parseDisclosure } from "../src/disclosures.ts";
import { resolveDisclosure, resolveDisclosures } from "../src/resolve.ts";

const DAY: Disclosure[] = (await Bun.file(join(import.meta.dir, "fixtures", "kap", "fr-2026-08-17.json")).json()).map(
  parseDisclosure,
);
const byId = (id: number) => DAY.find((d) => d.disclosure_id === id) as Disclosure;

describe("17.08.2026 as KAP recorded it (done when)", () => {
  const { resolved, unresolved } = resolveDisclosures(DAY);

  test("every disclosure resolves or says why", () => {
    expect(DAY).toHaveLength(225);
    expect(resolved.length + unresolved.length).toBe(225);
    expect(resolved).toHaveLength(72);
    // The rest are responsibility statements, activity reports and sustainability reports.
    expect(new Set(unresolved.map((u) => u.reason))).toEqual(new Set(["not_a_financial_report"]));
    for (const u of unresolved) expect(u.message).toContain(String(u.disclosure_id));
  });

  test("every financial report gets a member id, 2026/2 and a company code", () => {
    for (const r of resolved) {
      expect(r.mkk_member_oid).toMatch(/^[0-9a-f]{32}$/);
      expect([r.year, r.quarter]).toEqual([2026, 2]);
      expect(r.company_code).toMatch(/^[A-Z0-9]+$/);
    }
    expect(new Set(resolved.map((r) => r.disclosure_id)).size).toBe(72);
  });

  test("KATMR", () => {
    expect(resolveDisclosure(byId(1651411))).toEqual({
      ok: true,
      report: {
        disclosure_id: 1651411,
        mkk_member_oid: byId(1651411).mkk_member_oid,
        year: 2026,
        quarter: 2,
        company_code: "KATMR",
        ticker_group: "KATMR",
        stock_codes: ["KATMR"],
        is_correction: false,
      },
    });
  });

  test("a company with several codes is one company, named as in KAP's file names", () => {
    const ata = resolveDisclosure(byId(1651692));
    expect(ata.ok && [ata.report.company_code, ata.report.ticker_group]).toEqual(["ATA", "ATA-ATAYM"]);
    const tera = resolveDisclosure(byId(1651563));
    expect(tera.ok && [tera.report.company_code, tera.report.ticker_group]).toEqual(["TAE", "TAE-TRBNK"]);
  });

  test("a correction is marked", () => {
    const rubns = resolveDisclosure(byId(1651540));
    expect(rubns.ok && [rubns.report.company_code, rubns.report.is_correction]).toEqual(["RUBNS", true]);
    expect(
      resolved
        .filter((r) => r.is_correction)
        .map((r) => r.company_code)
        .sort(),
    ).toEqual(["INM", "RUBNS"]);
  });
});

describe("reasons", () => {
  const katmr = () => ({ ...byId(1651411) });

  test.each([
    ["no year or period", { year: null }, "no_period"],
    ["no quarter", { quarter: null }, "no_period"],
    ["a member id that is not KAP's", { mkk_member_oid: "KATMR" }, "bad_member_id"],
    ["no stock code", { stock_codes: [] }, "no_stock_code"],
    ["a period that ends after publication", { year: 2026, quarter: 3 }, "period_after_publication"],
    ["a period ending on the publication day", { published_at: "2026-06-30T10:00:00" }, "period_after_publication"],
    ["another title", { title: "Faaliyet Raporu (Konsolide)" }, "not_a_financial_report"],
  ] as [string, Partial<Disclosure>, string][])("%s", (_name, change, reason) => {
    const r = resolveDisclosure({ ...katmr(), ...change });
    expect(r).toMatchObject({ ok: false, disclosure_id: 1651411, reason });
  });

  test("a year-end report published in the next year resolves", () => {
    const r = resolveDisclosure({ ...katmr(), year: 2025, quarter: 4, published_at: "2026-03-10T18:00:00" });
    expect(r.ok && [r.report.year, r.report.quarter]).toEqual([2025, 4]);
  });

  test("lower-case codes are upper-cased", () => {
    const r = resolveDisclosure({ ...katmr(), stock_codes: ["krdma", "krdmb"] });
    expect(r.ok && r.report.ticker_group).toBe("KRDMA-KRDMB");
  });
});

// With the 2026/2 bulk files present: the ticker group is the file name's.
const RAW = join(import.meta.dir, "..", "..", "..", "data", "raw", "2026_2");
test.skipIf(!existsSync(join(RAW, "KATMR_1651411_2026_2.xls")))(
  "on 2026/2, every resolved report present in the bulk files has its ticker group",
  () => {
    const files = new Map(
      readdirSync(RAW)
        .map((n) => /^([A-Z0-9-]+)_(\d+)_2026_2\.xls$/i.exec(n))
        .filter((m) => m !== null)
        .map((m) => [Number(m[2]), m[1] as string]),
    );
    let checked = 0;
    for (const r of resolveDisclosures(DAY).resolved) {
      const name = files.get(r.disclosure_id);
      if (name === undefined) continue;
      expect(r.ticker_group).toBe(name);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  },
);
