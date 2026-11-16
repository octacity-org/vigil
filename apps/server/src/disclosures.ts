/**
 * KAP's disclosure list (#163, `docs/kap.md` "Disclosure list"): `POST disclosure/list/main`, the list behind KAP's
 * home page. The collector (#50) follows new disclosures with it, and a quarter's download is checked against it (#43).
 *
 * KAP refuses ranges over 90 days, so a longer range is asked for in windows of at most 90 days, one request after the
 * other through the shared KAP client (one request at a time, at least a second apart, #199). A window that ended
 * before today (Istanbul) does not change any more, except through new corrections, which are new disclosures on a
 * later day; its answer is cached and not asked for again.
 */
import { daysBetween, type IsoDate, isoDate, nextDay } from "@vigil/core";
import { type KapClient, KapError, kap as sharedKap } from "./kap.ts";

export const DISCLOSURE_LIST_PATH = "/tr/api/disclosure/list/main";
/** KAP answers an error for a range of more than 90 days, both ends included. */
export const MAX_WINDOW_DAYS = 90;

/** A disclosure as Vigil uses it. Times are Istanbul time, as in the parsed files (`published_at`). */
export interface Disclosure {
  /** `disclosureIndex`: the disclosure id in bulk file names. */
  disclosure_id: number;
  /** `disclosureId`: KAP's own id, which `related_disclosure_oid` of a correction points to. */
  disclosure_oid: string;
  /** `publishDate`, e.g. `2026-08-17T19:05:18`. */
  published_at: string;
  /** `stockCode` split on commas: `TEB, TEBNK` is two codes. Empty when KAP gives none. */
  stock_codes: string[];
  /** Stable company id. */
  mkk_member_oid: string;
  company_title: string;
  /** `Finansal Rapor` for the statements themselves. */
  title: string;
  /** `disclosureClass`, e.g. `FR`. */
  disclosure_class: string;
  /** Report year and quarter (`year`, `donem`); null for disclosures without a period. */
  year: number | null;
  quarter: number | null;
  /** `DUZELTILEN`: corrected later. `DUZENLENEN`: a correction of `related_disclosure_oid`. */
  is_changed: "DUZELTILEN" | "DUZENLENEN" | null;
  related_disclosure_oid: string | null;
  is_late: boolean;
}

export interface DisclosureQuery {
  /** First and last day, both included, as `YYYY-MM-DD`. */
  from: IsoDate;
  to: IsoDate;
  /** `["FR"]` for financial reports; null (default) for every class. */
  classes?: readonly string[] | null;
  /** One company only. */
  mkkMemberOid?: string | null;
}

/** Answers of finished windows, keyed by the request body. */
export interface DisclosureCache {
  get(key: string): Disclosure[] | undefined;
  set(key: string, value: Disclosure[]): void;
}

export const memoryCache = (): DisclosureCache => new Map<string, Disclosure[]>();

export interface ListOptions {
  kap?: KapClient;
  cache?: DisclosureCache;
  /** Current time; replaceable in tests. */
  now?: () => Date;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function checkDate(d: string, name: string): IsoDate {
  const m = DATE_RE.exec(d);
  const valid = m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (valid === null) throw new RangeError(`${name} must be a date such as 2026-08-17, got ${d}`);
  return valid;
}

/** Split `from`..`to` (both included) into windows of at most `MAX_WINDOW_DAYS` days, oldest first. */
export function dateWindows(from: IsoDate, to: IsoDate): [IsoDate, IsoDate][] {
  checkDate(from, "from");
  checkDate(to, "to");
  if (daysBetween(from, to) < 0) throw new RangeError(`from ${from} is after to ${to}`);
  const windows: [IsoDate, IsoDate][] = [];
  let start = from;
  for (;;) {
    let end = start;
    for (let i = 1; i < MAX_WINDOW_DAYS && daysBetween(end, to) > 0; i++) end = nextDay(end);
    windows.push([start, end]);
    if (end === to) return windows;
    start = nextDay(end);
  }
}

/** `2026-08-17` → `17.08.2026`, the format KAP wants. */
export const kapDate = (d: IsoDate) => d.split("-").reverse().join(".");

/** Today's date in Istanbul (UTC+3 all year since 2016). */
export function istanbulToday(now: Date): IsoDate {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

const PUBLISH_RE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/** `17.08.2026 19:05:18` → `2026-08-17T19:05:18`. */
function publishTime(text: unknown): string {
  const m = typeof text === "string" ? PUBLISH_RE.exec(text) : null;
  const date = m ? isoDate(Number(m[3]), Number(m[2]), Number(m[1])) : null;
  if (!m || date === null || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) {
    throw new Error(`publishDate ${JSON.stringify(text)} is not DD.MM.YYYY HH:MM:SS`);
  }
  return `${date}T${m[4]}:${m[5]}:${m[6]}`;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`${name} is ${JSON.stringify(v)}, not a string`);
  return v;
};
const optStr = (v: unknown, name: string): string | null => (v === null || v === undefined ? null : str(v, name));
const optInt = (v: unknown, name: string): number | null => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v)) throw new Error(`${name} is ${JSON.stringify(v)}, not a whole number`);
  return v as number;
};

