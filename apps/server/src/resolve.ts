/**
 * Resolve a disclosure to the company, year and period a single-company download needs (#202, `docs/kap.md`):
 * `home-financial/download-file/{mkkMemberOid}/{year}/{quarter}`. Everything comes from the disclosure list entry
 * itself; nothing is guessed. A disclosure that cannot be resolved says why.
 *
 * A company with several codes (`ATA, ATAYM`, `KRDMA, KRDMB, KRDMD`) is one company: KAP names its files with the
 * codes joined by `-` in the order of the list (`ATA-ATAYM_1651692_2026_2.xls`), and the company code is the first,
 * as the parser takes it from the file name.
 */
import { isoDate } from "@vigil/core";
import type { Disclosure } from "./disclosures.ts";

export interface ResolvedReport {
  disclosure_id: number;
  mkk_member_oid: string;
  year: number;
  quarter: number;
  /** The first stock code: the company code of the file and of the database. */
  company_code: string;
  /** The codes joined by `-`, as in KAP's file names, e.g. `KRDMA-KRDMB-KRDMD`. */
  ticker_group: string;
  stock_codes: string[];
  /** A correction of an earlier disclosure (`DUZENLENEN`); #204 links the two. */
  is_correction: boolean;
}

export type UnresolvedReason =
  | "not_a_financial_report"
  | "no_period"
  | "bad_member_id"
  | "no_stock_code"
  | "period_after_publication";

export type Resolution =
  | { ok: true; report: ResolvedReport }
  | { ok: false; disclosure_id: number; reason: UnresolvedReason; message: string };

const QUARTER_END: Record<number, [number, number]> = { 1: [3, 31], 2: [6, 30], 3: [9, 30], 4: [12, 31] };

/** Company, year and period of a disclosure, or why it has none. */
export function resolveDisclosure(d: Disclosure): Resolution {
  const fail = (reason: UnresolvedReason, message: string): Resolution => ({
    ok: false,
    disclosure_id: d.disclosure_id,
    reason,
    message: `disclosure ${d.disclosure_id}: ${message}`,
  });
  if (d.title !== "Finansal Rapor") {
    return fail("not_a_financial_report", `"${d.title}" is not a financial report`);
  }
  if (d.year === null || d.quarter === null) return fail("no_period", "KAP gives no year or period");
  if (!/^[0-9a-f]{32}$/i.test(d.mkk_member_oid)) {
    return fail("bad_member_id", `member id ${JSON.stringify(d.mkk_member_oid)} is not a KAP member id`);
  }
  const codes = d.stock_codes.map((c) => c.toUpperCase());
  if (codes.length === 0) return fail("no_stock_code", "KAP gives no stock code");
  const [month, day] = QUARTER_END[d.quarter] as [number, number];
  const end = isoDate(d.year, month, day);
  if (end === null || end >= d.published_at.slice(0, 10)) {
    return fail("period_after_publication", `period ${d.year}/${d.quarter} does not end before ${d.published_at}`);
  }
  return {
    ok: true,
    report: {
      disclosure_id: d.disclosure_id,
      mkk_member_oid: d.mkk_member_oid,
      year: d.year,
      quarter: d.quarter,
      company_code: codes[0] as string,
      ticker_group: codes.join("-"),
      stock_codes: codes,
      is_correction: d.is_changed === "DUZENLENEN",
    },
  };
}

/** Resolve a list: the resolved reports, and the others with their reasons. */
export function resolveDisclosures(list: readonly Disclosure[]): {
  resolved: ResolvedReport[];
  unresolved: Extract<Resolution, { ok: false }>[];
} {
  const resolved: ResolvedReport[] = [];
  const unresolved: Extract<Resolution, { ok: false }>[] = [];
  for (const d of list) {
    const r = resolveDisclosure(d);
    if (r.ok) resolved.push(r.report);
    else unresolved.push(r);
  }
  return { resolved, unresolved };
}
