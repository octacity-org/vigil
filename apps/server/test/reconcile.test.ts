/**
 * Reconciling with the quarter's bulk archive (#205). KAP is fake and the zips synthetic, laid out like KAP's bulk zip
 * (`docs/kap.md`, "What the zip contains"); no KAP content is committed. Expected behaviour: the issue's tasks (compare,
 * store what is missing, report differences, on demand and once a day) and "a deliberately missing file is found and
 * stored".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KapClient } from "../src/kap.ts";
import { filesByDisclosure, filesByQuarter, readRawFile, storeRawFile } from "../src/raw-files.ts";
import {
  dueQuarters,
  RECONCILE_CHECK_MS,
  RECONCILE_EVERY_MS,
  reconcileQuarter,
  reconciliations,
  startReconciling,
} from "../src/reconcile.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { makeZip } from "./fixtures/zip.ts";

const A = "KATMR_1651411_2026_2.xls";
const B = "ATA-ATAYM_1651692_2026_2.xls";
const C = "RUBNS_1651540_2026_2.xls";
const ARCHIVE = { [A]: "<html>A bulk</html>", [B]: "<html>B bulk</html>", [C]: "<html>C bulk</html>" };
const URL = "https://www.kap.org.tr/tr/api/financialTable/download/2026/2";

/** A fake KAP: every request gets the next answer (the last one repeats); the URLs asked for are kept. */
function fakeKap(...answers: (() => Response)[]) {
  const urls: string[] = [];
  const client = new KapClient({
    transport: async (url) => {
      urls.push(url);
      return (answers[Math.min(urls.length, answers.length) - 1] as () => Response)();
    },
    sleep: async () => {},
  });
  return { client, urls };
}
const zip = (members: Record<string, string>) => () => new Response(new Uint8Array(makeZip(members)));
const cut = (members: Record<string, string>) => () => {
  const z = makeZip(members);
  return new Response(new Uint8Array(z.subarray(0, Math.floor(z.length * 0.6))));
};
const noFile = () => new Response('{"success": false}', { status: 500 });

let store: Store;
let raw: string;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
  raw = mkdtempSync(join(tmpdir(), "vigil-reconcile-"));
});
afterEach(() => {
  store.close();
  rmSync(raw, { recursive: true, force: true });
});

let clock = new Date("2026-11-10T03:00:00Z");
const now = () => clock;
beforeEach(() => {
  clock = new Date("2026-11-10T03:00:00Z");
});
const options = (kap: KapClient) => ({ kap, rawDir: raw, now, retries: 2, sleep: async () => {} });

/** A file the collector stored earlier from the company download: other bytes than the bulk file. */
function put(name: string, html = `<html>${name} company download</html>`) {
  return storeRawFile(store, new TextEncoder().encode(html), {
    fileName: name,
    sourceUrl: "https://www.kap.org.tr/tr/api/home-financial/download-file/x/2026/2",
    downloadedAt: new Date("2026-08-18T08:00:00Z"),
  }).file;
}

/** Record a disclosure as the poller does. */
function see(id: number, fields: Record<string, unknown> = {}) {
  const d = { published_at: "2026-08-17T19:05:18", year: 2026, quarter: 2, is_changed: null, ...fields };
  store.run(
    `INSERT INTO seen_disclosures (disclosure_id, disclosure_oid, mkk_member_oid, stock_codes, year, quarter,
       published_at, is_changed, seen_at)
     VALUES (?1, ?2, 'oid-company', '["TST"]', ?3, ?4, ?5, ?6, '2026-08-17T16:10:00Z')`,
    [id, `oid-${id}`, d.year, d.quarter, d.published_at, d.is_changed],
  );
}
const seenRow = (id: number) =>
  store.query("SELECT handled_at, outcome, object_id, last_error FROM seen_disclosures WHERE disclosure_id = ?1", [
    id,
  ])[0];
const events = () =>
  store
    .query("SELECT subject, payload FROM events WHERE type = 'report_stored' ORDER BY id")
    .map((r) => ({ subject: String(r.subject), ...JSON.parse(String(r.payload)) }));

