/**
 * Processor, first step (#207, part of #166): parse and check a report stored in Zova.
 *
 * For each pending `report_stored` event (#179), a job on the write queue (#197) reads the stored bytes, parses them
 * with `packages/core`, runs the checks and records the outcome with `finish`. Nothing is written to DuckDB here:
 * loading the report and its check results is #208, which plugs in through the `handle` callback so that the load
 * and `finish` happen in the same job, in that order.
 *
 * Until #208 provides `handle`, nothing in the app calls `processPending`: an event finished without a load would
 * never be offered again, and its report would be missing from DuckDB until a rebuild (#162).
 *
 * Delivery is at least once. Parsing and checking have no side effects, `finish` refuses an event that is already
 * handled, and a job skips an event that was handled after it was queued, so a repeated run changes nothing.
 * A file that cannot be parsed gives `report_failed` with the reason; the same bytes would fail the same way, so it is
 * not retried here (retries are #211). An error of the store itself is thrown: the job fails and the event stays
 * pending.
 */
import { blockingFailures, checkFiling, type FilingCheck, type ParsedFiling, parseKapXls } from "@vigil/core";
import { duplicateKeys } from "./db.ts";
import { type AppEvent, EventStateError, finish, getEvent, pending } from "./events.ts";
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
export async function processEvent(
  store: Store,
  event: AppEvent,
  handle?: (report: CheckedReport, context: EventContext) => Promise<void> | void,
): Promise<ProcessResult> {
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
      // Every version has the same file name: say which bytes failed. The older version is not used instead;
      // what to do with a version already loaded is #208's to decide.
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

export interface ProcessSummary {
  processed: number;
  failed: number;
  already_handled: number;
  /** Jobs that threw (a store error, or `handle`); their events stay pending. */
  errors: { event: number; error: string }[];
}

/**
 * Queue a job for every pending `report_stored` event, `batch` at a time, and wait for each batch before reading the
 * next. An event whose job threw is not queued again in the same run. Returns what happened.
 */
export async function processPending(
  store: Store,
  queue: WriteQueue,
  options: { batch?: number; handle?: (report: CheckedReport, context: EventContext) => Promise<void> | void } = {},
): Promise<ProcessSummary> {
  const batch = options.batch ?? 100;
  if (!Number.isInteger(batch) || batch < 1) throw new RangeError(`batch must be a whole number above 0, got ${batch}`);
  const done: ProcessSummary = { processed: 0, failed: 0, already_handled: 0, errors: [] };
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
      if (s.status === "rejected") done.errors.push({ event: (events[i] as AppEvent).id, error: describe(s.reason) });
      else if (s.value.outcome === "report_processed") done.processed += 1;
      else if (s.value.outcome === "report_failed") done.failed += 1;
      else done.already_handled += 1;
    });
    if (closed) return done;
  }
}
