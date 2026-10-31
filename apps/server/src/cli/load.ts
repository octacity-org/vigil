/**
 * Load a quarter of parsed filings into DuckDB (re-running replaces each filing, it never duplicates rows).
 *
 *   bun run load data/raw/2026_2 data/vigil.duckdb
 *
 * Exits 1 on load errors, row-count mismatches, stale reports (files that failed now but have rows from an earlier
 * load) or missing files (removed from the directory but still in the database).
 */
import { basename, join } from "node:path";
import {
  close,
  connect,
  countMismatches,
  failedFiles,
  loadFilings,
  missingReports,
  okFiles,
  parseDirectory,
  staleReports,
  totalFacts,
} from "../db.ts";

const args = process.argv.slice(2);
const rawDir = args[0] ?? join("data", "raw", "2026_2");
const dbPath = args[1] ?? join("data", "vigil.duckdb");

const [filings, report] = parseDirectory(rawDir);
const db = await connect(dbPath);
await loadFilings(db, filings, report);
const mismatches = await countMismatches(db, report);
const stale = await staleReports(db, report);
const missing = await missingReports(db, report);
close(db);

console.log(`Files: ${report.files.length} | ok: ${okFiles(report).length} | failed: ${failedFiles(report).length}`);
console.log(`Facts in parse report: ${totalFacts(report)}`);
for (const r of failedFiles(report)) console.log(`  ${r.status.padEnd(16)} ${basename(r.filepath)}: ${r.error}`);

const loadErrors = failedFiles(report).filter((r) => r.status === "load_error");
if (loadErrors.length > 0) {
  console.log(`Load errors: ${loadErrors.length}`);
  process.exit(1);
}
if (mismatches.length > 0) {
  console.log(`Row count mismatches: ${mismatches.length}`);
  for (const [path, expected, got] of mismatches)
    console.log(`  ${basename(path)}: parse report ${expected}, database ${got}`);
  process.exit(1);
}
if (stale.length > 0) {
  console.log(`Stale reports (failed now, rows from an earlier load still in the database): ${stale.length}`);
  for (const [path, id] of stale) console.log(`  ${basename(path)} (disclosure ${id})`);
  process.exit(1);
}
if (missing.length > 0) {
  console.log(`Missing files (removed from ${rawDir}, rows still in the database): ${missing.length}`);
  for (const [path, id] of missing) console.log(`  ${basename(path)} (disclosure ${id})`);
  process.exit(1);
}
console.log(`Row counts match the parse report for all ${okFiles(report).length} loaded files -> ${dbPath}`);
