/**
 * Download KAP files.
 *
 *   bun run download 2026 2 data/raw data                  # one quarter, stored in data/vigil.zova (#44)
 *   bun run download --files tests/raw_files.txt data/raw  # only the files the tests need (#128); not archived
 *
 * A quarter's files are extracted to `{raw_dir}/{year}_{quarter}/` and stored in the Zova archive with their
 * `report_stored` events, ready for `bun run process`. Files recovered from a cut-off download are stored too.
 * Exits 1 if the quarter (or a listed file) is incomplete, a file could not be stored, or the archive cannot be
 * opened (for example while the app runs).
 */
import { join } from "node:path";
import { downloadToStore, fetchFiles } from "../downloader.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

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
  console.error("usage: download <year> <quarter> [raw_dir] [data_dir] | download --files <list> [raw_dir]");
  process.exit(2);
}
const dataDir = args[3] ?? "data";
// Open the archive first: a download that cannot be stored would have to be repeated.
let store: Store;
try {
  store = openStore(dataDir, { onUpgrade: (u) => console.log(upgradeMessage(u)) });
  migrateStore(store);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
let result: Awaited<ReturnType<typeof downloadToStore>>;
try {
  result = await downloadToStore(store, year, quarter, args[2] ?? defaultRaw);
} catch (e) {
  console.error(`Stopped: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
} finally {
  store.close();
}
const { download: r, stored } = result;
for (const e of r.errors) console.log(e);
const state = r.complete ? "complete" : "INCOMPLETE";
console.log(
  `${year}/${quarter}: ${state} after ${r.attempts} attempt(s); ${r.recovered.length} files, ${r.lost.length} lost`,
);
for (const name of r.lost) console.log(`  lost: ${name}`);
const versions = stored.new_versions > 0 ? ` (${stored.new_versions} new versions)` : "";
console.log(
  `Archive: ${stored.imported} stored${versions}, ${stored.skipped} already stored, ${stored.failed.length} failed -> ${join(dataDir, "vigil.zova")}`,
);
for (const f of stored.failed) console.log(`  failed ${f.file}: ${f.reason}`);
if (stored.error) console.log(`  not stored: ${stored.error}`);
process.exit(r.complete && stored.failed.length === 0 && stored.error === null ? 0 : 1);
