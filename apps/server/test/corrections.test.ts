/**
 * Corrected reports (#204). The KAP answers in `fixtures/kap/` are recorded: `fr-2026-08-17.json` is the disclosure
 * list for class `FR` on 17.08.2026, with RUBNS's correction 1651540; `fr-rubns-2026-07-01-2026-08-17.json` is RUBNS's
 * financial disclosures from 01.07 to 17.08.2026, with the original 1646921. The statement files are synthetic.
 * Expected behaviour: the issue's tasks and "a recorded correction is stored as a second version linked to the first".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { correctionOf, linkCorrections, reportVersions, searchRange } from "../src/corrections.ts";
import { KapClient } from "../src/kap.ts";
import { pollOnce, startPolling } from "../src/poller.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";

const KAP_DIR = join(import.meta.dir, "fixtures", "kap");
const DAY: unknown[] = await Bun.file(join(KAP_DIR, "fr-2026-08-17.json")).json();
const RUBNS_LIST: unknown[] = await Bun.file(join(KAP_DIR, "fr-rubns-2026-07-01-2026-08-17.json")).json();
const RUBNS = "8acae2c47d3bee50017d8f777c171313";
const ORIGINAL = 1646921;
const CORRECTION = 1651540;

/** A fake KAP disclosure list: the day's answer, or a company's from `byCompany`; every request body is kept. */
function fakeKap(byCompany: Record<string, unknown[] | (() => Response)> = {}, day: unknown[] = DAY) {
  const bodies: Record<string, unknown>[] = [];
  const client = new KapClient({
    transport: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const company = body.mkkMemberOid as string | null;
      const answer = company === null ? day : (byCompany[company] ?? []);
      return typeof answer === "function" ? answer() : new Response(JSON.stringify(answer));
    },
    sleep: async () => {},
  });
  return { client, bodies };
}
const companyRequests = (bodies: Record<string, unknown>[]) => bodies.filter((b) => b.mkkMemberOid !== null);

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

const now = () => new Date("2026-08-17T18:00:00Z"); // 21:00 in Istanbul

function put(name: string, html: string, downloadedAt: string) {
  return storeRawFile(store, new TextEncoder().encode(html), {
    fileName: name,
    sourceUrl: `https://www.kap.org.tr/${name}`,
    downloadedAt: new Date(downloadedAt),
  }).file;
}

/** Record a disclosure as the poller does. */
function see(id: number, fields: Record<string, unknown> = {}) {
  const d = {
    disclosure_oid: `oid-${id}`,
    mkk_member_oid: "oid-company",
    year: 2026,
    quarter: 2,
    published_at: "2026-08-17T19:05:18",
    is_changed: null,
    related_disclosure_oid: null,
    ...fields,
  };
  store.run(
    `INSERT INTO seen_disclosures (disclosure_id, disclosure_oid, mkk_member_oid, stock_codes, year, quarter,
       published_at, is_changed, related_disclosure_oid, seen_at)
     VALUES (?1, ?2, ?3, '["TST"]', ?4, ?5, ?6, ?7, ?8, '2026-08-17T16:10:00Z')`,
    [id, d.disclosure_oid, d.mkk_member_oid, d.year, d.quarter, d.published_at, d.is_changed, d.related_disclosure_oid],
  );
}

describe("done when: a recorded correction is stored as a second version linked to the first", () => {
  test("RUBNS 2026/2: the correction 1651540 is linked to 1646921 and is its second version", async () => {
    // The original was stored before the collector started, e.g. by the first download of 2026/2.
    const first = put(`RUBNS_${ORIGINAL}_2026_2.xls`, "<html>original</html>", "2026-08-11T06:00:00Z");
    const { client, bodies } = fakeKap({ [RUBNS]: RUBNS_LIST });
    await pollOnce(store, { kap: client, now, since: "2026-08-17" });
    const second = put(`RUBNS_${CORRECTION}_2026_2.xls`, "<html>corrected</html>", "2026-08-17T18:00:00Z");

    const r = await linkCorrections(store, { kap: client, now });
    expect(correctionOf(store, CORRECTION)).toEqual({
      disclosure_id: CORRECTION,
      original_disclosure_id: ORIGINAL,
      original_oid: "4028328c9f52dc3f019feb1110362326",
      linked_at: now().toISOString(),
      note: `found in KAP's financial disclosures of ${RUBNS} from 2026-07-01 to 2026-08-17`,
    });
    // One request for RUBNS, from the day after the period to the day of the correction.
    expect(companyRequests(bodies).filter((b) => b.mkkMemberOid === RUBNS)).toEqual([
      { fromDate: "01.07.2026", toDate: "17.08.2026", disclosureTypes: ["FR"], memberTypes: [], mkkMemberOid: RUBNS },
    ]);
    expect(r.errors).toEqual([]);

    const versions = [
      { disclosure_id: ORIGINAL, corrects: null, files: [first] },
      { disclosure_id: CORRECTION, corrects: ORIGINAL, files: [second] },
    ];
    expect(reportVersions(store, CORRECTION)).toEqual(versions);
    expect(reportVersions(store, ORIGINAL)).toEqual(versions);
  });

  test("every correction of the day is linked or recorded as not found, once", async () => {
    const { client, bodies } = fakeKap({ [RUBNS]: RUBNS_LIST });
    await pollOnce(store, { kap: client, now, since: "2026-08-17" });
    const r = await linkCorrections(store, { kap: client, now });
    // The day has two corrections; the other company's original is not in the (fake) answer.
    expect(r.linked.map((l) => [l.disclosure_id, l.original_disclosure_id])).toEqual([
      [1651056, null],
      [CORRECTION, ORIGINAL],
    ]);
    expect(r.linked[0]?.note).toStartWith("not in KAP's financial disclosures of ");
    const asked = companyRequests(bodies).length;
    expect(asked).toBe(2);
    // Not asked again.
    expect(await linkCorrections(store, { kap: client, now })).toEqual({ linked: [], errors: [] });
    expect(companyRequests(bodies)).toHaveLength(asked);
  });
});

