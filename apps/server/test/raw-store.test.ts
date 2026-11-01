/** Raw KAP files in the Zova archive (#176). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ParseError } from "@vigil/core";
import { filesByCompany, filesByDisclosure, filesByQuarter, readRawFile, storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { BANK, fileName, GENERAL, HOLDING, kapHtml } from "./fixtures/index.ts";

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

const bytes = (s: string) => new TextEncoder().encode(s);
const URL_2026_2 = "https://www.kap.org.tr/tr/api/financialTable/download/2026/2";

test("a stored file keeps its identity, size, hash, time and source", () => {
  const content = bytes(kapHtml(GENERAL));
  const at = new Date("2026-08-18T06:00:00Z");
  const file = storeRawFile(store, content, { fileName: fileName(GENERAL), sourceUrl: URL_2026_2, downloadedAt: at });
  expect(file).toMatchObject({
    object_id: createHash("sha256").update(content).digest("hex"),
    disclosure_id: GENERAL.disclosureId,
    company_code: "TSTGN",
    raw_ticker_group: "TSTGN",
    year: 2026,
    quarter: 2,
    file_name: fileName(GENERAL),
    size_bytes: content.length,
    downloaded_at: "2026-08-18T06:00:00.000Z",
    source_url: URL_2026_2,
  });
  expect(readRawFile(store, file)).toEqual(content);
});

test("a file can be found by disclosure, company and quarter", () => {
  for (const f of [GENERAL, BANK, HOLDING]) {
    storeRawFile(store, bytes(kapHtml(f)), { fileName: fileName(f), sourceUrl: URL_2026_2 });
  }
  storeRawFile(store, bytes("2026/1 file"), { fileName: "TSTGN_8000001_2026_1.xls", sourceUrl: "file:///raw" });

  expect(filesByDisclosure(store, BANK.disclosureId).map((f) => f.company_code)).toEqual(["TSTBN"]);
  expect(filesByCompany(store, "tstgn").map((f) => [f.year, f.quarter])).toEqual([
    [2026, 1],
    [2026, 2],
  ]);
  expect(filesByQuarter(store, 2026, 2).map((f) => f.company_code)).toEqual(["TSTBN", "TSTGN", "TSTHD"]);
  expect(filesByQuarter(store, 2025, 4)).toEqual([]);
});

test("a ticker group is stored under its first code", () => {
  const file = storeRawFile(store, bytes("x"), { fileName: "A1CAP-ACP_1645514_2026_2.xls", sourceUrl: URL_2026_2 });
  expect([file.company_code, file.raw_ticker_group]).toEqual(["A1CAP", "A1CAP-ACP"]);
  expect(filesByCompany(store, "A1CAP")).toHaveLength(1);
});

test("a path is reduced to the file name", () => {
  const file = storeRawFile(store, bytes("x"), {
    fileName: "data/raw/2026_2/TSTGN_9000001_2026_2.xls",
    sourceUrl: "file:///data/raw/2026_2/TSTGN_9000001_2026_2.xls",
  });
  expect(file.file_name).toBe("TSTGN_9000001_2026_2.xls");
});

test("a name that is not a KAP file name stores nothing", () => {
  expect(() => storeRawFile(store, bytes("x"), { fileName: "notes.txt", sourceUrl: "file:///notes.txt" })).toThrow(
    ParseError,
  );
  expect(store.query("SELECT count(*) AS n FROM raw_files")).toEqual([{ n: 0n }]);
});

test("versions of one disclosure are listed oldest download first", () => {
  const name = fileName(GENERAL);
  storeRawFile(store, bytes("corrected"), {
    fileName: name,
    sourceUrl: URL_2026_2,
    downloadedAt: new Date("2026-09-01"),
  });
  storeRawFile(store, bytes("first"), { fileName: name, sourceUrl: URL_2026_2, downloadedAt: new Date("2026-08-18") });
  expect(
    filesByDisclosure(store, GENERAL.disclosureId).map((f) => new TextDecoder().decode(readRawFile(store, f))),
  ).toEqual(["first", "corrected"]);
});
