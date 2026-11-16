/**
 * Downloading recorded disclosures (#203). KAP is fake and the zips synthetic, laid out like KAP's company zip
 * (`docs/kap.md`, "Single-company download"); no KAP content is committed. Expected behaviour: the issue's tasks and
 * "a disclosure ends up as a stored file and one event"; a failed download is retried later, not lost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KapClient } from "../src/kap.ts";
import { pendingDisclosures, startPolling } from "../src/poller.ts";
import { filesByDisclosure, storeRawFile } from "../src/raw-files.ts";
import { downloadPending, RETRY_BASE_MS, RETRY_MAX_MS, retryDelay } from "../src/report-downloads.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { makeZip } from "./fixtures/zip.ts";

const OID = "4028e4a14184e9cf01419c001e945a74";
const KATMR = 1651411;
const STATEMENT = "<html>KATMR 2026/2 statement</html>";
const ZIP = makeZip({
  [`KATMR_${KATMR}_2026_2.xls`]: STATEMENT,
  "Dönem2Ekler/(0)Katmerciler_30062026_TR.pdf": "%PDF footnotes",
});

/** A fake KAP: download requests get the next answer; the URLs asked for are kept. */
function fakeKap(...answers: (() => Response)[]) {
  const urls: string[] = [];
  const client = new KapClient({
    transport: async (url) => {
      urls.push(url);
      const next = answers[Math.min(urls.length, answers.length) - 1] as () => Response;
      return next();
    },
    sleep: async () => {},
  });
  return { client, urls };
}
const zip = (data: Buffer) => () => new Response(new Uint8Array(data));
const serverError = () => new Response("down", { status: 503 });

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

let clock = new Date("2026-08-17T17:00:00Z");
const now = () => clock;
beforeEach(() => {
  clock = new Date("2026-08-17T17:00:00Z");
});

/** Record a disclosure as the poller does. */
function see(id: number, fields: Record<string, unknown> = {}) {
  const d = {
    disclosure_oid: `oid-${id}`,
    mkk_member_oid: OID,
    stock_codes: '["KATMR"]',
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
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    [
      id,
      d.disclosure_oid,
      d.mkk_member_oid,
      d.stock_codes,
      d.year,
      d.quarter,
      d.published_at,
      d.is_changed,
      d.related_disclosure_oid,
      "2026-08-17T16:10:00Z",
    ],
  );
}
const row = (id: number) => store.query("SELECT * FROM seen_disclosures WHERE disclosure_id = ?1", [id])[0];
const events = () => store.query("SELECT type, payload FROM events ORDER BY id");

describe("done when: a disclosure ends up as a stored file and one event", () => {
  test("downloaded through KAP's company download, stored with its metadata, one event", async () => {
    see(KATMR);
    const { client, urls } = fakeKap(zip(ZIP));
    const r = await downloadPending(store, { kap: client, now });
    expect(urls).toEqual([`https://www.kap.org.tr/tr/api/home-financial/download-file/${OID}/2026/2`]);
    const [file] = filesByDisclosure(store, KATMR);
    expect(file).toMatchObject({ file_name: `KATMR_${KATMR}_2026_2.xls`, disclosure_id: KATMR });
    expect(r).toEqual({
      closed: [{ disclosure_id: KATMR, outcome: "stored", object_id: file?.object_id ?? null }],
      failed: [],
      downloads: 1,
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]?.type).toBe("report_stored");
    expect(row(KATMR)).toMatchObject({ outcome: "stored", object_id: file?.object_id, attempts: 0n });
    expect(row(KATMR)?.handled_at).toBe(clock.toISOString());
  });

  test("a second run asks KAP nothing and emits nothing", async () => {
    see(KATMR);
    const { client, urls } = fakeKap(zip(ZIP));
    await downloadPending(store, { kap: client, now });
    const again = await downloadPending(store, { kap: client, now });
    expect(again).toEqual({ closed: [], failed: [], downloads: 0 });
    expect([urls.length, events().length]).toEqual([1, 1]);
  });

  test("a file already stored (a bulk import) is closed as a duplicate, with no second event", async () => {
    storeRawFile(store, new TextEncoder().encode(STATEMENT), {
      fileName: `KATMR_${KATMR}_2026_2.xls`,
      sourceUrl: "bulk",
      downloadedAt: clock,
    });
    see(KATMR);
    const { client } = fakeKap(zip(ZIP));
    const r = await downloadPending(store, { kap: client, now });
    expect(r.closed.map((c) => c.outcome)).toEqual(["duplicate"]);
    expect(events()).toHaveLength(0);
  });
});