describe("linking", () => {
  test("an original the collector recorded is linked without asking KAP", async () => {
    see(10, { disclosure_oid: "oid-original" });
    see(11, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-original" });
    const { client, bodies } = fakeKap();
    const r = await linkCorrections(store, { kap: client, now });
    expect(r.linked).toEqual([expect.objectContaining({ disclosure_id: 11, original_disclosure_id: 10 })]);
    expect(r.linked[0]?.note).toBe("recorded by the collector");
    expect(bodies).toEqual([]);
  });

  test("a disclosure that is not a correction is not linked", async () => {
    see(10);
    see(11, { is_changed: "DUZELTILEN" });
    const { client, bodies } = fakeKap();
    expect(await linkCorrections(store, { kap: client, now })).toEqual({ linked: [], errors: [] });
    expect([bodies, correctionOf(store, 10), reportVersions(store, 10)]).toEqual([
      [],
      null,
      [{ disclosure_id: 10, corrects: null, files: [] }],
    ]);
  });

  test("a KAP error leaves the correction for the next run; the others are linked", async () => {
    see(10, { disclosure_oid: "oid-original" });
    see(11, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-original", published_at: "2026-08-18T09:00:00" });
    see(20, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-elsewhere", mkk_member_oid: "oid-down" });
    const down = fakeKap({ "oid-down": () => new Response("down", { status: 503 }) });
    const r = await linkCorrections(store, { kap: down.client, now });
    expect(r.linked.map((l) => l.disclosure_id)).toEqual([11]);
    expect(r.errors).toEqual([{ disclosure_id: 20, error: expect.stringContaining("503") }]);
    expect(correctionOf(store, 20)).toBeNull();

    const up = fakeKap({
      "oid-down": [
        {
          disclosureBasic: {
            ...(RUBNS_LIST[3] as { disclosureBasic: object }).disclosureBasic,
            disclosureId: "oid-elsewhere",
            disclosureIndex: 19,
          },
        },
      ],
    });
    const again = await linkCorrections(store, { kap: up.client, now });
    expect(again.linked).toEqual([expect.objectContaining({ disclosure_id: 20, original_disclosure_id: 19 })]);
  });

  test("the range asked for: from the day after the period to the day of the correction", () => {
    expect(searchRange({ year: 2026, quarter: 2, published_at: "2026-08-17T20:12:56" })).toEqual({
      from: "2026-07-01",
      to: "2026-08-17",
    });
    expect(searchRange({ year: 2025, quarter: 4, published_at: "2026-04-20T10:00:00" })).toEqual({
      from: "2026-01-01",
      to: "2026-04-20",
    });
    expect(searchRange({ year: null, quarter: null, published_at: "2026-08-17T20:12:56" })).toEqual({
      from: "2026-05-20",
      to: "2026-08-17",
    });
  });

  test("a Q4 correction more than 90 days after the year end is looked for in two windows", async () => {
    see(30, {
      is_changed: "DUZENLENEN",
      related_disclosure_oid: "oid-q4",
      year: 2025,
      quarter: 4,
      published_at: "2026-04-20T10:00:00",
    });
    const { client, bodies } = fakeKap();
    await linkCorrections(store, { kap: client, now: () => new Date("2026-08-17T18:00:00Z") });
    expect(bodies.map((b) => [b.fromDate, b.toDate])).toEqual([
      ["01.01.2026", "31.03.2026"],
      ["01.04.2026", "20.04.2026"],
    ]);
  });
});

describe("versions", () => {
  test("a correction of a correction: three versions in order from any of them", async () => {
    see(10, { disclosure_oid: "oid-10" });
    see(11, { disclosure_oid: "oid-11", is_changed: "DUZENLENEN", related_disclosure_oid: "oid-10" });
    see(12, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-11", published_at: "2026-08-19T09:00:00" });
    await linkCorrections(store, { kap: fakeKap().client, now });
    const files = [10, 11, 12].map((id, i) =>
      put(`TST_${id}_2026_2.xls`, `<html>${id}</html>`, `2026-08-1${7 + i}T10:00:00Z`),
    );
    const expected = [
      { disclosure_id: 10, corrects: null, files: files.slice(0, 1) },
      { disclosure_id: 11, corrects: 10, files: files.slice(1, 2) },
      { disclosure_id: 12, corrects: 11, files: files.slice(2) },
    ];
    for (const id of [10, 11, 12]) expect(reportVersions(store, id)).toEqual(expected);
  });

  test("an original not found ends the chain at the correction", async () => {
    see(20, { is_changed: "DUZENLENEN", related_disclosure_oid: "oid-gone" });
    await linkCorrections(store, { kap: fakeKap().client, now });
    expect(reportVersions(store, 20)).toEqual([{ disclosure_id: 20, corrects: null, files: [] }]);
  });
});

test("the poller links new corrections after each poll", async () => {
  const { client } = fakeKap({ [RUBNS]: RUBNS_LIST });
  const linked = Promise.withResolvers<number[]>();
  const poller = startPolling(store, {
    kap: client,
    now,
    since: "2026-08-17",
    onLink: (r) => linked.resolve(r.linked.map((l) => l.disclosure_id)),
    schedule: () => () => {},
  });
  expect(await linked.promise).toEqual([1651056, CORRECTION]);
  await poller.stop();
  expect(correctionOf(store, CORRECTION)?.original_disclosure_id).toBe(ORIGINAL);
});
