/**
 * Single-company download (#164). The server is fake and the zips synthetic, laid out like KAP's company zip
 * (`docs/kap.md`, "Single-company download"): statement files at the top, PDFs under `Dönem{N}Ekler/`. No KAP content
 * is committed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { companyMembers, downloadCompanyReport } from "../src/company-download.ts";
import { readZip } from "../src/downloader.ts";
import { KapClient } from "../src/kap.ts";
import { filesByDisclosure, readRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { makeZip } from "./fixtures/zip.ts";

const OID = "4028e4a14184e9cf01419c001e945a74";
const PERIOD = { mkkMemberOid: OID, year: 2026, quarter: 2 };
const URL = `https://www.kap.org.tr/tr/api/home-financial/download-file/${OID}/2026/2`;

const STATEMENT = "<html>KATMR 2026/2 statement</html>";
// Pseudo-random, so it does not compress to a few bytes and a cut can fall inside it.
const PDF = (() => {
  let x = 12345;
  return new Uint8Array(5000).map(() => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x >>> 16;
  });
})();
const ZIP = makeZip({
  "KATMR_1651411_2026_2.xls": STATEMENT,
  "Dönem2Ekler/(0)Katmerciler_30062026_TR.pdf": PDF,
});

/** A fake KAP: each request gets the next answer; the URLs asked for are kept. */
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
const zipResponse = (data: Buffer) => () => new Response(new Uint8Array(data));

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

const now = () => new Date("2026-08-18T06:00:00Z");
const events = () => store.query("SELECT type, subject, payload FROM events ORDER BY id");
const attachments = () => store.query("SELECT * FROM raw_attachments ORDER BY path");

describe("companyMembers", () => {
  test("lists the company's statement files for the period by its member id", async () => {
    const { client, urls } = fakeKap(
      () =>
        new Response(
          JSON.stringify([
            {
              mkkMemberOid: OID,
              stockCode: "KATMR",
              pdOid: "4028328c9f52dc4001a010677a807522",
              disclosureIndex: 1651411,
              year: 2026,
              period: 2,
              title: "KATMERCİLER A.Ş.",
            },
          ]),
        ),
    );
    expect(await companyMembers(PERIOD, client)).toEqual([
      {
        disclosure_id: 1651411,
        disclosure_oid: "4028328c9f52dc4001a010677a807522",
        stock_code: "KATMR",
        title: "KATMERCİLER A.Ş.",
      },
    ]);
    expect(urls).toEqual([`https://www.kap.org.tr/tr/api/financialTable/listCompanyExcelMembers/${OID}/2026/2`]);
  });

  test("an answer of another shape, or a ticker instead of a member id, is refused", async () => {
    const { client, urls } = fakeKap(() => new Response(JSON.stringify([{ stockCode: "KATMR" }])));
    await expect(companyMembers(PERIOD, client)).rejects.toThrow("unexpected entry");
    await expect(companyMembers({ ...PERIOD, mkkMemberOid: "KATMR" }, client)).rejects.toThrow(RangeError);
    await expect(companyMembers({ ...PERIOD, quarter: 5 }, client)).rejects.toThrow(RangeError);
    expect(urls).toHaveLength(1);
  });
});