describe("a failed download is retried later, not lost", () => {
  test("KAP down: kept with its error and a time to try again; then stored, with one event", async () => {
    see(KATMR);
    const down = fakeKap(serverError);
    const r = await downloadPending(store, { kap: down.client, now, retries: 1 });
    expect(r.closed).toEqual([]);
    expect(r.failed).toMatchObject([{ disclosure_id: KATMR, attempts: 1 }]);
    expect(r.failed[0]?.error).toContain("503");
    const retryAt = new Date(clock.getTime() + RETRY_BASE_MS).toISOString();
    expect(row(KATMR)).toMatchObject({ handled_at: null, attempts: 1n, retry_after: retryAt });

    // Before the wait is over it is not asked for again.
    clock = new Date(clock.getTime() + RETRY_BASE_MS - 1000);
    expect(pendingDisclosures(store, 100, clock)).toEqual([]);
    expect((await downloadPending(store, { kap: down.client, now })).downloads).toBe(0);
    // Without a clock (the poller's own view) it is still pending.
    expect(pendingDisclosures(store).map((d) => d.disclosure_id)).toEqual([KATMR]);

    clock = new Date(clock.getTime() + 2000);
    const up = fakeKap(zip(ZIP));
    const later = await downloadPending(store, { kap: up.client, now });
    expect(later.closed.map((c) => c.outcome)).toEqual(["stored"]);
    expect(row(KATMR)).toMatchObject({ outcome: "stored", attempts: 1n, last_error: null, retry_after: null });
    expect(events()).toHaveLength(1);
  });

  test("each failure is counted and waits longer", async () => {
    see(KATMR);
    const down = fakeKap(serverError);
    await downloadPending(store, { kap: down.client, now, retries: 1 });
    clock = new Date(clock.getTime() + RETRY_BASE_MS);
    await downloadPending(store, { kap: down.client, now, retries: 1 });
    const retryAt = new Date(clock.getTime() + 2 * RETRY_BASE_MS).toISOString();
    expect(row(KATMR)).toMatchObject({ attempts: 2n, retry_after: retryAt, handled_at: null });
  });

  test("a zip cut off before its file: kept for a retry as incomplete", async () => {
    see(KATMR);
    // Pseudo-random, so it does not compress and the cut falls inside it, before the statement file.
    let x = 7;
    const noise = new Uint8Array(20_000).map(() => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return x >>> 16;
    });
    const full = makeZip({ "Dönem2Ekler/(0)notes.pdf": noise, [`KATMR_${KATMR}_2026_2.xls`]: STATEMENT });
    const { client } = fakeKap(zip(full.subarray(0, 10_000)));
    const r = await downloadPending(store, { kap: client, now, retries: 1 });
    expect(r.failed[0]?.error).toStartWith("incomplete zip after 1 attempts");
    expect(row(KATMR)?.handled_at).toBeNull();
  });

  test("the wait doubles with each failure, up to a day", () => {
    expect([1, 2, 3].map(retryDelay)).toEqual([RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS]);
    expect(retryDelay(30)).toBe(RETRY_MAX_MS);
    expect(RETRY_MAX_MS).toBe(24 * 60 * 60_000);
  });

  test("its file missing from the company's zip: kept for a retry, naming what came", async () => {
    see(KATMR);
    const other = makeZip({ "KATMR_1651999_2026_2.xls": STATEMENT });
    const { client } = fakeKap(zip(other));
    const r = await downloadPending(store, { kap: client, now });
    expect(r.failed[0]?.error).toBe("its file is not in the company's download (got: KATMR_1651999_2026_2.xls)");
    expect(row(KATMR)?.handled_at).toBeNull();
  });
});

