/**
 * Processing failures (#211). Files are the synthetic fixtures. Expected behaviour: the issue's tasks (the reason kept
 * with `report_failed`, a limited number of retries, then left for the user to see; failures listed for the quality
 * page) and "a broken file fails with its reason and the queue continues".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emit, pending, recordAttempt } from "../src/events.ts";
import { failedReports, MAX_ATTEMPTS, processPending, type ReportHandler } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { fileName, GENERAL, HOLDING, kapHtml } from "./fixtures/index.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let store: Store;
let queue: WriteQueue;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
  queue = new WriteQueue();
});
afterEach(async () => {
  await queue.close();
  store.close();
});

function put(name: string, html: string, downloadedAt = new Date("2026-10-20T08:00:00Z")): string {
  storeRawFile(
    store,
    new TextEncoder().encode(html),
    { fileName: name, sourceUrl: `file:///raw/${name}`, downloadedAt },
    {
      onStored: (s, f) =>
        emit(s, "report_stored", f.object_id, { disclosure_id: f.disclosure_id, file_name: f.file_name }),
    },
  );
  return sha256(html);
}
const event = (subject: string) =>
  store.query("SELECT id, attempts, last_error, handled_at FROM events WHERE subject = ?1 AND type = 'report_stored'", [
    subject,
  ])[0];
const BROKEN = "TSTBR_9000099_2026_2.xls";

describe("done when: a broken file fails with its reason and the queue continues", () => {
  test("the broken file gets report_failed with the parser's reason; the others are processed", async () => {
    const good1 = put(fileName(GENERAL), kapHtml(GENERAL));
    const broken = put(BROKEN, "<html>no statements here</html>");
    const good2 = put(fileName(HOLDING), kapHtml(HOLDING));
    const s = await processPending(store, queue);
    expect(s).toMatchObject({ processed: 2, failed: 1, errors: [], gave_up: [] });
    const [f] = failedReports(store);
    expect(f).toMatchObject({ object_id: broken, disclosure_id: 9000099, file_name: BROKEN, gave_up: false });
    expect(f?.reason).toStartWith("ParseError: ");
    expect(failedReports(store)).toHaveLength(1);
    expect([good1, good2].map((g) => event(g)?.handled_at !== null)).toEqual([true, true]);
  });

  test("a file that cannot be parsed is not retried: one attempt, closed at once", async () => {
    const broken = put(BROKEN, "<html>no statements here</html>");
    await processPending(store, queue);
    expect(event(broken)).toMatchObject({ attempts: 0n });
    expect(pending(store, "report_stored")).toEqual([]);
  });
});

describe("a job that throws is retried a limited number of times", () => {
  const failingFor =
    (id: number): ReportHandler =>
    (r) => {
      if (r.file?.disclosure_id === id) throw new Error("DuckDB: database is locked");
    };

  test("each run counts the attempt and keeps the error; the others go on", async () => {
    const g = put(fileName(GENERAL), kapHtml(GENERAL));
    put(fileName(HOLDING), kapHtml(HOLDING));
    const s = await processPending(store, queue, { handle: failingFor(GENERAL.disclosureId) });
    expect(s).toMatchObject({ processed: 1, failed: 0, gave_up: [] });
    expect(s.errors).toEqual([
      { event: Number(event(g)?.id), error: "Error: DuckDB: database is locked", attempts: 1 },
    ]);
    expect(event(g)).toMatchObject({ attempts: 1n, last_error: "Error: DuckDB: database is locked", handled_at: null });
    expect(failedReports(store)).toEqual([]);
  });

  test(`after ${MAX_ATTEMPTS} attempts it is closed as report_failed with the last error, for the user to see`, async () => {
    const g = put(fileName(GENERAL), kapHtml(GENERAL));
    const handle = failingFor(GENERAL.disclosureId);
    for (let run = 1; run < MAX_ATTEMPTS; run++) {
      const s = await processPending(store, queue, { handle });
      expect(s.gave_up).toEqual([]);
      expect(event(g)?.handled_at).toBeNull();
    }
    const last = await processPending(store, queue, { handle });
    expect(last.gave_up).toEqual([Number(event(g)?.id)]);
    expect(last.failed).toBe(1);
    expect(event(g)?.handled_at).not.toBeNull();
    expect(failedReports(store)).toEqual([
      expect.objectContaining({
        object_id: g,
        disclosure_id: GENERAL.disclosureId,
        file_name: fileName(GENERAL),
        reason: `gave up after ${MAX_ATTEMPTS} attempts: Error: DuckDB: database is locked`,
        gave_up: true,
      }),
    ]);
    // Never again: the next run has nothing to do.
    expect(await processPending(store, queue, { handle })).toMatchObject({ processed: 0, failed: 0, errors: [] });
  });

  test("a job that succeeds on a later attempt is processed, and nothing is listed as failed", async () => {
    const g = put(fileName(GENERAL), kapHtml(GENERAL));
    await processPending(store, queue, { handle: failingFor(GENERAL.disclosureId) });
    const s = await processPending(store, queue);
    expect(s).toMatchObject({ processed: 1, failed: 0 });
    expect(event(g)?.attempts).toBe(1n);
    expect(failedReports(store)).toEqual([]);
  });
});

describe("failedReports", () => {
  test("a file processed after a failure is no longer listed", async () => {
    const broken = put(BROKEN, "<html>broken</html>");
    await processPending(store, queue);
    expect(failedReports(store).map((f) => f.object_id)).toEqual([broken]);
    // A later rebuild (#162) or retry processes the same file successfully.
    emit(store, "report_processed", broken, { event: 0 }, { handled: true });
    expect(failedReports(store)).toEqual([]);
  });

  test("newest first", async () => {
    const a = put("TSTBA_9000101_2026_2.xls", "<html>a</html>");
    const b = put("TSTBB_9000102_2026_2.xls", "<html>b</html>");
    await processPending(store, queue);
    expect(failedReports(store).map((f) => f.object_id)).toEqual([b, a]);
  });
});

test("recordAttempt counts only pending events", () => {
  const id = emit(store, "report_stored", "x", {});
  expect(recordAttempt(store, id, "e1")).toBe(1);
  expect(recordAttempt(store, id, "e2")).toBe(2);
  const handled = emit(store, "report_processed", "x", {}, { handled: true });
  expect(recordAttempt(store, handled, "e")).toBe(0);
  expect(recordAttempt(store, 999, "e")).toBe(0);
});
