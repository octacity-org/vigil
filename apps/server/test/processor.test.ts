/**
 * Processor, first step (#207): parse and check a report stored in Zova, from its `report_stored` event. Files are
 * the synthetic fixtures; expected behaviour is #207, `docs/ARCHITECTURE.md` (Processor) and `docs/SCHEMA.md`
 * (events). The check counts in a `report_processed` payload are the ones `bun run quality` gives for the same file,
 * so `filingQuality` is the reference for them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { filingQuality, parseKapXls } from "@vigil/core";
import { type AppEvent, emit, finish, getEvent, pending } from "../src/events.ts";
import { type CheckedReport, type EventContext, processEvent, processPending } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { type FixtureFiling, fileName, GENERAL, HOLDING, kapHtml } from "./fixtures/index.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

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

/** Store bytes under a file name with its `report_stored` event, as the collector and `bun run import` do. */
function put(name: string, html: string, downloadedAt = new Date("2026-10-20T08:00:00Z")): string {
  storeRawFile(
    store,
    enc(html),
    { fileName: name, sourceUrl: `file:///raw/${name}`, downloadedAt },
    {
      onStored: (s, f) =>
        emit(s, "report_stored", f.object_id, { disclosure_id: f.disclosure_id, file_name: f.file_name }),
    },
  );
  return sha256(html);
}
const outcomes = () =>
  store
    .query("SELECT type, subject, payload FROM events WHERE type <> 'report_stored' ORDER BY id")
    .map((r) => ({ type: String(r.type), subject: String(r.subject), payload: JSON.parse(String(r.payload)) }));
const stored = () => pending(store, "report_stored", 1000);

describe("a stored report", () => {
  test("is parsed and checked once: report_processed with the file and the quality counts", async () => {
    const id = put(fileName(GENERAL), kapHtml(GENERAL));
    const [event] = stored();
    const seen: [CheckedReport, EventContext][] = [];
    const s = await processPending(store, queue, { handle: (r, c) => void seen.push([r, c]) });
    expect(s).toEqual({ processed: 1, failed: 0, already_handled: 0, errors: [] });

    const q = filingQuality(parseKapXls(kapHtml(GENERAL), fileName(GENERAL)));
    expect(outcomes()).toEqual([
      {
        type: "report_processed",
        subject: id,
        payload: {
          disclosure_id: GENERAL.disclosureId,
          object_id: id,
          file_name: fileName(GENERAL),
          superseded: false,
          facts: 10, // 2 balance sheet rows × 2 columns + 3 income statement rows × 2 columns
          passed: q.passed,
          failed: q.failed,
          not_checked: q.not_checked,
          informational_differences: q.informational_differences,
          known_errors: q.known_errors,
          // Total assets (row 129) are 1,000,000, but only cash (120,000) of their components is in the file.
          blocked: true,
          event: event?.id,
        },
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0].status).toBe("checked");
    expect(seen[0]?.[1]).toMatchObject({ superseded: false, event: { id: event?.id } });
    expect(stored()).toEqual([]);
  });

  test("a second run does nothing", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    await processPending(store, queue);
    let calls = 0;
    const s = await processPending(store, queue, { handle: () => void calls++ });
    expect(s).toEqual({ processed: 0, failed: 0, already_handled: 0, errors: [] });
    expect(calls).toBe(0);
    expect(outcomes()).toHaveLength(1);
  });

  test("a report without blocking failures is processed with blocked: false", async () => {
    put(fileName(HOLDING), kapHtml(HOLDING));
    await processPending(store, queue);
    const [o] = outcomes();
    expect(o?.type).toBe("report_processed");
    expect(o?.payload).toMatchObject({ blocked: false, failed: 0, known_errors: 0 });
  });
});

describe("a report that cannot be processed fails with its reason, and is not retried", () => {
  test("a file that is not a statement", async () => {
    const id = put("TSTXX_9000060_2026_2.xls", "<html>not a statement</html>");
    const s = await processPending(store, queue);
    expect(s).toMatchObject({ processed: 0, failed: 1 });
    const [o] = outcomes();
    expect(o).toMatchObject({
      type: "report_failed",
      subject: id,
      payload: { disclosure_id: 9_000_060, object_id: id, file_name: "TSTXX_9000060_2026_2.xls", superseded: false },
    });
    expect(String(o?.payload.reason).length).toBeGreaterThan(0);
    expect((await processPending(store, queue)).failed).toBe(0);
  });

  test("two values for one cell", async () => {
    const dup: FixtureFiling = {
      ...GENERAL,
      disclosureId: 9_000_061,
      tables: [
        {
          role: "210015",
          headers: GENERAL.tables[0]?.headers as string[],
          rows: [
            { row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 1, 5: 2 } },
            { row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 3, 5: 4 } },
          ],
        },
      ],
    };
    put(fileName(dup), kapHtml(dup));
    await processPending(store, queue);
    const [o] = outcomes();
    expect(o?.type).toBe("report_failed");
    expect(o?.payload.reason).toContain("duplicate");
  });

  test("an event whose file is not stored under its disclosure", async () => {
    emit(store, "report_stored", sha256("missing"), { disclosure_id: 9_000_070, file_name: "X_9000070_2026_2.xls" });
    emit(store, "report_stored", sha256("no id"), { file_name: "Y.xls" });
    const s = await processPending(store, queue);
    expect(s).toMatchObject({ processed: 0, failed: 2, errors: [] });
    const [a, b] = outcomes();
    expect(a).toMatchObject({
      type: "report_failed",
      subject: sha256("missing"),
      payload: { disclosure_id: 9_000_070, object_id: sha256("missing"), file_name: "X_9000070_2026_2.xls" },
    });
    expect(a?.payload.reason).toContain("not found");
    expect(b).toMatchObject({ type: "report_failed", payload: { disclosure_id: null, file_name: "Y.xls" } });
    expect(b?.payload.reason).toContain("disclosure_id");
  });
});