describe("other outcomes", () => {
  test("other pending disclosures in the same zip are closed with it: one request", async () => {
    see(KATMR);
    see(KATMR + 1, { published_at: "2026-08-17T19:06:00" }); // the solo statement
    const both = makeZip({
      [`KATMR_${KATMR}_2026_2.xls`]: STATEMENT,
      [`KATMR_${KATMR + 1}_2026_2.xls`]: "<html>solo</html>",
    });
    const { client, urls } = fakeKap(zip(both));
    const r = await downloadPending(store, { kap: client, now });
    expect(r.closed.map((c) => [c.disclosure_id, c.outcome])).toEqual([
      [KATMR, "stored"],
      [KATMR + 1, "stored"],
    ]);
    expect([urls.length, events().length]).toEqual([1, 2]);
  });

  test("a disclosure KAP has replaced by its correction is closed as superseded", async () => {
    see(KATMR, { disclosure_oid: "oid-original" });
    see(KATMR + 5, {
      is_changed: "DUZENLENEN",
      related_disclosure_oid: "oid-original",
      published_at: "2026-08-18T10:00:00",
    });
    const onlyCorrection = makeZip({ [`KATMR_${KATMR + 5}_2026_2.xls`]: "<html>corrected</html>" });
    const { client, urls } = fakeKap(zip(onlyCorrection));
    const r = await downloadPending(store, { kap: client, now });
    expect(r.closed.map((c) => [c.disclosure_id, c.outcome])).toEqual([
      [KATMR + 5, "stored"],
      [KATMR, "superseded"],
    ]);
    expect(row(KATMR)?.last_error).toBe(`KAP offers its correction ${KATMR + 5} instead`);
    expect(urls).toHaveLength(1);
  });

  test("a disclosure that cannot be resolved is closed with the reason, without asking KAP", async () => {
    see(KATMR, { stock_codes: "[]" });
    const { client, urls } = fakeKap(zip(ZIP));
    const r = await downloadPending(store, { kap: client, now });
    expect(r.closed).toEqual([{ disclosure_id: KATMR, outcome: "unresolved", object_id: null }]);
    expect(String(row(KATMR)?.last_error)).toStartWith("no_stock_code:");
    expect(urls).toEqual([]);
  });
});

test("the poller downloads after each poll when asked to", async () => {
  const list = [
    {
      disclosureBasic: {
        title: "Finansal Rapor",
        mkkMemberOid: OID,
        companyTitle: "KATMERCİLER A.Ş.",
        stockCode: "KATMR",
        disclosureClass: "FR",
        publishDate: "17.08.2026 19:05:18",
        disclosureId: "oid-katmr",
        disclosureIndex: KATMR,
        year: 2026,
        donem: 2,
        isChanged: null,
        relatedDisclosureOid: null,
        isLate: false,
      },
    },
  ];
  const urls: string[] = [];
  const client = new KapClient({
    transport: async (url) => {
      urls.push(url);
      return url.includes("disclosure/list") ? new Response(JSON.stringify(list)) : zip(ZIP)();
    },
    sleep: async () => {},
  });
  let downloaded: unknown = null;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const poller = startPolling(store, {
    kap: client,
    now: () => new Date("2026-08-17T17:00:00Z"),
    since: "2026-08-17",
    download: true,
    onDownload: (r) => {
      downloaded = r;
      done();
    },
    schedule: () => () => {},
  });
  await finished;
  await poller.stop();
  expect(urls.map((u) => u.split("/api/")[1]?.split("/")[0])).toEqual(["disclosure", "home-financial"]);
  expect(downloaded).toMatchObject({ closed: [{ disclosure_id: KATMR, outcome: "stored" }] });
  expect(events()).toHaveLength(1);
});
