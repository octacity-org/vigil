/**
 * The first download of the quarters the user chose (#206, first-run setup #165): each quarter's bulk zip is
 * downloaded through the KAP client and its files stored in Zova with their events (`downloadToStore`, #44).
 *
 * The chosen quarters and how far each got are kept in Zova (`quarter_downloads`), so a download stopped by a restart
 * continues where it stopped: quarters already done are not downloaded again, and the quarter that was running starts
 * again (KAP's zip cannot be resumed part way, `docs/kap.md`). A quarter that was incomplete or failed is tried again
 * on the next run. Files stored before a stop are skipped on the next run, never stored twice.
 *
 * Progress is reported after each step: the quarter, its phase, files done and total, and the errors so far.
 */
import { join } from "node:path";
import { type DownloadOptions, downloadToStore } from "./downloader.ts";
import type { Store } from "./zova.ts";

export interface Quarter {
  year: number;
  quarter: number;
}

export type QuarterStatus = "pending" | "running" | "done" | "incomplete" | "failed";

export interface QuarterDownload extends Quarter {
  status: QuarterStatus;
  requested_at: string;
  finished_at: string | null;
  attempts: number;
  files_stored: number;
  files_skipped: number;
  files_failed: number;
  files_lost: number;
  error: string | null;
}

export interface Progress {
  year: number;
  quarter: number;
  phase: "downloading" | "storing" | "done" | "incomplete" | "failed";
  /** Quarters finished (done, incomplete or failed) in this run, and quarters to run. */
  quarters_done: number;
  quarters_total: number;
  /** Files of the current quarter handled and found; 0 of 0 while downloading. */
  files_done: number;
  files_total: number;
  /** Errors in this run so far: lost or failed files, and failed quarters. */
  errors: number;
}

function checkQuarter(q: Quarter): void {
  if (!Number.isInteger(q.year) || q.year < 2009 || ![1, 2, 3, 4].includes(q.quarter)) {
    throw new RangeError(`not a quarter KAP has a bulk file for: ${q.year}/${q.quarter}`);
  }
}

/**
 * Add the chosen quarters. A quarter already done stays done; one that is pending, running, incomplete or failed is
 * left to the next run. Returns the quarters that were new.
 */
export function chooseQuarters(store: Store, quarters: readonly Quarter[], now = new Date()): Quarter[] {
  for (const q of quarters) checkQuarter(q);
  return store.transaction((s) => {
    const added: Quarter[] = [];
    for (const q of quarters) {
      const n = s.run(
        `INSERT INTO quarter_downloads (year, quarter, status, requested_at) VALUES (?1, ?2, 'pending', ?3)
         ON CONFLICT (year, quarter) DO NOTHING`,
        [q.year, q.quarter, now.toISOString()],
      );
      if (n > 0) added.push({ year: q.year, quarter: q.quarter });
    }
    return added;
  });
}

const toDownload = (r: Record<string, unknown>): QuarterDownload => ({
  year: Number(r.year),
  quarter: Number(r.quarter),
  status: String(r.status) as QuarterStatus,
  requested_at: String(r.requested_at),
  finished_at: r.finished_at === null ? null : String(r.finished_at),
  attempts: Number(r.attempts),
  files_stored: Number(r.files_stored),
  files_skipped: Number(r.files_skipped),
  files_failed: Number(r.files_failed),
  files_lost: Number(r.files_lost),
  error: r.error === null ? null : String(r.error),
});

/** Every chosen quarter, oldest first. */
export function quarterDownloads(store: Store): QuarterDownload[] {
  return store.query("SELECT * FROM quarter_downloads ORDER BY year, quarter").map(toDownload);
}

export interface RunOptions extends DownloadOptions {
  /** Where the zips are kept and extracted, as `bun run download` does. */
  rawDir?: string;
  onProgress?: (p: Progress) => void;
  /** Checked before each quarter: once aborted, the run stops after the quarter in progress. */
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * Download every chosen quarter that is not done, oldest first, one at a time. A quarter is `done` when its zip was
 * complete and every file was stored; `incomplete` when files were lost or failed; `failed` when nothing came back
 * or the folder could not be read. An error of the store itself is thrown and leaves the quarter `running`, which the
 * next run starts again.
 */
export async function runQuarterDownloads(store: Store, options: RunOptions = {}): Promise<QuarterDownload[]> {
  const rawDir = options.rawDir ?? join("data", "raw");
  const now = options.now ?? (() => new Date());
  const todo = quarterDownloads(store).filter((q) => q.status !== "done");
  let quartersDone = 0;
  let errors = 0;
  const report = (q: Quarter, phase: Progress["phase"], filesDone = 0, filesTotal = 0) =>
    options.onProgress?.({
      year: q.year,
      quarter: q.quarter,
      phase,
      quarters_done: quartersDone,
      quarters_total: todo.length,
      files_done: filesDone,
      files_total: filesTotal,
      errors,
    });

  for (const q of todo) {
    if (options.signal?.aborted) break;
    store.run(
      "UPDATE quarter_downloads SET status = 'running', attempts = attempts + 1 WHERE year = ?1 AND quarter = ?2",
      [q.year, q.quarter],
    );
    report(q, "downloading");
    const { download, stored } = await downloadToStore(store, q.year, q.quarter, rawDir, {
      ...options,
      now,
      onFile: (done, total) => report(q, "storing", done, total),
    });
    const lost = download.lost.length;
    const failed = stored.failed.length;
    let status: QuarterStatus;
    let error: string | null = null;
    if (download.recovered.length === 0) {
      status = "failed";
      error = download.errors.at(-1) ?? "no files in the download";
    } else if (stored.error !== null) {
      status = "failed";
      error = stored.error;
    } else if (!download.complete || lost > 0 || failed > 0) {
      status = "incomplete";
      error =
        [
          lost > 0 ? `${lost} files lost` : "",
          failed > 0 ? `${failed} files failed` : "",
          ...stored.failed.map((f) => `${f.file}: ${f.reason}`),
        ]
          .filter((x) => x !== "")
          .join("; ") || "the download was not complete";
    } else status = "done";
    errors += lost + failed + (status === "failed" ? 1 : 0);
    store.run(
      `UPDATE quarter_downloads SET status = ?3, finished_at = ?4, files_stored = files_stored + ?5,
         files_skipped = ?6, files_failed = ?7, files_lost = ?8, error = ?9
       WHERE year = ?1 AND quarter = ?2`,
      [q.year, q.quarter, status, now().toISOString(), stored.imported, stored.skipped, failed, lost, error],
    );
    quartersDone += 1;
    report(q, status, stored.imported + stored.skipped + failed, stored.imported + stored.skipped + failed);
  }
  return quarterDownloads(store);
}
