/**
 * Import KAP files already downloaded into `data/raw/` into the Zova archive (#180).
 *
 *   bun run import                              # every {year}_{quarter} folder in data/raw, into data/vigil.zova
 *   bun run import data/raw/2026_2 data         # one quarter
 *   bun run import data/raw/2026_2 data --downloaded-at=2026-10-24T20:55:00Z   # one time, so one quarter
 *
 * Re-running stores nothing new: files already stored with the same bytes are skipped. Prints imported, skipped
 * and failed per quarter. Exits 1 if a file or a folder failed, the raw folder is missing, or the store cannot be
 * opened (for example while the app runs) or written; 2 for wrong arguments.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { emptyQuarterImport, importQuarter, type QuarterImport, quarterDirs } from "../import.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, STORE_FILE, type Store, upgradeMessage } from "../zova.ts";

const usage = "Usage: bun run import [raw_dir=data/raw] [data_dir=data] [--downloaded-at=<UTC time>]";
const config = { options: { "downloaded-at": { type: "string" } }, allowPositionals: true, strict: true } as const;
let parsed: ReturnType<typeof parseArgs<typeof config>>;
try {
  parsed = parseArgs(config);
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`);
  process.exit(2);
}
const [rawDir = join("data", "raw"), dataDir = "data", ...extra] = parsed.positionals;
const given = parsed.values["downloaded-at"];
if (extra.length > 0) {
  console.error(usage);
  process.exit(2);
}
const isUtc = (t: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(t) &&
  !Number.isNaN(Date.parse(t)) &&
  new Date(t).toISOString().slice(0, 19) === t.slice(0, 19); // refuses 2026-02-30 instead of rolling it over
if (given !== undefined && !isUtc(given)) {
  console.error(`--downloaded-at must be a UTC time such as 2026-10-24T20:55:00Z, got ${given}`);
  process.exit(2);
}
if (given !== undefined && Date.parse(given) > Date.now()) {
  console.error(`--downloaded-at ${given} is in the future`);
  process.exit(2);
}

// Find the folders before opening the store, so a wrong path creates no vigil.zova.
let dirs: string[];
try {
  dirs = quarterDirs(rawDir);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (given !== undefined && dirs.length > 1) {
  console.error(`--downloaded-at gives one time, so import one quarter folder with it, not ${dirs.length}`);
  process.exit(2);
}

let store: Store;
try {
  store = openStore(dataDir, { onUpgrade: (u) => console.log(upgradeMessage(u)) });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const results: QuarterImport[] = [];
let error: Error | null = null;
try {
  migrateStore(store);
  const downloadedAt = given === undefined ? undefined : new Date(given);
  for (const dir of dirs) {
    const result = emptyQuarterImport(dir);
    results.push(result); // before importing, so a store error part way still shows what was stored
    importQuarter(store, dir, { downloadedAt }, result);
  }
} catch (e) {
  error = e as Error;
} finally {
  store.close(); // releases the lock; process.exit inside the try would skip this
}

// Quarters finished before an error are stored; print them either way.
let failed = 0;
for (const r of results) {
  const versions = r.new_versions > 0 ? ` (${r.new_versions} new versions)` : "";
  const when = r.error
    ? `; folder failed: ${r.error}`
    : r.downloaded_at
      ? `; downloaded_at ${r.downloaded_at} from ${r.downloaded_at_source}`
      : r.failed.length > 0
        ? "; no readable .xls files"
        : "; no .xls files";
  console.log(
    `${r.year}/${r.quarter}: ${r.imported} imported${versions}, ${r.skipped} skipped, ${r.failed.length} failed${when}`,
  );
  for (const f of r.failed) console.log(`  failed ${f.file}: ${f.reason}`);
  failed += r.failed.length + (r.error ? 1 : 0);
}
if (error) {
  console.error(`Stopped: ${error.name}: ${error.message}`);
  process.exit(1);
}
const sum = (k: "imported" | "skipped") => results.reduce((n, r) => n + r[k], 0);
console.log(
  `Total: ${sum("imported")} imported, ${sum("skipped")} skipped, ${failed} failed -> ${join(dataDir, STORE_FILE)}`,
);
process.exit(failed > 0 ? 1 : 0);
