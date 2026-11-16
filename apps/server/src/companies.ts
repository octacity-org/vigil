/**
 * Company metadata in DuckDB (#189): for the API's company search and single-company downloads, every company with a
 * report gets its KAP member id, all its codes, its title, its template family and its KAP sector.
 *
 * - The member id, codes and title come from KAP's disclosure list (#163): the entry of the company's latest report,
 *   found by its disclosure id (the id in the file name is the list's `disclosureIndex`).
 * - The sector comes from KAP's sector classification (#295), matched by member id, never by ticker.
 * - The template family is the latest report's.
 * - `search_key` holds the codes and title folded the Turkish way (`turkishSearchKey`), so `ışık`, `IŞIK` and `isik`
 *   find the same company.
 */
import type { Database } from "./db.ts";
import { rows } from "./db.ts";
import type { Disclosure } from "./disclosures.ts";
import type { CompanySector } from "./sectors.ts";

const FOLD: Record<string, string> = { ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c", â: "a", î: "i", û: "u" };

/**
 * Lower case by Turkish rules (`I` → `ı`, `İ` → `i`), then without Turkish letters and accents, with runs of other
 * characters as one space: `KATMERCİLER ARAÇ ÜSTÜ` → `katmerciler arac ustu`. Fold a search query the same way and
 * match it as a substring.
 */
export function turkishSearchKey(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .normalize("NFC")
    .replace(/[ışğüöçâîû]/g, (c) => FOLD[c] as string)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A company's latest report: the one its metadata is read from. */
export interface LatestReport {
  company_code: string;
  disclosure_id: number;
  template_family: string;
  /** Istanbul time, or null for a report loaded without one. */
  published_at: string | null;
}

/** Each company's latest report, by publication time and then disclosure id (decision 0002). */
export async function latestReports(db: Database): Promise<LatestReport[]> {
  const found = await rows(
    db,
    `SELECT company_code, disclosure_id, template_family, strftime(published_at, '%Y-%m-%dT%H:%M:%S') AS published_at
     FROM reports
     QUALIFY row_number() OVER (PARTITION BY company_code ORDER BY published_at DESC NULLS LAST, disclosure_id DESC) = 1
     ORDER BY company_code`,
  );
  return found.map((r) => ({
    company_code: String(r.company_code),
    disclosure_id: Number(r.disclosure_id),
    template_family: String(r.template_family),
    published_at: r.published_at === null ? null : String(r.published_at),
  }));
}

export interface CompanyRow {
  company_code: string;
  mkk_member_oid: string;
  stock_codes: string[];
  title: string;
  template_family: string;
  main_sector_no: string | null;
  main_sector_name: string | null;
  sector_no: string | null;
  sector_name: string | null;
  search_key: string;
}

export interface CompanyUpdate {
  rows: CompanyRow[];
  /** Companies whose latest report is not in the disclosure list: no member id, left as they were. */
  missing: string[];
  /** Companies with a member id that KAP's classification does not list (debt issuers and others, 0017). */
  without_sector: string[];
}

/** The metadata of each company from its latest report, the disclosure list and the sector classification. */
export function companyRows(
  latest: readonly LatestReport[],
  disclosures: readonly Disclosure[],
  sectors: readonly CompanySector[] | null,
): CompanyUpdate {
  const byId = new Map(disclosures.map((d) => [d.disclosure_id, d]));
  const byOid = new Map((sectors ?? []).map((s) => [s.mkk_member_oid, s]));
  const out: CompanyUpdate = { rows: [], missing: [], without_sector: [] };
  for (const r of latest) {
    const d = byId.get(r.disclosure_id);
    if (d === undefined) {
      out.missing.push(r.company_code);
      continue;
    }
    const s = byOid.get(d.mkk_member_oid);
    if (s === undefined) out.without_sector.push(r.company_code);
    const codes = d.stock_codes.length > 0 ? d.stock_codes : [r.company_code];
    out.rows.push({
      company_code: r.company_code,
      mkk_member_oid: d.mkk_member_oid,
      stock_codes: codes,
      title: d.company_title,
      template_family: r.template_family,
      main_sector_no: s?.main_sector_no ?? null,
      main_sector_name: s?.main_sector_name ?? null,
      sector_no: s?.sector_no ?? null,
      sector_name: s?.sector_name ?? null,
      search_key: turkishSearchKey([...new Set([...codes, r.company_code])].concat(d.company_title).join(" ")),
    });
  }
  return out;
}

/**
 * Write the metadata of every company with a report, in one transaction. `sectorsReadAt` is the time of the sector
 * reading used (UTC ISO), or null without one; sectors are then left empty. Returns what was written and what is
 * missing. A company without a disclosure keeps what it had.
 */
export async function updateCompanies(
  db: Database,
  disclosures: readonly Disclosure[],
  sectors: { read_at: string; companies: readonly CompanySector[] } | null,
): Promise<CompanyUpdate> {
  const update = companyRows(await latestReports(db), disclosures, sectors?.companies ?? null);
  const readAt = sectors === null ? null : sectors.read_at.replace(/Z$/, "");
  await db.con.run("BEGIN TRANSACTION");
  try {
    for (const c of update.rows) {
      await db.con.run(
        `UPDATE companies SET mkk_member_oid = $2, stock_codes = $3::VARCHAR[], title = $4, template_family = $5,
           main_sector_no = $6, main_sector_name = $7, sector_no = $8, sector_name = $9,
           sectors_read_at = $10::TIMESTAMP, search_key = $11
         WHERE company_code = $1`,
        [
          c.company_code,
          c.mkk_member_oid,
          JSON.stringify(c.stock_codes),
          c.title,
          c.template_family,
          c.main_sector_no,
          c.main_sector_name,
          c.sector_no,
          c.sector_name,
          readAt,
          c.search_key,
        ] as never,
      );
    }
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
  return update;
}

/** The first and last day (Istanbul) on which the companies' latest reports were published, or null for none. */
export function publicationRange(latest: readonly LatestReport[]): { from: string; to: string } | null {
  const days = latest
    .map((r) => r.published_at?.slice(0, 10))
    .filter((d): d is string => d !== undefined)
    .sort();
  return days.length === 0 ? null : { from: days[0] as string, to: days[days.length - 1] as string };
}
