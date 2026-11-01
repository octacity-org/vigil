/** Zova connection layer (#175). Temporary Zova files; no KAP data. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStore, openStore, STORE_FILE, StoreError } from "../src/zova.ts";

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
