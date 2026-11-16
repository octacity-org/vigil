/**
 * Rebuild DuckDB from the Zova archive (#162, decision 0009): DuckDB is derived, so after a parser or check change it
 * is built again from the stored raw files, without asking KAP.
 *
 * Every disclosure in Zova is parsed and checked from its latest stored version (as the processor does, #207) and
 * loaded with its check results (#208) into a new file next to the database (`<db>.rebuild`). The CPI series is
 * loaded from the file that ships with Vigil. Only when everything is loaded is the new file moved over the old one;
 * until then the old database is untouched, and a failed rebuild leaves it as it was.
 *
 * Company metadata (#189) comes from KAP's disclosure list and sector pages, not from the raw files, so it is copied
 * from the old database when there is one; `bun run companies` refreshes it. Metrics and findings are not copied:
 * they were computed from the old facts and are computed again (#209, #210).
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { CPI_FILE, loadCpiSeries, readCpiFile } from "./cpi.ts";
import { close, connect, type Database, loadFiling, rows } from "./db.ts";
import { checkStoredFile, checkSummary, latestFile } from "./processor.ts";
import type { Store } from "./zova.ts";

/** The new database is written here, then moved over `dbPath`. */
export const rebuildPath = (dbPath: string) => `${dbPath}.rebuild`;

export interface RebuildSummary {
  /** Disclosures in the archive. */
  disclosures: number;
  loaded: number;
  /** Disclosures whose latest file cannot be parsed or checked: not in the new database. */
  failed: { disclosure_id: number; file_name: string; reason: string }[];
  facts: number;
  /** Loaded reports with a blocking check failure, known filing errors included (no findings). */
  blocked: number;
  /** Totals of the checks, as `bun run quality` counts them. */
  checks: ReturnType<typeof checkSummary>;
  cpi_months: number;
  /** Companies whose metadata came from the old database. */
  companies_copied: number;
}

const METADATA = [
  "mkk_member_oid",
  "stock_codes",
  "title",
  "template_family",
  "main_sector_no",
  "main_sector_name",
  "sector_no",
  "sector_name",
  "sectors_read_at",
  "search_key",
];

function removeFile(path: string): void {
  for (const p of [path, `${path}.wal`]) rmSync(p, { force: true });
}

/** Copy company metadata from the old database into the new one; returns how many companies got it. */
async function copyCompanies(db: Database, oldPath: string): Promise<number> {
  const quoted = oldPath.replaceAll("'", "''");
  await db.con.run(`ATTACH '${quoted}' AS old (READ_ONLY)`);
  try {
    await db.con.run(
      `UPDATE companies AS n SET ${METADATA.map((c) => `${c} = o.${c}`).join(", ")}
       FROM old.companies AS o WHERE n.company_code = o.company_code AND o.mkk_member_oid IS NOT NULL`,
    );
    const [r] = await rows(db, "SELECT count(*) AS n FROM companies WHERE mkk_member_oid IS NOT NULL");
    return Number(r?.n);
  } finally {
    await db.con.run("DETACH old");
  }
}

/**
 * Build a new database at `dbPath` from every disclosure in `store`. `onProgress` is called after each disclosure.
 * Throws if the store or the new database fails; the old database is then unchanged and the partial file removed.
 */
export async function rebuildDatabase(
  store: Store,
  dbPath: string,
  options: { onProgress?: (done: number, total: number) => void; cpiFile?: string } = {},
): Promise<RebuildSummary> {
  const tmp = rebuildPath(dbPath);
  removeFile(tmp); // left over from a rebuild that stopped
  const ids = store
    .query("SELECT DISTINCT disclosure_id FROM raw_files ORDER BY disclosure_id")
    .map((r) => Number(r.disclosure_id));
  const out: RebuildSummary = {
    disclosures: ids.length,
    loaded: 0,
    failed: [],
    facts: 0,
    blocked: 0,
    checks: { passed: 0, failed: 0, not_checked: 0, informational_differences: 0, known_errors: 0 },
    cpi_months: 0,
    companies_copied: 0,
  };
  const db = await connect(tmp);
  try {
    out.cpi_months = await loadCpiSeries(db, readCpiFile(options.cpiFile ?? CPI_FILE));
    for (const [i, id] of ids.entries()) {
      const file = latestFile(store, id);
      if (file === null) continue;
      const report = checkStoredFile(store, file);
      if (report.status === "checked") {
        await loadFiling(db, report.filing, { checks: report.checks });
        out.loaded += 1;
        out.facts += report.filing.facts.length;
        if (report.blocking.length > 0) out.blocked += 1;
        const c = checkSummary(report.checks);
        for (const k of Object.keys(c) as (keyof typeof c)[]) out.checks[k] += c[k];
      } else {
        out.failed.push({ disclosure_id: id, file_name: file.file_name, reason: report.reason });
      }
      options.onProgress?.(i + 1, ids.length);
    }
    if (existsSync(dbPath)) out.companies_copied = await copyCompanies(db, dbPath);
    await db.con.run("CHECKPOINT");
  } catch (e) {
    close(db);
    removeFile(tmp);
    throw e;
  }
  close(db);
  // The swap: the old file's write-ahead log belongs to the old file and must not be replayed into the new one.
  rmSync(`${dbPath}.wal`, { force: true });
  renameSync(tmp, dbPath);
  return out;
}
