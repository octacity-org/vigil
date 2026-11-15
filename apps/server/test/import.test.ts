/**
 * Importing an existing `data/raw/` folder into Zova (#180). Expected behaviour is issue #180, `docs/SCHEMA.md`
 * ("Importing `data/raw/`") and #177/#178; hashes and times are worked out here from the files the test writes, not
 * read back from the code under test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pending } from "../src/events.ts";
import { emptyQuarterImport, importQuarter, quarterDirs, quarterDownloadTime } from "../src/import.ts";
import { filesByDisclosure, filesByQuarter, storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { BANK, FIXTURES, fileName, GENERAL, HOLDING, kapHtml, writeRawFiles } from "./fixtures/index.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const at = (iso: string) => new Date(iso);
const setTime = (path: string, iso: string) => utimesSync(path, at(iso), at(iso));

let raw: string;
let quarter: string;
let store: Store;
let paths: string[];

beforeEach(() => {
  raw = mkdtempSync(join(tmpdir(), "vigil-import-"));
  paths = writeRawFiles(raw); // three fixtures, all 2026/2
  quarter = join(raw, "2026_2");
  for (const p of paths) setTime(p, "2026-10-20T08:00:00.000Z");
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => {
  store.close();
  rmSync(raw, { recursive: true, force: true });
});

describe("importing a quarter", () => {
  test("every file is stored byte for byte with one pending report_stored event", () => {
    const r = importQuarter(store, quarter);
    expect(r).toMatchObject({
      year: 2026,
      quarter: 2,
      imported: 3,
      new_versions: 0,
      skipped: 0,
      failed: [],
      error: null,
    });

    const files = filesByQuarter(store, 2026, 2);
    expect(files).toHaveLength(3);
    for (const path of paths) {
      const bytes = readFileSync(path);
      const f = files.find((x) => x.object_id === sha256(bytes));
      expect(f).toBeDefined();
      expect(store.getObject(f?.object_id as string)).toEqual(new Uint8Array(bytes));
      expect(f?.source_url).toBe(pathToFileURL(path).href);
      expect(f?.size_bytes).toBe(bytes.length);
    }

    const events = pending(store, "report_stored");
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.subject))).toEqual(new Set(files.map((f) => f.object_id)));
    for (const e of events) {
      const f = files.find((x) => x.object_id === e.subject);
      expect(e.payload).toEqual({
        disclosure_id: f?.disclosure_id,
        file_name: f?.file_name,
        source: "import",
        downloaded_at_source: "oldest file in the folder",
      });
    }
  });

  test("a second run imports nothing and emits nothing", () => {
    importQuarter(store, quarter);
    const again = importQuarter(store, quarter);
    expect(again).toMatchObject({ imported: 0, skipped: 3, new_versions: 0, failed: [] });
    expect(filesByQuarter(store, 2026, 2)).toHaveLength(3);
    expect(pending(store, "report_stored")).toHaveLength(3);
  });

  test("different bytes for a disclosure already stored are a new version with its own event", () => {
    importQuarter(store, quarter);
    const changed = `${kapHtml(GENERAL)}<!-- corrected -->`;
    writeFileSync(paths[0] as string, changed);
    setTime(paths[0] as string, "2026-10-20T08:00:00.000Z");
    const r = importQuarter(store, quarter);
    expect(r).toMatchObject({ imported: 1, new_versions: 1, skipped: 2 });
    const versions = filesByDisclosure(store, GENERAL.disclosureId);
    expect(versions.map((v) => v.object_id).sort()).toEqual([sha256(kapHtml(GENERAL)), sha256(changed)].sort());
    expect(pending(store, "report_stored").filter((e) => e.subject === sha256(changed))).toHaveLength(1);
  });

  test("an empty quarter folder imports nothing and has no download time", () => {
    const empty = join(raw, "2025_4");
    mkdirSync(empty);
    expect(importQuarter(store, empty)).toMatchObject({ imported: 0, failed: [], error: null, downloaded_at: null });
  });
});

describe("files that cannot be imported are listed, and the others continue", () => {
  test("a file whose name gives another quarter than its folder", () => {
    const misplaced = { ...HOLDING, disclosureId: 9_000_777, year: 2026, quarter: 1 };
    writeFileSync(join(quarter, fileName(misplaced)), kapHtml(misplaced));
    const r = importQuarter(store, quarter);
    expect(r.imported).toBe(3);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.file).toBe(fileName(misplaced));
    expect(r.failed[0]?.reason).toContain("2026/1");
    expect(filesByDisclosure(store, 9_000_777)).toEqual([]);
  });

  test("an .xls file whose name is not a KAP file name", () => {
    writeFileSync(join(quarter, "notes.xls"), "x");
    const r = importQuarter(store, quarter);
    expect(r.imported).toBe(3);
    expect(r.failed.map((f) => f.file)).toEqual(["notes.xls"]);
  });

  test("an .xls entry that is a folder", () => {
    mkdirSync(join(quarter, "TSTXX_9000999_2026_2.xls"));
    const r = importQuarter(store, quarter);
    expect(r.imported).toBe(3);
    expect(r.failed).toEqual([{ file: "TSTXX_9000999_2026_2.xls", reason: "not a file" }]);
  });

  test("a symbolic link that points nowhere", (done) => {
    const link = join(quarter, "TSTXX_9000998_2026_2.xls");
    try {
      symlinkSync(join(raw, "missing.xls"), link);
    } catch {
      done(); // creating links needs a privilege on some Windows set-ups
      return;
    }
    const r = importQuarter(store, quarter);
    expect(r.imported).toBe(3);
    expect(r.failed.map((f) => f.file)).toEqual(["TSTXX_9000998_2026_2.xls"]);
    done();
  });

  test("other files in the folder are ignored", () => {
    writeFileSync(join(quarter, "readme.txt"), "x");
    expect(importQuarter(store, quarter)).toMatchObject({ imported: 3, failed: [] });
  });

  test("an entry named like a quarter that is not a folder is a folder error", () => {
    const notDir = join(raw, "2025_3");
    writeFileSync(notDir, "x");
    const r = importQuarter(store, notDir);
    expect(r.imported).toBe(0);
    expect(r.error).not.toBeNull();
  });
});

describe("downloaded_at is when the quarter was downloaded, never the import time", () => {
  test("from {year}_{quarter}.zip next to the folder, before kap_{year}_{quarter}.zip and the files", () => {
    writeFileSync(join(raw, "2026_2.zip"), "z");
    setTime(join(raw, "2026_2.zip"), "2026-10-15T12:00:00.000Z");
    writeFileSync(join(raw, "kap_2026_2.zip"), "z");
    setTime(join(raw, "kap_2026_2.zip"), "2026-10-16T12:00:00.000Z");
    const r = importQuarter(store, quarter);
    expect(r.downloaded_at).toBe("2026-10-15T12:00:00.000Z");
    expect(r.downloaded_at_source).toBe(join(raw, "2026_2.zip"));
    for (const f of filesByQuarter(store, 2026, 2)) expect(f.downloaded_at).toBe("2026-10-15T12:00:00.000Z");
    expect(pending(store, "report_stored")[0]?.payload.downloaded_at_source).toBe(join(raw, "2026_2.zip"));
  });

  test("from kap_{year}_{quarter}.zip when there is no {year}_{quarter}.zip", () => {
    writeFileSync(join(raw, "kap_2026_2.zip"), "z");
    setTime(join(raw, "kap_2026_2.zip"), "2026-10-16T12:00:00.000Z");
    expect(quarterDownloadTime(quarter, paths)).toEqual({
      at: at("2026-10-16T12:00:00.000Z"),
      source: join(raw, "kap_2026_2.zip"),
    });
  });

  test("else from the oldest file in the folder", () => {
    setTime(paths[1] as string, "2026-10-18T07:30:00.000Z");
    const r = importQuarter(store, quarter);
    expect(r.downloaded_at).toBe("2026-10-18T07:30:00.000Z");
    expect(r.downloaded_at_source).toBe("oldest file in the folder");
  });

  test("a given time wins over the zip", () => {
    writeFileSync(join(raw, "2026_2.zip"), "z");
    setTime(join(raw, "2026_2.zip"), "2026-10-15T12:00:00.000Z");
    const r = importQuarter(store, quarter, { downloadedAt: at("2026-10-24T20:55:00.000Z") });
    expect(r).toMatchObject({ downloaded_at: "2026-10-24T20:55:00.000Z", downloaded_at_source: "given" });
  });

  test("a time in the future is refused and nothing is stored", () => {
    const r = importQuarter(store, quarter, { downloadedAt: new Date(Date.now() + 86_400_000) });
    expect(r.error).toContain("future");
    expect(r.imported).toBe(0);
    expect(filesByQuarter(store, 2026, 2)).toEqual([]);
    expect(pending(store, "report_stored")).toEqual([]);
  });

  test("a time before the quarter ended is refused; the first moment after it is accepted", () => {
    const early = importQuarter(store, quarter, { downloadedAt: at("2026-06-30T23:59:59.999Z") });
    expect(early.error).toContain("before 2026/2 ended");
    expect(filesByQuarter(store, 2026, 2)).toEqual([]);
    const ok = importQuarter(store, quarter, { downloadedAt: at("2026-07-01T00:00:00.000Z") });
    expect(ok).toMatchObject({ imported: 3, error: null });
  });

  test("a fourth quarter ends at the start of the next year", () => {
    const q4 = join(raw, "2025_4");
    writeRawFiles(raw, [{ ...BANK, year: 2025, quarter: 4 }]);
    expect(importQuarter(store, q4, { downloadedAt: at("2025-12-31T23:59:59.000Z") }).error).toContain(
      "before 2025/4 ended",
    );
    expect(importQuarter(store, q4, { downloadedAt: at("2026-01-01T00:00:00.000Z") }).imported).toBe(1);
  });
});

describe("the file and its event are written together", () => {
  test("a throw in onStored rolls the file back", () => {
    const bytes = new TextEncoder().encode(kapHtml(GENERAL));
    expect(() =>
      storeRawFile(
        store,
        bytes,
        { fileName: fileName(GENERAL), sourceUrl: "file:///x" },
        {
          onStored: () => {
            throw new Error("event failed");
          },
        },
      ),
    ).toThrow("event failed");
    expect(filesByDisclosure(store, GENERAL.disclosureId)).toEqual([]);
  });

  test("onStored is not called for a duplicate", () => {
    const bytes = new TextEncoder().encode(kapHtml(GENERAL));
    const source = { fileName: fileName(GENERAL), sourceUrl: "file:///x" };
    let calls = 0;
    const onStored = () => {
      calls++;
    };
    storeRawFile(store, bytes, source, { onStored });
    expect(storeRawFile(store, bytes, source, { onStored }).duplicate).toBe(true);
    expect(calls).toBe(1);
  });

  test("a store error part way is thrown; files stored before it keep their events and are counted", () => {
    let puts = 0;
    const failing: Store = {
      ...store,
      transaction: (fn) => store.transaction(() => fn(failing)),
      putObject: (data) => {
        if (++puts === 2) throw new Error("disk full");
        return store.putObject(data);
      },
    };
    const result = emptyQuarterImport(quarter);
    expect(() => importQuarter(failing, quarter, {}, result)).toThrow("disk full");
    expect(result.imported).toBe(1);
    expect(filesByQuarter(store, 2026, 2)).toHaveLength(1);
    expect(pending(store, "report_stored")).toHaveLength(1);
    // A re-run continues.
    expect(importQuarter(store, quarter)).toMatchObject({ imported: 2, skipped: 1 });
    expect(pending(store, "report_stored")).toHaveLength(3);
  });
});

describe("quarterDirs", () => {
  test("a quarter folder is itself; a raw folder lists its quarter folders in order", () => {
    writeRawFiles(raw, [{ ...BANK, year: 2025, quarter: 4 }]);
    mkdirSync(join(raw, "other"));
    expect(quarterDirs(quarter)).toEqual([quarter]);
    expect(quarterDirs(raw)).toEqual([join(raw, "2025_4"), quarter]);
  });

  test("an entry named like a quarter is listed even if it is not a folder, so it is reported", () => {
    writeFileSync(join(raw, "2025_3"), "x");
    expect(quarterDirs(raw)).toContain(join(raw, "2025_3"));
  });

  test("a missing folder, or one without quarter folders, is an error", () => {
    expect(() => quarterDirs(join(raw, "missing"))).toThrow();
    const empty = join(raw, "other");
    mkdirSync(empty);
    expect(() => quarterDirs(empty)).toThrow();
  });
});

describe("bun run import", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", join(REPO, "apps", "server", "src", "cli", "import.ts"), ...args], { cwd: raw });

  test("imports, prints the counts, and a second run skips everything", () => {
    const data = join(raw, "data");
    const first = run(raw, data);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain(`2026/2: ${FIXTURES.length} imported`);
    const second = run(raw, data);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain(`0 imported, ${FIXTURES.length} skipped, 0 failed`);
  });

  test("exits 1 when a file failed, after importing the others", () => {
    writeFileSync(join(quarter, "notes.xls"), "x");
    const r = run(raw, join(raw, "data"));
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("failed notes.xls");
    expect(r.stdout.toString()).toContain(`${FIXTURES.length} imported`);
  });

  test("wrong arguments exit 2 and create no store", () => {
    writeRawFiles(raw, [{ ...BANK, year: 2025, quarter: 4 }]);
    const data = join(raw, "data");
    expect(run(raw, data, "--downloaded-at=2026-10-24T20:55:00Z").exitCode).toBe(2); // one time, two quarters
    expect(run(quarter, data, "--downloaded-at=2026-02-30T00:00:00Z").exitCode).toBe(2);
    expect(run(quarter, data, "--downloaded-at=2099-01-01T00:00:00Z").exitCode).toBe(2);
    expect(run(quarter, data, "extra", "args").exitCode).toBe(2);
    expect(run(quarter, data).exitCode).toBe(0);
    expect(run(join(raw, "missing"), join(raw, "data2")).exitCode).toBe(1);
    expect(Bun.file(join(raw, "data2", "vigil.zova")).size).toBe(0);
  });
});
