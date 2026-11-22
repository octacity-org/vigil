/**
 * Company types for companies without a KAP sector (#296, decision 0017). Companies that file statements only because
 * they issue debt are not on KAP's Sektörler page; `data/company-types.json` gives each of them a type, with the
 * reason and the source someone read. A company with no KAP sector and no entry gets no findings.
 *
 * The file is kept like the known filing errors (`known-errors.ts`, decision 0006): an entry is added only after the
 * source has been read, and every addition is reviewed like code (`CONTRIBUTING.md`, "Company types"). The loader
 * refuses an entry without a reason or a source, a member id that appears twice, and an entry for a company that has a
 * KAP sector: KAP wins, and the entry must be removed.
 */
import { readFileSync } from "node:fs";

export type CompanyType = "real_sector" | "financial";

export interface CompanyTypeEntry {
  /** KAP's stable company id; entries are matched by it, never by ticker. */
  mkkMemberOid: string;
  ticker: string;
  title: string;
  type: CompanyType;
  /** Why the company has this type. */
  reason: string;
  /** The company's activity as the source gives it, for the reviewer; null when the type follows from the title. */
  activity: string | null;
  /** What was read and when, with its address. */
  source: string;
}

export class CompanyTypesError extends Error {
  override name = "CompanyTypesError";
}

export const COMPANY_TYPES_FILE = new URL("../data/company-types.json", import.meta.url);

const TYPES: readonly CompanyType[] = ["real_sector", "financial"];
const OID = /^[0-9a-fA-F]{32}$/;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Validate the entries. With `sectorOids` (the companies of the latest KAP sector reading), an entry for a company
 * that has a sector is an error too. Errors are collected, so one run lists every bad entry.
 */
export function parseCompanyTypes(data: unknown, sectorOids?: ReadonlySet<string>): CompanyTypeEntry[] {
  if (!Array.isArray(data)) throw new CompanyTypesError("company types: the file must hold a JSON array");
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const out: CompanyTypeEntry[] = [];
  data.forEach((raw, i) => {
    const at = `entry ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${at}: not an object`);
      return;
    }
    const e = raw as Record<string, unknown>;
    const name = nonEmpty(e.ticker) ? `${at} (${e.ticker})` : at;
    const before = errors.length;
    if (!nonEmpty(e.mkkMemberOid) || !OID.test(e.mkkMemberOid))
      errors.push(`${name}: mkkMemberOid must be KAP's 32-character id`);
    if (!nonEmpty(e.ticker)) errors.push(`${name}: ticker is missing`);
    if (!nonEmpty(e.title)) errors.push(`${name}: title is missing`);
    if (!TYPES.includes(e.type as CompanyType)) errors.push(`${name}: type must be ${TYPES.join(" or ")}`);
    if (!nonEmpty(e.reason)) errors.push(`${name}: reason is missing`);
    if (!nonEmpty(e.source)) errors.push(`${name}: source is missing`);
    if (e.activity !== null && e.activity !== undefined && typeof e.activity !== "string") {
      errors.push(`${name}: activity must be text or null`);
    }
    if (nonEmpty(e.mkkMemberOid)) {
      const first = seen.get(e.mkkMemberOid);
      if (first !== undefined) errors.push(`${name}: mkkMemberOid ${e.mkkMemberOid} is also entry ${first}`);
      else seen.set(e.mkkMemberOid, i + 1);
      if (sectorOids?.has(e.mkkMemberOid)) {
        errors.push(`${name}: the company has a KAP sector now; KAP wins, remove the entry`);
      }
    }
    if (errors.length === before) {
      out.push({
        mkkMemberOid: e.mkkMemberOid as string,
        ticker: e.ticker as string,
        title: e.title as string,
        type: e.type as CompanyType,
        reason: e.reason as string,
        activity: (e.activity as string | null | undefined) ?? null,
        source: e.source as string,
      });
    }
  });
  if (errors.length > 0) throw new CompanyTypesError(`company types:\n- ${errors.join("\n- ")}`);
  return out;
}

/** Read and validate `data/company-types.json`, keyed by member id. */
export function loadCompanyTypes(
  options: { path?: string | URL; sectorOids?: ReadonlySet<string> } = {},
): ReadonlyMap<string, CompanyTypeEntry> {
  const path = options.path ?? COMPANY_TYPES_FILE;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CompanyTypesError(`company types: cannot read ${String(path)}: ${(e as Error).message}`);
  }
  return new Map(parseCompanyTypes(data, options.sectorOids).map((e) => [e.mkkMemberOid, e]));
}
