/**
 * Read KAP's sector classification into the Zova archive (#295).
 *
 *   bun run sectors              # data/vigil.zova; reads the page only if the last reading is a day old
 *   bun run sectors data --force # read it now
 *
 * Prints the companies, main sectors and sub-sectors of the reading in use, and whether the page was read and the
 * classification changed. Exits 1 if KAP cannot be read, the page is not what Vigil reads (its layout changed), or the
 * archive cannot be opened; 2 for wrong arguments.
 */
import { parseArgs } from "node:util";
import { refreshSectors } from "../sectors.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

const usage = "Usage: bun run sectors [data_dir=data] [--force]";
let parsed: { values: { force?: boolean }; positionals: string[] };
try {
  parsed = parseArgs({ options: { force: { type: "boolean" } }, allowPositionals: true, strict: true });
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`);
  process.exit(2);
}
if (parsed.positionals.length > 1) {
  console.error(usage);
  process.exit(2);
}
const dataDir = parsed.positionals[0] ?? "data";

let store: Store;
try {
  store = openStore(dataDir, { onUpgrade: (u) => console.log(upgradeMessage(u)) });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
let code = 0;
try {
  migrateStore(store);
  const before = store.query("SELECT count(*) AS n FROM sector_classifications")[0]?.n;
  const { reading, fetched } = await refreshSectors(store, { force: parsed.values.force === true });
  const changed = store.query("SELECT count(*) AS n FROM sector_classifications")[0]?.n !== before;
  const count = (k: "main_sector_no" | "sector_no") =>
    new Set(reading.companies.map((c) => c[k]).filter((v) => v !== null)).size;
  const how = !fetched ? "last reading, less than a day old" : changed ? "read now, changed" : "read now, unchanged";
  console.log(
    `Sectors (${how}, ${reading.read_at}): ${reading.companies.length} companies, ` +
      `${count("main_sector_no")} main sectors, ${count("sector_no")} sub-sectors`,
  );
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  code = 1;
} finally {
  store.close();
}
process.exit(code);