describe("done when: a deliberately missing file is found and stored", () => {
  test("the file the collector missed is stored with its event; the others are left alone", async () => {
    put(A);
    put(B);
    const before = events().length;
    const { client, urls } = fakeKap(zip(ARCHIVE));
    const r = await reconcileQuarter(store, 2026, 2, options(client));

    expect(urls).toEqual([URL]);
    expect(r).toMatchObject({
      year: 2026,
      quarter: 2,
      complete: true,
      in_archive: 3,
      stored: [{ disclosure_id: 1651540, file_name: C }],
      already_stored: 2,
      lost: [],
      failed: [],
      error: null,
    });
    const [c] = filesByDisclosure(store, 1651540);
    expect(new TextDecoder().decode(readRawFile(store, c as never))).toBe(ARCHIVE[C]);
    expect([c?.source_url, c?.downloaded_at]).toEqual([URL, clock.toISOString()]);
    expect(events().slice(before)).toEqual([
      expect.objectContaining({ subject: c?.object_id, disclosure_id: 1651540, file_name: C, source: "download" }),
    ]);
    // The bulk bytes of A and B differ from the stored ones only in whitespace: no new version.
    expect(filesByQuarter(store, 2026, 2)).toHaveLength(3);
    expect(reconciliations(store)).toEqual([r]);
  });

  test("a second run finds nothing missing and stores nothing", async () => {
    const { client } = fakeKap(zip(ARCHIVE));
    const first = await reconcileQuarter(store, 2026, 2, options(client));
    expect(first.stored).toHaveLength(3);
    clock = new Date("2026-11-11T03:00:00Z");
    const before = events().length;
    const second = await reconcileQuarter(store, 2026, 2, options(client));
    expect([second.stored, second.already_stored, events().length]).toEqual([[], 3, before]);
    expect(reconciliations(store).map((x) => x.ran_at)).toEqual([second.ran_at, first.ran_at]);
  });
});

describe("recorded disclosures", () => {
  test("a recorded disclosure not downloaded yet is closed with the archive's file", async () => {
    put(A);
    see(1651540);
    see(1651411);
    const { client } = fakeKap(zip(ARCHIVE));
    await reconcileQuarter(store, 2026, 2, options(client));
    expect(seenRow(1651540)).toEqual({
      handled_at: clock.toISOString(),
      outcome: "stored",
      object_id: filesByDisclosure(store, 1651540)[0]?.object_id ?? "none",
      last_error: "from the quarter's bulk archive",
    });
    expect(seenRow(1651411)).toMatchObject({
      outcome: "duplicate",
      object_id: filesByDisclosure(store, 1651411)[0]?.object_id,
    });
  });

  test("a disclosure already closed keeps its outcome", async () => {
    put(A);
    see(1651411);
    store.run("UPDATE seen_disclosures SET handled_at = 'earlier', outcome = 'stored' WHERE disclosure_id = 1651411");
    const { client } = fakeKap(zip(ARCHIVE));
    await reconcileQuarter(store, 2026, 2, options(client));
    expect(seenRow(1651411)).toMatchObject({ handled_at: "earlier", outcome: "stored", last_error: null });
  });
});

