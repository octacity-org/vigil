/**
 * Poll KAP's disclosure list for new financial reports (#201, part of the collector #50, decision 0010).
 *
 * Every `POLL_INTERVAL_MS` while the app runs, `pollOnce` asks the disclosure list (#163) for financial-report
 * disclosures (class `FR`) from the last day already covered to today (Istanbul), and records each new
 * `Finansal Rapor` in Zova's `seen_disclosures`, where the next steps (#202, #164, #203) pick it up. A disclosure is
 * recorded once, however often it is listed, so a restart or an overlapping range never yields it twice.
 *
 * The day covered so far is kept in Zova (`collector_state`), so a restart continues where it stopped, also after
 * days offline; ranges longer than 90 days are split by the disclosure-list client. Each poll asks again from the day
 * before the last one covered: a disclosure published just after a poll on the same day is still found.
 *
 * The interval and the request rules are constants, not settings (decision 0008).
 */
import { type IsoDate, previousDay } from "@vigil/core";
import { type Disclosure, type DisclosureCache, istanbulToday, listDisclosures } from "./disclosures.ts";
import type { KapClient } from "./kap.ts";
import { downloadPending, type PendingDownloads } from "./report-downloads.ts";
import type { Store } from "./zova.ts";

/** Time between the end of one poll and the start of the next. */
export const POLL_INTERVAL_MS = 5 * 60_000;
/** `collector_state` row with the last day (Istanbul) a poll covered completely. */
export const COVERED_THROUGH = "disclosures_covered_through";

/** The disclosures the collector downloads: the statements themselves, with their period. */
export const isFinancialReport = (d: Disclosure) =>
  d.title === "Finansal Rapor" && d.year !== null && d.quarter !== null;

export interface PollOptions {
  kap?: KapClient;
  cache?: DisclosureCache;
  now?: () => Date;
  /** First day to ask for when nothing has been covered yet; defaults to today. */
  since?: IsoDate;
}

export interface PollResult {
  from: IsoDate;
  to: IsoDate;
  /** Financial reports recorded by this poll, oldest first. */
  new: Disclosure[];
  /** Financial reports in the answer that were already recorded. */
  known: number;
}

export function coveredThrough(store: Store): IsoDate | null {
  const row = store.query("SELECT value FROM collector_state WHERE name = ?1", [COVERED_THROUGH])[0];
  return row === undefined ? null : String(row.value);
}

/**
 * Recorded disclosures whose file has not been downloaded yet, oldest first; with `now`, only those whose wait after
 * a failed download (#203) is over.
 */
export function pendingDisclosures(store: Store, limit = 100, now: Date | null = null): Disclosure[] {
  return store
    .query(
      `SELECT * FROM seen_disclosures
       WHERE handled_at IS NULL AND (?2 IS NULL OR retry_after IS NULL OR retry_after <= ?2)
       ORDER BY published_at, disclosure_id LIMIT ?1`,
      [limit, now === null ? null : now.toISOString()],
    )
    .map((r) => ({
      disclosure_id: Number(r.disclosure_id),
      disclosure_oid: String(r.disclosure_oid),
      published_at: String(r.published_at),
      stock_codes: JSON.parse(String(r.stock_codes)) as string[],
      mkk_member_oid: String(r.mkk_member_oid),
      company_title: "",
      title: "Finansal Rapor",
      disclosure_class: "FR",
      year: r.year === null ? null : Number(r.year),
      quarter: r.quarter === null ? null : Number(r.quarter),
      is_changed: r.is_changed === null ? null : (String(r.is_changed) as Disclosure["is_changed"]),
      related_disclosure_oid: r.related_disclosure_oid === null ? null : String(r.related_disclosure_oid),
      is_late: false,
    }));
}

/**
 * Ask KAP once and record the new financial reports. The covered day moves forward only after the answer is stored,
 * in the same transaction, so a failed request or store error leaves the next poll to ask for the same days.
 */
export async function pollOnce(store: Store, options: PollOptions = {}): Promise<PollResult> {
  const now = (options.now ?? (() => new Date()))();
  const today = istanbulToday(now);
  const covered = coveredThrough(store);
  let from = covered === null ? (options.since ?? today) : previousDay(covered);
  if (from > today) from = today;
  const list = await listDisclosures(
    { from, to: today, classes: ["FR"] },
    { kap: options.kap, cache: options.cache, now: () => now },
  );
  const reports = list.filter(isFinancialReport).reverse(); // KAP answers newest first
  const seenAt = now.toISOString();
  return store.transaction((s) => {
    const fresh: Disclosure[] = [];
    for (const d of reports) {
      const added = s.run(
        `INSERT INTO seen_disclosures (disclosure_id, disclosure_oid, mkk_member_oid, stock_codes, year, quarter,
           published_at, is_changed, related_disclosure_oid, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (disclosure_id) DO NOTHING`,
        [
          d.disclosure_id,
          d.disclosure_oid,
          d.mkk_member_oid,
          JSON.stringify(d.stock_codes),
          d.year,
          d.quarter,
          d.published_at,
          d.is_changed,
          d.related_disclosure_oid,
          seenAt,
        ],
      );
      if (added > 0) fresh.push(d);
    }
    s.run(
      `INSERT INTO collector_state VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [COVERED_THROUGH, today, seenAt],
    );
    return { from, to: today, new: fresh, known: reports.length - fresh.length };
  });
}

export interface PollerOptions extends PollOptions {
  /** After each poll, download the pending reports (#203); the server process turns this on (#168). */
  download?: boolean;
  /** Hears every poll's result, and every error (the poller keeps running after one). */
  onPoll?: (result: PollResult) => void;
  onDownload?: (result: PendingDownloads) => void;
  onError?: (error: unknown) => void;
  /** Replaceable in tests: schedules `fn` after `ms`, returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Poll now and then every `POLL_INTERVAL_MS` after the previous poll ended, until `stop`. Polls never overlap. An
 * error is reported and the next poll runs as usual (KAP may be down for a while). `stop` waits for a poll in progress.
 */
export function startPolling(store: Store, options: PollerOptions = {}): { stop: () => Promise<void> } {
  const schedule = options.schedule ?? realSchedule;
  let stopped = false;
  let cancel: () => void = () => {};
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = pollOnce(store, options)
      .then((r) => options.onPoll?.(r), options.onError ?? (() => {}))
      // A failed poll still leaves earlier disclosures to download.
      .then(async () => {
        if (options.download && !stopped) options.onDownload?.(await downloadPending(store, options));
      })
      .catch(options.onError ?? (() => {}))
      .finally(() => {
        if (!stopped) cancel = schedule(tick, POLL_INTERVAL_MS);
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
