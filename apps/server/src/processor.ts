/**
 * Processor (#207, #208, part of #166): parse and check a report stored in Zova, then load it into DuckDB.
 *
 * For each pending `report_stored` event (#179), a job on the write queue (#197) reads the stored bytes, parses them
 * with `packages/core`, runs the checks, calls `handle` and records the outcome with `finish`. `loadInto(db)` is the
 * `handle` that loads the report with its check results (#208), so the load and `finish` happen in the same job, in
 * that order: a load that throws leaves the event pending.
 *
 * Delivery is at least once. Parsing and checking have no side effects, `finish` refuses an event that is already
 * handled, and a job skips an event that was handled after it was queued, so a repeated run changes nothing.
 * A file that cannot be parsed gives `report_failed` with the reason; the same bytes would fail the same way, so it is
 * not retried. A job that throws (an error of the store or of the load, which may pass) leaves the event pending: the
 * next run tries it again, up to `MAX_ATTEMPTS` jobs in all; then it is closed as `report_failed` with the last error
 * and `gave_up`, for the user to see (#211). Either way the other events go on.
 */
import { blockingFailures, checkFiling, type FilingCheck, type ParsedFiling, parseKapXls } from "@vigil/core";
import { type Database, duplicateKeys, loadFiling, removeReport } from "./db.ts";
import { type AppEvent, EventStateError, finish, getEvent, pending, recordAttempt } from "./events.ts";
import { QueueClosedError, type WriteQueue } from "./queue.ts";
import { filesByDisclosure, type RawFile, readRawFile } from "./raw-files.ts";
import type { Store } from "./zova.ts";

