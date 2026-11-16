/**
 * Process the reports waiting in the Zova archive and load them into DuckDB (#208).
 *
 *   bun run process                        # data/vigil.zova into data/vigil.duckdb
 *   bun run process data data/vigil.duckdb
 *
 * Every pending `report_stored` event (from `bun run import` or the collector) is parsed, checked and loaded with its
 * check results, then marked handled. Running it again does nothing new. Prints processed, failed and errors, and how
 * many loaded reports are blocked by a failing check. Exits 1 if a report failed or a job threw (its event stays
 * pending), or the store or database cannot be opened (for example while the app runs); 2 for wrong arguments.
 */
import { join } from "node:path";
import { close, connect, type Database, rows } from "../db.ts";
import { loadInto, type ProcessSummary, processPending } from "../processor.ts";
import { WriteQueue } from "../queue.ts";
import { migrateStore } from "../store-schema.ts";
import { openStore, type Store, upgradeMessage } from "../zova.ts";

const args = process.argv.slice(2);
if (args.length > 2 || args.some((a) => a.startsWith("-"))) {
  console.error("Usage: bun run process [data_dir=data] [db_path=<data_dir>/vigil.duckdb]");
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
const queue = new WriteQueue();
let summary: ProcessSummary | null = null;
let blocked = 0;
let error: Error | null = null;
try {
  migrateStore(store);
  db = await connect(dbPath);
  summary = await processPending(store, queue, { handle: loadInto(db) });
  const [r] = await rows(
    db,
    "SELECT count(DISTINCT disclosure_id) AS n FROM check_results WHERE severity = 'blocking' AND status = 'fail'",
  );
  blocked = Number(r?.n);
} catch (e) {
  error = e as Error;
} finally {
  await queue.close();
  if (db !== null) close(db);
  store.close(); // releases the lock; process.exit inside the try would skip this
}

if (error) {
  console.error(`Stopped: ${error.name}: ${error.message}`);
  process.exit(1);
}
const s = summary as ProcessSummary;
console.log(
  `Processed: ${s.processed} | failed: ${s.failed} | already handled: ${s.already_handled} | errors: ${s.errors.length}`,
);
for (const e of s.errors) console.log(`  event ${e.event}: ${e.error}`);
console.log(`Reports blocked by a failing check in ${dbPath}: ${blocked}`);
process.exit(s.failed > 0 || s.errors.length > 0 ? 1 : 0);
