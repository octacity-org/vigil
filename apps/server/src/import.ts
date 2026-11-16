/**
 * Import KAP files already on disk into the Zova archive (#180): `{rawDir}/{year}_{quarter}/*.xls`, as written by
 * `bun run download`, so contributors who downloaded quarters before Zova do not download them again.
 *
 * Each new file is stored with `storeRawFile` and a `report_stored` event in the same transaction, so the processor
 * (#166) picks it up like a downloaded one. A file already stored with the same bytes is skipped and emits nothing
 * (#177); different bytes for the same disclosure become a new version (#178).
 *
 * `downloaded_at` is when the quarter was downloaded, never the time of the import: versions are ordered by it (#178),
 * so an old file imported today must not look newer than a later download. It is the modification time of the
 * quarter's zip next to the folder (`{year}_{quarter}.zip`, or
 * `kap_{year}_{quarter}.zip`), else of the oldest file in the folder, unless the caller gives one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFilename } from "@vigil/core";
import { emit } from "./events.ts";
import { filesByDisclosure, storeRawFile } from "./raw-files.ts";
import type { Store } from "./zova.ts";

const QUARTER_DIR = /^(\d{4})_([1-4])$/;

export interface ImportFailure {
  file: string;
  reason: string;
}

export interface QuarterImport {
  dir: string;
  year: number;
  quarter: number;
  /** ISO 8601, UTC. Null when nothing was imported for want of files or because of `error`. */
  downloaded_at: string | null;
  /** Where `downloaded_at` came from: a zip path, `oldest file in the folder`, or `given`. */
  downloaded_at_source: string | null;
  imported: number;
  /** Of `imported`: files whose disclosure already had other bytes, stored as a new version (#178). */
  new_versions: number;
  skipped: number;
  failed: ImportFailure[];
  /** Why nothing in the folder was imported: it is not a readable folder, or its download time is impossible. */
  error: string | null;
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory(); // follows symbolic links, as `bun run load` does
  } catch {
    return false;
  }
};

/** The `{year}_{quarter}` folders to import: `rawDir` itself if it is one, else its subfolders of that form. */
export function quarterDirs(rawDir: string): string[] {
  const dir = resolve(rawDir);
  if (!isDirectory(dir)) throw new Error(`${rawDir} is not a folder`);
  if (QUARTER_DIR.test(basename(dir))) return [dir];
  // Every entry named like a quarter: one that is not a readable folder is reported by importQuarter, not skipped.
  const dirs = readdirSync(dir)
    .filter((name) => QUARTER_DIR.test(name))
    .map((name) => join(dir, name))
    .sort();
  if (dirs.length === 0) throw new Error(`${rawDir} has no {year}_{quarter} folders`);
  return dirs;
}

