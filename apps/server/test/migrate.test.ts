/** Schema versioning and migrations (#182). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { close, connect } from "../src/db.ts";
import { CURRENT_VERSION, migrate, SchemaError, schemaVersion } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";

async function memory(): Promise<DuckDBConnection> {
  return (await DuckDBInstance.create(":memory:")).connect();
}

async function all(con: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  return (await con.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
}

async function columns(con: DuckDBConnection, table: string): Promise<string[]> {
  const r = await all(
    con,
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`,
  );
  return r.map((x) => String(x.column_name));
}

/** The reports table as databases had it before #157 and before versioning. */
const PRE_157 = `
CREATE TABLE companies (company_code VARCHAR PRIMARY KEY);
CREATE TABLE reports (
  disclosure_id BIGINT PRIMARY KEY, company_code VARCHAR NOT NULL, raw_ticker_group VARCHAR NOT NULL,
  year INTEGER NOT NULL, quarter INTEGER NOT NULL, consolidation_type VARCHAR NOT NULL,
  template_family VARCHAR NOT NULL, scale_unit VARCHAR NOT NULL, scale_multiplier BIGINT NOT NULL,
  has_tms29_monetary_item BOOLEAN NOT NULL, filepath VARCHAR NOT NULL, fact_count INTEGER NOT NULL,
  loaded_at TIMESTAMP NOT NULL);
INSERT INTO reports VALUES (1651411, 'KATMR', 'KATMR', 2026, 2, 'consolidated', 'general', 'TL', 1, true, 'x.xls', 10, now()::TIMESTAMP);
`;

describe("migrate", () => {
  test("a new database gets every step and the views", async () => {
    const con = await memory();
    expect(await migrate(con)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await schemaVersion(con)).toBe(CURRENT_VERSION);
    expect(await columns(con, "reports")).toContain("published_at");
    expect(await all(con, "SELECT count(*) AS n FROM facts_latest")).toEqual([{ n: 0n }]);
  });

  test("a current database is left alone", async () => {
    const con = await memory();
    await migrate(con);
    expect(await migrate(con)).toEqual([]);
    expect(await all(con, "SELECT count(*) AS n FROM schema_version")).toEqual([{ n: BigInt(CURRENT_VERSION) }]);
  });

  test("a database made before versioning and before #157 is upgraded and keeps its data", async () => {
    const con = await memory();
    await con.run(PRE_157);
    expect(await migrate(con)).toEqual([1, 2]);
    expect((await columns(con, "reports")).at(-1)).toBe("published_at");
    expect(await all(con, "SELECT company_code, published_at FROM reports")).toEqual([
      { company_code: "KATMR", published_at: null },
    ]);
  });

  test("a database made after #157 but before versioning is upgraded", async () => {
    const con = await memory();
    await con.run(`${PRE_157} ALTER TABLE reports ADD COLUMN published_at TIMESTAMP;`);
    expect(await migrate(con)).toEqual([1, 2]);
    expect(await schemaVersion(con)).toBe(CURRENT_VERSION);
  });

  test("a step stops at the first failure and is rolled back", async () => {
    const con = await memory();
    const steps = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, name: "good", sql: "CREATE TABLE t_good (x INTEGER);" },
      { version: MIGRATIONS.length + 2, name: "bad", sql: "CREATE TABLE t_bad (x INTEGER); SELECT * FROM missing;" },
    ];
    const error = (await migrate(con, steps).catch((e) => e)) as SchemaError;
    expect(error).toBeInstanceOf(SchemaError);
    expect(error.message).toContain("delete it and load again");
    expect(await schemaVersion(con)).toBe(MIGRATIONS.length + 1);
    expect(await all(con, "SELECT table_name FROM information_schema.tables WHERE table_name = 't_bad'")).toEqual([]);
  });

  test("a database from a newer Vigil is refused", async () => {
    const con = await memory();
    await migrate(con);
    await con.run("INSERT INTO schema_version VALUES (99, 'future', now()::TIMESTAMP)");
    await expect(migrate(con)).rejects.toThrow(/newer than this Vigil/);
  });

  test("migrations must be numbered 1..n", async () => {
    const con = await memory();
    await expect(migrate(con, [{ version: 2, name: "x", sql: "" }])).rejects.toBeInstanceOf(SchemaError);
  });
});

test("connect migrates a file database and refuses a newer one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-migrate-"));
  try {
    const path = join(dir, "vigil.duckdb");
    let db = await connect(path);
    expect(await schemaVersion(db.con)).toBe(CURRENT_VERSION);
    await db.con.run("INSERT INTO schema_version VALUES (99, 'future', now()::TIMESTAMP)");
    close(db);
    await expect(connect(path)).rejects.toBeInstanceOf(SchemaError);
    db = await DuckDBInstance.create(path).then(async (instance) => ({ instance, con: await instance.connect() }));
    close(db); // the failed connect released the file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
