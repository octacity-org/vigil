/**
 * Tables in the Zova store (decision 0009), versioned like the DuckDB schema (#182): ordered, append-only steps,
 * each run once in a transaction and recorded in `store_schema_version`.
 */
import type { Store } from "./zova.ts";

export interface StoreMigration {
  version: number;
  name: string;
  sql: string;
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    name: "app events (#179)",
    sql: `
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK (type IN ('report_stored', 'report_processed', 'report_failed')),
    subject     TEXT NOT NULL,           -- what the event is about, e.g. the stored file's object id
    payload     TEXT NOT NULL,           -- JSON
    created_at  TEXT NOT NULL,           -- ISO 8601, UTC
    handled_at  TEXT                     -- NULL until a consumer has finished with it
);
CREATE INDEX events_pending ON events (type, id) WHERE handled_at IS NULL;
`,
  },
  {
    version: 2,
    name: "raw KAP files (#176)",
    sql: `
CREATE TABLE raw_files (
    object_id         TEXT NOT NULL,     -- Zova object id = SHA-256 of the content, hex
    disclosure_id     INTEGER NOT NULL,  -- KAP disclosure number
    company_code      TEXT NOT NULL,     -- first code of the ticker group
    raw_ticker_group  TEXT NOT NULL,     -- e.g. A1CAP-ACP
    year              INTEGER NOT NULL,
    quarter           INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    file_name         TEXT NOT NULL,     -- {TICKER-GROUP}_{disclosure}_{year}_{quarter}.xls
    size_bytes        INTEGER NOT NULL,
    downloaded_at     TEXT NOT NULL,     -- ISO 8601, UTC
    source_url        TEXT NOT NULL,     -- KAP URL the bytes came from, or file:// for an import
    stored_at         TEXT NOT NULL      -- ISO 8601, UTC
);
CREATE INDEX raw_files_disclosure ON raw_files (disclosure_id, downloaded_at);
CREATE INDEX raw_files_company ON raw_files (company_code, year, quarter);
CREATE INDEX raw_files_quarter ON raw_files (year, quarter);
`,
  },
  {
    version: 3,
    name: "one row per disclosure and content (#177)",
    sql: `
DELETE FROM raw_files
WHERE rowid NOT IN (SELECT min(rowid) FROM raw_files GROUP BY disclosure_id, object_id);
CREATE UNIQUE INDEX raw_files_disclosure_content ON raw_files (disclosure_id, object_id);
`,
  },
];

export class StoreSchemaError extends Error {
  override name = "StoreSchemaError";
}

export function storeSchemaVersion(store: Store): number {
  store.exec(
    "CREATE TABLE IF NOT EXISTS store_schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  return Number(store.query("SELECT coalesce(max(version), 0) AS v FROM store_schema_version")[0]?.v ?? 0);
}

/** Apply the missing steps in order. Returns the versions applied. */
export function migrateStore(store: Store, migrations: readonly StoreMigration[] = STORE_MIGRATIONS): number[] {
  if (migrations.some((m, i) => m.version !== i + 1))
    throw new StoreSchemaError("store migrations must be numbered 1..n");
  const current = storeSchemaVersion(store);
  if (current > migrations.length) {
    throw new StoreSchemaError(
      `store schema version ${current} is newer than this Vigil (${migrations.length}); update Vigil`,
    );
  }
  const applied: number[] = [];
  for (const m of migrations.slice(current)) {
    try {
      store.transaction((s) => {
        s.exec(m.sql);
        s.run("INSERT INTO store_schema_version VALUES (?1, ?2, ?3)", [m.version, m.name, new Date().toISOString()]);
      });
    } catch (e) {
      throw new StoreSchemaError(`store migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
    applied.push(m.version);
  }
  return applied;
}
