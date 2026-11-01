/**
 * Download a quarter of KAP financial statements and recover what a cut-off download contains (#38).
 *
 * KAP behaviour measured on 2026-10-29 (docs/kap.md):
 * - `GET financialTable/download/{year}/{quarter}` streams one zip without `Content-Length` and ignores `Range`, so a
 *   cut-off download cannot be resumed; it is retried from the start.
 * - Every member uses a data descriptor: the local header has no sizes or CRC. A member's end is found by inflating
 *   its deflate stream until it ends, never by searching for the next `PK` signature, which can occur inside
 *   compressed data.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { type KapClient, kap as sharedKap } from "./kap.ts";

export const KAP_BULK_PATH = "/tr/api/financialTable/download/{year}/{quarter}";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DATA_DESCRIPTOR = 0x08074b50;

export interface SalvageResult {
  /** The archive was a valid zip and every member was read. */
  complete: boolean;
  /** Paths of the files written. */
  recovered: string[];
  /** Members seen but cut off or corrupt; members after the cut are not known at all. */
  lost: string[];
}

export interface DownloadResult {
  zip_path: string;
  attempts: number;
  complete: boolean;
  recovered: string[];
  lost: string[];
  errors: string[];
}

/** Base name of an `.xls` member, so nothing is written outside the target directory. */
function safeName(member: string): string | null {
  const name = member.replaceAll("\\", "/").split("/").pop() ?? "";
  return name.toLowerCase().endsWith(".xls") ? name : null;
}

function write(extractDir: string, name: string, data: Uint8Array): string {
  const path = join(extractDir, name);
  writeFileSync(path, data);
  return path;
}

const decoder = new TextDecoder("utf-8");

/** Inflate one raw deflate stream from `start`. Returns [content, end offset], or null if cut off or corrupt. */
function inflate(data: Buffer, start: number): [Buffer, number] | null {
  try {
    const out = inflateRawSync(data.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    return [out.buffer, start + out.engine.bytesWritten];
  } catch {
    return null;
  }
}

function scanLocalHeaders(data: Buffer, extractDir: string, only: ReadonlySet<string> | null): SalvageResult {
  const result: SalvageResult = { complete: false, recovered: [], lost: [] };
  let pos = data.indexOf("PK\x03\x04", 0, "latin1");
  while (pos !== -1 && pos + 30 <= data.length) {
    const flags = data.readUInt16LE(pos + 6);
    const method = data.readUInt16LE(pos + 8);
    let crc = data.readUInt32LE(pos + 14);
    const compSize = data.readUInt32LE(pos + 18);
    const nameLen = data.readUInt16LE(pos + 26);
    const extraLen = data.readUInt16LE(pos + 28);
    const start = pos + 30 + nameLen + extraLen;
    const member = decoder.decode(data.subarray(pos + 30, Math.min(pos + 30 + nameLen, data.length)));
    if (start > data.length) {
      if (pos + 30 + nameLen <= data.length) result.lost.push(member); // the name is known, its data is not
      break;
    }
    const hasDescriptor = (flags & 0x08) !== 0;

    let inflated: [Buffer, number] | null = null;
    if (method === 8) inflated = inflate(data, start);
    else if (method === 0 && !hasDescriptor && start + compSize <= data.length) {
      inflated = [data.subarray(start, start + compSize), start + compSize];
    }
    // Otherwise cut off, or stored with an unknown size: its end cannot be found.
    if (inflated === null) {
      result.lost.push(member);
      break;
    }
    const [content, contentEnd] = inflated;
    let end = contentEnd;

    if (hasDescriptor) {
      if (end + 4 <= data.length && data.readUInt32LE(end) === DATA_DESCRIPTOR) end += 4;
      if (end + 12 > data.length) {
        result.lost.push(member);
        break;
      }
      crc = data.readUInt32LE(end);
      end += 12; // crc, compressed size, uncompressed size (KAP does not use zip64)
    }

    const name = safeName(member);
    if (crc32(content) >>> 0 !== crc) result.lost.push(member);
    else if (name && (only === null || only.has(name))) result.recovered.push(write(extractDir, name, content));
    pos = data.indexOf("PK\x03\x04", end, "latin1");
  }
  return result;
}

/** Offset of the end-of-central-directory record, or -1 if the file is not a complete zip. */
function endOfCentralDirectory(data: Buffer): number {
  const min = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= min; i--) {
    if (data.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY && i + 22 + data.readUInt16LE(i + 20) <= data.length)
      return i;
  }
  return -1;
}

