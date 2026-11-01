/**
 * The Zova archive (#175, decision 0009): raw KAP files, collector state and app events.
 * This is the only module that imports `zova-js`; the rest of the server uses the typed functions here.
 *
 * Zova allows the same file to be opened twice, so `openStore` takes a lock file next to it: a second Vigil
 * process on the same data folder is refused instead of writing next to the first.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database, objectIdFromHex, objectIdToHex, probeFormat, Step, ZovaError } from "zova-js";

export const STORE_FILE = "vigil.zova";

export type StoreErrorKind = "not_zova" | "locked" | "outdated_format" | "io";

/** A store problem the user can act on; `kind` says which. */
export class StoreError extends Error {
  override name = "StoreError";
  constructor(
    readonly kind: StoreErrorKind,
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

export type SqlValue = bigint | number | string | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export interface Store {
  readonly path: string;
  readonly closed: boolean;
  /** Run SQL that returns nothing; several statements allowed, no parameters. */
  exec(sql: string): void;
  /** Run one statement with `?1, ?2…` parameters; returns the rows. Integers come back as bigint. */
  query(sql: string, params?: readonly SqlValue[]): SqlRow[];
  /** Run one statement with parameters; returns the number of changed rows. */
  run(sql: string, params?: readonly SqlValue[]): number;
  /** Run `fn` in a transaction; a throw rolls back. `fn` must be synchronous. */
  transaction<T>(fn: (store: Store) => T): T;
  /** Store bytes; returns the object id (SHA-256 of the content, hex). Same bytes give the same id. */
  putObject(data: Uint8Array): string;
  getObject(id: string): Uint8Array;
  hasObject(id: string): boolean;
  objectSize(id: string): bigint;
  deleteObject(id: string): void;
  close(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take `{path}.lock`, holding our pid. A lock left by a dead process is taken over. */
function takeLock(path: string): string {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        throw new StoreError("locked", `${path} is in use by another Vigil process (pid ${pid}); close it first`, path);
      }
      rmSync(lock, { force: true }); // stale: its process is gone
    }
  }
  throw new StoreError("locked", `could not take the lock ${lock}`, path);
}

function bind(stmt: ReturnType<Database["prepare"]>, params: readonly SqlValue[]): void {
  params.forEach((v, i) => {
    const at = i + 1;
    if (v === null) stmt.bindNull(at);
    else if (typeof v === "bigint") stmt.bindInteger(at, v);
    else if (typeof v === "number") {
      if (Number.isInteger(v)) stmt.bindInteger(at, BigInt(v));
      else stmt.bindFloat(at, v);
    } else if (typeof v === "string") stmt.bindText(at, v);
    else stmt.bindBlob(at, v);
  });
}

function wrap(db: Database, path: string, release: () => void): Store {
  const prepared = <T>(sql: string, params: readonly SqlValue[], use: (s: ReturnType<Database["prepare"]>) => T) => {
    const stmt = db.prepare(sql);
    try {
      bind(stmt, params);
      return use(stmt);
    } finally {
      stmt.close();
    }
  };
  const store: Store = {
    path,
    get closed() {
      return db.closed;
    },
    exec: (sql) => db.exec(sql),
    query: (sql, params = []) =>
      prepared(sql, params, (stmt) => {
        const rows: SqlRow[] = [];
        const names = Array.from({ length: stmt.columnCount() }, (_, i) => stmt.columnName(i));
        while (stmt.step() === Step.Row) {
          const row: SqlRow = {};
          names.forEach((name, i) => {
            const type = stmt.columnType(i);
            row[name] =
              type === "integer"
                ? stmt.columnInteger(i)
                : type === "float"
                  ? stmt.columnFloat(i)
                  : type === "text"
                    ? stmt.columnText(i)
                    : type === "blob"
                      ? stmt.columnBlob(i)
                      : null;
          });
          rows.push(row);
        }
        return rows;
      }),
    run: (sql, params = []) =>
      prepared(sql, params, (stmt) => {
        while (stmt.step() === Step.Row) {
          // drain
        }
        return Number(db.changes());
      }),
    transaction: (fn) => db.transaction(() => fn(store)),
    putObject: (data) => objectIdToHex(db.putObject(data)),
    getObject: (id) => db.getObject(objectIdFromHex(id)),
    hasObject: (id) => db.hasObject(objectIdFromHex(id)),
    objectSize: (id) => db.objectSize(objectIdFromHex(id)),
    deleteObject: (id) => db.deleteObject(objectIdFromHex(id)),
    close: () => {
      if (db.closed) return;
      try {
        db.close();
      } finally {
        release();
      }
    },
  };
  return store;
}

/**
 * Open `{dataDir}/vigil.zova`, creating the folder and the file on first start.
 * Throws `StoreError` for a file that is not Zova, a file in use, or a format this Vigil cannot open.
 */
export function openStore(dataDir: string): Store {
  const path = join(resolve(dataDir), STORE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const lock = takeLock(path);
  const release = () => rmSync(lock, { force: true });
  try {
    if (existsSync(path)) {
      let format: ReturnType<typeof probeFormat>;
      try {
        format = probeFormat(path);
      } catch (e) {
        throw asStoreError(e, path);
      }
      if (format.compatibility !== "current") {
        throw new StoreError(
          "outdated_format",
          `${path} uses Zova format ${format.formatVersion} (${format.compatibility}); it must be migrated first (#181)`,
          path,
        );
      }
    }
    let db: Database;
    try {
      db = existsSync(path) ? Database.open(path) : Database.create(path);
    } catch (e) {
      throw asStoreError(e, path);
    }
    return wrap(db, path, release);
  } catch (e) {
    release();
    throw e;
  }
}

/** An in-memory store for tests; no file, no lock. */
export function memoryStore(): Store {
  return wrap(Database.createMemory(), ":memory:", () => {});
}

function asStoreError(e: unknown, path: string): StoreError {
  if (e instanceof StoreError) return e;
  if (e instanceof ZovaError && e.code === "ZOVA_NOT_ZOVA_DATABASE") {
    return new StoreError("not_zova", `${path} is not a Zova file or is damaged`, path);
  }
  return new StoreError("io", `cannot open ${path}: ${(e as Error).message}`, path);
}
