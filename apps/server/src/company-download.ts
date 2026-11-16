/**
 * Download one company's report for one period (#164, `docs/kap.md` "Single-company download"): the statement file
 * and the footnote PDFs, about 1 MB against 28.6 MB for a whole quarter. The collector (#50) uses it for each new
 * disclosure (#201, #203).
 *
 * - `financialTable/listCompanyExcelMembers/{mkkMemberOid}/{year}/{quarter}` lists the company's current statement
 *   files for the period: after a correction, only the correction.
 * - `home-financial/download-file/{mkkMemberOid}/{year}/{quarter}` returns a zip with those `.xls` files and the
 *   PDFs under `Dönem{N}Ekler/`.
 *
 * Every request goes through the KAP client (#199). A cut-off zip is asked for again, up to `retries` times; if it is
 * never complete, the complete members of the longest answer are kept and the rest listed as lost (as #38 does for the
 * bulk zip). Statement files are stored with `storeRawFile` and a `report_stored` event, PDFs in `raw_attachments`;
 * the same bytes are stored once.
 */
import { createHash } from "node:crypto";
import { parseFilename } from "@vigil/core";
import { readZip } from "./downloader.ts";
import { emit } from "./events.ts";
import { KAP_ORIGIN, type KapClient, kap as sharedKap } from "./kap.ts";
import { type StoreResult, storeRawFile } from "./raw-files.ts";
import type { Store } from "./zova.ts";

export interface CompanyPeriod {
  mkkMemberOid: string;
  year: number;
  quarter: number;
}

/** A statement file KAP lists for a company and period. */
export interface CompanyMember {
  disclosure_id: number;
  /** `pdOid`: KAP's id of the disclosure. */
  disclosure_oid: string;
  stock_code: string;
  title: string;
}

const membersPath = (p: CompanyPeriod) =>
  `/tr/api/financialTable/listCompanyExcelMembers/${p.mkkMemberOid}/${p.year}/${p.quarter}`;
const downloadPath = (p: CompanyPeriod) =>
  `/tr/api/home-financial/download-file/${p.mkkMemberOid}/${p.year}/${p.quarter}`;

function checkPeriod(p: CompanyPeriod): void {
  if (!/^[0-9a-f]{32}$/i.test(p.mkkMemberOid)) throw new RangeError(`not a KAP member id: ${p.mkkMemberOid}`);
  if (!Number.isInteger(p.year) || p.year < 2000 || ![1, 2, 3, 4].includes(p.quarter)) {
    throw new RangeError(`not a report period: ${p.year}/${p.quarter}`);
  }
}

/** The company's current statement files for the period, as KAP lists them; empty when there are none. */
export async function companyMembers(p: CompanyPeriod, kap: KapClient = sharedKap): Promise<CompanyMember[]> {
  checkPeriod(p);
  const answer = await kap.json<unknown>(membersPath(p));
  if (!Array.isArray(answer)) throw new Error(`listCompanyExcelMembers: not a list: ${JSON.stringify(answer)}`);
  return answer.map((m: Record<string, unknown>) => {
    if (!Number.isInteger(m.disclosureIndex) || typeof m.pdOid !== "string") {
      throw new Error(`listCompanyExcelMembers: unexpected entry ${JSON.stringify(m)}`);
    }
    return {
      disclosure_id: m.disclosureIndex as number,
      disclosure_oid: m.pdOid,
      stock_code: String(m.stockCode ?? ""),
      title: String(m.title ?? ""),
    };
  });
}

export interface CompanyDownload {
  /** Statement files stored (or already stored: `duplicate`). */
  statements: StoreResult[];
  /** PDFs: how many were new and how many already stored. */
  attachments: { stored: number; skipped: number };
  /** False if the zip was never complete; `lost` names the members that could not be read. */
  complete: boolean;
  lost: string[];
  /** Members that are neither `.xls` nor `.pdf`, or `.xls` without a KAP file name; not stored. */
  ignored: string[];
  attempts: number;
  errors: string[];
}

