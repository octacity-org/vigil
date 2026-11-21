/**
 * Start the server process (#168): collector, processor and API in one process.
 *
 *   bun run start              # data folder `VIGIL_DATA_DIR` or `data`, API on http://127.0.0.1:8787
 *   bun run start data
 *
 * `VIGIL_PORT` changes the port. Logs are JSON lines on stdout (errors on stderr), one per event, for a bug report.
 * Ctrl+C or SIGTERM (`docker compose down`) stops it gracefully (#198); a second signal, or the time limit, exits at
 * once. Exits 1 when start-up fails (for example when another process holds the data folder), 2 for wrong arguments.
 */
import { DEFAULT_PORT } from "../api/app.ts";
import { type Log, startServer } from "../server.ts";
import { DEFAULT_DATA_DIR } from "../settings.ts";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => a.startsWith("-"))) {
  console.error("Usage: bun run start [data_dir=$VIGIL_DATA_DIR or data]");
  process.exit(2);
}
const port = process.env.VIGIL_PORT === undefined ? DEFAULT_PORT : Number(process.env.VIGIL_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`VIGIL_PORT must be a port number, got ${process.env.VIGIL_PORT}`);
  process.exit(2);
}

const log: Log = (level, message, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer({ dataDir: args[0] ?? DEFAULT_DATA_DIR, port, log });
} catch (e) {
  log("error", "start-up failed", { error: `${(e as Error).name}: ${(e as Error).message}` });
  process.exit(1);
}

let signals = 0;
const shutdown = async (signal: string) => {
  signals += 1;
  if (signals > 1) {
    log("error", "second signal, exiting without waiting", { signal });
    process.exit(1);
  }
  log("info", "signal received", { signal });
  const result = await server.stop();
  process.exit(result.clean ? 0 : 1);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