describe("versions (#178)", () => {
  const v2Html = `${kapHtml(GENERAL)}<!-- corrected -->`;

  test("every event of a disclosure processes the latest version; an older one is marked superseded", async () => {
    const v1 = put(fileName(GENERAL), kapHtml(GENERAL), new Date("2026-10-20T08:00:00Z"));
    const v2 = put(fileName(GENERAL), v2Html, new Date("2026-10-21T08:00:00Z"));
    const contexts: boolean[] = [];
    await processPending(store, queue, { handle: (_r, c) => void contexts.push(c.superseded) });
    const o = outcomes();
    expect(o.map((x) => [x.subject, x.payload.object_id, x.payload.superseded])).toEqual([
      [v1, v2, true],
      [v2, v2, false],
    ]);
    expect(contexts).toEqual([true, false]);
  });

  test("an older download whose event comes last still processes the newer bytes", async () => {
    const newer = put(fileName(GENERAL), v2Html, new Date("2026-10-21T08:00:00Z"));
    const older = put(fileName(GENERAL), kapHtml(GENERAL), new Date("2026-10-20T08:00:00Z"));
    await processPending(store, queue);
    expect(outcomes().map((x) => [x.subject, x.payload.object_id, x.payload.superseded])).toEqual([
      [newer, newer, false],
      [older, newer, true],
    ]);
  });

  test("a broken latest version fails, naming it; the valid older version is not used instead", async () => {
    const v1 = put(fileName(GENERAL), kapHtml(GENERAL), new Date("2026-10-20T08:00:00Z"));
    const v2 = put(fileName(GENERAL), "<html>broken</html>", new Date("2026-10-21T08:00:00Z"));
    const s = await processPending(store, queue);
    expect(s).toMatchObject({ processed: 0, failed: 2 });
    const [a, b] = outcomes();
    expect(a).toMatchObject({ type: "report_failed", subject: v1, payload: { object_id: v2, superseded: true } });
    expect(a?.payload.reason).toContain(`latest version ${v2}`);
    expect(b).toMatchObject({ type: "report_failed", subject: v2, payload: { object_id: v2, superseded: false } });
    expect(b?.payload.reason).not.toContain("latest version");
  });
});

describe("at least once", () => {
  test("a throwing handle leaves the event pending, is not retried in the same run, and is retried in the next", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    put(fileName(HOLDING), kapHtml(HOLDING));
    let calls = 0;
    const s = await processPending(store, queue, {
      batch: 1,
      handle: (r) => {
        calls++;
        if (r.file?.disclosure_id === GENERAL.disclosureId) throw new Error("load failed");
      },
    });
    expect(calls).toBe(2);
    expect(s.processed).toBe(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]?.error).toContain("load failed");
    expect(stored().map((e) => e.payload.disclosure_id)).toEqual([GENERAL.disclosureId]);
    expect(outcomes()).toHaveLength(1);

    const again = await processPending(store, queue);
    expect(again).toMatchObject({ processed: 1, errors: [] });
    expect(stored()).toEqual([]);
  });

  test("a store error fails the job and leaves the event pending", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    const broken: Store = {
      ...store,
      getObject: () => {
        throw new Error("disk read error");
      },
    };
    const [event] = stored();
    await expect(processEvent(broken, event as AppEvent)).rejects.toThrow("disk read error");
    expect(stored()).toHaveLength(1);
    expect(outcomes()).toEqual([]);
  });

  test("an event handled after it was queued is skipped before handle runs", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    const [event] = stored() as [AppEvent];
    finish(store, event, { type: "report_processed" });
    let calls = 0;
    const r = await processEvent(store, event, () => void calls++);
    expect(r).toEqual({ event: event.id, outcome: "already_handled" });
    expect(calls).toBe(0);
  });

  test("an event handled while handle ran gives already_handled and one outcome", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    const [event] = stored() as [AppEvent];
    const r = await processEvent(store, event, () => {
      finish(store, getEvent(store, event.id) as AppEvent, { type: "report_processed", payload: { by: "other" } });
    });
    expect(r).toEqual({ event: event.id, outcome: "already_handled" });
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]?.payload.by).toBe("other");
  });
});

describe("processPending", () => {
  test("works through every event in batches, oldest first", async () => {
    for (let k = 0; k < 5; k++)
      put(`TSTB${k}_${9_000_100 + k}_2026_2.xls`, kapHtml({ ...GENERAL, disclosureId: 9_000_100 + k }));
    const order: number[] = [];
    const s = await processPending(store, queue, {
      batch: 2,
      handle: (r) => void order.push(r.file?.disclosure_id as number),
    });
    expect(s.processed).toBe(5);
    expect(order).toEqual([9_000_100, 9_000_101, 9_000_102, 9_000_103, 9_000_104]);
  });

  test("a batch size that is not a whole number above 0 is refused", async () => {
    for (const batch of [0, -1, 1.5, Number.NaN]) {
      await expect(processPending(store, queue, { batch })).rejects.toThrow(RangeError);
    }
  });

  test("a closed queue stops the run; the events stay pending", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL));
    put(fileName(HOLDING), kapHtml(HOLDING));
    await queue.close();
    const s = await processPending(store, queue, { batch: 1 });
    expect(s.processed).toBe(0);
    expect(s.errors).toHaveLength(1); // it stops after the first refused batch, not one error per event
    expect(s.errors[0]?.error).toContain("QueueClosedError");
    expect(stored()).toHaveLength(2);
  });
});