/** One entry of the answer. Throws with the field named when KAP's answer has another shape. */
export function parseDisclosure(entry: unknown): Disclosure {
  const b = (entry as { disclosureBasic?: Record<string, unknown> } | null)?.disclosureBasic;
  if (typeof b !== "object" || b === null) throw new Error("entry has no disclosureBasic");
  const id = optInt(b.disclosureIndex, "disclosureIndex");
  if (id === null || id <= 0) throw new Error(`disclosureIndex is ${JSON.stringify(b.disclosureIndex)}`);
  try {
    const changed = optStr(b.isChanged, "isChanged");
    if (changed !== null && changed !== "DUZELTILEN" && changed !== "DUZENLENEN") {
      throw new Error(`isChanged is ${JSON.stringify(changed)}`);
    }
    const quarter = optInt(b.donem, "donem");
    if (quarter !== null && (quarter < 1 || quarter > 4)) throw new Error(`donem is ${quarter}`);
    const codes = optStr(b.stockCode, "stockCode");
    return {
      disclosure_id: id,
      disclosure_oid: str(b.disclosureId, "disclosureId"),
      published_at: publishTime(b.publishDate),
      stock_codes:
        codes === null
          ? []
          : codes
              .split(",")
              .map((c) => c.trim())
              .filter((c) => c !== ""),
      mkk_member_oid: str(b.mkkMemberOid, "mkkMemberOid"),
      company_title: optStr(b.companyTitle, "companyTitle") ?? "",
      title: optStr(b.title, "title") ?? "",
      disclosure_class: optStr(b.disclosureClass, "disclosureClass") ?? "",
      year: optInt(b.year, "year"),
      quarter,
      is_changed: changed as Disclosure["is_changed"],
      related_disclosure_oid: optStr(b.relatedDisclosureOid, "relatedDisclosureOid"),
      is_late: b.isLate === true,
    };
  } catch (e) {
    throw new Error(`disclosure ${id}: ${(e as Error).message}`);
  }
}

/** The request body KAP expects for one window. */
export function requestBody(from: IsoDate, to: IsoDate, query: DisclosureQuery) {
  return {
    fromDate: kapDate(from),
    toDate: kapDate(to),
    disclosureTypes: query.classes == null ? null : [...query.classes],
    memberTypes: [],
    mkkMemberOid: query.mkkMemberOid ?? null,
  };
}

/**
 * List the disclosures published from `query.from` to `query.to` (both included), newest first as KAP gives them.
 * Windows that ended before today are cached; a window reaching today is always asked for again. A disclosure in two
 * answers is listed once. A KAP error (after the client's retries) or an answer of another shape is thrown.
 */
export async function listDisclosures(query: DisclosureQuery, options: ListOptions = {}): Promise<Disclosure[]> {
  const client = options.kap ?? sharedKap;
  const today = istanbulToday((options.now ?? (() => new Date()))());
  const seen = new Set<number>();
  const pages: Disclosure[][] = [];
  for (const [from, to] of dateWindows(query.from, query.to)) {
    const body = requestBody(from, to, query);
    const key = JSON.stringify(body);
    let list = options.cache?.get(key);
    if (list === undefined) {
      const answer = await client.json<unknown>(DISCLOSURE_LIST_PATH, { json: body });
      if (!Array.isArray(answer)) {
        // KAP answers errors as an object, e.g. {"success": false, "errorMessage": "HTTP 400 - "}.
        throw new KapError(`disclosure list ${from}..${to}: not a list: ${JSON.stringify(answer).slice(0, 200)}`, null);
      }
      list = answer.map(parseDisclosure);
      if (daysBetween(to, today) > 0) options.cache?.set(key, list);
    }
    pages.push(list);
  }
  // Newest window first, so the whole list stays newest first.
  const out: Disclosure[] = [];
  for (const page of pages.reverse()) {
    for (const d of page) {
      if (seen.has(d.disclosure_id)) continue;
      seen.add(d.disclosure_id);
      out.push(d);
    }
  }
  return out;
}

/** The statements of one report period: title `Finansal Rapor` with that year and quarter. */
export const financialReports = (list: readonly Disclosure[], year: number, quarter: number) =>
  list.filter((d) => d.title === "Finansal Rapor" && d.year === year && d.quarter === quarter);
