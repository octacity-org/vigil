/**
 * Rebuild DuckDB from the Zova archive (#162), for example after a parser change, without asking KAP.
 *
 *   bun run rebuild                        # data/vigil.zova into data/vigil.duckdb
 *   bun run rebuild data data/vigil.duckdb
 *
 * Builds a new database next to the old one and moves it over the old one only when every stored report is loaded;
 * prints the parse and quality summary. Exits 1 if the store or the database fails (the old database is then
 * unchanged), or if a report could not be parsed or checked (the new database is in place without it); 2 for wrong
 * arguments. Do not run it while the app runs.
 */
import { join } from "node:path";
import { type RebuildSummary, rebuildDatabase } from "../rebuild.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

const args = process.argv.slice(2);
if (args.length > 2 || args.some((a) => a.startsWith("-"))) {
  console.error("Usage: bun run rebuild [data_dir=data] [db_path=<data_dir>/vigil.duckdb]");
  process.exit(2);
}
const dataDir = args[0] ?? "data";
const dbPath = args[1] ?? join(dataDir, "vigil.duckdb");

let store: Store;
try {
  store = openStore(dataDir, { onUpgrade: (u) => console.log(upgradeMessage(u)) });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
let summary: RebuildSummary | null = null;
let error: Error | null = null;
try {
  migrateStore(store);
  let shown = 0;
  summary = await rebuildDatabase(store, dbPath, {
    onProgress: (done, total) => {
      if (done === total || done - shown >= 100) {
        console.log(`  ${done} / ${total}`);
        shown = done;
      }
    },
  });
} catch (e) {
  error = e as Error;
} finally {
  store.close();
}
if (error) {
  console.error(`Stopped, ${dbPath} unchanged: ${error.name}: ${error.message}`);
  process.exit(1);
}
const s = summary as RebuildSummary;
console.log(`Rebuilt ${dbPath} from ${s.disclosures} stored reports`);
console.log(`Loaded: ${s.loaded} | failed: ${s.failed.length} | facts: ${s.facts} | CPI months: ${s.cpi_months}`);
for (const f of s.failed) console.log(`  ${f.file_name}: ${f.reason}`);
const c = s.checks;
console.log(
  `Checks: passed ${c.passed} | failed ${c.failed} | known errors ${c.known_errors} | not checked ${c.not_checked} | ` +
    `informational differences ${c.informational_differences}`,
);
console.log(`Reports blocked by a failing check: ${s.blocked}`);
console.log(`Company metadata kept from the old database: ${s.companies_copied} (bun run companies refreshes it)`);
process.exit(s.failed.length > 0 ? 1 : 0);
