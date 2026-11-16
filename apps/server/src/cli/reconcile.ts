/**
 * Reconcile a quarter with KAP's bulk archive on demand (#205).
 *
 *   bun run reconcile 2026 2 [raw_dir] [data_dir]
 *
 * Downloads the quarter's zip into `{raw_dir}/{year}_{quarter}/`, stores the files Zova is missing with their
 * `report_stored` events (ready for `bun run process`), and prints the differences: what was stored, and what Vigil
 * has that the archive does not (corrected originals marked). The run is kept in Zova. Exits 1 if the zip was not
 * complete, a file could not be stored or the archive cannot be opened, 2 for wrong arguments.
 */
import { join } from "node:path";
import { reconcileQuarter } from "../reconcile.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

const args = process.argv.slice(2);
const year = Number(args[0]);
const quarter = Number(args[1]);
if (args.length < 2 || args.length > 4 || !Number.isInteger(year) || year < 2009 || ![1, 2, 3, 4].includes(quarter)) {
  console.error("usage: bun run reconcile <year> <quarter> [raw_dir] [data_dir]");
  process.exit(2);
}
const rawDir = args[2] ?? join("data", "raw");
const dataDir = args[3] ?? "data";

let store: Store;
try {
  store = openStore(dataDir, { onUpgrade: (u) => console.log(upgradeMessage(u)) });
  migrateStore(store);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
let r: Awaited<ReturnType<typeof reconcileQuarter>>;
try {
  r = await reconcileQuarter(store, year, quarter, { rawDir });
} catch (e) {
  console.error(`Stopped: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
} finally {
  store.close();
}

const state = r.complete ? "complete" : "INCOMPLETE";
console.log(`${year}/${quarter}: archive ${state}, ${r.in_archive} files, ${r.lost.length} lost`);
if (r.error !== null) console.log(`  error: ${r.error}`);
console.log(`Missing from Vigil, now stored: ${r.stored.length}; already stored: ${r.already_stored}`);
for (const s of r.stored) console.log(`  stored ${s.file_name}`);
for (const f of r.failed) console.log(`  failed ${f.file}: ${f.reason}`);
for (const name of r.lost) console.log(`  lost: ${name}`);
if (r.complete) {
  const corrected = r.not_in_archive.filter((d) => d.corrected);
  const other = r.not_in_archive.filter((d) => !d.corrected);
  console.log(
    `In Vigil but not in the archive: ${r.not_in_archive.length} (${corrected.length} corrected, the archive has the correction)`,
  );
  for (const d of other) console.log(`  ${d.disclosure_id}${d.stored ? " (stored)" : " (recorded, not stored)"}`);
}
process.exit(r.complete && r.failed.length === 0 && r.error === null ? 0 : 1);
