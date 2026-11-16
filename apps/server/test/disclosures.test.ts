/**
 * KAP disclosure list client (#163). Answers are synthetic, shaped like the recorded ones in `docs/kap.md`
 * ("Disclosure list"); no KAP content is committed. Expected behaviour: the 90-day limit, the body KAP wants, and the
 * fields Vigil reads.
 */
import { describe, expect, test } from "bun:test";
import {
  dateWindows,
  financialReports,
  istanbulToday,
  kapDate,
  listDisclosures,
  memoryCache,
  parseDisclosure,
  requestBody,
} from "../src/disclosures.ts";
import { KapClient, KapError } from "../src/kap.ts";

/** One entry as KAP answers it; `basic` overrides fields of `disclosureBasic`. */
function entry(index: number, basic: Record<string, unknown> = {}) {
  return {
    disclosureBasic: {
      title: "Finansal Rapor",
      mkkMemberOid: `oid-company-${index % 7}`,
      companyTitle: "TEST SANAYİ A.Ş.",
      stockCode: "TSTGN",
      relatedStocks: null,
      disclosureClass: "FR",
      disclosureType: "FR",
      disclosureCategory: "FR",
      publishDate: "17.08.2026 19:05:18",
      disclosureId: `oid-disclosure-${index}`,
      disclosureIndex: index,
      summary: null,
      attachmentCount: 1,
      year: 2026,
      donem: 2,
      period: "3AB",
      isLate: false,
      relatedDisclosureOid: null,
      isChanged: null,
      isBlocked: false,
      ...basic,
    },
    disclosureDetail: { relatedDisclosureIndex: null },
  };
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** A KAP client whose server answers each request with `answer(body)`, without waits. */
function fakeKap(answer: (body: Record<string, unknown>) => unknown, status = 200) {
  const calls: Call[] = [];
  const client = new KapClient({
    transport: async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, method: String(init.method), body });
      return new Response(JSON.stringify(answer(body)), { status });
    },
    sleep: async () => {},
  });
  return { client, calls };
}

describe("dateWindows", () => {
  test("90 days is one window, 91 are two", () => {
    expect(dateWindows("2026-07-01", "2026-09-28")).toEqual([["2026-07-01", "2026-09-28"]]);
    expect(dateWindows("2026-07-01", "2026-09-29")).toEqual([
      ["2026-07-01", "2026-09-28"],
      ["2026-09-29", "2026-09-29"],
    ]);
  });

  test("one day, a year, and a leap day", () => {
    expect(dateWindows("2026-08-17", "2026-08-17")).toEqual([["2026-08-17", "2026-08-17"]]);
    const year = dateWindows("2028-01-01", "2028-12-31");
    expect(year.map(([a, b]) => [a, b])).toEqual([
      ["2028-01-01", "2028-03-30"],
      ["2028-03-31", "2028-06-28"],
      ["2028-06-29", "2028-09-26"],
      ["2028-09-27", "2028-12-25"],
      ["2028-12-26", "2028-12-31"],
    ]);
  });

  test("a range backwards or a date that does not exist is refused", () => {
    expect(() => dateWindows("2026-08-18", "2026-08-17")).toThrow(RangeError);
    expect(() => dateWindows("2026-02-30", "2026-03-01")).toThrow(RangeError);
    expect(() => dateWindows("17.08.2026", "2026-08-18")).toThrow(RangeError);
  });
});

describe("the request", () => {
  test("has the documented body", () => {
    expect(kapDate("2026-08-07")).toBe("07.08.2026");
    expect(requestBody("2026-08-17", "2026-08-18", { from: "", to: "", classes: ["FR"] })).toEqual({
      fromDate: "17.08.2026",
      toDate: "18.08.2026",
      disclosureTypes: ["FR"],
      memberTypes: [],
      mkkMemberOid: null,
    });
    expect(
      requestBody("2026-08-17", "2026-08-17", { from: "", to: "", mkkMemberOid: "4028e4a14184e9cf01419c001e945a74" }),
    ).toMatchObject({ disclosureTypes: null, mkkMemberOid: "4028e4a14184e9cf01419c001e945a74" });
  });

  test("goes to KAP as a POST, one window after the other", async () => {
    const { client, calls } = fakeKap(() => []);
    await listDisclosures({ from: "2026-07-01", to: "2026-10-15", classes: ["FR"] }, { kap: client });
    expect(calls.map((c) => [c.url, c.method, c.body.fromDate, c.body.toDate])).toEqual([
      ["https://www.kap.org.tr/tr/api/disclosure/list/main", "POST", "01.07.2026", "28.09.2026"],
      ["https://www.kap.org.tr/tr/api/disclosure/list/main", "POST", "29.09.2026", "15.10.2026"],
    ]);
  });
});

