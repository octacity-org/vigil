/**
 * Download the financial reports the poller recorded (#203, collector step 2 in `docs/ARCHITECTURE.md`): each pending
 * disclosure in `seen_disclosures` is resolved (#202), its company's file is downloaded through the KAP client (#164,
 * #199) and stored in Zova with its metadata (#176) and one `report_stored` event (#179).
 *
 * A disclosure is done (`handled_at`) only when its own statement file is in Zova: newly stored, already stored
 * (`duplicate`, no second event), or `superseded` when KAP now offers only its correction. A failed download is
 * kept, with its error, and tried again later with a growing wait (`RETRY_BASE_MS` doubling up to `RETRY_MAX_MS`);
 * it is never dropped. A disclosure that cannot be resolved is closed as `unresolved` with the reason: asking again
 * would give the same answer.
 *
 * A company's zip can hold the files of other pending disclosures too (consolidated and solo statements, AVGYO); they
 * are closed with it, so each file is asked for once.
 */
import { type CompanyDownloadOptions, downloadCompanyReport } from "./company-download.ts";
import type { KapClient } from "./kap.ts";
import { pendingDisclosures } from "./poller.ts";
import { resolveDisclosure } from "./resolve.ts";
import type { Store } from "./zova.ts";

/** Wait after the first failure; it doubles with each further failure. */
export const RETRY_BASE_MS = 10 * 60_000;
/** The longest wait between two attempts. */
export const RETRY_MAX_MS = 24 * 60 * 60_000;

export type Outcome = "stored" | "duplicate" | "superseded" | "unresolved";

export interface PendingDownloads {
  /** Disclosures closed by this run, by outcome (other pending disclosures in the same zip included). */
  closed: { disclosure_id: number; outcome: Outcome; object_id: string | null }[];
  /** Disclosures that failed and wait for a retry. */
  failed: { disclosure_id: number; attempts: number; error: string; retry_after: string }[];
  /** Company zips asked for. */
  downloads: number;
}

export interface DownloadPendingOptions {
  kap?: KapClient;
  now?: () => Date;
  /** Most disclosures handled in one run. */
  limit?: number;
  /** Zip downloads per disclosure in one run (`downloadCompanyReport`). */
  retries?: number;
}

/** Wait before the next attempt after `attempts` failures. */
export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

function close(store: Store, id: number, outcome: Outcome, objectId: string | null, note: string | null, at: Date) {
  store.run(
    `UPDATE seen_disclosures SET handled_at = ?2, outcome = ?3, object_id = ?4, last_error = ?5, retry_after = NULL
     WHERE disclosure_id = ?1 AND handled_at IS NULL`,
    [id, at.toISOString(), outcome, objectId, note],
  );
}

/** Download every pending disclosure whose wait is over, oldest first. KAP and store errors are kept, not thrown. */
export async function downloadPending(store: Store, options: DownloadPendingOptions = {}): Promise<PendingDownloads> {
  const clock = options.now ?? (() => new Date());
  const out: PendingDownloads = { closed: [], failed: [], downloads: 0 };
  const isOpen = (id: number) =>
    store.query("SELECT 1 FROM seen_disclosures WHERE disclosure_id = ?1 AND handled_at IS NULL", [id]).length > 0;

  for (const d of pendingDisclosures(store, options.limit ?? 100, clock())) {
    if (!isOpen(d.disclosure_id)) continue; // closed above, with another disclosure's zip
    const r = resolveDisclosure(d);
    if (!r.ok) {
      close(store, d.disclosure_id, "unresolved", null, `${r.reason}: ${r.message}`, clock());
      out.closed.push({ disclosure_id: d.disclosure_id, outcome: "unresolved", object_id: null });
      continue;
    }
    const fail = (error: string) => {
      const at = clock();
      const row = store.query("SELECT attempts FROM seen_disclosures WHERE disclosure_id = ?1", [d.disclosure_id])[0];
      const attempts = Number(row?.attempts ?? 0) + 1;
      const retryAfter = new Date(at.getTime() + retryDelay(attempts)).toISOString();
      store.run(
        "UPDATE seen_disclosures SET attempts = ?2, last_error = ?3, retry_after = ?4 WHERE disclosure_id = ?1",
        [d.disclosure_id, attempts, error, retryAfter],
      );
      out.failed.push({ disclosure_id: d.disclosure_id, attempts, error, retry_after: retryAfter });
    };

    const period = { mkkMemberOid: r.report.mkk_member_oid, year: r.report.year, quarter: r.report.quarter };
    const downloadOptions: CompanyDownloadOptions = { kap: options.kap, now: clock };
    if (options.retries !== undefined) downloadOptions.retries = options.retries;
    let result: Awaited<ReturnType<typeof downloadCompanyReport>>;
    out.downloads += 1;
    try {
      result = await downloadCompanyReport(store, period, downloadOptions);
    } catch (e) {
      fail(`${(e as Error).name}: ${(e as Error).message}`);
      continue;
    }

    // Close every pending disclosure whose file came in this zip, this one included.
    for (const s of result.statements) {
      const id = s.file.disclosure_id;
      if (!isOpen(id)) continue;
      const outcome: Outcome = s.duplicate ? "duplicate" : "stored";
      close(store, id, outcome, s.file.object_id, null, clock());
      out.closed.push({ disclosure_id: id, outcome, object_id: s.file.object_id });
    }
    if (!isOpen(d.disclosure_id)) continue;

    if (!result.complete) {
      fail(`incomplete zip after ${result.attempts} attempts; lost: ${result.lost.join(", ") || "none named"}`);
      continue;
    }
    // KAP offers only the current files of a period: after a correction, only the correction.
    const correction = store.query(
      `SELECT c.disclosure_id FROM seen_disclosures d JOIN seen_disclosures c
         ON c.related_disclosure_oid = d.disclosure_oid
       WHERE d.disclosure_id = ?1 AND c.is_changed = 'DUZENLENEN'`,
      [d.disclosure_id],
    )[0];
    if (correction !== undefined) {
      const note = `KAP offers its correction ${correction.disclosure_id} instead`;
      close(store, d.disclosure_id, "superseded", null, note, clock());
      out.closed.push({ disclosure_id: d.disclosure_id, outcome: "superseded", object_id: null });
      continue;
    }
    const got = result.statements.map((s) => s.file.file_name);
    fail(`its file is not in the company's download (got: ${got.join(", ") || "no statement files"})`);
  }
  return out;
}
