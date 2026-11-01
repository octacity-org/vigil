/**
 * Bring a DuckDB database to the current schema (#182). Steps are in `MIGRATIONS` (schema.ts).
 *
 * DuckDB is derived data (decision 0009): if a database cannot be migrated, the way out is to delete it and load
 * again from the raw archive. `SchemaError` says so.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { MIGRATIONS, type Migration, SCHEMA_VERSION_SQL, VIEWS_SQL } from "./schema.ts";

export class SchemaError extends Error {
  override name = "SchemaError";
}

export const CURRENT_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Highest applied version; 0 for a new database or one made before versioning. */
export async function schemaVersion(con: DuckDBConnection): Promise<number> {
  await con.run(SCHEMA_VERSION_SQL);
  const reader = await con.runAndReadAll("SELECT coalesce(max(version), 0) AS v FROM schema_version");
  return Number(reader.getRowObjectsJS()[0]?.v ?? 0);
}

/** Apply the missing steps in order, then recreate the views. Returns the steps applied. */
export async function migrate(con: DuckDBConnection, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  const versions = migrations.map((m) => m.version);
  if (versions.some((v, i) => v !== i + 1)) throw new SchemaError(`migrations must be numbered 1..n: ${versions}`);
  const current = await schemaVersion(con);
  const latest = versions.length;
  if (current > latest) {
    throw new SchemaError(
      `database schema version ${current} is newer than this Vigil (${latest}); update Vigil or delete the database and load again`,
    );
  }
  const applied: number[] = [];
  for (const m of migrations.slice(current)) {
    await con.run("BEGIN TRANSACTION");
    try {
      await con.run(m.sql);
      await con.run("INSERT INTO schema_version VALUES ($1, $2, now()::TIMESTAMP)", [m.version, m.name]);
      await con.run("COMMIT");
    } catch (e) {
      await con.run("ROLLBACK");
      throw new SchemaError(
        `migration ${m.version} (${m.name}) failed: ${(e as Error).message}. The database is left at version ${m.version - 1}; delete it and load again from the raw files to rebuild it`,
      );
    }
    applied.push(m.version);
  }
  await con.run(VIEWS_SQL);
  return applied;
}
