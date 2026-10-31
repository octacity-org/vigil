/**
 * Per-file data quality report (#19).
 *
 *   bun run quality data/raw/2026_2 reports/quality_2026_2.csv
 *
 * Writes the CSV and a Markdown summary next to it, prints the summary, and exits 1 if any file fails a blocking
 * check or cannot be parsed, so it can gate a quarter before loading.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileQuality, markdownSummary, toCsv } from "@vigil/core";
import { kapFiles } from "../db.ts";

const args = process.argv.slice(2);
const rawDir = args[0] ?? join("data", "raw", "2026_2");
const outCsv = args[1] ?? join("reports", "quality.csv");

const rows = kapFiles(rawDir).map((path) => fileQuality(basename(path), readFileSync(path)));
mkdirSync(dirname(resolve(outCsv)), { recursive: true });
writeFileSync(outCsv, toCsv(rows), "utf8");
const summary = markdownSummary(rows, basename(normalize(rawDir)));
writeFileSync(`${outCsv.replace(/\.[^./\\]*$/, "")}.md`, summary, "utf8");
console.log(summary);
process.exit(rows.some((r) => r.status === "fail" || r.status === "parse_error") ? 1 : 0);
