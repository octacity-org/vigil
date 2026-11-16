/**
 * Fill the company metadata in DuckDB (#189) from KAP's disclosure list and sector classification.
 *
 *   bun run companies                         # data/vigil.zova and data/vigil.duckdb
 *   bun run companies data data/vigil.duckdb
 *
 * Asks KAP for the financial-report disclosures of the days the companies' latest reports were published (#163), and
 * uses the sector classification in the archive, read again if it is a day old (#295). Prints the companies updated,
 * those without a disclosure (no member id) and those KAP does not classify. Exits 1 if a company has no member id,
 * KAP cannot be read, or the archive or database cannot be opened; 2 for wrong arguments.
 */
import { join } from "node:path";
import { latestReports, publicationRange, updateCompanies } from "../companies.ts";
import { close, connect, type Database } from "../db.ts";
import { listDisclosures } from "../disclosures.ts";
import { refreshSectors } from "../sectors.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

const args = process.argv.slice(2);
if (args.length > 2 || args.some((a) => a.startsWith("-"))) {
  console.error("Usage: bun run companies [data_dir=data] [db_path=<data_dir>/vigil.duckdb]");
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
let db: Database | null = null;
let code = 0;
try {
  migrateStore(store);
  db = await connect(dbPath);
  const latest = await latestReports(db);
  const range = publicationRange(latest);
  const disclosures = range === null ? [] : await listDisclosures({ ...range, classes: ["FR"] });
  const { reading } = await refreshSectors(store);
  const u = await updateCompanies(db, disclosures, reading);
  console.log(
    `Companies: ${u.rows.length} updated, ${u.missing.length} without a disclosure, ` +
      `${u.without_sector.length} without a KAP sector (sectors read ${reading.read_at})`,
  );
  if (u.missing.length > 0) console.log(`  without a disclosure: ${u.missing.join(", ")}`);
  if (u.without_sector.length > 0) console.log(`  without a KAP sector: ${u.without_sector.join(", ")}`);
  if (u.missing.length > 0) code = 1;
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  code = 1;
} finally {
  if (db !== null) close(db);
  store.close();
}
process.exit(code);
