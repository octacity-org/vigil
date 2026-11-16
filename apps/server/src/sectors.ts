/**
 * KAP's sector classification (#295, decisions 0016 and 0017, `docs/kap.md` "Sectors").
 *
 * There is no documented API: the Sektörler page embeds the classification as escaped JSON, one record for each
 * company's main sector (`mainSectorName`, …) and one for its sub-sector (`sectorName`, …), keyed by `mkkMemberOid`.
 * Companies are matched by that id, never by ticker (Kardemir is `KRDMA, KRDMB, KRDMD` on the page, and its files use
 * `KRDMA-KRDMB-KRDMD`).
 *
 * If the page changes, reading it fails loudly (`SectorPageError`): no records, fewer than `MIN_COMPANIES` companies,
 * a sub-sector without a main sector, or two different records for one company. It never falls back to "every company
 * unknown", which would silently switch findings off (0017).
 *
 * Every reading is kept in Zova with the time it was read. The same classification is stored once, with the page it
 * was first read from, so a comparison can be traced to the classification it used (0016). The page is read again at
 * most once a day.
 */
import { createHash } from "node:crypto";
import { type KapClient, kap as sharedKap } from "./kap.ts";
import type { Store } from "./zova.ts";

export const SECTORS_PATH = "/tr/Sektorler";
/** About 626 companies on 2026-11-01; far fewer means the page is not what this code reads. */
export const MIN_COMPANIES = 500;
/** A reading younger than this is used instead of reading the page again. */
export const REREAD_AFTER_MS = 24 * 3_600_000;

export interface CompanySector {
  mkk_member_oid: string;
  /** As on the page: one code, or several separated by commas. */
  stock_codes: string;
  title: string;
  main_sector_no: string;
  main_sector_name: string;
  main_sector_oid: string;
  /** Null when the page gives the company only a main sector. */
  sector_no: string | null;
  sector_name: string | null;
  sector_oid: string | null;
}

export class SectorPageError extends Error {
  override name = "SectorPageError";
}

/** A record as it is embedded in the page: `{\"mainSectorName\":…}` or `{\"sectorName\":…}`, no nested objects. */
const RECORD_RE = /\{\\"(?:mainSectorName|sectorName)\\":(?:[^{}\\]|\\.)*\}/g;