/** A stored file after parsing and checking. */
export type CheckedReport =
  | {
      status: "checked";
      file: RawFile;
      filing: ParsedFiling;
      checks: FilingCheck[];
      /** Blocking failures, known filing errors included (decision 0006): the report produces no findings. */
      blocking: FilingCheck[];
    }
  | { status: "failed"; file: RawFile | null; reason: string };

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * Parse and check one stored file. A file that cannot be parsed or checked is `failed` with the reason; it never
 * throws for a bad file. Used for events and, later, to rebuild DuckDB from Zova (#162).
 */
export function checkStoredFile(store: Store, file: RawFile): CheckedReport {
  const bytes = readRawFile(store, file); // a store error is thrown
  let filing: ParsedFiling;
  try {
    filing = parseKapXls(bytes, file.file_name);
  } catch (e) {
    return { status: "failed", file, reason: describe(e) };
  }
  const dups = duplicateKeys(filing);
  if (dups.length > 0) {
    // Two values for one cell cannot both be right; loading either one would be a guess (as in `bun run load`).
    const [row, col] = dups[0] as [string, string];
    const reason = `${dups.length} duplicate (row_id, column_class) keys, first: ('${row}', '${col}')`;
    return { status: "failed", file, reason };
  }
  let checks: FilingCheck[];
  try {
    checks = checkFiling(filing);
  } catch (e) {
    return { status: "failed", file, reason: describe(e) };
  }
  return { status: "checked", file, filing, checks, blocking: blockingFailures(checks) };
}

/** The latest stored version of a disclosure (by download time, #178), or null. Shared with the rebuild (#162). */
export function latestFile(store: Store, disclosureId: number): RawFile | null {
  const files = filesByDisclosure(store, disclosureId);
  return files[files.length - 1] ?? null;
}

/**
 * The file a `report_stored` event refers to, and the one to process: the latest version of its disclosure (by
 * download time, #178). An older file whose event arrives last therefore gives the same result as the newer one.
 * Null when the event's file is not stored under its disclosure.
 */
export function resolveEvent(store: Store, event: AppEvent): { event: RawFile; latest: RawFile } | null {
  const disclosureId = event.payload.disclosure_id;
  if (typeof disclosureId !== "number" || !Number.isInteger(disclosureId)) return null;
  const files = filesByDisclosure(store, disclosureId);
  const named = files.find((f) => f.object_id === event.subject);
  if (named === undefined) return null;
  return { event: named, latest: files[files.length - 1] as RawFile };
}

/** What `handle` is told about the event besides the report. */
export interface EventContext {
  event: AppEvent;
  /** The event named an older version; the latest one was processed instead. */
  superseded: boolean;
}

export type ReportHandler = (report: CheckedReport, context: EventContext) => Promise<void> | void;

/**
 * The `handle` that loads a report into DuckDB (#208). A checked report replaces its disclosure's rows with its facts
 * and check results in one transaction; a report that fails a blocking check is loaded too, and its failing rows in
 * `check_results` mark it as blocked (`docs/SCHEMA.md`). When the latest version of a disclosure fails, the rows of an
 * older version are removed: they are no longer the disclosure's numbers, and `report_failed` says why. An event whose
 * file is not stored changes nothing.
 */
export function loadInto(db: Database): ReportHandler {
  return async (report) => {
    if (report.status === "checked") await loadFiling(db, report.filing, { checks: report.checks });
    else if (report.file !== null) await removeReport(db, report.file.disclosure_id);
  };
}

export type ProcessResult =
  | { event: number; outcome: "report_processed" | "report_failed"; report: CheckedReport; outcome_event: number }
  | { event: number; outcome: "already_handled" };

/** Counts of a checked report, as `bun run quality` gives them. */
function summary(checks: readonly FilingCheck[]) {
  const count = (f: (c: FilingCheck) => boolean) => checks.filter(f).length;
  return {
    passed: count((c) => c.severity === "blocking" && c.status === "pass"),
    failed: count((c) => c.severity === "blocking" && c.status === "fail" && c.known_error === null),
    not_checked: count((c) => c.status === "not_checked"),
    informational_differences: count((c) => c.severity === "informational" && c.status === "fail"),
    known_errors: count((c) => c.known_error !== null),
  };
}

/**
 * Process one `report_stored` event: parse and check the latest version of its disclosure, run `handle` (the load,
 * #208), then record `report_processed` or `report_failed` with `finish`. If `handle` throws, nothing is recorded and
 * the event stays pending.
 */
export async function processEvent(store: Store, event: AppEvent, handle?: ReportHandler): Promise<ProcessResult> {
  const current = getEvent(store, event.id);
  if (current === null || current.handled_at !== null) return { event: event.id, outcome: "already_handled" };

  const disclosureId = current.payload.disclosure_id;
  const validId = typeof disclosureId === "number" && Number.isInteger(disclosureId);
  const files = resolveEvent(store, current);
  let report: CheckedReport;
  if (files === null) {
    const reason = validId
      ? `stored file ${current.subject} not found for disclosure ${disclosureId}`
      : `event ${current.id} has no valid disclosure_id`;
    report = { status: "failed", file: null, reason };
  } else {
    report = checkStoredFile(store, files.latest);
    if (report.status === "failed" && files.latest.object_id !== current.subject) {
      // Every version has the same file name: say which bytes failed. The older version is not used instead, and
      // `loadInto` removes it from DuckDB.
      report = {
        ...report,
        reason: `latest version ${files.latest.object_id} of disclosure ${files.latest.disclosure_id}: ${report.reason}`,
      };
    }
  }
  const superseded = files !== null && files.latest.object_id !== current.subject;
  await handle?.(report, { event: current, superseded });

  const file = report.file;
  const where = {
    disclosure_id: file?.disclosure_id ?? (validId ? disclosureId : null),
    object_id: file?.object_id ?? current.subject,
    file_name: file?.file_name ?? (typeof current.payload.file_name === "string" ? current.payload.file_name : null),
    superseded,
  };
  try {
    if (report.status === "checked") {
      const payload = {
        ...where,
        facts: report.filing.facts.length,
        ...summary(report.checks),
        blocked: report.blocking.length > 0,
      };
      const id = finish(store, current, { type: "report_processed", payload });
      return { event: event.id, outcome: "report_processed", report, outcome_event: id };
    }
    const id = finish(store, current, { type: "report_failed", reason: report.reason, payload: where });
    return { event: event.id, outcome: "report_failed", report, outcome_event: id };
  } catch (e) {
    if (e instanceof EventStateError) return { event: event.id, outcome: "already_handled" };
    throw e;
  }
}

/** Jobs that may throw for one event, over all runs, before it is closed as failed (#211). */
export const MAX_ATTEMPTS = 3;

export interface ProcessSummary {
  processed: number;
  /** Events closed as `report_failed`, those given up on included. */
  failed: number;
  already_handled: number;
  /** Jobs that threw (a store error, or `handle`), with the event's attempts so far. */
  errors: { event: number; error: string; attempts: number }[];
  /** Events closed as `report_failed` after `MAX_ATTEMPTS` jobs threw. */
  gave_up: number[];
}

/** Close an event whose jobs kept throwing, as `report_failed` with the last error. */
function giveUp(store: Store, event: AppEvent, attempts: number, error: string): boolean {
  const current = getEvent(store, event.id);
  if (current === null || current.handled_at !== null) return false;
  const payload = {
    disclosure_id: typeof current.payload.disclosure_id === "number" ? current.payload.disclosure_id : null,
    object_id: current.subject,
    file_name: typeof current.payload.file_name === "string" ? current.payload.file_name : null,
    attempts,
    gave_up: true,
  };
  try {
    finish(store, current, { type: "report_failed", reason: `gave up after ${attempts} attempts: ${error}`, payload });
    return true;
  } catch (e) {
    if (e instanceof EventStateError) return false;
    throw e;
  }
}

/**
 * Queue a job for every pending `report_stored` event, `batch` at a time, and wait for each batch before reading the
 * next. An event whose job threw is not queued again in the same run. Returns what happened.
 */
export async function processPending(
  store: Store,
  queue: WriteQueue,
  options: { batch?: number; handle?: ReportHandler } = {},
): Promise<ProcessSummary> {
  const batch = options.batch ?? 100;
  if (!Number.isInteger(batch) || batch < 1) throw new RangeError(`batch must be a whole number above 0, got ${batch}`);
  const done: ProcessSummary = { processed: 0, failed: 0, already_handled: 0, errors: [], gave_up: [] };
  const attempted = new Set<number>();
  for (;;) {
    const events = pending(store, "report_stored", batch + attempted.size)
      .filter((e) => !attempted.has(e.id))
      .slice(0, batch);
    if (events.length === 0) return done;
    const jobs = events.map((e) => {
      attempted.add(e.id);
      return queue.add(`process report_stored ${e.id}`, () => processEvent(store, e, options.handle));
    });
    const settled = await Promise.allSettled(jobs);
    // The queue was closed (shutdown, #198): stop instead of failing every remaining event.
    const closed = settled.some((s) => s.status === "rejected" && s.reason instanceof QueueClosedError);
    settled.forEach((s, i) => {
      const event = events[i] as AppEvent;
      if (s.status === "rejected") {
        if (s.reason instanceof QueueClosedError) {
          done.errors.push({ event: event.id, error: describe(s.reason), attempts: 0 });
          return;
        }
        const error = describe(s.reason);
        // Counting may fail too if the store is down; the event then stays pending without a count.
        let attempts = 0;
        try {
          attempts = recordAttempt(store, event.id, error);
          if (attempts >= MAX_ATTEMPTS && giveUp(store, event, attempts, error)) {
            done.gave_up.push(event.id);
            done.failed += 1;
          }
        } catch {
          // reported below with attempts 0
        }
        done.errors.push({ event: event.id, error, attempts });
      } else if (s.value.outcome === "report_processed") done.processed += 1;
      else if (s.value.outcome === "report_failed") done.failed += 1;
      else done.already_handled += 1;
    });
    if (closed) return done;
  }
}

/** A report that could not be processed, for the quality page (#225). */
export interface FailedReport {
  /** The `report_failed` event. */
  event: number;
  disclosure_id: number | null;
  object_id: string;
  file_name: string | null;
  reason: string;
  /** True when it was closed after `MAX_ATTEMPTS` jobs threw; false for a file that cannot be parsed or checked. */
  gave_up: boolean;
  failed_at: string;
}

/**
 * Reports whose latest outcome is `report_failed`, newest first. A file processed successfully after a failure (a new
 * version, or a rebuild after a parser fix, #162) is no longer listed.
 */
export function failedReports(store: Store, limit = 100): FailedReport[] {
  return store
    .query(
      `SELECT * FROM events e
       WHERE e.type = 'report_failed'
         AND e.id = (SELECT max(o.id) FROM events o
                     WHERE o.subject = e.subject AND o.type IN ('report_processed', 'report_failed'))
       ORDER BY e.id DESC LIMIT ?1`,
      [limit],
    )
    .map((r) => {
      const p = JSON.parse(String(r.payload)) as Record<string, unknown>;
      return {
        event: Number(r.id),
        disclosure_id: typeof p.disclosure_id === "number" ? p.disclosure_id : null,
        object_id: String(r.subject),
        file_name: typeof p.file_name === "string" ? p.file_name : null,
        reason: String(p.reason),
        gave_up: p.gave_up === true,
        failed_at: String(r.created_at),
      };
    });
}
