/**
 * Writes the old-format stores used by the upgrade tests (#181). It must run with zova-js 1.0.0, the last release
 * that writes Zova format 11, so the tests do not run it; the files are committed. To make them again:
 *
 *   mkdir /tmp/zova11 && cd /tmp/zova11 && bun add zova-js@1.0.0
 *   cp <repo>/apps/server/test/fixtures/zova/make-format-11.ts . && bun make-format-11.ts <repo>
 *
 * `format-11.zova` holds Vigil's store tables at store schema version 3, the three fixture filings stored as raw
 * files with their `report_stored` events, a second version of the first one, and a 200 KB object that spans several
 * chunks. `format-11-missing-object.zova` has the same tables and one raw file whose object is not there: Zova
 * migrates it, and Vigil's own check of the objects must refuse it.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database, formatVersion, objectIdToHex } from "zova-js";

const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: bun make-format-11.ts <repo>");
if (formatVersion !== "11") throw new Error(`zova-js writes format ${formatVersion} here; install zova-js@1.0.0`);
const { STORE_MIGRATIONS } = await import(join(repo, "apps", "server", "src", "store-schema.ts"));
const { FIXTURES, fileName, kapHtml } = await import(join(repo, "apps", "server", "test", "fixtures", "index.ts"));
const dir = join(repo, "apps", "server", "test", "fixtures", "zova");

function run(db: Database, sql: string, ...values: (string | number)[]): void {
  const stmt = db.prepare(sql);
  for (const [i, v] of values.entries()) {
    if (typeof v === "number") stmt.bindInteger(i + 1, BigInt(v));
    else stmt.bindText(i + 1, v);
  }
  stmt.step();
  stmt.close();
}

/** A new format-11 file with Vigil's store tables. */
function create(name: string): Database {
  const path = join(dir, name);
  rmSync(path, { force: true });
  const db = Database.create(path);
  db.exec(
    "CREATE TABLE store_schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const m of STORE_MIGRATIONS as { version: number; name: string; sql: string }[]) {
    db.exec(m.sql);
    run(db, "INSERT INTO store_schema_version VALUES (?1, ?2, ?3)", m.version, m.name, "2026-11-01T00:00:00.000Z");
  }
  return db;
}

function addFile(db: Database, objectId: string, name: string, size: number, at: string): void {
  const [group, disclosure, year, quarter] = name.replace(/\.xls$/, "").split("_") as [string, string, string, string];
  run(
    db,
    "INSERT INTO raw_files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    objectId,
    Number(disclosure),
    group.split("-")[0] as string,
    group,
    Number(year),
    Number(quarter),
    name,
    size,
    at,
    `file:///raw/${name}`,
    at,
  );
  run(
    db,
    "INSERT INTO events (type, subject, payload, created_at) VALUES ('report_stored', ?1, ?2, ?3)",
    objectId,
    JSON.stringify({ disclosure_id: Number(disclosure), file_name: name }),
    at,
  );
}

const enc = (s: string) => new TextEncoder().encode(s);
const first = FIXTURES[0];
const files: [string, Uint8Array][] = [
  ...FIXTURES.map((f: unknown) => [fileName(f), enc(kapHtml(f))] as [string, Uint8Array]),
  [fileName(first), enc(`${kapHtml(first)}<!-- corrected -->`)],
  ["TSTBG_9000099_2026_2.xls", new Uint8Array(200 * 1024).map((_, i) => (i * 7919) % 251)],
];

let db = create("format-11.zova");
files.forEach(([name, bytes], n) => {
  const id = objectIdToHex(db.putObject(bytes));
  if (id !== createHash("sha256").update(bytes).digest("hex")) throw new Error(`object id of ${name}`);
  addFile(db, id, name, bytes.length, `2026-10-2${n}T08:00:00.000Z`);
});
db.close();

db = create("format-11-missing-object.zova");
addFile(db, "0".repeat(64), fileName(first), 10, "2026-10-20T08:00:00.000Z");
db.close();
console.log(`format ${formatVersion}: ${files.length} objects, and a file with one missing -> ${dir}`);