const field = (r: Record<string, unknown>, name: string): string => {
  const v = r[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new SectorPageError(`a sector record has no ${name}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  return v.trim();
};

/** Read the classification from the page's HTML, sorted by member id. Throws `SectorPageError` as described above. */
export function parseSectorPage(html: string): CompanySector[] {
  const main = new Map<string, Record<string, unknown>>();
  const sub = new Map<string, Record<string, unknown>>();
  let records = 0;
  for (const m of html.matchAll(RECORD_RE)) {
    let record: Record<string, unknown>;
    try {
      // The record is a JSON text inside a JavaScript string: unescape the string, then read the JSON.
      record = JSON.parse(JSON.parse(`"${m[0]}"`));
    } catch (e) {
      throw new SectorPageError(`a sector record is not JSON (${(e as Error).message}): ${m[0].slice(0, 200)}`);
    }
    records += 1;
    const kind = "mainSectorName" in record ? main : sub;
    const oid = field(record, "mkkMemberOid");
    const earlier = kind.get(oid);
    if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(record)) {
      throw new SectorPageError(`company ${oid} has two different ${kind === main ? "main" : "sub"}-sector records`);
    }
    kind.set(oid, record);
  }
  if (records === 0) throw new SectorPageError("no sector records found on the page; its layout has changed");
  for (const oid of sub.keys()) {
    if (!main.has(oid)) {
      const s = sub.get(oid) as Record<string, unknown>;
      throw new SectorPageError(`company ${oid} (${String(s.stockCode)}) has a sub-sector but no main sector`);
    }
  }
  if (main.size < MIN_COMPANIES) {
    throw new SectorPageError(`only ${main.size} companies found on the page, expected at least ${MIN_COMPANIES}`);
  }
  return [...main.keys()].sort().map((oid) => {
    const m = main.get(oid) as Record<string, unknown>;
    const s = sub.get(oid);
    return {
      mkk_member_oid: oid,
      stock_codes: field(m, "stockCode"),
      title: field(m, "title"),
      main_sector_no: field(m, "mainSectorNo"),
      main_sector_name: field(m, "mainSectorName"),
      main_sector_oid: field(m, "mainSectorOid"),
      sector_no: s ? field(s, "sectorNo") : null,
      sector_name: s ? field(s, "sectorName") : null,
      sector_oid: s ? field(s, "sectorOid") : null,
    };
  });
}

/** The id of a classification: the SHA-256 of its rows, so the same content read twice is stored once. */
export const classificationId = (companies: readonly CompanySector[]) =>
  createHash("sha256").update(JSON.stringify(companies)).digest("hex");

export interface SectorReading {
  id: number;
  read_at: string;
  classification_id: string;
  companies: CompanySector[];
}

const COLUMNS = [
  "mkk_member_oid",
  "stock_codes",
  "title",
  "main_sector_no",
  "main_sector_name",
  "main_sector_oid",
  "sector_no",
  "sector_name",
  "sector_oid",
] as const;

function companiesOf(store: Store, classificationId: string): CompanySector[] {
  return store
    .query(`SELECT ${COLUMNS.join(", ")} FROM company_sectors WHERE classification_id = ?1 ORDER BY mkk_member_oid`, [
      classificationId,
    ])
    .map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] === null ? null : String(r[c])])) as never);
}

function reading(store: Store, row: Record<string, unknown> | undefined): SectorReading | null {
  if (row === undefined) return null;
  const id = String(row.classification_id);
  return { id: Number(row.id), read_at: String(row.read_at), classification_id: id, companies: companiesOf(store, id) };
}

/** The latest reading, or null before the first one. */
export function latestSectors(store: Store): SectorReading | null {
  return reading(store, store.query("SELECT * FROM sector_readings ORDER BY read_at DESC, id DESC LIMIT 1")[0]);
}

/** The reading in use at `time` (ISO 8601): the latest one read at or before it. */
export function sectorsAt(store: Store, time: string): SectorReading | null {
  return reading(
    store,
    store.query("SELECT * FROM sector_readings WHERE read_at <= ?1 ORDER BY read_at DESC, id DESC LIMIT 1", [time])[0],
  );
}

/**
 * Record a reading of the page read at `readAt`: the page and its classification are stored only if this
 * classification is new. Throws `SectorPageError` (and stores nothing) for a page that cannot be read.
 */
export function storeSectorPage(store: Store, html: string, readAt: Date): SectorReading {
  const companies = parseSectorPage(html);
  const id = classificationId(companies);
  return store.transaction((s) => {
    if (s.query("SELECT 1 FROM sector_classifications WHERE id = ?1", [id]).length === 0) {
      const page = s.putObject(new TextEncoder().encode(html));
      s.run("INSERT INTO sector_classifications VALUES (?1, ?2, ?3)", [id, page, companies.length]);
      for (const c of companies) {
        s.run(
          `INSERT INTO company_sectors (classification_id, ${COLUMNS.join(", ")})
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          [id, ...COLUMNS.map((k) => c[k])],
        );
      }
    }
    s.run("INSERT INTO sector_readings (read_at, classification_id) VALUES (?1, ?2)", [readAt.toISOString(), id]);
    return reading(s, s.query("SELECT * FROM sector_readings WHERE id = last_insert_rowid()")[0]) as SectorReading;
  });
}

export interface RefreshOptions {
  kap?: KapClient;
  now?: () => Date;
  /** Read the page even if the latest reading is less than a day old. */
  force?: boolean;
}

/**
 * The current classification: the latest reading if it is less than a day old, otherwise the page is read again
 * through the KAP client and stored. A KAP error or a page that cannot be read is thrown; earlier readings stay.
 */
export async function refreshSectors(
  store: Store,
  options: RefreshOptions = {},
): Promise<{ reading: SectorReading; fetched: boolean }> {
  const now = (options.now ?? (() => new Date()))();
  const latest = latestSectors(store);
  if (!options.force && latest !== null && now.getTime() - Date.parse(latest.read_at) < REREAD_AFTER_MS) {
    return { reading: latest, fetched: false };
  }
  const html = await (options.kap ?? sharedKap).request(SECTORS_PATH, (r) => r.text());
  return { reading: storeSectorPage(store, html, now), fetched: true };
}
