/** Checking a downloaded quarter against KAP's disclosure list (#43). */
import { describe, expect, test } from "bun:test";
import { checkArchive, filerKind } from "../src/archive-check.ts";
import type { FileReport } from "../src/db.ts";
import type { Disclosure } from "../src/disclosures.ts";

const disclosure = (id: number, fields: Partial<Disclosure> = {}): Disclosure => ({
  disclosure_id: id,
  disclosure_oid: `oid-${id}`,
  published_at: "2026-08-10T18:00:00",
  stock_codes: [`T${id}`],
  mkk_member_oid: `m-${id}`,
  company_title: `Şirket ${id}`,
  title: "Finansal Rapor",
  disclosure_class: "FR",
  year: 2026,
  quarter: 2,
  is_changed: null,
  related_disclosure_oid: null,
  is_late: false,
  ...fields,
});

describe("checkArchive", () => {
  test("matches files to listed reports by disclosure id and explains every gap", () => {
    const listed = [
      disclosure(100),
      disclosure(101, { is_changed: "DUZELTILEN" }), // corrected; the zip has 104
      disclosure(102, { stock_codes: ["GARAN"], company_title: "Banka" }), // not in the zip
      disclosure(104, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-101" }),
    ];
    const files = ["AAA_100_2026_2.xls", "BBB_104_2026_2.xls", "CCC_200_2026_2.xls", "readme.txt"];
    const parsed: FileReport[] = [
      { filepath: "x/AAA_100_2026_2.xls", status: "ok", disclosure_id: 100, fact_count: 10, error: null },
      { filepath: "x/CCC_200_2026_2.xls", status: "parse_error", disclosure_id: null, fact_count: 0, error: "bad" },
    ];
    const c = checkArchive(2026, 2, listed, files, parsed);
    expect(c).toEqual({
      year: 2026,
      quarter: 2,
      listed: 4,
      files: 3,
      matched: 2,
      missing: [
        {
          disclosure_id: 101,
          stock_codes: ["T101"],
          company_title: "Şirket 101",
          published_at: "2026-08-10T18:00:00",
          kind: "company",
          reason: "corrected",
        },
        {
          disclosure_id: 102,
          stock_codes: ["GARAN"],
          company_title: "Banka",
          published_at: "2026-08-10T18:00:00",
          kind: "bank",
          reason: "not_in_archive",
        },
      ],
      not_listed: [{ disclosure_id: 200, file_name: "CCC_200_2026_2.xls" }],
      broken: [{ file_name: "CCC_200_2026_2.xls", status: "parse_error", error: "bad" }],
    });
  });

  test("a complete quarter has no gaps", () => {
    const c = checkArchive(2026, 2, [disclosure(1), disclosure(2)], ["A_1_2026_2.xls", "B_2_2026_2.xls"]);
    expect([c.matched, c.missing.length, c.not_listed.length, c.broken.length]).toEqual([2, 0, 0, 0]);
  });
});

describe("filerKind", () => {
  test("funds, portfolio managers, brokers and banks are told apart from companies by title", () => {
    expect(filerKind("DENİZ PORTFÖY ONUNCU SERBEST (DÖVİZ) FON")).toBe("fund");
    expect(filerKind("INVEO PORTFÖY ESG SÜRDÜRÜLEBİLİRLİK FON SEPETİ FONU")).toBe("fund");
    expect(filerKind("AURA PORTFÖY YÖNETİMİ A.Ş.")).toBe("portfolio_manager");
    expect(filerKind("ALB YATIRIM MENKUL DEĞERLER A.Ş.")).toBe("broker");
    expect(filerKind("PİRAMİT MENKUL KIYMETLER A.Ş.")).toBe("broker");
    expect(filerKind("TÜRKİYE GARANTİ BANKASI A.Ş.")).toBe("bank");
    expect(filerKind("ICBC TURKEY BANK A.Ş.")).toBe("bank");
    expect(filerKind("DENİZBANK A.Ş.")).toBe("bank");
    expect(filerKind("GARANTİ FİNANSAL KİRALAMA A.Ş.")).toBe("finance");
    expect(filerKind("ŞEKER FAKTORİNG A.Ş.")).toBe("finance");
    expect(filerKind("TURKCELL FİNANSMAN A.Ş.")).toBe("finance");
    expect(filerKind("SARTEN AMBALAJ SANAYİ VE TİCARET A.Ş.")).toBe("company");
    expect(filerKind("FONET BİLGİ TEKNOLOJİLERİ A.Ş.")).toBe("company");
  });
});
