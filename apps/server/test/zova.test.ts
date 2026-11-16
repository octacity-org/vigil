/** Zova connection layer (#175). Temporary Zova files; no KAP data. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatVersion, probeFormat } from "zova-js";
import { migrateStore, STORE_MIGRATIONS, storeSchemaVersion } from "../src/store-schema.ts";
import {
  backupPath,
  type FormatUpgrade,
  memoryStore,
  migratingPath,
  openStore,
  STORE_FILE,
  StoreError,
} from "../src/zova.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-zova-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);

describe("openStore", () => {
  test("creates the folder and the file on first start, and reopens it", () => {
    const data = join(dir, "nested", "data");
    let store = openStore(data);
    expect(store.path).toBe(join(data, STORE_FILE));
    store.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    store.run("INSERT INTO notes (body) VALUES (?1)", ["kept"]);
    store.close();
    expect(store.closed).toBe(true);

    store = openStore(data);
    expect(store.query("SELECT id, body FROM notes")).toEqual([{ id: 1n, body: "kept" }]);
    store.close();
  });

  test("a second open of the same folder is refused while the first is open", () => {
    const first = openStore(dir);
    const error = (() => {
      try {
        openStore(dir);
      } catch (e) {
        return e as StoreError;
      }
    })();
    expect(error).toBeInstanceOf(StoreError);
    expect(error?.kind).toBe("locked");
    first.close();
    openStore(dir).close(); // released on close
  });

  test("a lock left by a dead process is taken over", () => {
    writeFileSync(join(dir, `${STORE_FILE}.lock`), "999999999");
    const store = openStore(dir);
    expect(readFileSync(join(dir, `${STORE_FILE}.lock`), "utf8")).toBe(String(process.pid));
    store.close();
    expect(existsSync(join(dir, `${STORE_FILE}.lock`))).toBe(false);
  });

  test("a file that is not Zova is refused and the lock released", () => {
    writeFileSync(join(dir, STORE_FILE), "not a zova file at all, just text");
    expect(() => openStore(dir)).toThrow(StoreError);
    try {
      openStore(dir);
    } catch (e) {
      expect((e as StoreError).kind).toBe("not_zova");
    }
    expect(readdirSync(dir)).toEqual([STORE_FILE]);
  });

  test("closing twice is harmless", () => {
    const store = openStore(dir);
    store.close();
    store.close();
  });
});

describe("store", () => {
  test("query maps column types", () => {
    const store = memoryStore();
    store.exec("CREATE TABLE t (i INTEGER, f REAL, s TEXT, b BLOB, n TEXT)");
    store.run("INSERT INTO t VALUES (?1, ?2, ?3, ?4, ?5)", [9_007_199_254_740_993n, 1.5, "ğüşİ", bytes("x"), null]);
    expect(store.query("SELECT * FROM t")).toEqual([
      { i: 9_007_199_254_740_993n, f: 1.5, s: "ğüşİ", b: bytes("x"), n: null },
    ]);
    store.close();
  });

  test("run returns the number of changed rows", () => {
    const store = memoryStore();
    store.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);");
    expect(store.run("UPDATE t SET x = x + 1 WHERE x >= ?1", [2])).toBe(2);
    store.close();
  });

  test("a throwing transaction is rolled back", () => {
    const store = memoryStore();
    store.exec("CREATE TABLE t (x INTEGER)");
    expect(() =>
      store.transaction((s) => {
        s.run("INSERT INTO t VALUES (?1)", [1]);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(store.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0n }]);
    expect(store.transaction((s) => s.run("INSERT INTO t VALUES (?1)", [2]))).toBe(1);
    store.close();
  });

  test("objects are content addressed: the id is the SHA-256 of the bytes", () => {
    const store = memoryStore();
    const content = bytes("<html>KAP</html>");
    const id = store.putObject(content);
    expect(id).toBe(createHash("sha256").update(content).digest("hex"));
    expect(store.putObject(content)).toBe(id);
    expect(store.hasObject(id)).toBe(true);
    expect(store.objectSize(id)).toBe(BigInt(content.length));
    expect(store.getObject(id)).toEqual(content);
    store.deleteObject(id);
    expect(store.hasObject(id)).toBe(false);
    store.close();
  });
});

test("no server code imports zova-js outside zova.ts", () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith(".ts") &&
        entry.name !== "zova.ts" &&
        readFileSync(path, "utf8").includes('"zova-js"')
      )
        offenders.push(entry.name);
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});

describe("format upgrade (#181)", () => {
  // Written by zova-js 1.0.0 (format 11): Vigil's store tables, five raw files, one of them in several chunks.
  const OLD = join(import.meta.dir, "fixtures", "zova", "format-11.zova");
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const storeFile = () => join(dir, STORE_FILE);
  const stage = (bytes: Uint8Array = readFileSync(OLD)) => writeFileSync(storeFile(), bytes);
  const failure = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e as StoreError;
    }
    throw new Error("expected a StoreError");
  };

  test("the fixture is format 11, which this Zova migrates", () => {
    expect(probeFormat(OLD)).toEqual({ formatVersion: 11, compatibility: "migratable" });
    expect(Number(formatVersion)).toBeGreaterThan(11);
  });

  test("an old file is upgraded on open without losing any object, and the old one is kept", () => {
    stage();
    const seen: FormatUpgrade[] = [];
    const store = openStore(dir, { onUpgrade: (u) => seen.push(u) });
    try {
      expect(seen).toEqual([
        { from: 11, to: Number(formatVersion), backup: backupPath(storeFile(), 11), objects_checked: 5 },
      ]);
      const files = store.query("SELECT object_id, size_bytes FROM raw_files ORDER BY rowid");
      expect(files).toHaveLength(5);
      for (const f of files) {
        const bytes = store.getObject(String(f.object_id));
        expect(sha(bytes)).toBe(String(f.object_id));
        expect(BigInt(bytes.length)).toBe(f.size_bytes as bigint);
      }
      expect(files.some((f) => (f.size_bytes as bigint) > 64n * 1024n)).toBe(true); // the one in several chunks
      expect(store.query("SELECT count(*) AS n FROM events WHERE type = 'report_stored'")).toEqual([{ n: 5n }]);
      // The upgrade keeps the store schema as it was (3); the store migrations then run as on any open.
      expect(storeSchemaVersion(store)).toBe(3);
      expect(migrateStore(store)).toEqual(STORE_MIGRATIONS.slice(3).map((m) => m.version));
    } finally {
      store.close();
    }
    expect(probeFormat(storeFile()).compatibility).toBe("current");
    // The old file is kept byte for byte; nothing else is left behind.
    expect(readFileSync(backupPath(storeFile(), 11))).toEqual(readFileSync(OLD));
    expect(readdirSync(dir).sort()).toEqual([STORE_FILE, `${STORE_FILE}.format-11.bak`]);
  });

  test("a current file is opened as it is, and the upgrade runs once", () => {
    stage();
    openStore(dir).close();
    const upgraded = readFileSync(storeFile());
    const seen: FormatUpgrade[] = [];
    openStore(dir, { onUpgrade: (u) => seen.push(u) }).close();
    expect(seen).toEqual([]);
    expect(readFileSync(storeFile())).toEqual(upgraded);
    openStore(join(dir, "new"), { onUpgrade: (u) => seen.push(u) }).close(); // a new store is current
    expect(seen).toEqual([]);
  });

  test("a file left by an attempt that stopped part way is replaced", () => {
    stage();
    writeFileSync(migratingPath(storeFile()), "half written");
    const store = openStore(dir);
    expect(store.query("SELECT count(*) AS n FROM raw_files")).toEqual([{ n: 5n }]);
    store.close();
    expect(existsSync(migratingPath(storeFile()))).toBe(false);
  });

  test("a failed upgrade leaves the file unchanged, says so, and releases the lock", () => {
    const bad = Buffer.from(readFileSync(OLD));
    for (let i = 0; i < 64; i++) bad[200_000 + i] = (bad[200_000 + i] as number) ^ 0xff; // inside an object
    stage(bad);
    const e = failure(() => openStore(dir));
    expect(e).toBeInstanceOf(StoreError);
    expect(e.kind).toBe("migration_failed");
    expect(e.message).toContain("format 11");
    expect(e.message).toContain("unchanged");
    expect(readFileSync(storeFile())).toEqual(bad);
    expect(readdirSync(dir)).toEqual([STORE_FILE]); // no backup, no half-written file, no lock
  });

  test("an upgrade whose objects do not read back is refused, and the old file kept as it was", () => {
    // Zova migrates this file; one raw file's object is missing, which only Vigil's own check finds.
    const old = readFileSync(join(import.meta.dir, "fixtures", "zova", "format-11-missing-object.zova"));
    stage(old);
    const e = failure(() => openStore(dir));
    expect(e.kind).toBe("migration_failed");
    expect(e.message).toContain(`object ${"0".repeat(64)} is missing`);
    expect(readFileSync(storeFile())).toEqual(old);
    expect(readdirSync(dir)).toEqual([STORE_FILE]);
  });

  test("an upgrade is refused while another process holds the store", () => {
    copyFileSync(OLD, storeFile());
    writeFileSync(join(dir, `${STORE_FILE}.lock`), String(process.pid));
    expect(failure(() => openStore(dir)).kind).toBe("locked");
    expect(probeFormat(storeFile()).formatVersion).toBe(11);
    rmSync(join(dir, `${STORE_FILE}.lock`));
  });
});
