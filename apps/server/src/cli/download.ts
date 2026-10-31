/**
 * Download KAP files.
 *
 *   bun run download 2026 2 data/raw                       # one quarter
 *   bun run download --files tests/raw_files.txt data/raw  # only the files the tests need (#128)
 *
 * Exits 1 if the quarter (or a listed file) is incomplete.
 */
import { join } from "node:path";
import { downloadQuarter, fetchFiles } from "../downloader.ts";

const args = process.argv.slice(2);
const defaultRaw = join("data", "raw");

if (args[0] === "--files") {
  const missing = await fetchFiles(args[1] as string, args[2] ?? defaultRaw);
  for (const [quarter, names] of missing) for (const name of names) console.log(`missing: ${quarter}/${name}`);
  console.log(missing.size === 0 ? "all listed files present" : "INCOMPLETE");
  process.exit(missing.size === 0 ? 0 : 1);
}

const year = Number(args[0]);
const quarter = Number(args[1]);
if (!Number.isInteger(year) || !Number.isInteger(quarter)) {
  console.error("usage: download <year> <quarter> [raw_dir] | download --files <list> [raw_dir]");
  process.exit(2);
}
const r = await downloadQuarter(year, quarter, args[2] ?? defaultRaw);
for (const e of r.errors) console.log(e);
const state = r.complete ? "complete" : "INCOMPLETE";
console.log(
  `${year}/${quarter}: ${state} after ${r.attempts} attempt(s); ${r.recovered.length} files, ${r.lost.length} lost`,
);
for (const name of r.lost) console.log(`  lost: ${name}`);
process.exit(r.complete ? 0 : 1);