export interface CompanyDownloadOptions {
  kap?: KapClient;
  /** Downloads of the zip; a cut-off zip is asked for again. */
  retries?: number;
  now?: () => Date;
}

/** Store a PDF of a company's period once. Returns whether it was new. */
export function storeAttachment(
  store: Store,
  p: CompanyPeriod,
  path: string,
  bytes: Uint8Array,
  source: { url: string; downloadedAt: Date },
): boolean {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return store.transaction((s) => {
    const known = s.query(
      "SELECT 1 FROM raw_attachments WHERE mkk_member_oid = ?1 AND year = ?2 AND quarter = ?3 AND object_id = ?4",
      [p.mkkMemberOid, p.year, p.quarter, hash],
    );
    if (known.length > 0) return false;
    const id = s.putObject(bytes);
    if (id !== hash) throw new Error(`Zova object id ${id} is not the SHA-256 of the content (${hash})`);
    s.run("INSERT INTO raw_attachments VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", [
      id,
      p.mkkMemberOid,
      p.year,
      p.quarter,
      path,
      bytes.length,
      source.downloadedAt.toISOString(),
      source.url,
      new Date().toISOString(),
    ]);
    return true;
  });
}

/**
 * Download the company's zip for the period and store its statement files and PDFs. A KAP error on every attempt is
 * thrown; nothing is stored then. An error of the store is thrown too; files stored before it stay.
 */
export async function downloadCompanyReport(
  store: Store,
  p: CompanyPeriod,
  options: CompanyDownloadOptions = {},
): Promise<CompanyDownload> {
  checkPeriod(p);
  const kap = options.kap ?? sharedKap;
  const retries = options.retries ?? 3;
  const errors: string[] = [];
  let best: ReturnType<typeof readZip> | null = null;
  let size = -1;
  let attempts = 0;
  for (attempts = 1; attempts <= retries; attempts++) {
    let bytes: Uint8Array;
    try {
      bytes = await kap.request(downloadPath(p), async (r) => new Uint8Array(await r.arrayBuffer()));
    } catch (e) {
      errors.push(`attempt ${attempts}: ${(e as Error).name}: ${(e as Error).message}`);
      continue;
    }
    const zip = readZip(bytes);
    if (zip.complete) {
      best = zip;
      break;
    }
    errors.push(`attempt ${attempts}: incomplete zip (${bytes.length} bytes)`);
    if (bytes.length > size) {
      size = bytes.length;
      best = zip;
    }
  }
  attempts = Math.min(attempts, retries);
  if (best === null)
    throw new Error(`no answer from KAP for ${p.year}/${p.quarter} of ${p.mkkMemberOid}: ${errors.join("; ")}`);

  const url = `${KAP_ORIGIN}${downloadPath(p)}`;
  const downloadedAt = (options.now ?? (() => new Date()))();
  const out: CompanyDownload = {
    statements: [],
    attachments: { stored: 0, skipped: 0 },
    complete: best.complete,
    lost: best.lost,
    ignored: [],
    attempts,
    errors,
  };
  for (const m of best.members) {
    const name = m.path.split("/").pop() as string;
    const lower = name.toLowerCase();
    if (lower.endsWith(".xls")) {
      try {
        parseFilename(name);
      } catch {
        out.ignored.push(m.path);
        continue;
      }
      out.statements.push(
        storeRawFile(
          store,
          m.content,
          { fileName: name, sourceUrl: url, downloadedAt },
          {
            onStored: (s, f) =>
              emit(s, "report_stored", f.object_id, {
                disclosure_id: f.disclosure_id,
                file_name: f.file_name,
                source: "company_download",
              }),
          },
        ),
      );
    } else if (lower.endsWith(".pdf")) {
      if (storeAttachment(store, p, m.path, m.content, { url, downloadedAt })) out.attachments.stored += 1;
      else out.attachments.skipped += 1;
    } else out.ignored.push(m.path);
  }
  return out;
}
