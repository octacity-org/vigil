/**
 * The first download of chosen quarters (#206). The server is fake and the zips synthetic; no KAP content. Expected
 * behaviour: the issue's tasks (download and store, progress, resume after a restart) and "stopping and restarting
 * continues where it stopped".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KapClient } from "../src/kap.ts";
import { chooseQuarters, type Progress, quarterDownloads, runQuarterDownloads } from "../src/quarter-downloads.ts";
import { filesByQuarter } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { makeZip } from "./fixtures/zip.ts";

const zipOf = (year: number, quarter: number, n: number) =>
  makeZip(
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `CO${i}_${year}${quarter}0${i}_${year}_${quarter}.xls`,
        `${year}/${quarter} file ${i}`,
      ]),
    ),
  );
const Q1 = { year: 2026, quarter: 1 };
const Q2 = { year: 2026, quarter: 2 };
const url = (q: { year: number; quarter: number }) =>
  `https://www.kap.org.tr/tr/api/financialTable/download/${q.year}/${q.quarter}`;

/** A fake KAP serving each quarter's zip from `zips`; a missing quarter answers 500. */
function fakeKap(zips: Record<string, () => Buffer>) {
  const urls: string[] = [];
  const client = new KapClient({
    transport: async (u) => {
      urls.push(u);
      const key = u.split("/").slice(-2).join("/");
      const make = zips[key];
      return make ? new Response(new Uint8Array(make())) : new Response('{"success":false}', { status: 500 });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

let store: Store;
let raw: string;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
  raw = mkdtempSync(join(tmpdir(), "vigil-quarters-"));
});
afterEach(() => {
  store.close();
  rmSync(raw, { recursive: true, force: true });
});

const now = () => new Date("2026-11-01T08:00:00Z");
const base = { rawDir: "", sleep: async () => {}, retries: 2, now };
const opts = (client: KapClient, more: Record<string, unknown> = {}) => ({
  ...base,
  rawDir: raw,
  kap: client,
  ...more,
});
const status = () => quarterDownloads(store).map((q) => [`${q.year}/${q.quarter}`, q.status]);

describe("chooseQuarters", () => {
  test("adds each chosen quarter once, pending", () => {
    expect(chooseQuarters(store, [Q2, Q1], now())).toEqual([Q2, Q1]);
    expect(chooseQuarters(store, [Q2], now())).toEqual([]);
    expect(quarterDownloads(store).map((q) => [q.year, q.quarter, q.status, q.requested_at, q.attempts])).toEqual([
      [2026, 1, "pending", "2026-11-01T08:00:00.000Z", 0],
      [2026, 2, "pending", "2026-11-01T08:00:00.000Z", 0],
    ]);
  });

  test("a quarter KAP has no bulk file for is refused, and nothing is added", () => {
    expect(() => chooseQuarters(store, [Q1, { year: 2026, quarter: 5 }])).toThrow(RangeError);
    expect(() => chooseQuarters(store, [{ year: 2008, quarter: 4 }])).toThrow(RangeError);
    expect(quarterDownloads(store)).toEqual([]);
  });
});

describe("runQuarterDownloads", () => {
  test("downloads and stores every chosen quarter, oldest first, reporting progress", async () => {
    const { client, urls } = fakeKap({ "2026/1": () => zipOf(2026, 1, 2), "2026/2": () => zipOf(2026, 2, 3) });
    chooseQuarters(store, [Q2, Q1]);
    const seen: Progress[] = [];
    const result = await runQuarterDownloads(store, opts(client, { onProgress: (p: Progress) => seen.push(p) }));
    expect(urls).toEqual([url(Q1), url(Q2)]);
    expect(result.map((q) => [q.status, q.attempts, q.files_stored, q.files_lost, q.error])).toEqual([
      ["done", 1, 2, 0, null],
      ["done", 1, 3, 0, null],
    ]);
    expect([filesByQuarter(store, 2026, 1).length, filesByQuarter(store, 2026, 2).length]).toEqual([2, 3]);
    expect(store.query("SELECT count(*) AS n FROM events WHERE type = 'report_stored'")).toEqual([{ n: 5n }]);
    expect(
      seen.map(
        (p) =>
          `${p.quarter} ${p.phase} ${p.files_done}/${p.files_total} q${p.quarters_done}/${p.quarters_total} e${p.errors}`,
      ),
    ).toEqual([
      "1 downloading 0/0 q0/2 e0",
      "1 storing 1/2 q0/2 e0",
      "1 storing 2/2 q0/2 e0",
      "1 done 2/2 q1/2 e0",
      "2 downloading 0/0 q1/2 e0",
      "2 storing 1/3 q1/2 e0",
      "2 storing 2/3 q1/2 e0",
      "2 storing 3/3 q1/2 e0",
      "2 done 3/3 q2/2 e0",
    ]);
  });

  test("stopped after a quarter, a restart continues with the next one only", async () => {
    const { client, urls } = fakeKap({ "2026/1": () => zipOf(2026, 1, 2), "2026/2": () => zipOf(2026, 2, 2) });
    chooseQuarters(store, [Q1, Q2]);
    const stop = new AbortController();
    await runQuarterDownloads(
      store,
      opts(client, { signal: stop.signal, onProgress: (p: Progress) => p.phase === "done" && stop.abort() }),
    );
    expect(status()).toEqual([
      ["2026/1", "done"],
      ["2026/2", "pending"],
    ]);
    await runQuarterDownloads(store, opts(client));
    expect(urls).toEqual([url(Q1), url(Q2)]);
    expect(status()).toEqual([
      ["2026/1", "done"],
      ["2026/2", "done"],
    ]);
  });

  test("a quarter stopped part way starts again; files stored before the stop are not stored twice", async () => {
    const { client } = fakeKap({ "2026/1": () => zipOf(2026, 1, 4) });
    chooseQuarters(store, [Q1]);
    // The process stops (here: the store fails) after two files.
    let puts = 0;
    const failing: Store = {
      ...store,
      transaction: (fn) =>
        store.transaction((s) =>
          fn({
            ...s,
            putObject: (data) => {
              puts += 1;
              if (puts > 2) throw new Error("disk full");
              return s.putObject(data);
            },
          }),
        ),
    };
    await expect(runQuarterDownloads(failing, opts(client))).rejects.toThrow("disk full");
    expect(status()).toEqual([["2026/1", "running"]]);
    expect(filesByQuarter(store, 2026, 1)).toHaveLength(2);

    const [q] = await runQuarterDownloads(store, opts(client));
    expect([q?.status, q?.attempts, q?.files_stored, q?.files_skipped]).toEqual(["done", 2, 2, 2]);
    expect(filesByQuarter(store, 2026, 1)).toHaveLength(4);
    expect(store.query("SELECT count(*) AS n FROM events")).toEqual([{ n: 4n }]);
  });

  test("a quarter whose zip is never complete is incomplete, keeps what it got, and is tried again", async () => {
    let cut = true;
    const full = zipOf(2026, 1, 3);
    // Cut inside the last member's data: the first two files are complete, the third is lost.
    const { client, urls } = fakeKap({
      "2026/1": () => (cut ? full.subarray(0, full.indexOf("PK", 0, "latin1") - 5) : full),
    });
    chooseQuarters(store, [Q1]);
    const seen: Progress[] = [];
    const [q] = await runQuarterDownloads(store, opts(client, { onProgress: (p: Progress) => seen.push(p) }));
    expect(q?.status).toBe("incomplete");
    expect(q?.files_lost).toBeGreaterThan(0);
    expect(q?.error).toContain("lost");
    expect(seen.at(-1)).toMatchObject({ phase: "incomplete", errors: q?.files_lost });

    cut = false;
    const before = urls.length;
    const [again] = await runQuarterDownloads(store, opts(client));
    expect(urls.length).toBeGreaterThan(before);
    // Files stored counts every attempt: two the first time, the lost one now.
    expect([again?.status, again?.files_lost, again?.error, again?.attempts, again?.files_stored]).toEqual([
      "done",
      0,
      null,
      2,
      3,
    ]);
    expect(filesByQuarter(store, 2026, 1)).toHaveLength(3);
  });

  test("a quarter KAP has no file for fails with the reason; the others still run", async () => {
    const { client } = fakeKap({ "2026/2": () => zipOf(2026, 2, 1) });
    chooseQuarters(store, [Q1, Q2]);
    const seen: Progress[] = [];
    const result = await runQuarterDownloads(store, opts(client, { onProgress: (p: Progress) => seen.push(p) }));
    expect(result.map((q) => [q.quarter, q.status])).toEqual([
      [1, "failed"],
      [2, "done"],
    ]);
    expect(result[0]?.error).toContain("HTTP 500");
    expect(seen.at(-1)).toMatchObject({ phase: "done", quarters_done: 2, errors: 1 });
  });

  test("with nothing chosen, nothing is asked for", async () => {
    const { client, urls } = fakeKap({});
    expect(await runQuarterDownloads(store, opts(client))).toEqual([]);
    expect(urls).toEqual([]);
  });
});
