/**
 * Load parsed KAP filings into the bitemporal DuckDB schema (#46; schema in schema.ts, docs/SCHEMA.md).
 *
 * `period_start` / `period_end` come from the column header dates, never from the quarter number (special fiscal
 * periods such as MAVI). If a header has no dates they are NULL. Loading is idempotent: each filing is replaced as a
 * whole, keyed by its disclosure id.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type DuckDBAppender, type DuckDBConnection, DuckDBInstance, dateValue } from "@duckdb/node-api";
import { type ParsedFiling, parseFilename, parseKapXls } from "@vigil/core";
import { SCHEMA_SQL } from "./schema.ts";

export const FACT_COLUMNS = [
  "disclosure_id",
  "row_id",
  "column_class",
  "role_code",
  "statement_type",
  "label_tr",
  "footnote_ref",
  "period_type",
  "period_label",
  "period_start",
  "period_end",
  "is_comparative",
  "raw_value",
  "scale_unit",
  "scale_multiplier",
  "normalized_value_tl",
] as const;

const REPORT_COLUMNS = [
  "disclosure_id",
  "company_code",
  "raw_ticker_group",
  "year",
  "quarter",
  "consolidation_type",
  "template_family",
  "scale_unit",
  "scale_multiplier",
  "has_tms29_monetary_item",
  "filepath",
  "fact_count",
  "loaded_at",
  "published_at",
] as const;

export type FileStatus = "ok" | "parse_error" | "duplicate_facts" | "duplicate_disclosure" | "load_error";

export interface FileReport {
  filepath: string;
  status: FileStatus;
  disclosure_id: number | null;
  fact_count: number;
  error: string | null;
}

export interface ParseReport {
  raw_dir: string;
  files: FileReport[];
}

export const okFiles = (r: ParseReport) => r.files.filter((f) => f.status === "ok");
export const failedFiles = (r: ParseReport) => r.files.filter((f) => f.status !== "ok");
export const totalFacts = (r: ParseReport) => okFiles(r).reduce((n, f) => n + f.fact_count, 0);

function fileReport(filepath: string, status: FileStatus, fields: Partial<FileReport> = {}): FileReport {
  return {
    filepath,
    status,
    disclosure_id: fields.disclosure_id ?? null,
    fact_count: fields.fact_count ?? 0,
    error: fields.error ?? null,
  };
}

function duplicateKeys(filing: ParsedFiling): [string, string][] {
  const seen = new Map<string, number>();
  for (const f of filing.facts) {
    const k = `${f.row_id}\u0000${f.column_class}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k.split("\u0000") as [string, string]);
}

/** Where each parsed filing was read from; stored in `reports.filepath`. */
const sourcePaths = new WeakMap<ParsedFiling, string>();

/** The `.xls` files of a directory, sorted by name. */
export function kapFiles(rawDir: string): string[] {
  return readdirSync(rawDir)
    .filter((n) => n.toLowerCase().endsWith(".xls"))
    .sort()
    .map((n) => join(rawDir, n));
}

/** Parse every .xls in rawDir. Files that fail are listed in the report, never skipped silently. */
export function parseDirectory(rawDir: string): [ParsedFiling[], ParseReport] {
  const filings: ParsedFiling[] = [];
  const files: FileReport[] = [];
  const seenIds = new Map<number, string>();
  for (const path of kapFiles(rawDir)) {
    let pf: ParsedFiling;
    try {
      pf = parseKapXls(readFileSync(path), basename(path));
    } catch (e) {
      files.push(fileReport(path, "parse_error", { error: `${(e as Error).name}: ${(e as Error).message}` }));
      continue;
    }
    const first = seenIds.get(pf.disclosure_id);
    if (first !== undefined) {
      // The disclosure id is the report key; a second file would silently replace the first one.
      files.push(
        fileReport(path, "duplicate_disclosure", {
          disclosure_id: pf.disclosure_id,
          fact_count: pf.facts.length,
          error: `disclosure ${pf.disclosure_id} already read from ${basename(first)}`,
        }),
      );
      continue;
    }
    seenIds.set(pf.disclosure_id, path);

    const dups = duplicateKeys(pf);
    if (dups.length > 0) {
      // Two values for one cell cannot both be right; loading either one would be a guess.
      const [row, col] = dups[0] as [string, string];
      files.push(
        fileReport(path, "duplicate_facts", {
          disclosure_id: pf.disclosure_id,
          fact_count: pf.facts.length,
          error: `${dups.length} duplicate (row_id, column_class) keys, first: ('${row}', '${col}')`,
        }),
      );
      continue;
    }
    sourcePaths.set(pf, path);
    filings.push(pf);
    files.push(fileReport(path, "ok", { disclosure_id: pf.disclosure_id, fact_count: pf.facts.length }));
  }
  return [filings, { raw_dir: rawDir, files }];
}

export interface Database {
  instance: DuckDBInstance;
  con: DuckDBConnection;
}

/** Open (or create) a database and make sure the schema exists. `:memory:` for an in-memory database. */
export async function connect(dbPath: string): Promise<Database> {
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const instance = await DuckDBInstance.create(dbPath);
  const con = await instance.connect();
  await con.run(SCHEMA_SQL);
  return { instance, con };
}

export function close(db: Database): void {
  db.con.closeSync();
  db.instance.closeSync();
}

/** Run a query and return its rows as plain objects (bigints for integers, strings for dates). */
export async function rows(db: Database, sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const reader = await db.con.runAndReadAll(sql, values as never);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}

function appendDate(app: DuckDBAppender, d: string | null): void {
  if (d === null) {
    app.appendNull();
    return;
  }
  const [year, month, day] = d.split("-").map(Number) as [number, number, number];
  app.appendDate(dateValue({ year, month, day }));
}