/** Whether a file is a complete zip (has an end-of-central-directory record). */
export function isZipFile(path: string): boolean {
  if (!existsSync(path) || statSync(path).size < 22) return false;
  return endOfCentralDirectory(readFileSync(path)) !== -1;
}

/** Read a complete zip through its central directory. Returns null if the directory is unreadable. */
function readCentralDirectory(
  data: Buffer,
  eocd: number,
  extractDir: string,
  only: ReadonlySet<string> | null,
): SalvageResult | null {
  const result: SalvageResult = { complete: true, recovered: [], lost: [] };
  const count = data.readUInt16LE(eocd + 10);
  let pos = data.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (pos + 46 > data.length || data.readUInt32LE(pos) !== CENTRAL_HEADER) return null;
    const method = data.readUInt16LE(pos + 10);
    const crc = data.readUInt32LE(pos + 16);
    const compSize = data.readUInt32LE(pos + 20);
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const local = data.readUInt32LE(pos + 42);
    const member = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    const name = safeName(member);
    if (!name || (only !== null && !only.has(name))) continue;
    if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL_HEADER) {
      result.lost.push(member);
      continue;
    }
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    let content: Buffer | null = null;
    try {
      const raw = data.subarray(start, start + compSize);
      content = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
    } catch {
      content = null;
    }
    if (content === null || crc32(content) >>> 0 !== crc) result.lost.push(member);
    else result.recovered.push(write(extractDir, name, content));
  }
  result.complete = result.lost.length === 0;
  return result;
}

/**
 * Write every complete `.xls` member of a zip, valid or cut off, to `extractDir` (flat, by base name).
 * With `only`, write just the members with those base names.
 */
export function salvageZip(zipPath: string, extractDir: string, only: Iterable<string> | null = null): SalvageResult {
  mkdirSync(extractDir, { recursive: true });
  const wanted = only === null ? null : new Set(only);
  const data = readFileSync(zipPath);
  const eocd = data.length >= 22 ? endOfCentralDirectory(data) : -1;
  if (eocd !== -1) {
    const complete = readCentralDirectory(data, eocd, extractDir, wanted);
    if (complete !== null) return complete;
  }
  return scanLocalHeaders(data, extractDir, wanted);
}

export interface DownloadOptions {
  retries?: number;
  timeoutMs?: number;
  /** Seconds before the first retry; doubles after each attempt. */
  backoff?: number;
  /** All KAP requests go through this client (#199); tests pass one with a fake transport. */
  kap?: KapClient;
  /** Waits `seconds`; replaceable in tests. */
  sleep?: (seconds: number) => Promise<void>;
  /** Extract only these file names; `complete` then means all of them were recovered. */
  only?: Iterable<string> | null;
}

const realSleep = (seconds: number) => new Promise<void>((r) => setTimeout(r, seconds * 1000));

/** Read a response body into chunks. If the stream breaks, the chunks read so far are kept and the error rethrown. */
async function readBody(resp: Response, chunks: Uint8Array[]): Promise<void> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    chunks.push(value);
  }
}

/**
 * Download one quarter into `{rawDir}/{year}_{quarter}.zip` and extract it to `{rawDir}/{year}_{quarter}/`.
 *
 * Retries from the start with exponential backoff until the zip is complete. If it never is, the largest partial
 * download is salvaged and the result lists what was recovered and what was lost.
 */