describe("differences", () => {
  test("disclosures Vigil has that the archive does not are listed, corrected ones marked", async () => {
    put("RUBNS_1646921_2026_2.xls"); // the original of C, kept when it was first seen
    store.run(
      "INSERT INTO corrections VALUES (1651540, 1646921, 'oid-1646921', '2026-08-17T18:00:00Z', 'recorded by the collector')",
    );
    see(1650000); // a bank: recorded, its company's file never in the bulk zip
    see(1650001, { is_changed: "DUZELTILEN" });
    see(1650002, { year: 2026, quarter: 1 }); // another quarter
    put("TSTQ_1640000_2026_1.xls"); // stored, of another quarter
    const { client } = fakeKap(zip(ARCHIVE));
    const r = await reconcileQuarter(store, 2026, 2, options(client));
    expect(r.not_in_archive).toEqual([
      { disclosure_id: 1646921, stored: true, corrected: true },
      { disclosure_id: 1650000, stored: false, corrected: false },
      { disclosure_id: 1650001, stored: false, corrected: true },
    ]);
  });

  test("a cut-off archive: what was read is stored, the lost files are listed, nothing is called not in the archive", async () => {
    see(1650000);
    const big = { ...ARCHIVE, "ZZZ_1659999_2026_2.xls": "x".repeat(20_000) };
    const { client, urls } = fakeKap(cut(big));
    const r = await reconcileQuarter(store, 2026, 2, options(client));
    expect(urls).toHaveLength(2); // retried from the start
    expect(r.complete).toBe(false);
    expect(r.stored.length).toBeGreaterThan(0);
    expect(r.stored.length + r.lost.length).toBeLessThanOrEqual(4);
    expect(r.not_in_archive).toEqual([]);
  });

  test("no archive from KAP: the run is kept with the error, nothing is stored", async () => {
    put(A);
    const { client } = fakeKap(noFile);
    const r = await reconcileQuarter(store, 2026, 2, options(client));
    expect(r).toMatchObject({ complete: false, in_archive: 0, stored: [], not_in_archive: [] });
    expect(r.error).not.toBeNull();
    expect(reconciliations(store, { year: 2026, quarter: 2 })).toEqual([r]);
    expect(reconciliations(store, { year: 2026, quarter: 1 })).toEqual([]);
  });

  test("a file in the archive whose name is not a KAP file name is listed as failed", async () => {
    const { client } = fakeKap(zip({ [A]: "<html>A</html>", "notes.xls": "<html>?</html>" }));
    const r = await reconcileQuarter(store, 2026, 2, options(client));
    expect(r.stored.map((s) => s.file_name)).toEqual([A]);
    expect(r.failed).toEqual([{ file: "notes.xls", reason: expect.stringContaining("ParseError") }]);
  });
});

describe("once a day", () => {
  test("due: quarters with reports recorded in the last 120 days, not reconciled in the last day", async () => {
    see(1, { published_at: "2026-08-17T19:05:18" }); // 2026/2
    see(2, { published_at: "2026-10-30T10:00:00", year: 2026, quarter: 3 });
    see(3, { published_at: "2026-05-11T10:00:00", year: 2026, quarter: 1 }); // more than 120 days ago
    expect(dueQuarters(store, clock)).toEqual([
      { year: 2026, quarter: 2 },
      { year: 2026, quarter: 3 },
    ]);
    const { client } = fakeKap(zip(ARCHIVE));
    await reconcileQuarter(store, 2026, 2, options(client));
    expect(dueQuarters(store, new Date(clock.getTime() + RECONCILE_EVERY_MS - 1))).toEqual([
      { year: 2026, quarter: 3 },
    ]);
    expect(dueQuarters(store, new Date(clock.getTime() + RECONCILE_EVERY_MS + 1))).toEqual([
      { year: 2026, quarter: 2 },
      { year: 2026, quarter: 3 },
    ]);
  });

  test("the scheduler reconciles each due quarter once, and looks again every hour", async () => {
    see(1651540);
    const { client, urls } = fakeKap(zip(ARCHIVE));
    const scheduled: [() => void, number][] = [];
    const seen: string[] = [];
    let ticked = Promise.withResolvers<void>();
    const r = startReconciling(store, {
      ...options(client),
      onReconcile: (x) => seen.push(`${x.year}/${x.quarter}: ${x.stored.length} stored`),
      schedule: (fn, ms) => {
        scheduled.push([fn, ms]);
        ticked.resolve();
        return () => {};
      },
    });
    await ticked.promise;
    expect(seen).toEqual(["2026/2: 3 stored"]);
    expect(scheduled.map(([, ms]) => ms)).toEqual([RECONCILE_CHECK_MS]);

    // An hour later: done today, nothing to ask KAP.
    clock = new Date(clock.getTime() + RECONCILE_CHECK_MS);
    ticked = Promise.withResolvers<void>();
    scheduled[0]?.[0]();
    await ticked.promise;
    expect(urls).toHaveLength(1);
    await r.stop();
  });
});
