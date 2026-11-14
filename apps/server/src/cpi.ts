/**
 * The monthly CPI (TÜFE) series that ships with Vigil (#47) and its DuckDB table (#188). The file format and the
 * factor between two period ends are in `@vigil/core` (`cpi.ts`).
 *
 * `cpi_monthly` holds one series. Loading replaces it as a whole in one transaction, so values of two base years
 * never mix, a month dropped from the file does not linger, and re-running changes nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CpiSeries, parseCpiCsv } from "@vigil/core";
import { type Database, rows } from "./db.ts";

/** The CPI series that ships with Vigil: TÜİK's general index, refreshed monthly by maintainers (`bun run cpi:import`). */
export const CPI_FILE = fileURLToPath(new URL("../reference/cpi-tr.csv", import.meta.url));

/** Read and check a CPI series file; any problem raises an error naming the line. */
export function readCpiFile(path: string): CpiSeries {
  return parseCpiCsv(readFileSync(path, "utf8"));
}

/** Replace the series in `cpi_monthly`. Returns the number of months written. */
export async function loadCpiSeries(db: Database, series: CpiSeries): Promise<number> {
  const values = [...series.values.values()].sort((a, b) => a.month.localeCompare(b.month));
  await db.con.run("BEGIN TRANSACTION");
  try {
    await db.con.run("DELETE FROM cpi_monthly");
    for (const v of values) {
      await db.con.run(
        "INSERT INTO cpi_monthly VALUES ($1::DATE, $2::DECIMAL(18, 6), $3, $4, $5, $6::TIMESTAMP)",
        // retrieved_at is UTC; the column has no time zone, so the trailing Z is dropped.
        [`${v.month}-01`, v.index, v.base, v.source, v.series_code, v.retrieved_at.replace(/Z$/, "")],
      );
    }
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
  return values.length;
}

/** Months in `cpi_monthly`, with the first and last month (`YYYY-MM`), for the load summary. */
export async function cpiSummary(db: Database): Promise<{ months: number; first: string | null; last: string | null }> {
  const [r] = await rows(
    db,
    "SELECT count(*) AS n, strftime(min(month), '%Y-%m') AS first, strftime(max(month), '%Y-%m') AS last FROM cpi_monthly",
  );
  return {
    months: Number(r?.n ?? 0),
    first: (r?.first as string | null) ?? null,
    last: (r?.last as string | null) ?? null,
  };
}
