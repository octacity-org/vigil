/**
 * Turn TÜİK's CPI export into the CPI series file that ships with Vigil (#47). Maintainers run it once a month:
 *
 *   1. On https://veriportali.tuik.gov.tr/tr/bulk-download, download DF_TUFE_SDMX_TT10 as CSV.
 *   2. bun run cpi:import "<downloaded file>.csv" [output] [--retrieved-at=2026-11-14T20:56:43Z]
 *   3. Check the printed summary and the diff, then commit apps/server/reference/cpi-tr.csv.
 *
 * The retrieval time of new or revised months is `--retrieved-at`, or else the downloaded file's modification time
 * (UTC); unchanged months keep theirs. Exits with an error if the export is incomplete, the index is not one chain
 * (see `parseTuikCpiCsv` in `@vigil/core`), or it lacks a month the current file has. If TÜİK ever rebases the series
 * again and the new export starts later than the current file, move the current file away and import into a new one.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatCpiCsv, fractionToDecimal, parseTuikCpiCsv, updateCpiSeries } from "@vigil/core";
import { CPI_FILE, readCpiFile } from "../cpi.ts";

const usage = "Usage: bun run cpi:import <TÜİK DF_TUFE_SDMX_TT10 export.csv> [output] [--retrieved-at=<UTC time>]";
const config = { options: { "retrieved-at": { type: "string" } }, allowPositionals: true, strict: true } as const;
let parsed: ReturnType<typeof parseArgs<typeof config>>;
try {
  // strict: an unknown or misspelled option is an error, never taken for a file name.
  parsed = parseArgs(config);
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`);
  process.exit(1);
}
const [input, output = CPI_FILE, ...extra] = parsed.positionals;
if (input === undefined || extra.length > 0) {
  console.error(usage);
  process.exit(1);
}

const retrievedAt = parsed.values["retrieved-at"] ?? `${statSync(input).mtime.toISOString().slice(0, 19)}Z`;
const imported = parseTuikCpiCsv(readFileSync(input, "utf8"), retrievedAt);
const months = [...imported.series.values.keys()].sort();
console.log(`CPI ${imported.series.base}: ${months.length} months, ${months[0]} to ${months[months.length - 1]}`);
console.log(
  `Chain: ${imported.checked_months} monthly changes match TÜİK's published ones; largest gap ${fractionToDecimal(imported.largest_gap, 4)} points`,
);

let series = imported.series;
if (existsSync(output)) {
  const previous = readCpiFile(output);
  const update = updateCpiSeries(previous, imported.series);
  if (update.missing.length > 0) {
    console.error(`The export lacks months that ${output} has: ${update.missing.join(", ")}`);
    process.exit(1);
  }
  if (previous.base !== imported.series.base) {
    console.log(`Base year changed from ${previous.base} to ${imported.series.base}: every month is replaced`);
  }
  console.log(`New months: ${update.added.join(", ") || "none"}`);
  console.log(`Revised months: ${update.revised.join(", ") || "none"}`);
  series = update.series;
}
// Write a temporary file and rename it, so an interrupted run never leaves a shorter file that still reads as valid.
writeFileSync(`${output}.tmp`, formatCpiCsv(series));
renameSync(`${output}.tmp`, output);
console.log(`${series.values.size} months -> ${output} (new or revised months retrieved at ${retrievedAt})`);
