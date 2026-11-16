/**
 * Reconcile with the quarter's bulk archive (#205, collector #50): polling can miss a disclosure, so the quarter's zip
 * (#38) is the safety net. It is downloaded and compared with Zova by disclosure:
 *
 * - **Missing**: a statement in the zip whose disclosure has no stored file is stored, with its `report_stored` event
 *   (`source: "download"`), so the processor picks it up. A disclosure the collector recorded but had not downloaded
 *   yet is closed with it (`seen_disclosures.outcome`), so it is not asked for again.
 * - **Already stored**: left alone. The zip's bytes differ from the company download's in whitespace only
 *   (`docs/kap.md`), so storing them would add a version with the same values for every report.
 * - **Not in the archive**: disclosures of the quarter Vigil stored or recorded that the zip does not have, each with
 *   whether it was corrected (KAP's zip has only the correction, #204). Others (banks, brokers, `docs/kap.md`) are
 *   differences to look at. Only listed when the zip was read completely; a cut-off zip does not show what is after
 *   the cut.
 *
 * Every run is kept in Zova (`reconciliations`) with its counts and differences. `startReconciling` runs it once a day
 * for the quarters whose reports are coming in; `bun run reconcile <year> <quarter>` runs it on demand.
 */
import { basename, join } from "node:path";
import { type IsoDate, parseFilename, previousDay } from "@vigil/core";
import { istanbulToday } from "./disclosures.ts";
import { type DownloadOptions, downloadQuarter, KAP_BULK_PATH } from "./downloader.ts";
import { type ImportFailure, importQuarter } from "./import.ts";
import { KAP_ORIGIN } from "./kap.ts";
import { filesByDisclosure } from "./raw-files.ts";
import type { Store } from "./zova.ts";

/** Time between two reconciliations of the same quarter. */
export const RECONCILE_EVERY_MS = 24 * 60 * 60_000;
/** How often the scheduler looks for a quarter that is due. Looking costs nothing; only a due quarter asks KAP. */
export const RECONCILE_CHECK_MS = 60 * 60_000;
/** Quarters with financial reports recorded in this many days are reconciled daily. */
export const RECONCILE_WINDOW_DAYS = 120;

export interface NotInArchive {
  disclosure_id: number;
  /** Has a stored file, or was only recorded by the collector. */
  stored: boolean;
  /** Corrected later: the archive has the correction instead (#204). */
  corrected: boolean;
}

export interface Reconciliation {
  year: number;
  quarter: number;
  ran_at: string;
  /** The zip was read completely. */
  complete: boolean;
  /** Statement files read from the zip. */
  in_archive: number;
  /** Missing from Zova, now stored. */
  stored: { disclosure_id: number; file_name: string }[];
  already_stored: number;
  /** Empty when the zip was not complete. */
  not_in_archive: NotInArchive[];
  /** Zip members cut off or corrupt. */
  lost: string[];
  /** Files that could not be stored (a wrong name, another quarter). */
  failed: ImportFailure[];
  /** Why the run did nothing: no zip, or the files could not be stored. */
  error: string | null;
}

export interface ReconcileOptions extends DownloadOptions {
  /** Where the zip is kept and extracted, as `bun run download` does. */
  rawDir?: string;
  now?: () => Date;
}