export async function downloadQuarter(
  year: number,
  quarter: number,
  rawDir: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { retries = 5, timeoutMs = 60_000, backoff = 2, kap = sharedKap, sleep = realSleep } = options;
  const only = options.only == null ? null : [...options.only];
  mkdirSync(rawDir, { recursive: true });
  const zipPath = join(rawDir, `${year}_${quarter}.zip`);
  const partPath = `${zipPath}.part`;
  const path = KAP_BULK_PATH.replace("{year}", String(year)).replace("{quarter}", String(quarter));
  if (existsSync(zipPath)) rmSync(zipPath); // never salvage a file left by an earlier run
  const errors: string[] = [];
  let best = 0;
  let attempt = 0;
  for (attempt = 1; attempt <= retries; attempt++) {
    const chunks: Uint8Array[] = [];
    try {
      // One attempt per call: this loop retries a cut-off zip itself, from the start.
      await kap.request(path, (resp) => readBody(resp, chunks), { timeoutMs, attempts: 1 });
    } catch (e) {
      // Network errors are retried and reported, never raised.
      errors.push(`attempt ${attempt}: ${(e as Error).name}: ${(e as Error).message}`);
    }
    writeFileSync(partPath, Buffer.concat(chunks));
    if (isZipFile(partPath)) {
      renameSync(partPath, zipPath);
      break;
    }
    const size = statSync(partPath).size;
    if (size) errors.push(`attempt ${attempt}: incomplete zip (${size} bytes)`);
    if (size > best) {
      // Every attempt streams the same file from the start; keep the longest.
      best = size;
      renameSync(partPath, zipPath);
    }
    if (attempt < retries) await sleep(backoff * 2 ** (attempt - 1));
  }
  attempt = Math.min(attempt, retries);
  if (existsSync(partPath)) rmSync(partPath);
  if (!existsSync(zipPath))
    return { zip_path: zipPath, attempts: attempt, complete: false, recovered: [], lost: [], errors };
  const salvage = salvageZip(zipPath, join(rawDir, `${year}_${quarter}`), only);
  let complete = salvage.complete;
  if (only !== null) {
    const got = new Set(salvage.recovered.map((p) => basename(p)));
    complete = only.every((n) => got.has(n));
  }
  return { zip_path: zipPath, attempts: attempt, complete, recovered: salvage.recovered, lost: salvage.lost, errors };
}

/** Read a list of raw files, one `{year}_{quarter}/{file name}` per line; `#` starts a comment. Grouped by quarter. */
export function readFileList(path: string): Map<string, string[]> {
  const wanted = new Map<string, string[]>();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (!line) continue;
    const [folder, name] = line.split("/") as [string, string];
    const [year, quarter] = folder.split("_").map(Number);
    const key = `${year}_${quarter}`;
    wanted.set(key, [...(wanted.get(key) ?? []), name]);
  }
  return wanted;
}

/**
 * Download each quarter named in `listPath` and extract only the listed files (#128).
 * Files already present are not downloaded again. Returns the files still missing, by quarter (`2026_2`).
 */
export async function fetchFiles(
  listPath: string,
  rawDir: string,
  options: DownloadOptions & { keepZip?: boolean } = {},
): Promise<Map<string, string[]>> {
  const missing = new Map<string, string[]>();
  for (const [quarterKey, names] of readFileList(listPath)) {
    const folder = join(rawDir, quarterKey);
    const needed = names.filter((n) => !existsSync(join(folder, n)));
    if (needed.length === 0) continue;
    const [year, quarter] = quarterKey.split("_").map(Number) as [number, number];
    const result = await downloadQuarter(year, quarter, rawDir, { ...options, only: needed });
    if (!options.keepZip && existsSync(result.zip_path)) rmSync(result.zip_path);
    const got = new Set(result.recovered.map((p) => basename(p)));
    const still = needed.filter((n) => !got.has(n)).sort();
    if (still.length > 0) missing.set(quarterKey, still);
  }
  return missing;
}
