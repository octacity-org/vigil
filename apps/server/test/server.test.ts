/** The server process (#168) and its graceful shutdown (#198). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, rows } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { KapClient } from "../src/kap.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { type LogLevel, startServer, type VigilServer } from "../src/server.ts";
import { SettingsError } from "../src/settings.ts";
import { migrateStore } from "../src/store-schema.ts";
import { openStore, type Store, StoreError } from "../src/zova.ts";
import { fileName, GENERAL, kapHtml } from "./fixtures/index.ts";

let dataDir: string;
let server: VigilServer | null = null;
const logs: { level: LogLevel; message: string; fields: Record<string, unknown> }[] = [];
const log = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) =>
  logs.push({ level, message, fields });

/** Timers never fire on their own; the test decides. */
const timers: { fn: () => void; ms: number }[] = [];
const schedule = (fn: () => void, ms: number) => {
  const t = { fn, ms };
  timers.push(t);
  return () => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };
};

function putReport(store: Store, disclosureId = GENERAL.disclosureId): void {
  const f = { ...GENERAL, disclosureId };
  storeRawFile(
    store,
    new TextEncoder().encode(kapHtml(f)),
    { fileName: fileName(f), sourceUrl: `file:///raw/${fileName(f)}`, downloadedAt: new Date("2026-10-20T08:00:00Z") },
    {
      onStored: (s, file) =>
        emit(s, "report_stored", file.object_id, { disclosure_id: file.disclosure_id, file_name: file.file_name }),
    },
  );
}

const start = (options: { collect?: boolean; kap?: KapClient } = {}) =>
  startServer({ dataDir, port: 0, collect: options.collect ?? false, kap: options.kap, log, schedule });

const loaded = async (s: VigilServer) =>
  (await rows(s.db, "SELECT disclosure_id FROM reports ORDER BY disclosure_id")).map((r) => Number(r.disclosure_id));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vigil-server-"));
  logs.length = 0;
  timers.length = 0;
});

afterEach(async () => {
  if (server !== null) await server.stop({ timeoutMs: 5_000 });
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("start-up", () => {
  test("serves the API on 127.0.0.1 and answers ready", async () => {
    server = await start();
    expect(server.url).toStartWith("http://127.0.0.1:");
    expect((await fetch(`${server.url}/v1/health`)).status).toBe(200);
    const ready = await fetch(`${server.url}/v1/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });
    expect(server.settings).toEqual({ data_dir: expect.any(String), quarters: [], llm: null });
  });

  test("processes the reports stored before it started", async () => {
    const store = openStore(dataDir);
    migrateStore(store);
    putReport(store);
    store.close();

    server = await start();
    await server.processed();
    expect(await loaded(server)).toEqual([GENERAL.disclosureId]);
    expect(logs.some((l) => l.message === "processed reports" && l.fields.processed === 1)).toBe(true);
  });

  test("processes a report stored while running, on request and on its timer", async () => {
    server = await start();
    await server.processed();
    putReport(server.store, 1_000_001);
    server.process();
    await server.processed();
    expect(await loaded(server)).toEqual([1_000_001]);

    putReport(server.store, 1_000_002);
    const timer = timers.find((t) => t.ms === 60_000);
    expect(timer).toBeDefined();
    timer?.fn();
    await server.processed();
    expect(await loaded(server)).toEqual([1_000_001, 1_000_002]);
  });

  test("an invalid settings file stops start-up before the data folder is opened", async () => {
    writeFileSync(join(dataDir, "vigil.settings.json"), JSON.stringify({ unknown: 1 }));
    await expect(start()).rejects.toBeInstanceOf(SettingsError);
    const store = openStore(dataDir); // not locked
    store.close();
  });

  test("a data folder held by another process stops start-up", async () => {
    const other = openStore(dataDir);
    try {
      await expect(start()).rejects.toBeInstanceOf(StoreError);
    } finally {
      other.close();
    }
  });

  test("with the collector on, a KAP that cannot be reached is logged and the API keeps serving", async () => {
    const kap = new KapClient({
      transport: () => Promise.reject(new Error("network down")),
      sleep: () => Promise.resolve(),
    });
    server = await start({ collect: true, kap });
    expect((await fetch(`${server.url}/v1/ready`)).status).toBe(200);
    for (let i = 0; i < 50 && !logs.some((l) => l.message === "collector error"); i++) await Bun.sleep(10);
    expect(logs.find((l) => l.message === "collector error")?.fields.error).toContain("network down");
  });
});

describe("graceful shutdown (#198)", () => {
  test("stops answering, closes DuckDB and Zova, and releases the data folder", async () => {
    server = await start();
    const url = server.url;
    const result = await server.stop();
    expect(result).toEqual({ clean: true, pending: [] });
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
    expect(await server.stop()).toBe(result); // once only
    server = null;
    const store = openStore(dataDir);
    store.close();
  });

  test("finishes the write job in progress and takes no new one", async () => {
    server = await start();
    await server.processed();
    let release: () => void = () => {};
    const done: string[] = [];
    const long = server.queue.add("long job", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      await server?.db.con.run("CREATE TABLE written_by_long_job (x INTEGER)");
      done.push("long job");
    });
    const stopping = server.stop();
    await expect(server.queue.add("late job", () => done.push("late job"))).rejects.toThrow("queue is closed");
    setTimeout(() => release(), 20);
    expect(await stopping).toEqual({ clean: true, pending: [] });
    await long;
    expect(done).toEqual(["long job"]);
    server = null;

    // The table the long job wrote is in the database after the restart.
    server = await start();
    expect(await rows(server.db, "SELECT count(*) AS n FROM written_by_long_job")).toEqual([{ n: 0n }]);
  });

  test("gives up after the time limit and says what was still running", async () => {
    server = await start();
    await server.processed();
    let release: () => void = () => {};
    const long = server.queue.add(
      "stuck job",
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const stopping = server.stop({ timeoutMs: 1_000 });
    await Bun.sleep(0);
    const limit = timers.find((t) => t.ms === 1_000);
    expect(limit).toBeDefined();
    limit?.fn();
    const result = await stopping;
    expect(result.clean).toBe(false);
    expect(result.pending).toContain('write job "stuck job"');
    expect(logs.some((l) => l.level === "error" && l.message === "shutdown time limit reached")).toBe(true);

    // The caller exits here; the test lets the job end and closes what the server left open.
    release();
    await long;
    close(server.db);
    server.store.close();
    server = null;
  });
});
