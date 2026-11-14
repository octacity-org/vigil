/**
 * Load the CPI (TÜFE) series into DuckDB (#188). Re-running replaces the series; it never duplicates rows.
 *
 *   bun run cpi                                  # the series that ships with Vigil, into data/vigil.duckdb
 *   bun run cpi <series.csv> data/vigil.duckdb
 *
 * The file format is `CPI_CSV_HEADER` in `@vigil/core`. Exits 1 if the file is not valid or the database does not
 * hold the same number of months afterwards.
 */
import { join } from "node:path";
import { CPI_FILE, cpiSummary, loadCpiSeries, readCpiFile } from "../cpi.ts";
import { close, connect } from "../db.ts";

const args = process.argv.slice(2);
const file = args[0] ?? CPI_FILE;
const dbPath = args[1] ?? join("data", "vigil.duckdb");

const series = readCpiFile(file);
const db = await connect(dbPath);
const written = await loadCpiSeries(db, series);
const summary = await cpiSummary(db);
close(db);

console.log(`CPI ${series.base}: ${written} months in ${file}, ${summary.months} in the database`);
if (summary.months !== written) process.exit(1);
console.log(`${summary.first} to ${summary.last} -> ${dbPath}`);
