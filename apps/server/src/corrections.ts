/**
 * Corrected reports (#204). KAP publishes a correction as a new disclosure with its own id and file name, marked
 * `isChanged: "DUZENLENEN"` and pointing to the disclosure it corrects with `relatedDisclosureOid`; the original is then
 * marked `DUZELTILEN` (`docs/kap.md`, "Corrections"). Both files are kept in Zova: the original under its own
 * disclosure id when it was seen first, the correction as a new one. This module links the two, so the correction is
 * the second version of the same report.
 *
 * A correction the collector recorded (`seen_disclosures`) is linked to its original by the original's oid:
 * - when the original was recorded too, without asking KAP;
 * - otherwise (it was published before the collector started), with one request for the company's financial
 *   disclosures from the day after the period ended to the day of the correction (two if that is over 90 days).
 *
 * Each correction is linked once (`corrections`). An original KAP's list does not have is recorded as not found, with
 * the range asked for, and not asked for again. A KAP error leaves the correction for the next run.
 */
import { type IsoDate, isoDate, nextDay, previousDay } from "@vigil/core";
import { type DisclosureCache, listDisclosures } from "./disclosures.ts";
import type { KapClient } from "./kap.ts";
import { filesByDisclosure, type RawFile } from "./raw-files.ts";
import type { Store } from "./zova.ts";

export interface CorrectionLink {
  /** The correction. */
  disclosure_id: number;
  /** The disclosure it corrects; null when KAP's list did not have it. */
  original_disclosure_id: number | null;
  original_oid: string;
  linked_at: string;
  note: string | null;
}

export interface LinkResult {
  linked: CorrectionLink[];
  /** Corrections left for the next run because KAP could not be read. */
  errors: { disclosure_id: number; error: string }[];
}

export interface LinkOptions {
  kap?: KapClient;
  cache?: DisclosureCache;
  now?: () => Date;
}

const toLink = (r: Record<string, unknown>): CorrectionLink => ({
  disclosure_id: Number(r.disclosure_id),
  original_disclosure_id: r.original_disclosure_id === null ? null : Number(r.original_disclosure_id),
  original_oid: String(r.original_oid),
  linked_at: String(r.linked_at),
  note: r.note === null ? null : String(r.note),
});

/** The last day of a quarter. */
function quarterEnd(year: number, quarter: number): IsoDate {
  return isoDate(year, quarter * 3, [31, 30, 30, 31][quarter - 1] as number) as IsoDate;
}

/**
 * Where to look for the original: from the day after the correction's period ended (an original is filed after it)
 * to the day of the correction. Without a period, the 90 days up to the correction.
 */
export function searchRange(c: { year: number | null; quarter: number | null; published_at: string }): {
  from: IsoDate;
  to: IsoDate;
} {
  const to = c.published_at.slice(0, 10) as IsoDate;
  let from: IsoDate;
  if (c.year !== null && c.quarter !== null) {
    from = nextDay(quarterEnd(c.year, c.quarter));
  } else {
    from = to;
    for (let i = 1; i < 90; i++) from = previousDay(from);
  }
  return { from: from > to ? to : from, to };
}

/** Link every recorded correction not linked yet to the disclosure it corrects. */
export async function linkCorrections(store: Store, options: LinkOptions = {}): Promise<LinkResult> {
  const clock = options.now ?? (() => new Date());
  const out: LinkResult = { linked: [], errors: [] };
  const todo = store.query(
    `SELECT disclosure_id, mkk_member_oid, year, quarter, published_at, related_disclosure_oid FROM seen_disclosures
     WHERE is_changed = 'DUZENLENEN' AND related_disclosure_oid IS NOT NULL
       AND disclosure_id NOT IN (SELECT disclosure_id FROM corrections)
     ORDER BY published_at, disclosure_id`,
  );
  for (const c of todo) {
    const id = Number(c.disclosure_id);
    const oid = String(c.related_disclosure_oid);
    let original: number | null = null;
    let note: string;
    const seen = store.query("SELECT disclosure_id FROM seen_disclosures WHERE disclosure_oid = ?1", [oid])[0];
    if (seen !== undefined) {
      original = Number(seen.disclosure_id);
      note = "recorded by the collector";
    } else {
      const range = searchRange({
        year: c.year === null ? null : Number(c.year),
        quarter: c.quarter === null ? null : Number(c.quarter),
        published_at: String(c.published_at),
      });
      const company = String(c.mkk_member_oid);
      try {
        const list = await listDisclosures(
          { from: range.from, to: range.to, classes: ["FR"], mkkMemberOid: company },
          { kap: options.kap, cache: options.cache, now: clock },
        );
        const found = list.find((d) => d.disclosure_oid === oid);
        original = found === undefined ? null : found.disclosure_id;
      } catch (e) {
        out.errors.push({ disclosure_id: id, error: `${(e as Error).name}: ${(e as Error).message}` });
        continue;
      }
      note =
        original === null
          ? `not in KAP's financial disclosures of ${company} from ${range.from} to ${range.to}`
          : `found in KAP's financial disclosures of ${company} from ${range.from} to ${range.to}`;
    }
    store.run(
      `INSERT INTO corrections (disclosure_id, original_disclosure_id, original_oid, linked_at, note)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      [id, original, oid, clock().toISOString(), note],
    );
    out.linked.push(correctionOf(store, id) as CorrectionLink);
  }
  return out;
}

/** The link of a correction, or null when the disclosure is not a linked correction. */
export function correctionOf(store: Store, disclosureId: number): CorrectionLink | null {
  const r = store.query("SELECT * FROM corrections WHERE disclosure_id = ?1", [disclosureId])[0];
  return r === undefined ? null : toLink(r);
}

export interface ReportVersion {
  disclosure_id: number;
  /** The correction this disclosure is (null for the first one). */
  corrects: number | null;
  /** Its stored files, oldest download first; empty when it was never downloaded. */
  files: RawFile[];
}

/**
 * Every version of the report a disclosure belongs to, oldest first: the first disclosure, then each correction of
 * the one before. A disclosure without corrections gives one version.
 */
export function reportVersions(store: Store, disclosureId: number): ReportVersion[] {
  const visited = new Set<number>([disclosureId]);
  let first = disclosureId;
  for (;;) {
    const back = correctionOf(store, first)?.original_disclosure_id ?? null;
    if (back === null || visited.has(back)) break;
    visited.add(back);
    first = back;
  }
  const out: ReportVersion[] = [];
  const done = new Set<number>();
  let id: number | null = first;
  let corrects: number | null = null;
  while (id !== null && !done.has(id)) {
    done.add(id);
    out.push({ disclosure_id: id, corrects, files: filesByDisclosure(store, id) });
    const next: Record<string, unknown> | undefined = store.query(
      "SELECT disclosure_id FROM corrections WHERE original_disclosure_id = ?1 ORDER BY disclosure_id",
      [id],
    )[0];
    corrects = id;
    id = next === undefined ? null : Number(next.disclosure_id);
  }
  return out;
}
