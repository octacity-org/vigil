/**
 * The server process (#168, decision 0010): the collector, the processor and the API in one Bun process, which owns
 * the Zova archive and the DuckDB connection (DuckDB allows one writing process per file).
 *
 * Start-up, in order: read the settings file (#195), open Zova and run its migrations, connect DuckDB (it migrates
 * itself), then start the processor, the collector (poller with downloads, #50; reconciler, #205) and the API. `/v1/ready`
 * answers 200 only between a finished start-up and the start of shutdown.
 *
 * The processor runs the pending `report_stored` events through the write queue (#197): at start, after each
 * collector run that stored files, and every `PROCESS_EVERY_MS` for events stored by other means (`bun run import`).
 *
 * Shutdown (#198): stop answering ready, stop the collector (it finishes the poll or download in progress), close the
 * write queue (the jobs already added finish, no new ones are taken), stop the API, then close DuckDB and Zova. A
 * time limit ends the wait; the caller then exits anyway. Every DuckDB write runs in its own transaction, so a write
 * cut off by the limit leaves the database as it was before it.
 */
import { join } from "node:path";
import { createApp, DEFAULT_PORT, type Routes, type RunningServer, serve } from "./api/app.ts";
import type { LinkResult } from "./corrections.ts";
import { close, connect, type Database } from "./db.ts";
import type { KapClient } from "./kap.ts";
import { type PollResult, startPolling } from "./poller.ts";
import { loadInto, type ProcessSummary, processPending } from "./processor.ts";
import { WriteQueue } from "./queue.ts";
import { type Reconciliation, startReconciling } from "./reconcile.ts";
import type { PendingDownloads } from "./report-downloads.ts";
import { defaultSettingsPath, readSettings, type StoredSettings } from "./settings.ts";
import { migrateStore } from "./store-schema.ts";
import { openStore, type Store, upgradeMessage } from "./zova.ts";

/** How often the processor looks for pending reports besides after collector runs. */
export const PROCESS_EVERY_MS = 60_000;
/** How long shutdown waits for the work in progress before giving up. */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export type LogLevel = "info" | "warn" | "error";
export type Log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

export interface ServerOptions {
  /** The data folder: Zova archive, DuckDB file, settings file and the bulk zips. */
  dataDir: string;
  /** Defaults to `<dataDir>/vigil.duckdb`. */
  dbPath?: string;
  /** Defaults to `<dataDir>/vigil.settings.json`. */
  settingsPath?: string;
  /** Defaults to 8787; 0 picks a free port. */
  port?: number;
  /** Run the collector (KAP polling, downloads, reconciliation). On by default; tests turn it off. */
  collect?: boolean;
  /** Shared by the poller, the downloads and the reconciler, so the polite-access spacing (#199) holds across them. */
  kap?: KapClient;
  /** Extra API routes (#78). */
  routes?: Routes[];
  log?: Log;
  /** Replaceable in tests: schedules `fn` after `ms`, returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface StopResult {
  /** Everything finished and was closed in time. */
  clean: boolean;
  /** What was still running when the time limit ended the wait. */
  pending: string[];
}