describe("downloadCompanyReport", () => {
  test("stores the statement with its event and the PDF, with the KAP URL and the download time", async () => {
    const { client, urls } = fakeKap(zipResponse(ZIP));
    const r = await downloadCompanyReport(store, PERIOD, { kap: client, now });
    expect(urls).toEqual([URL]);
    expect([r.complete, r.lost, r.ignored, r.attempts, r.attachments]).toEqual([
      true,
      [],
      [],
      1,
      { stored: 1, skipped: 0 },
    ]);
    expect(r.statements.map((s) => [s.file.file_name, s.duplicate])).toEqual([["KATMR_1651411_2026_2.xls", false]]);

    const [file] = filesByDisclosure(store, 1651411);
    expect(new TextDecoder().decode(readRawFile(store, file as never))).toBe(STATEMENT);
    expect([file?.source_url, file?.downloaded_at]).toEqual([URL, "2026-08-18T06:00:00.000Z"]);
    expect(events().map((e) => [e.type, e.subject, JSON.parse(String(e.payload))])).toEqual([
      [
        "report_stored",
        file?.object_id,
        { disclosure_id: 1651411, file_name: "KATMR_1651411_2026_2.xls", source: "company_download" },
      ],
    ]);

    const [pdf] = attachments();
    expect(pdf).toMatchObject({
      mkk_member_oid: OID,
      year: 2026n,
      quarter: 2n,
      path: "Dönem2Ekler/(0)Katmerciler_30062026_TR.pdf",
      size_bytes: 5000n,
      downloaded_at: "2026-08-18T06:00:00.000Z",
      source_url: URL,
    });
    const id = String(pdf?.object_id);
    expect(id).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(store.getObject(id)).toEqual(PDF);
  });

  test("downloading the same files again stores nothing and emits no event", async () => {
    const { client } = fakeKap(zipResponse(ZIP));
    await downloadCompanyReport(store, PERIOD, { kap: client, now });
    const again = await downloadCompanyReport(store, PERIOD, { kap: client, now });
    expect(again.statements.map((s) => s.duplicate)).toEqual([true]);
    expect(again.attachments).toEqual({ stored: 0, skipped: 1 });
    expect([events().length, attachments().length]).toEqual([1, 1]);
  });

  test("a company with consolidated and solo statements gets both; other files are not stored", async () => {
    const zip = makeZip({
      "AVGYO_1651001_2026_2.xls": "consolidated",
      "AVGYO_1651002_2026_2.xls": "solo",
      "readme.txt": "x",
      "notes.xls": "not a KAP file name",
      "Dönem2Ekler/": "",
    });
    const { client } = fakeKap(zipResponse(zip));
    const r = await downloadCompanyReport(store, PERIOD, { kap: client, now });
    expect(r.statements.map((s) => s.file.disclosure_id)).toEqual([1651001, 1651002]);
    expect(r.ignored).toEqual(["readme.txt", "notes.xls"]);
    expect(events()).toHaveLength(2);
  });

  test("a cut-off zip is asked for again", async () => {
    const { client, urls } = fakeKap(zipResponse(ZIP.subarray(0, ZIP.length - 30)), zipResponse(ZIP));
    const r = await downloadCompanyReport(store, PERIOD, { kap: client, now });
    expect([r.complete, r.attempts, urls.length]).toEqual([true, 2, 2]);
    expect(r.errors).toEqual([`attempt 1: incomplete zip (${ZIP.length - 30} bytes)`]);
  });

  test("never complete: the complete members of the longest answer are stored, the rest listed as lost", async () => {
    // The statement is complete in the longer answer; the PDF after it is cut off.
    const statementEnd =
      30 + Buffer.byteLength("KATMR_1651411_2026_2.xls") + deflateRawSync(Buffer.from(STATEMENT)).length;
    const short = zipResponse(ZIP.subarray(0, 20));
    const longer = zipResponse(ZIP.subarray(0, statementEnd + 200));
    const { client } = fakeKap(short, longer, short);
    const r = await downloadCompanyReport(store, PERIOD, { kap: client, now, retries: 3 });
    expect([r.complete, r.attempts]).toEqual([false, 3]);
    expect(r.statements.map((s) => s.file.file_name)).toEqual(["KATMR_1651411_2026_2.xls"]);
    expect(r.lost).toEqual(["Dönem2Ekler/(0)Katmerciler_30062026_TR.pdf"]);
    expect(attachments()).toEqual([]);
  });

  test("when KAP never answers, nothing is stored and the error says why", async () => {
    const { client } = fakeKap(() => new Response("not found", { status: 404 }));
    await expect(downloadCompanyReport(store, PERIOD, { kap: client, now, retries: 2 })).rejects.toThrow("HTTP 404");
    expect([events().length, attachments().length]).toEqual([0, 0]);
  });
});

test("readZip reads members in memory with their paths, and skips folders", () => {
  const r = readZip(makeZip({ "a.xls": "A", "Dönem2Ekler/": "", "Dönem2Ekler/b.pdf": "B" }));
  expect(r.complete).toBe(true);
  expect(r.members.map((m) => [m.path, new TextDecoder().decode(m.content)])).toEqual([
    ["a.xls", "A"],
    ["Dönem2Ekler/b.pdf", "B"],
  ]);
});
