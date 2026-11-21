/**
 * Check a downloaded quarter against KAP's disclosure list (#43): every financial report KAP lists for the period
 * should have its statement file in the quarter's bulk archive, and every file in the archive should be a listed
 * report. What does not match is listed with the reason, so the archive is either complete or every gap is explained.
 *
 * Reasons for a listed report without a file:
 * - `corrected`: the report was corrected later (`DUZELTILEN`); the archive has the correction instead (#204).
 * - `not_in_archive`: KAP's bulk zip does not have it. Banks and brokers report in templates the zip leaves out, and
 *   some companies are missing for reasons KAP does not give (`docs/kap.md`).
 *
 * A file the list does not have is `not_listed`: usually a report published after the window the list was asked
 * for (270 days after the period), or a report filed for another period.
 */
import { basename } from "node:path";
import { parseFilename } from "@vigil/core";
import type { FileReport } from "./db.ts";
import type { Disclosure } from "./disclosures.ts";

export type GapReason = "corrected" | "not_in_archive";

/**
 * What kind of filer a listed report is from, by its title: KAP's financial-report list also has investment funds,
 * portfolio managers, brokers, banks and finance companies (factoring, leasing, consumer finance), whose statements the
 * bulk zip mostly does not carry. `company` is everything else.
 */
export type FilerKind = "fund" | "portfolio_manager" | "broker" | "bank" | "finance" | "company";

export function filerKind(title: string): FilerKind {
  const t = title.toLocaleUpperCase("tr-TR");
  const words = new Set(t.split(/[\s,.()]+/));
  if (words.has("FON") || words.has("FONU") || words.has("FONLARI")) return "fund";
  if (t.includes("PORTFÖY YÖNETİM")) return "portfolio_manager";
  if (t.includes("MENKUL DEĞERLER") || t.includes("MENKUL KIYMETLER")) return "broker";
  if ([...words].some((w) => w.endsWith("BANK") || w.endsWith("BANKASI") || w === "BANKA")) return "bank";
  if (t.includes("FAKTORİNG") || t.includes("FİNANSAL KİRALAMA") || words.has("FİNANSMAN")) return "finance";
  return "company";
}

export interface ListedGap {
  disclosure_id: number;
  stock_codes: string[];
  company_title: string;
  published_at: string;
  kind: FilerKind;
  reason: GapReason;
}

export interface ArchiveCheck {
  year: number;
  quarter: number;
  /** Financial reports KAP lists for the period. */
  listed: number;
  /** Statement files in the archive. */
  files: number;
  /** Listed and in the archive. */
  matched: number;
  /** Listed, no file. */
  missing: ListedGap[];
  /** In the archive, not listed. */
  not_listed: { disclosure_id: number; file_name: string }[];
  /** Files that cannot be read (parse errors, duplicate cells), from `parseDirectory`. */
  broken: { file_name: string; status: string; error: string | null }[];
}

/** Compare the period's listed financial reports with the archive's file names and parse report. */
export function checkArchive(
  year: number,
  quarter: number,
  listed: readonly Disclosure[],
  fileNames: readonly string[],
  parsed: readonly FileReport[] = [],
): ArchiveCheck {
  const files = new Map<number, string>();
  for (const name of fileNames) {
    try {
      files.set(parseFilename(name).disclosure_id, name);
    } catch {
      // Not a statement file name; `parsed` reports it if it is broken.
    }
  }
  const listedIds = new Set(listed.map((d) => d.disclosure_id));
  const missing: ListedGap[] = listed
    .filter((d) => !files.has(d.disclosure_id))
    .map((d) => ({
      disclosure_id: d.disclosure_id,
      stock_codes: d.stock_codes,
      company_title: d.company_title,
      published_at: d.published_at,
      kind: filerKind(d.company_title),
      reason: d.is_changed === "DUZELTILEN" ? "corrected" : "not_in_archive",
    }));
  missing.sort((a, b) => a.reason.localeCompare(b.reason) || a.disclosure_id - b.disclosure_id);
  const notListed = [...files.entries()]
    .filter(([id]) => !listedIds.has(id))
    .map(([disclosure_id, file_name]) => ({ disclosure_id, file_name }))
    .sort((a, b) => a.disclosure_id - b.disclosure_id);
  return {
    year,
    quarter,
    listed: listed.length,
    files: files.size,
    matched: listed.length - missing.length,
    missing,
    not_listed: notListed,
    broken: parsed
      .filter((f) => f.status !== "ok")
      .map((f) => ({ file_name: basename(f.filepath), status: f.status, error: f.error })),
  };
}
