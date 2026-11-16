/**
 * KAP sector classification (#295). Pages are synthetic, built the way the Sektörler page embeds its records
 * (`docs/kap.md`, "Sectors"): escaped JSON inside a script string, one main-sector and one sub-sector record per
 * company. No KAP content is committed. Expected behaviour: the issue's tasks and decision 0017's "fail loudly".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KapClient } from "../src/kap.ts";
import {
  classificationId,
  latestSectors,
  MIN_COMPANIES,
  parseSectorPage,
  REREAD_AFTER_MS,
  refreshSectors,
  SectorPageError,
  sectorsAt,
  storeSectorPage,
} from "../src/sectors.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";

const KATMR = "4028e4a14184e9cf01419c001e945a74";
const KARDEMIR = "4028e4a140f2ed7201412ace3ada0707";

type Rec = Record<string, unknown>;

function mainRecord(oid: string, code: string, title: string, no: string, name: string): Rec {
  return {
    mainSectorName: name,
    mainSectorOid: `MAIN-${no}`,
    mainSectorNo: no,
    mkkMemberOid: oid,
    stockCode: code,
    title,
    kapTypes: ["IGS"],
  };
}
function subRecord(oid: string, code: string, title: string, no: string, name: string): Rec {
  return {
    sectorName: name,
    sectorOid: `SUB-${no}`,
    sectorNo: no,
    mkkMemberOid: oid,
    stockCode: code,
    title,
    kapTypes: ["IGS"],
  };
}

/** `n` filler companies plus KATMR and Kardemir, each with both records. */
function records(n = MIN_COMPANIES): Rec[] {
  const out: Rec[] = [
    mainRecord(KATMR, "KATMR", "KATMERCİLER A.Ş.", "003000.", "İMALAT"),
    subRecord(
      KATMR,
      "KATMR",
      "KATMERCİLER A.Ş.",
      "003000.008000.",
      "METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE ULAŞIM ARAÇLARI",
    ),
    mainRecord(KARDEMIR, "KRDMA, KRDMB, KRDMD", "KARDEMİR A.Ş.", "003000.", "İMALAT"),
    subRecord(KARDEMIR, "KRDMA, KRDMB, KRDMD", "KARDEMİR A.Ş.", "003000.007000.", "ANA METAL SANAYİ"),
  ];
  for (let i = 0; i < n - 2; i++) {
    const oid = `oid-${String(i).padStart(4, "0")}`;
    out.push(mainRecord(oid, `TS${i}`, `ŞİRKET "${i}" A.Ş.`, "008000.", "MALİ KURULUŞLAR"));
    out.push(subRecord(oid, `TS${i}`, `ŞİRKET "${i}" A.Ş.`, "008000.081000.", "HOLDİNGLER VE YATIRIM ŞİRKETLERİ"));
  }
  return out;
}

/** The records as the page embeds them: grouped by sector, escaped inside a script string. */
function page(recs: Rec[]): string {
  const escaped = (r: Rec) => JSON.stringify(JSON.stringify(r)).slice(1, -1);
  const mains = recs.filter((r) => "mainSectorName" in r).map(escaped);
  const subs = recs.filter((r) => !("mainSectorName" in r)).map(escaped);
  const payload = `{\\"content\\":[${subs.join(",")}]},{\\"content\\":[${mains.join(",")}]}`;
  return `<!DOCTYPE html><html><body><div>Sektörler</div><script>self.__next_f.push([1,"${payload}\\n"])</script></body></html>`;
}