/** The `.xls` files of a folder (symbolic links followed); an `.xls` entry that is not a readable file is a failure. */
function xlsFiles(dir: string): { files: string[]; failed: ImportFailure[] } {
  const files: string[] = [];
  const failed: ImportFailure[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith(".xls")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) files.push(path);
      else failed.push({ file: name, reason: "not a file" });
    } catch (e) {
      failed.push({ file: name, reason: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }
  return { files, failed };
}

/** When the quarter in `dir` was downloaded, and how that was found; null for a folder without files. */
export function quarterDownloadTime(dir: string, files: readonly string[]): { at: Date; source: string } | null {
  const name = basename(dir);
  for (const zip of [`${name}.zip`, `kap_${name}.zip`]) {
    const path = join(dirname(dir), zip);
    if (existsSync(path)) return { at: statSync(path).mtime, source: path };
  }
  if (files.length === 0) return null;
  const oldest = files.reduce((t, f) => Math.min(t, statSync(f).mtime.getTime()), Number.POSITIVE_INFINITY);
  return { at: new Date(oldest), source: "oldest file in the folder" };
}

/** A file that cannot be imported; the others continue. */
class FileError extends Error {
  override name = "FileError";
}

/** An empty result for a `{year}_{quarter}` folder, filled in by `importQuarter`. */
export function emptyQuarterImport(dir: string): QuarterImport {
  const [, year, quarter] = QUARTER_DIR.exec(basename(dir)) as RegExpExecArray;
  return {
    dir,
    year: Number(year),
    quarter: Number(quarter),
    downloaded_at: null,
    downloaded_at_source: null,
    imported: 0,
    new_versions: 0,
    skipped: 0,
    failed: [],
    error: null,
  };
}

/** The first moment after the quarter: a file of the quarter cannot have been downloaded before it. */
function quarterEnd(year: number, quarter: number): Date {
  return new Date(Date.UTC(year, quarter * 3, 1));
}

/**
 * Import one `{year}_{quarter}` folder into `result` (pass one in to keep the counts of files already stored if the
 * store fails part way). A file that cannot be read or has a wrong name is listed in `failed`, and a folder that is
 * not readable or whose download time is impossible (before the quarter ends, or in the future) in `error`; the
 * others continue. An error of the store itself (Zova) is thrown: it would fail every file the same way.
 */
export interface ImportOptions {
  downloadedAt?: Date;
  /** Only these file names of the folder; the others are left alone (a download stores what it just extracted). */
  files?: readonly string[];
  /** `source` in the `report_stored` payload: `import` (default) or `download` (#44). */
  source?: "import" | "download";
  /** The URL the bytes came from; defaults to each file's `file://` path. */
  sourceUrl?: string;
  /** Called after each file with the files handled so far and the total (#206). */
  onFile?: (done: number, total: number) => void;
}

export function importQuarter(
  store: Store,
  dir: string,
  options: ImportOptions = {},
  result: QuarterImport = emptyQuarterImport(dir),
): QuarterImport {
  let files: string[];
  let time: { at: Date; source: string } | null;
  try {
    const listed = xlsFiles(dir);
    const only = options.files === undefined ? null : new Set(options.files);
    files = only === null ? listed.files : listed.files.filter((f) => only.has(basename(f)));
    result.failed.push(...listed.failed);
    if (files.length === 0) return result;
    time = options.downloadedAt ? { at: options.downloadedAt, source: "given" } : quarterDownloadTime(dir, files);
  } catch (e) {
    result.error = `${(e as Error).name}: ${(e as Error).message}`;
    return result;
  }
  if (time && time.at.getTime() > Date.now()) {
    // A future time would rank these files above every real download (#178).
    result.error = `the download time ${time.at.toISOString()} from ${time.source} is in the future`;
    return result;
  }
  if (time && time.at < quarterEnd(result.year, result.quarter)) {
    // A file of the quarter cannot have been downloaded before the quarter ended; an earlier time is a mistake.
    result.error = `the download time ${time.at.toISOString()} from ${time.source} is before ${result.year}/${result.quarter} ended`;
    return result;
  }
  result.downloaded_at = time?.at.toISOString() ?? null;
  result.downloaded_at_source = time?.source ?? null;

  let handled = 0;
  for (const path of files) {
    handled += 1;
    const file = basename(path);
    let bytes: Uint8Array;
    let disclosureId: number;
    try {
      const id = parseFilename(file);
      if (id.year !== result.year || id.quarter !== result.quarter) {
        // The download time comes from this folder's zip; a file of another quarter would get the wrong one.
        throw new FileError(`the file name says ${id.year}/${id.quarter}, but it is in ${basename(dir)}`);
      }
      disclosureId = id.disclosure_id;
      bytes = readFileSync(path);
    } catch (e) {
      result.failed.push({ file, reason: `${(e as Error).name}: ${(e as Error).message}` });
      options.onFile?.(handled, files.length);
      continue;
    }
    const earlier = filesByDisclosure(store, disclosureId).length;
    const stored = storeRawFile(
      store,
      bytes,
      { fileName: file, sourceUrl: options.sourceUrl ?? pathToFileURL(path).href, downloadedAt: time?.at },
      {
        onStored: (s, f) =>
          emit(s, "report_stored", f.object_id, {
            disclosure_id: f.disclosure_id,
            file_name: f.file_name,
            source: options.source ?? "import",
            downloaded_at_source: time?.source ?? null,
          }),
      },
    );
    if (stored.duplicate) result.skipped += 1;
    else {
      result.imported += 1;
      if (earlier > 0) result.new_versions += 1;
    }
    options.onFile?.(handled, files.length);
  }
  return result;
}