function save(store: Store, r: Reconciliation): Reconciliation {
  store.run(
    `INSERT INTO reconciliations (year, quarter, ran_at, complete, in_archive, stored, already_stored, not_in_archive,
       lost, failed, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    [
      r.year,
      r.quarter,
      r.ran_at,
      r.complete ? 1 : 0,
      r.in_archive,
      JSON.stringify(r.stored),
      r.already_stored,
      JSON.stringify(r.not_in_archive),
      JSON.stringify(r.lost),
      JSON.stringify(r.failed),
      r.error,
    ],
  );
  return r;
}

/** Close a recorded disclosure whose file the archive gave. */
function closeSeen(store: Store, disclosureId: number, outcome: "stored" | "duplicate", at: string): void {
  const file = filesByDisclosure(store, disclosureId).at(-1);
  if (file === undefined) return;
  store.run(
    `UPDATE seen_disclosures SET handled_at = ?2, outcome = ?3, object_id = ?4, retry_after = NULL,
       last_error = 'from the quarter''s bulk archive'
     WHERE disclosure_id = ?1 AND handled_at IS NULL`,
    [disclosureId, at, outcome, file.object_id],
  );
}

/** Download a quarter's bulk zip, store what Zova is missing and record the differences. */
export async function reconcileQuarter(
  store: Store,
  year: number,
  quarter: number,
  options: ReconcileOptions = {},
): Promise<Reconciliation> {
  const clock = options.now ?? (() => new Date());
  const rawDir = options.rawDir ?? join("data", "raw");
  const download = await downloadQuarter(year, quarter, rawDir, options);
  const ranAt = clock();
  const out: Reconciliation = {
    year,
    quarter,
    ran_at: ranAt.toISOString(),
    complete: download.complete,
    in_archive: download.recovered.length,
    stored: [],
    already_stored: 0,
    not_in_archive: [],
    lost: download.lost,
    failed: [],
    error: null,
  };
  if (download.recovered.length === 0) {
    out.error = download.errors.at(-1) ?? "no files in the archive";
    return save(store, out);
  }

  const inArchive = new Map<number, string>(); // disclosure id → file name
  const missing: string[] = [];
  for (const path of download.recovered) {
    const name = basename(path);
    let id: number;
    try {
      id = parseFilename(name).disclosure_id;
    } catch (e) {
      out.failed.push({ file: name, reason: `${(e as Error).name}: ${(e as Error).message}` });
      continue;
    }
    inArchive.set(id, name);
    if (filesByDisclosure(store, id).length === 0) missing.push(name);
    else {
      out.already_stored += 1;
      closeSeen(store, id, "duplicate", out.ran_at);
    }
  }

  if (missing.length > 0) {
    const path = KAP_BULK_PATH.replace("{year}", String(year)).replace("{quarter}", String(quarter));
    const imported = importQuarter(store, join(rawDir, `${year}_${quarter}`), {
      downloadedAt: ranAt,
      files: missing,
      source: "download",
      sourceUrl: `${KAP_ORIGIN}${path}`,
    });
    out.failed.push(...imported.failed);
    out.error = imported.error;
    for (const name of missing) {
      const id = parseFilename(name).disclosure_id;
      if (filesByDisclosure(store, id).length === 0) continue;
      out.stored.push({ disclosure_id: id, file_name: name });
      closeSeen(store, id, "stored", out.ran_at);
    }
  }

  if (download.complete) {
    const known = store.query(
      `SELECT disclosure_id, max(stored) AS stored FROM (
         SELECT disclosure_id, 1 AS stored FROM raw_files WHERE year = ?1 AND quarter = ?2
         UNION ALL
         SELECT disclosure_id, 0 AS stored FROM seen_disclosures WHERE year = ?1 AND quarter = ?2
       ) GROUP BY disclosure_id ORDER BY disclosure_id`,
      [year, quarter],
    );
    for (const k of known) {
      const id = Number(k.disclosure_id);
      if (inArchive.has(id)) continue;
      const corrected =
        store.query(
          `SELECT 1 FROM corrections WHERE original_disclosure_id = ?1
           UNION ALL SELECT 1 FROM seen_disclosures WHERE disclosure_id = ?1 AND is_changed = 'DUZELTILEN'`,
          [id],
        ).length > 0;
      out.not_in_archive.push({ disclosure_id: id, stored: Number(k.stored) === 1, corrected });
    }
  }
  return save(store, out);
}

/** Every reconciliation run, newest first; with a quarter, only that quarter's. */
export function reconciliations(store: Store, quarter?: { year: number; quarter: number }): Reconciliation[] {
  const rows =
    quarter === undefined
      ? store.query("SELECT * FROM reconciliations ORDER BY ran_at DESC, id DESC")
      : store.query("SELECT * FROM reconciliations WHERE year = ?1 AND quarter = ?2 ORDER BY ran_at DESC, id DESC", [
          quarter.year,
          quarter.quarter,
        ]);
  return rows.map((r) => ({
    year: Number(r.year),
    quarter: Number(r.quarter),
    ran_at: String(r.ran_at),
    complete: Number(r.complete) === 1,
    in_archive: Number(r.in_archive),
    stored: JSON.parse(String(r.stored)),
    already_stored: Number(r.already_stored),
    not_in_archive: JSON.parse(String(r.not_in_archive)),
    lost: JSON.parse(String(r.lost)),
    failed: JSON.parse(String(r.failed)),
    error: r.error === null ? null : String(r.error),
  }));
}

/**
 * The quarters to reconcile at `now`: those with a financial report recorded by the collector in the last
 * `RECONCILE_WINDOW_DAYS` days (Istanbul), whose last reconciliation is a day old or older. Oldest quarter first.
 */
export function dueQuarters(store: Store, now: Date): { year: number; quarter: number }[] {
  let since: IsoDate = istanbulToday(now);
  for (let i = 0; i < RECONCILE_WINDOW_DAYS; i++) since = previousDay(since);
  const before = new Date(now.getTime() - RECONCILE_EVERY_MS).toISOString();
  return store
    .query(
      `SELECT DISTINCT s.year, s.quarter FROM seen_disclosures s
       WHERE s.year IS NOT NULL AND s.quarter IS NOT NULL AND s.published_at >= ?1
         AND NOT EXISTS (SELECT 1 FROM reconciliations r
                         WHERE r.year = s.year AND r.quarter = s.quarter AND r.ran_at > ?2)
       ORDER BY s.year, s.quarter`,
      [since, before],
    )
    .map((r) => ({ year: Number(r.year), quarter: Number(r.quarter) }));
}

export interface ReconcilerOptions extends ReconcileOptions {
  onReconcile?: (r: Reconciliation) => void;
  onError?: (error: unknown) => void;
  /** Replaceable in tests: schedules `fn` after `ms`, returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Reconcile every due quarter now, then look again every `RECONCILE_CHECK_MS`, until `stop`. A quarter is reconciled
 * at most once a day, also across restarts (the runs are in Zova). An error is reported and the next check runs as
 * usual. `stop` waits for a run in progress.
 */
export function startReconciling(store: Store, options: ReconcilerOptions = {}): { stop: () => Promise<void> } {
  const schedule = options.schedule ?? realSchedule;
  const clock = options.now ?? (() => new Date());
  let stopped = false;
  let cancel: () => void = () => {};
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      for (const q of dueQuarters(store, clock())) {
        if (stopped) return;
        try {
          options.onReconcile?.(await reconcileQuarter(store, q.year, q.quarter, options));
        } catch (e) {
          options.onError?.(e);
        }
      }
    })()
      .catch(options.onError ?? (() => {}))
      .finally(() => {
        if (!stopped) cancel = schedule(tick, RECONCILE_CHECK_MS);
      });
  };
  tick();
  return {
    stop: async () => {
      stopped = true;
      cancel();
      await running;
    },
  };
}