describe("parseSectorPage", () => {
  test("reads both record types and matches them by member id", () => {
    const companies = parseSectorPage(page(records()));
    expect(companies).toHaveLength(MIN_COMPANIES);
    expect(companies.find((c) => c.mkk_member_oid === KATMR)).toEqual({
      mkk_member_oid: KATMR,
      stock_codes: "KATMR",
      title: "KATMERCİLER A.Ş.",
      main_sector_no: "003000.",
      main_sector_name: "İMALAT",
      main_sector_oid: "MAIN-003000.",
      sector_no: "003000.008000.",
      sector_name: "METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE ULAŞIM ARAÇLARI",
      sector_oid: "SUB-003000.008000.",
    });
    // Kardemir is found by its member id, whatever tickers the page shows.
    expect(companies.find((c) => c.mkk_member_oid === KARDEMIR)).toMatchObject({
      stock_codes: "KRDMA, KRDMB, KRDMD",
      main_sector_name: "İMALAT",
      sector_name: "ANA METAL SANAYİ",
    });
    expect(companies.map((c) => c.mkk_member_oid)).toEqual(companies.map((c) => c.mkk_member_oid).sort());
  });

  test("escaped quotes and Turkish letters in a title survive", () => {
    const c = parseSectorPage(page(records())).find((x) => x.mkk_member_oid === "oid-0007");
    expect(c?.title).toBe('ŞİRKET "7" A.Ş.');
  });

  test("a company with only a main sector has no sub-sector", () => {
    const recs = records().filter((r) => !(r.mkkMemberOid === KATMR && "sectorName" in r));
    const c = parseSectorPage(page(recs)).find((x) => x.mkk_member_oid === KATMR);
    expect([c?.main_sector_name, c?.sector_no, c?.sector_name, c?.sector_oid]).toEqual(["İMALAT", null, null, null]);
  });

  test("a record repeated on the page with the same content is read once", () => {
    const recs = records();
    expect(parseSectorPage(page([...recs, recs[0] as Rec, recs[1] as Rec]))).toHaveLength(MIN_COMPANIES);
  });

  describe("fails loudly", () => {
    const error = (html: string) => {
      try {
        parseSectorPage(html);
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a SectorPageError");
    };

    test("when no records are found", () => {
      const e = error("<html><body>Sektörler</body></html>");
      expect(e).toBeInstanceOf(SectorPageError);
      expect(e.message).toContain("no sector records");
      // Records in another form (not escaped) are not read either.
      expect(error(JSON.stringify(records())).message).toContain("no sector records");
    });

    test("when fewer companies than expected are found", () => {
      const e = error(page(records(MIN_COMPANIES - 1)));
      expect(e).toBeInstanceOf(SectorPageError);
      expect(e.message).toContain(`only ${MIN_COMPANIES - 1} companies`);
    });

    test("when a company has a sub-sector but no main sector", () => {
      const recs = records().filter((r) => !(r.mkkMemberOid === KATMR && "mainSectorName" in r));
      const e = error(page([...recs, mainRecord("oid-extra", "X", "X", "001000.", "TARIM")]));
      expect(e).toBeInstanceOf(SectorPageError);
      expect(e.message).toContain(`${KATMR} (KATMR) has a sub-sector but no main sector`);
    });

    test("when one company has two different records", () => {
      const recs = records();
      const other = mainRecord(KATMR, "KATMR", "KATMERCİLER A.Ş.", "008000.", "MALİ KURULUŞLAR");
      const e = error(page([...recs, other]));
      expect(e).toBeInstanceOf(SectorPageError);
      expect(e.message).toContain("two different main-sector records");
    });

    test("when a record lacks a field", () => {
      const recs = records().map((r) =>
        r.mkkMemberOid === KATMR && "mainSectorName" in r ? { ...r, mainSectorNo: "" } : r,
      );
      expect(error(page(recs)).message).toContain("no mainSectorNo");
    });
  });
});

describe("readings in Zova", () => {
  let store: Store;
  beforeEach(() => {
    store = memoryStore();
    migrateStore(store);
  });
  afterEach(() => store.close());

  const count = (table: string) => Number(store.query(`SELECT count(*) AS n FROM ${table}`)[0]?.n);

  test("a reading is stored with its time, its classification and the page", () => {
    const html = page(records());
    const r = storeSectorPage(store, html, new Date("2026-11-15T08:00:00Z"));
    expect(r.read_at).toBe("2026-11-15T08:00:00.000Z");
    expect(r.companies).toEqual(parseSectorPage(html));
    expect(r.classification_id).toBe(classificationId(parseSectorPage(html)));
    const [c] = store.query("SELECT page_object_id, companies FROM sector_classifications");
    expect(new TextDecoder().decode(store.getObject(String(c?.page_object_id)))).toBe(html);
    expect(c?.companies).toBe(BigInt(MIN_COMPANIES));
    expect(latestSectors(store)).toEqual(r);
  });

  test("the same classification is stored once; every reading is kept", () => {
    storeSectorPage(store, page(records()), new Date("2026-11-15T08:00:00Z"));
    // Another page around the same records (KAP's page changes daily) is the same classification.
    storeSectorPage(store, `${page(records())}<!-- build 2 -->`, new Date("2026-11-16T08:00:00Z"));
    expect([count("sector_readings"), count("sector_classifications"), count("company_sectors")]).toEqual([
      2,
      1,
      MIN_COMPANIES,
    ]);
  });

  test("a changed classification is kept next to the earlier one, and each time finds the one in use", () => {
    const first = storeSectorPage(store, page(records()), new Date("2026-11-15T08:00:00Z"));
    const moved = records().map((r) =>
      r.mkkMemberOid === KATMR && "mainSectorName" in r ? { ...r, mainSectorName: "İMALAT SANAYİ" } : r,
    );
    const second = storeSectorPage(store, page(moved), new Date("2026-11-20T08:00:00Z"));
    expect(count("sector_classifications")).toBe(2);
    const katmr = (r: ReturnType<typeof sectorsAt>) =>
      r?.companies.find((c) => c.mkk_member_oid === KATMR)?.main_sector_name;
    expect(katmr(sectorsAt(store, "2026-11-17T00:00:00.000Z"))).toBe("İMALAT");
    expect(katmr(sectorsAt(store, "2026-11-20T08:00:00.000Z"))).toBe("İMALAT SANAYİ");
    expect(sectorsAt(store, "2026-11-01T00:00:00.000Z")).toBeNull();
    expect([first.id, second.id, latestSectors(store)?.id]).toEqual([1, 2, 2]);
  });

  test("a page that cannot be read stores nothing and keeps the earlier readings", () => {
    storeSectorPage(store, page(records()), new Date("2026-11-15T08:00:00Z"));
    expect(() => storeSectorPage(store, "<html></html>", new Date("2026-11-16T08:00:00Z"))).toThrow(SectorPageError);
    expect([count("sector_readings"), count("sector_classifications")]).toEqual([1, 1]);
    expect(latestSectors(store)?.read_at).toBe("2026-11-15T08:00:00.000Z");
  });

  test("before the first reading there is none", () => {
    expect(latestSectors(store)).toBeNull();
  });
});

describe("refreshSectors", () => {
  let store: Store;
  beforeEach(() => {
    store = memoryStore();
    migrateStore(store);
  });
  afterEach(() => store.close());

  function fakeKap(html: () => string) {
    const urls: string[] = [];
    const client = new KapClient({
      transport: async (url) => {
        urls.push(url);
        return new Response(html());
      },
      sleep: async () => {},
    });
    return { client, urls };
  }

  test("reads the page through the KAP client, at most once a day", async () => {
    const { client, urls } = fakeKap(() => page(records()));
    const t0 = new Date("2026-11-15T08:00:00Z");
    const first = await refreshSectors(store, { kap: client, now: () => t0 });
    expect(first.fetched).toBe(true);
    expect(urls).toEqual(["https://www.kap.org.tr/tr/Sektorler"]);

    const almost = new Date(t0.getTime() + REREAD_AFTER_MS - 1);
    const again = await refreshSectors(store, { kap: client, now: () => almost });
    expect(again).toEqual({ reading: first.reading, fetched: false });
    expect(urls).toHaveLength(1);

    const day = new Date(t0.getTime() + REREAD_AFTER_MS);
    expect((await refreshSectors(store, { kap: client, now: () => day })).fetched).toBe(true);
    expect(urls).toHaveLength(2);
  });

  test("force reads it now", async () => {
    const { client, urls } = fakeKap(() => page(records()));
    const now = () => new Date("2026-11-15T08:00:00Z");
    await refreshSectors(store, { kap: client, now });
    await refreshSectors(store, { kap: client, now, force: true });
    expect(urls).toHaveLength(2);
  });

  test("a changed page layout is an error, and the last good reading stays in use", async () => {
    let html = page(records());
    const { client } = fakeKap(() => html);
    await refreshSectors(store, { kap: client, now: () => new Date("2026-11-15T08:00:00Z") });
    html = "<html><body>new layout</body></html>";
    await expect(refreshSectors(store, { kap: client, now: () => new Date("2026-11-17T08:00:00Z") })).rejects.toThrow(
      SectorPageError,
    );
    expect(latestSectors(store)?.read_at).toBe("2026-11-15T08:00:00.000Z");
  });
});
