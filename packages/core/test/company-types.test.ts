/** Company types for companies without a KAP sector (#296, decision 0017). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPANY_TYPES_FILE, CompanyTypesError, loadCompanyTypes, parseCompanyTypes } from "../src/index.ts";

const entry = (fields: Record<string, unknown> = {}) => ({
  mkkMemberOid: "4028e4a240e95dc30140ee34335300e8",
  ticker: "OPET",
  title: "OPET PETROLCÜLÜK A.Ş.",
  type: "real_sector",
  reason: "Industrial, trade or service company by its activity.",
  activity: "Her türlü petrol ürünleri ... dağıtımı",
  source: "KAP general information page, 'Şirketin Faaliyet Konusu' (disclosure 662082), read 2026-11-22",
  ...fields,
});

const errorOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CompanyTypesError);
    return (e as Error).message;
  }
  throw new Error("expected an error");
};

describe("the loader's rules", () => {
  test("a valid entry is read as it is", () => {
    expect(parseCompanyTypes([entry()])).toEqual([entry() as never]);
  });

  test("an entry without a reason or a source is refused", () => {
    expect(errorOf(() => parseCompanyTypes([entry({ reason: "" })]))).toContain("OPET): reason is missing");
    expect(errorOf(() => parseCompanyTypes([entry({ source: "  " })]))).toContain("OPET): source is missing");
    expect(errorOf(() => parseCompanyTypes([entry({ source: undefined })]))).toContain("source is missing");
  });

  test("a member id that appears twice is refused", () => {
    const m = errorOf(() => parseCompanyTypes([entry(), entry({ ticker: "OPET2" })]));
    expect(m).toContain("entry 2 (OPET2): mkkMemberOid 4028e4a240e95dc30140ee34335300e8 is also entry 1");
  });

  test("an entry for a company that has a KAP sector is refused: KAP wins", () => {
    const sectors = new Set(["4028e4a240e95dc30140ee34335300e8"]);
    expect(errorOf(() => parseCompanyTypes([entry()], sectors))).toContain("has a KAP sector now; KAP wins");
    expect(parseCompanyTypes([entry()], new Set(["other"]))).toHaveLength(1);
  });

  test("type, member id and the other fields are checked, and every bad entry is listed", () => {
    const m = errorOf(() =>
      parseCompanyTypes([entry({ type: "bank" }), entry({ mkkMemberOid: "OPET", ticker: "X" }), "not an object"]),
    );
    expect(m).toContain("entry 1 (OPET): type must be real_sector or financial");
    expect(m).toContain("entry 2 (X): mkkMemberOid must be KAP's 32-character id");
    expect(m).toContain("entry 3: not an object");
    expect(errorOf(() => parseCompanyTypes({}))).toContain("must hold a JSON array");
  });
});

describe("data/company-types.json", () => {
  const types = loadCompanyTypes();

  test("passes the loader's rules", () => {
    expect(types.size).toBe(61);
  });

  test("lease certificate issuers are financial (decision 0017)", () => {
    const issuers = [...types.values()].filter((e) => e.title.includes("VARLIK KİRALAMA"));
    expect(issuers.length).toBe(26);
    expect(issuers.every((e) => e.type === "financial")).toBe(true);
  });

  test("every entry cites KAP and the date it was read", () => {
    for (const e of types.values()) {
      expect(e.source).toContain(`https://www.kap.org.tr/tr/sirket-bilgileri/genel/${e.mkkMemberOid}`);
      expect(e.source).toContain("read 2026-11-22");
    }
  });

  test("is kept sorted by ticker, one entry per company", () => {
    const tickers = (JSON.parse(readFileSync(COMPANY_TYPES_FILE, "utf8")) as { ticker: string }[]).map((e) => e.ticker);
    expect(tickers).toEqual([...tickers].sort());
  });
});