describe("parseDisclosure", () => {
  test("reads the fields Vigil uses", () => {
    expect(parseDisclosure(entry(1651411, { stockCode: "TEB, TEBNK", isLate: true }))).toEqual({
      disclosure_id: 1651411,
      disclosure_oid: "oid-disclosure-1651411",
      published_at: "2026-08-17T19:05:18",
      stock_codes: ["TEB", "TEBNK"],
      mkk_member_oid: "oid-company-6", // 1651411 % 7
      company_title: "TEST SANAYİ A.Ş.",
      title: "Finansal Rapor",
      disclosure_class: "FR",
      year: 2026,
      quarter: 2,
      is_changed: null,
      related_disclosure_oid: null,
      is_late: true,
    });
  });

  test("a correction keeps the link to what it corrects", () => {
    const d = parseDisclosure(entry(2, { isChanged: "DUZENLENEN", relatedDisclosureOid: "oid-disclosure-1" }));
    expect([d.is_changed, d.related_disclosure_oid]).toEqual(["DUZENLENEN", "oid-disclosure-1"]);
    expect(parseDisclosure(entry(1, { isChanged: "DUZELTILEN" })).is_changed).toBe("DUZELTILEN");
  });

  test("stock codes are split on commas with or without a space", () => {
    expect(parseDisclosure(entry(4, { stockCode: "TEB,TEBNK , X" })).stock_codes).toEqual(["TEB", "TEBNK", "X"]);
  });

  test("a disclosure without a period or a stock code", () => {
    const d = parseDisclosure(entry(3, { year: null, donem: null, stockCode: null, title: "Özel Durum Açıklaması" }));
    expect([d.year, d.quarter, d.stock_codes]).toEqual([null, null, []]);
  });

  test("another shape is refused with the disclosure and the field named", () => {
    expect(() => parseDisclosure({})).toThrow("disclosureBasic");
    expect(() => parseDisclosure(entry(0))).toThrow("disclosureIndex");
    expect(() => parseDisclosure(entry(5, { publishDate: "2026-08-17 19:05:18" }))).toThrow(
      /disclosure 5: publishDate/,
    );
    expect(() => parseDisclosure(entry(5, { publishDate: "31.02.2026 19:05:18" }))).toThrow(/publishDate/);
    expect(() => parseDisclosure(entry(5, { publishDate: "17.08.2026 19:05:60" }))).toThrow(/publishDate/);
    expect(() => parseDisclosure(entry(5, { publishDate: "17.08.2026 24:00:00" }))).toThrow(/publishDate/);
    expect(() => parseDisclosure(entry(5, { isChanged: "X" }))).toThrow(/disclosure 5: isChanged/);
    expect(() => parseDisclosure(entry(5, { donem: 5 }))).toThrow(/donem/);
    expect(() => parseDisclosure(entry(5, { year: "2026" }))).toThrow(/year/);
    expect(() => parseDisclosure(entry(5, { disclosureId: null }))).toThrow(/disclosureId/);
    expect(() => parseDisclosure(entry(5, { mkkMemberOid: "" }))).toThrow(/mkkMemberOid/);
  });
});

describe("listDisclosures", () => {
  test("windows are joined newest first, and a disclosure in two answers is listed once", async () => {
    // KAP answers newest first within a window.
    const { client } = fakeKap((b) =>
      b.fromDate === "01.07.2026" ? [entry(12), entry(11)] : [entry(22), entry(21), entry(12)],
    );
    const list = await listDisclosures({ from: "2026-07-01", to: "2026-10-15" }, { kap: client });
    expect(list.map((d) => d.disclosure_id)).toEqual([22, 21, 12, 11]);
  });

  test("a window that ended before today is cached; one reaching today is asked for again", async () => {
    const { client, calls } = fakeKap(() => [entry(1)]);
    const cache = memoryCache();
    const now = () => new Date("2026-10-15T09:00:00Z");
    const query = { from: "2026-07-01", to: "2026-10-15", classes: ["FR"] };
    await listDisclosures(query, { kap: client, cache, now });
    await listDisclosures(query, { kap: client, cache, now });
    expect(calls.map((c) => c.body.fromDate)).toEqual(["01.07.2026", "29.09.2026", "29.09.2026"]);
    // The next day the second window has ended too.
    const later = () => new Date("2026-10-16T09:00:00Z");
    await listDisclosures(query, { kap: client, cache, now: later });
    await listDisclosures(query, { kap: client, cache, now: later });
    expect(calls).toHaveLength(4);
    // Another query is another key.
    await listDisclosures({ ...query, classes: null }, { kap: client, cache, now: later });
    expect(calls).toHaveLength(6);
  });

  test("today is Istanbul's date", () => {
    expect(istanbulToday(new Date("2026-08-17T20:59:59Z"))).toBe("2026-08-17");
    expect(istanbulToday(new Date("2026-08-17T21:00:00Z"))).toBe("2026-08-18");
  });

  test("an error answer is thrown, not read as an empty list, and nothing is cached", async () => {
    const { client } = fakeKap(() => ({ success: false, errorMessage: "HTTP 400 - " }));
    const cache = memoryCache();
    const run = listDisclosures(
      { from: "2026-07-01", to: "2026-07-02" },
      { kap: client, cache, now: () => new Date("2026-10-01") },
    );
    await expect(run).rejects.toThrow(KapError);
    await expect(run).rejects.toThrow("HTTP 400");
    expect([...(cache as Map<string, unknown>).keys()]).toEqual([]);
  });

  test("an HTTP error from KAP is thrown after the client's retries", async () => {
    const { client, calls } = fakeKap(() => ({ success: false }), 500);
    await expect(listDisclosures({ from: "2026-07-01", to: "2026-07-01" }, { kap: client })).rejects.toThrow(
      "HTTP 500",
    );
    expect(calls).toHaveLength(3);
  });

  test("one malformed entry fails the whole list", async () => {
    const { client } = fakeKap(() => [entry(1), entry(2, { publishDate: null })]);
    await expect(listDisclosures({ from: "2026-07-01", to: "2026-07-01" }, { kap: client })).rejects.toThrow(
      "disclosure 2",
    );
  });
});

test("financialReports keeps the statements of one period", () => {
  const list = [
    entry(1),
    entry(2, { donem: 1 }),
    entry(3, { title: "Sorumluluk Beyanı" }),
    entry(4, { year: 2025 }),
    entry(5, { isChanged: "DUZELTILEN" }),
  ].map(parseDisclosure);
  expect(financialReports(list, 2026, 2).map((d) => d.disclosure_id)).toEqual([1, 5]);
});
