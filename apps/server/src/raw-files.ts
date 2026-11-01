/**
 * Raw KAP files in the Zova archive (#176). The bytes are a Zova object; `raw_files` says what they are and
 * where they came from. Identity comes from the KAP file name (docs/kap.md, "File name").
 */
import { parseFilename } from "@vigil/core";
import type { SqlRow, Store } from "./zova.ts";

export interface RawFileSource {
  /** `{TICKER-GROUP}_{disclosure}_{year}_{quarter}.xls`; company, disclosure and period are read from it. */
  fileName: string;
  /** Where the bytes came from: a KAP URL, or `file://…` for a local import. */
  sourceUrl: string;
  /** When the bytes were downloaded; defaults to now. */
  downloadedAt?: Date;
}

export interface RawFile {
  object_id: string;
  disclosure_id: number;
  company_code: string;
  raw_ticker_group: string;
  year: number;
  quarter: number;
  file_name: string;
  size_bytes: number;
  downloaded_at: string;
  source_url: string;
  stored_at: string;
}

function toRawFile(row: SqlRow): RawFile {
  return {
    object_id: String(row.object_id),
    disclosure_id: Number(row.disclosure_id),
    company_code: String(row.company_code),
    raw_ticker_group: String(row.raw_ticker_group),
    year: Number(row.year),
    quarter: Number(row.quarter),
    file_name: String(row.file_name),
    size_bytes: Number(row.size_bytes),
    downloaded_at: String(row.downloaded_at),
    source_url: String(row.source_url),
    stored_at: String(row.stored_at),
  };
}

/**
 * Store the bytes as a Zova object and record its metadata, in one transaction. Returns the record.
 * Throws a `ParseError` for a file name that is not a KAP file name.
 */
export function storeRawFile(store: Store, bytes: Uint8Array, source: RawFileSource): RawFile {
  const id = parseFilename(source.fileName);
  const fileName = source.fileName.split(/[/]/).pop() as string;
  const downloadedAt = (source.downloadedAt ?? new Date()).toISOString();
  return store.transaction((s) => {
    const objectId = s.putObject(bytes);
    s.run(
      `INSERT INTO raw_files (object_id, disclosure_id, company_code, raw_ticker_group, year, quarter, file_name,
         size_bytes, downloaded_at, source_url, stored_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      [
        objectId,
        id.disclosure_id,
        id.company_code,
        id.raw_ticker_group,
        id.year,
        id.quarter,
        fileName,
        bytes.length,
        downloadedAt,
        source.sourceUrl,
        new Date().toISOString(),
      ],
    );
    return toRawFile(s.query("SELECT * FROM raw_files WHERE rowid = last_insert_rowid()")[0] as SqlRow);
  });
}

const ORDER = "ORDER BY year, quarter, company_code, disclosure_id, downloaded_at, rowid";

/** Every file stored for a disclosure, oldest download first. */
export function filesByDisclosure(store: Store, disclosureId: number): RawFile[] {
  return store
    .query("SELECT * FROM raw_files WHERE disclosure_id = ?1 ORDER BY downloaded_at, rowid", [disclosureId])
    .map(toRawFile);
}

/** Every file stored for a company (by its first code), by period. */
export function filesByCompany(store: Store, companyCode: string): RawFile[] {
  return store
    .query(`SELECT * FROM raw_files WHERE company_code = ?1 ${ORDER}`, [companyCode.toUpperCase()])
    .map(toRawFile);
}

/** Every file stored for one quarter. */
export function filesByQuarter(store: Store, year: number, quarter: number): RawFile[] {
  return store
    .query(`SELECT * FROM raw_files WHERE year = ?1 AND quarter = ?2 ${ORDER}`, [year, quarter])
    .map(toRawFile);
}

/** The stored bytes of a file. */
export function readRawFile(store: Store, file: Pick<RawFile, "object_id">): Uint8Array {
  return store.getObject(file.object_id);
}
