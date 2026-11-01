/** App events in Zova (#179) and the store schema steps. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvent, EventStateError, emit, finish, getEvent, history, pending } from "../src/events.ts";
import { migrateStore, STORE_MIGRATIONS, StoreSchemaError, storeSchemaVersion } from "../src/store-schema.ts";
import { memoryStore, openStore, type Store } from "../src/zova.ts";

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

describe("store schema", () => {
  test("steps run once", () => {
    expect(storeSchemaVersion(store)).toBe(STORE_MIGRATIONS.length);
    expect(migrateStore(store)).toEqual([]);
  });

  test("a failing step is rolled back", () => {
    const s = memoryStore();
    const steps = [
      ...STORE_MIGRATIONS,
      { version: STORE_MIGRATIONS.length + 1, name: "bad", sql: "CREATE TABLE x (a); SELECT * FROM missing;" },
    ];
    expect(() => migrateStore(s, steps)).toThrow(StoreSchemaError);
    expect(storeSchemaVersion(s)).toBe(STORE_MIGRATIONS.length);
    expect(s.query("SELECT name FROM sqlite_master WHERE name = 'x'")).toEqual([]);
    s.close();
  });

  test("a newer store is refused", () => {
    store.run("INSERT INTO store_schema_version VALUES (?1, 'future', 'now')", [99]);
    expect(() => migrateStore(store)).toThrow(/newer than this Vigil/);
  });
});

describe("events", () => {
  test("pending returns unhandled events of one type, oldest first", () => {
    const a = emit(store, "report_stored", "obj-a", { file: "A.xls" });
    const b = emit(store, "report_stored", "obj-b");
    expect(pending(store, "report_stored").map((e) => [e.id, e.subject])).toEqual([
      [a, "obj-a"],
      [b, "obj-b"],
    ]);
    expect(pending(store, "report_stored")[0]?.payload).toEqual({ file: "A.xls" });
    expect(pending(store, "report_stored", 1)).toHaveLength(1);
  });

  test("finish marks the event handled and records the outcome", () => {
    emit(store, "report_stored", "obj-a");
    const event = pending(store, "report_stored")[0] as AppEvent;
    const outcome = finish(store, event, { type: "report_processed", payload: { facts: 12 } });
    expect(pending(store, "report_stored")).toEqual([]);
    expect(getEvent(store, event.id)?.handled_at).not.toBeNull();
    expect(getEvent(store, outcome)).toMatchObject({
      type: "report_processed",
      subject: "obj-a",
      payload: { facts: 12, event: event.id },
    });
    expect(pending(store, "report_processed")).toEqual([]); // outcomes are not work to do
  });

  test("a failure keeps its reason", () => {
    emit(store, "report_stored", "obj-a");
    const event = pending(store, "report_stored")[0] as AppEvent;
    finish(store, event, { type: "report_failed", reason: "ParseError: no tables" });
    expect(history(store, "obj-a").map((e) => [e.type, e.payload.reason])).toEqual([
      ["report_stored", undefined],
      ["report_failed", "ParseError: no tables"],
    ]);
  });

  test("an event cannot be finished twice", () => {
    emit(store, "report_stored", "obj-a");
    const event = pending(store, "report_stored")[0] as AppEvent;
    finish(store, event, { type: "report_processed" });
    expect(() => finish(store, event, { type: "report_processed" })).toThrow(EventStateError);
    expect(history(store, "obj-a")).toHaveLength(2); // no second outcome
  });

  test("an emit inside a failed transaction is rolled back with it", () => {
    expect(() =>
      store.transaction((s) => {
        emit(s, "report_stored", "obj-a");
        throw new Error("store failed");
      }),
    ).toThrow("store failed");
    expect(pending(store, "report_stored")).toEqual([]);
  });
});

test("after a restart, every stored but unprocessed report is processed exactly once", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-events-"));
  const processed: string[] = [];
  const work = (s: Store, limit: number) => {
    for (const event of pending(s, "report_stored", limit)) {
      processed.push(event.subject);
      finish(s, event, { type: "report_processed" });
    }
  };
  try {
    let s = openStore(dir);
    migrateStore(s);
    for (const subject of ["a", "b", "c", "d"]) emit(s, "report_stored", subject);
    work(s, 2); // the app stops after two
    s.close();

    s = openStore(dir);
    migrateStore(s);
    work(s, 100);
    work(s, 100); // nothing left the second time
    s.close();
    expect(processed).toEqual(["a", "b", "c", "d"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