export interface VigilServer {
  url: string;
  port: number;
  settings: StoredSettings;
  store: Store;
  db: Database;
  queue: WriteQueue;
  /** Resolves when the processor has nothing left to do (tests). */
  processed(): Promise<void>;
  /** Run the processor now (or once more after the run in progress). */
  process(): void;
  stop(options?: { timeoutMs?: number }): Promise<StopResult>;
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

const quiet: Log = () => {};

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Start the server process. Throws, with everything it opened closed again, when start-up fails. */
export async function startServer(options: ServerOptions): Promise<VigilServer> {
  const log = options.log ?? quiet;
  const schedule = options.schedule ?? realSchedule;
  const dataDir = options.dataDir;
  const settings = readSettings(options.settingsPath ?? defaultSettingsPath(dataDir));
  let ready = false;

  const store = openStore(dataDir, { onUpgrade: (u) => log("info", upgradeMessage(u)) });
  let db: Database;
  try {
    migrateStore(store);
    db = await connect(options.dbPath ?? join(dataDir, "vigil.duckdb"));
  } catch (e) {
    store.close();
    throw e;
  }

  const queue = new WriteQueue((job, error) =>
    log("error", "write job failed", { job: job.name, error: describe(error) }),
  );

  // The processor: one run at a time; a request during a run asks for one more run after it.
  const handle = loadInto(db);
  let processing: Promise<void> | null = null;
  let again = false;
  let stopping = false;
  const idle: (() => void)[] = [];
  const runProcessor = (): void => {
    if (stopping) return;
    if (processing !== null) {
      again = true;
      return;
    }
    again = false;
    processing = processPending(store, queue, { handle })
      .then((s: ProcessSummary) => {
        if (s.processed + s.failed + s.errors.length > 0) {
          log(s.errors.length > 0 ? "warn" : "info", "processed reports", {
            processed: s.processed,
            failed: s.failed,
            errors: s.errors.length,
            gave_up: s.gave_up.length,
          });
        }
      })
      .catch((e) => log("error", "processor run failed", { error: describe(e) }))
      .finally(() => {
        processing = null;
        if (again && !stopping) runProcessor();
        else for (const r of idle.splice(0)) r();
      });
  };
  let cancelTimer: () => void = () => {};
  const tick = () => {
    runProcessor();
    if (!stopping) cancelTimer = schedule(tick, PROCESS_EVERY_MS);
  };

  const collectors: { stop: () => Promise<void> }[] = [];
  let api: RunningServer;
  try {
    tick();
    if (options.collect !== false) {
      const onError = (e: unknown) => log("warn", "collector error", { error: describe(e) });
      collectors.push(
        startPolling(store, {
          kap: options.kap,
          download: true,
          onPoll: (r: PollResult) => {
            if (r.new.length > 0) log("info", "new financial reports", { from: r.from, to: r.to, new: r.new.length });
          },
          onLink: (r: LinkResult) => {
            if (r.linked.length > 0) log("info", "corrections linked", { linked: r.linked.length });
          },
          onDownload: (r: PendingDownloads) => {
            if (r.closed.length + r.failed.length > 0) {
              log("info", "reports downloaded", { closed: r.closed.length, failed: r.failed.length });
            }
            if (r.closed.length > 0) runProcessor();
          },
          onError,
        }),
        startReconciling(store, {
          kap: options.kap,
          rawDir: join(dataDir, "raw"),
          onReconcile: (r: Reconciliation) => {
            log(r.error === null ? "info" : "warn", "quarter reconciled", {
              year: r.year,
              quarter: r.quarter,
              stored: r.stored.length,
              not_in_archive: r.not_in_archive.length,
              error: r.error,
            });
            if (r.stored.length > 0) runProcessor();
          },
          onError,
        }),
      );
    }
    const app = createApp({
      routes: options.routes,
      isReady: () => ready,
      onInternalError: (e) => log("error", "API error", { error: describe(e) }),
    });
    api = serve(app, options.port ?? DEFAULT_PORT);
  } catch (e) {
    stopping = true;
    cancelTimer();
    await Promise.allSettled(collectors.map((c) => c.stop()));
    await Promise.all([queue.close(), processing ?? Promise.resolve()]);
    close(db);
    store.close();
    throw e;
  }
  ready = true;
  log("info", "server started", { url: api.url, data_dir: dataDir, collect: options.collect !== false });

  let stopped: Promise<StopResult> | null = null;
  const stop = (stopOptions: { timeoutMs?: number } = {}): Promise<StopResult> => {
    stopped ??= (async () => {
      ready = false;
      stopping = true;
      cancelTimer();
      log("info", "shutting down");
      const steps: [string, () => Promise<unknown>][] = [
        ["collector", () => Promise.all(collectors.map((c) => c.stop()))],
        // Closing the queue makes the processor's next job fail with QueueClosedError, which ends its run.
        ["processor", () => Promise.all([queue.close(), processing ?? Promise.resolve()])],
        ["api", () => api.stop()],
      ];
      const pending = new Set(steps.map(([name]) => name));
      const work = Promise.all(
        steps.map(([name, run]) =>
          run()
            .catch((e) => log("error", `${name} did not stop cleanly`, { error: describe(e) }))
            .finally(() => pending.delete(name)),
        ),
      );
      let cancelLimit: () => void = () => {};
      const limit = new Promise<"timeout">((r) => {
        cancelLimit = schedule(() => r("timeout"), stopOptions.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
      });
      const outcome = await Promise.race([work.then(() => "done" as const), limit]);
      cancelLimit();
      if (outcome === "timeout") {
        const left = [...pending];
        const running = queue.stats().running;
        if (running !== null) left.push(`write job "${running.name}"`);
        log("error", "shutdown time limit reached", { pending: left });
        return { clean: false, pending: left };
      }
      close(db);
      store.close();
      log("info", "server stopped");
      return { clean: true, pending: [] };
    })();
    return stopped;
  };

  return {
    url: api.url,
    port: api.port,
    settings,
    store,
    db,
    queue,
    processed: () => (processing === null && !again ? Promise.resolve() : new Promise<void>((r) => idle.push(r))),
    process: runProcessor,
    stop,
  };
}