function appendText(app: DuckDBAppender, s: string | null): void {
  if (s === null) app.appendNull();
  else app.appendVarchar(s);
}

/** Write a filing's facts with DuckDB's appender, in the order of FACT_COLUMNS (the table's column order). */
async function appendFacts(db: Database, filing: ParsedFiling): Promise<void> {
  const app = await db.con.createAppender("facts");
  try {
    for (const f of filing.facts) {
      app.appendBigInt(BigInt(f.disclosure_id));
      app.appendVarchar(f.row_id);
      app.appendVarchar(f.column_class);
      app.appendVarchar(f.role_code);
      app.appendVarchar(f.statement_type);
      app.appendVarchar(f.label_tr);
      appendText(app, f.footnote_ref);
      app.appendVarchar(f.period_type);
      app.appendVarchar(f.period_label);
      appendDate(app, f.period_start);
      appendDate(app, f.period_end);
      app.appendBoolean(f.is_restated_comparative);
      app.appendBigInt(f.raw_value);
      app.appendVarchar(f.scale_unit);
      app.appendBigInt(f.scale_multiplier);
      app.appendHugeInt(f.normalized_value_tl);
      app.endRow();
    }
    app.flushSync();
  } finally {
    app.closeSync();
  }
}

function localTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function placeholders(columns: number, rowCount: number): string {
  let n = 0;
  const row = () => `(${Array.from({ length: columns }, () => `$${++n}`).join(", ")})`;
  return Array.from({ length: rowCount }, row).join(", ");
}

/** Replace one filing in the database inside a transaction. Returns the number of facts written. */
export async function loadFiling(db: Database, filing: ParsedFiling): Promise<number> {
  const id = BigInt(filing.disclosure_id);
  await db.con.run("BEGIN TRANSACTION");
  try {
    await db.con.run("DELETE FROM facts WHERE disclosure_id = $1", [id]);
    await db.con.run("DELETE FROM reports WHERE disclosure_id = $1", [id]);
    await db.con.run("INSERT INTO companies VALUES ($1) ON CONFLICT DO NOTHING", [filing.company_code]);
    await db.con.run(
      `INSERT INTO reports (${REPORT_COLUMNS.join(", ")}) VALUES ${placeholders(REPORT_COLUMNS.length, 1)}`,
      [
        id,
        filing.company_code,
        filing.raw_ticker_group,
        filing.year,
        filing.quarter,
        filing.consolidation_type,
        filing.template_family,
        filing.scale_unit,
        filing.scale_multiplier,
        filing.has_tms29_monetary_item,
        sourcePaths.get(filing) ?? filing.file_name,
        filing.facts.length,
        localTimestamp(new Date()),
        filing.published_at,
      ] as never,
    );
    await appendFacts(db, filing);
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
  return filing.facts.length;
}

/** Load every filing; a filing that fails to load is marked `load_error` in the report and the rest continue. */
export async function loadFilings(db: Database, filings: readonly ParsedFiling[], report: ParseReport): Promise<void> {
  const byId = new Map(report.files.filter((r) => r.status === "ok").map((r) => [r.disclosure_id, r]));
  for (const pf of filings) {
    try {
      await loadFiling(db, pf);
    } catch (e) {
      const r = byId.get(pf.disclosure_id);
      if (r) {
        r.status = "load_error";
        r.error = `${(e as Error).name}: ${(e as Error).message}`;
      }
    }
  }
}

/** Facts per filing in the database compared with the parse report: [filepath, expected, loaded] for differences. */
export async function countMismatches(db: Database, report: ParseReport): Promise<[string, number, number][]> {
  const loaded = new Map<number, number>();
  for (const r of await rows(db, "SELECT disclosure_id, count(*) AS n FROM facts GROUP BY 1")) {
    loaded.set(Number(r.disclosure_id), Number(r.n));
  }
  const out: [string, number, number][] = [];
  for (const r of okFiles(report)) {
    const n = loaded.get(r.disclosure_id as number) ?? 0;
    if (n !== r.fact_count) out.push([r.filepath, r.fact_count, n]);
  }
  return out;
}

/**
 * Reports still in the database for files that failed in this run. Their rows come from an earlier load and no
 * longer match what the parser produces. Returns [filepath, disclosure_id].
 */
export async function staleReports(db: Database, report: ParseReport): Promise<[string, number][]> {
  const failed = new Map(failedFiles(report).map((r) => [basename(r.filepath), r.filepath]));
  if (failed.size === 0) return [];
  const out: [string, number][] = [];
  for (const r of await rows(db, "SELECT disclosure_id, filepath FROM reports")) {
    const path = failed.get(basename(String(r.filepath)));
    if (path !== undefined) out.push([path, Number(r.disclosure_id)]);
  }
  return out;
}

/**
 * Reports still in the database for a report period (year, quarter) of this run whose file is no longer in raw_dir.
 * Returns [filepath, disclosure_id].
 */
export async function missingReports(db: Database, report: ParseReport): Promise<[string, number][]> {
  const names = new Set(report.files.map((r) => basename(r.filepath)));
  const periods = new Set<string>();
  for (const name of names) {
    try {
      const m = parseFilename(name);
      periods.add(`${m.year}_${m.quarter}`);
    } catch {
      // not a KAP file name
    }
  }
  const out: [string, number][] = [];
  for (const r of await rows(db, "SELECT disclosure_id, filepath, year, quarter FROM reports ORDER BY filepath")) {
    const path = String(r.filepath);
    if (periods.has(`${r.year}_${r.quarter}`) && !names.has(basename(path))) out.push([path, Number(r.disclosure_id)]);
  }
  return out;
}
