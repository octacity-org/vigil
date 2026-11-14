/**
 * CPI (TÜFE) series and the price factor between two period ends (#47; decisions 0014 and 0018).
 *
 * Under IAS 29 (TMS 29) every report is in the prices of its own period end, so an amount from an older report is
 * compared with a newer one only after multiplying it by CPI(newer period end) / CPI(older period end). A period
 * that ends on the last day of a month uses that month's index, as in the KGK TMS 29 guidance (factor = index at the
 * reporting date / index at the transaction date).
 *
 * TÜİK rebased the CPI to 2025=100 from January 2026 and kept the headline monthly changes, so a factor differs
 * between the two bases only by the rounding of the published values. A series holds one base; `parseCpiCsv` refuses
 * a file that mixes bases.
 *
 * No approximations: a month that is not in the series, or a date that is not a month end, gives "not computable"
 * with the reason. The factor is an exact fraction of bigints and is rounded only for display.
 */
import { type IsoDate, isoDate } from "./dates.ts";
import type { Reason } from "./result.ts";

/** A calendar month, `YYYY-MM`. */
export type YearMonth = string;

/** An exact rational number. The denominator is positive. */
export interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

/** One month of the series, as published. */
export interface CpiValue {
  month: YearMonth;
  /** The index as published, e.g. `129.99`. */
  index: string;
  /** Base year of the index, e.g. `2025=100`. */
  base: string;
  /** Publisher, e.g. `TÜİK`. */
  source: string;
  /** The publisher's id of the series or dataset. */
  series_code: string;
  /** When the value was retrieved, ISO 8601 in UTC (`2026-11-14T20:00:00Z`). */
  retrieved_at: string;
}

export interface CpiSeries {
  base: string;
  values: ReadonlyMap<YearMonth, CpiValue>;
}

/**
 * Why a factor cannot be computed: a `Reason` (#65) with one of two codes. `needs` lists the months, e.g.
 * `cpi:2026-06` (glossary code `cpi`, then the month).
 */
export interface CpiReason extends Reason {
  code: "missing_input" | "period_mismatch";
}

export type CpiFactor =
  | {
      status: "ok";
      /** CPI(to) / CPI(from), reduced. Multiply an amount in `from` prices by it to get `to` prices. */
      factor: Fraction;
      to: CpiValue;
      from: CpiValue;
    }
  | { status: "not_computable"; reason: CpiReason };

/**
 * Most decimals accepted in an index value (the DuckDB column is DECIMAL(18, 6), #188). TÜİK publishes the months
 * before 2026, rebased to 2025=100, with up to six decimals.
 */
export const CPI_MAX_DECIMALS = 6;

export const CPI_CSV_HEADER = "month,index,base,source,series_code,retrieved_at";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const INDEX_RE = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${CPI_MAX_DECIMALS}}))?$`);
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const abs = (n: bigint) => (n < 0n ? -n : n);

/** `2026-11-14T20:00:00Z` (optional milliseconds) for a real date and time; `2026-02-30T…` is refused. */
function isUtcTimestamp(s: string): boolean {
  if (!UTC_RE.test(s)) return false;
  const t = new Date(s);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 19) === s.slice(0, 19);
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function reduce(numerator: bigint, denominator: bigint): Fraction {
  if (denominator === 0n) throw new RangeError("denominator is zero");
  const sign = denominator < 0n ? -1n : 1n;
  const g = gcd(numerator, denominator) || 1n;
  return { numerator: (sign * numerator) / g, denominator: (sign * denominator) / g };
}

/** A published index value (`129.99`) as an exact fraction; null if it is not a positive decimal. */
export function parseIndex(text: string): Fraction | null {
  const m = INDEX_RE.exec(text);
  if (!m) return null;
  const decimals = m[2] ?? "";
  const units = BigInt(`${m[1]}${decimals}`);
  if (units === 0n) return null;
  return reduce(units, 10n ** BigInt(decimals.length));
}

/** The month a period end falls in, if the date is the last day of that month; otherwise null. */
export function monthEnding(periodEnd: IsoDate): YearMonth | null {
  const [y, m, d] = periodEnd.split("-").map(Number) as [number, number, number];
  if (isoDate(y, m, d) !== periodEnd) return null;
  if (isoDate(y, m, d + 1) !== null) return null;
  return periodEnd.slice(0, 7);
}

/**
 * CPI(month of `to`) / CPI(month of `from`): the factor that brings an amount in `from` prices to `to` prices.
 * Both dates must be the last day of a month (a period end); the series must have both months.
 */
export function cpiFactor(series: CpiSeries, to: IsoDate, from: IsoDate): CpiFactor {
  const notMonthEnd = [to, from].filter((d) => monthEnding(d) === null);
  if (notMonthEnd.length > 0) {
    return {
      status: "not_computable",
      reason: {
        code: "period_mismatch",
        message: `TÜFE oranı ay sonları arasında hesaplanır; ${notMonthEnd.join(", ")} bir ay sonu değil`,
        needs: [],
      },
    };
  }
  const months = [monthEnding(to), monthEnding(from)] as [YearMonth, YearMonth];
  const missing = [...new Set(months.filter((m) => !series.values.has(m)))];
  if (missing.length > 0) {
    return {
      status: "not_computable",
      reason: {
        code: "missing_input",
        message: `TÜFE serisinde ${missing.join(", ")} için değer yok (${series.base})`,
        needs: missing.map((m) => `cpi:${m}`),
      },
    };
  }
  const toValue = series.values.get(months[0]) as CpiValue;
  const fromValue = series.values.get(months[1]) as CpiValue;
  const a = parseIndex(toValue.index);
  const b = parseIndex(fromValue.index);
  if (a === null || b === null) {
    // parseCpiCsv refuses such values; this guards a series built by hand.
    throw new Error(`CPI index is not a positive number: ${a === null ? toValue.index : fromValue.index}`);
  }
  return {
    status: "ok",
    factor: reduce(a.numerator * b.denominator, a.denominator * b.numerator),
    to: toValue,
    from: fromValue,
  };
}

/** A fraction as a decimal string with `digits` decimals, rounded half away from zero. For display only. */
export function fractionToDecimal(f: Fraction, digits: number): string {
  if (!Number.isInteger(digits) || digits < 0) throw new RangeError(`digits must be a whole number: ${digits}`);
  const { numerator, denominator } = reduce(f.numerator, f.denominator);
  const scale = 10n ** BigInt(digits);
  const scaled = abs(numerator) * scale;
  let units = scaled / denominator;
  if ((scaled % denominator) * 2n >= denominator) units += 1n;
  const text = units.toString().padStart(digits + 1, "0");
  const sign = numerator < 0n && units !== 0n ? "-" : "";
  return digits === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * Read a CPI series file: the header `CPI_CSV_HEADER`, then one row per month with the month (`YYYY-MM`), the index
 * as published, its base (`2025=100`), the publisher, the series id and the retrieval time in UTC
 * (`2026-11-14T20:00:00Z`). Fields hold no commas or quotes.
 *
 * Anything unexpected raises an error that names the line: a bad header, month, index or timestamp, an empty field,
 * a month listed twice, more than one base, or no rows. Nothing is guessed.
 */
export function parseCpiCsv(text: string): CpiSeries {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== CPI_CSV_HEADER) throw new Error(`CPI file: expected header "${CPI_CSV_HEADER}", got "${lines[0]}"`);

  const values = new Map<YearMonth, CpiValue>();
  let base: string | null = null;
  for (const [i, line] of lines.entries()) {
    if (i === 0) continue;
    const where = `CPI file line ${i + 1}`;
    const fields = line.split(",");
    if (fields.length !== 6) throw new Error(`${where}: expected 6 fields, got ${fields.length}`);
    const [month, index, rowBase, source, seriesCode, retrievedAt] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (fields.some((f) => f.trim() === "" || f !== f.trim() || f.includes('"'))) {
      throw new Error(`${where}: empty field, surrounding spaces or quotes`);
    }
    if (!MONTH_RE.test(month)) throw new Error(`${where}: month "${month}" is not YYYY-MM`);
    if (parseIndex(index) === null) {
      throw new Error(`${where}: index "${index}" is not a positive number with at most ${CPI_MAX_DECIMALS} decimals`);
    }
    if (!isUtcTimestamp(retrievedAt)) {
      throw new Error(`${where}: retrieved_at "${retrievedAt}" is not an ISO 8601 UTC timestamp`);
    }
    if (base !== null && rowBase !== base) throw new Error(`${where}: base "${rowBase}" differs from "${base}"`);
    if (values.has(month)) throw new Error(`${where}: month ${month} is listed twice`);
    base = rowBase;
    values.set(month, { month, index, base: rowBase, source, series_code: seriesCode, retrieved_at: retrievedAt });
  }
  if (base === null) throw new Error("CPI file: no rows");
  return { base, values };
}

/** The series in the file format `parseCpiCsv` reads, oldest month first. */
export function formatCpiCsv(series: CpiSeries): string {
  const values = [...series.values.values()].sort((a, b) => a.month.localeCompare(b.month));
  const lines = values.map((v) => [v.month, v.index, v.base, v.source, v.series_code, v.retrieved_at].join(","));
  return `${[CPI_CSV_HEADER, ...lines].join("\n")}\n`;
}

/** TÜİK's dataset for the CPI general index and its change rates (veri portalı, bulk download). */
export const TUIK_CPI_DATASET = "DF_TUFE_SDMX_TT10";

const TUIK_COLUMNS = {
  area: "Coğrafi Kapsam",
  frequency: "Gözlem Sıklığı",
  level: "Sınıflama Düzeyi",
  measure: "Endeks-Değişim",
  baseYear: "Temel Dönem/Yıl",
  month: "Zaman",
  value: "Gözlem Değeri",
} as const;
const TUIK_INDEX = "Endeks";
const TUIK_MONTHLY_CHANGE = "Bir önceki aya göre değişim oranı (%)";

/**
 * Largest accepted gap, in percentage points, between a published monthly change and the one computed from the
 * index. Both are rounded: the change to two decimals (up to 0.005 points), and the 2026 index values to two
 * decimals too (up to about 0.009 points at an index of 110-140). A mix of base years moves the change by far more;
 * a small revision of one value can pass, and `updateCpiSeries` then lists it as revised.
 */
const CHAIN_TOLERANCE: Fraction = { numerator: 2n, denominator: 100n };

export interface TuikCpiImport {
  series: CpiSeries;
  /** Months whose change from the month before was checked against TÜİK's published monthly change. */
  checked_months: number;
  /** Largest gap found between the published and the computed monthly change, in points. */
  largest_gap: Fraction;
}

/** A TÜİK number with a decimal comma (`110,386963`, `-0,5`) as an exact fraction; null if it is not one. */
function tuikNumber(text: string): Fraction | null {
  const m = /^(-?)(\d+)(?:,(\d+))?$/.exec(text);
  if (!m) return null;
  const decimals = m[3] ?? "";
  const units = BigInt(`${m[2]}${decimals}`) * (m[1] === "-" ? -1n : 1n);
  return reduce(units, 10n ** BigInt(decimals.length));
}

function nextMonth(month: YearMonth): YearMonth {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${String(y + 1).padStart(4, "0")}-01` : `${month.slice(0, 5)}${String(m + 1).padStart(2, "0")}`;
}

/**
 * Read TÜİK's CSV export of `TUIK_CPI_DATASET` (semicolon separated, quoted, decimal comma) into a series: the
 * monthly general index for Türkiye, with the base year from `Temel Dönem/Yıl` (`2025` gives `2025=100`).
 *
 * The export must be complete and the index one unbroken chain: every month between the first and the last, one
 * base year, and for every month after the first a published monthly change that the index reproduces to within
 * `CHAIN_TOLERANCE`, and no monthly change without its index. A download cut inside these rows, a missing month or
 * a mix of base years raises an error; nothing is guessed. Months dropped at either end are caught by comparing
 * with the previous series (`bun run cpi:import`).
 */
export function parseTuikCpiCsv(text: string, retrievedAt: string): TuikCpiImport {
  if (!isUtcTimestamp(retrievedAt)) throw new Error(`retrieved_at "${retrievedAt}" is not an ISO 8601 UTC timestamp`);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const split = (line: string, where: string): string[] =>
    line.split(";").map((field) => {
      const m = /^"([^"]*)"$/.exec(field);
      if (!m) throw new Error(`${where}: field ${JSON.stringify(field)} is not a quoted value`);
      return m[1] as string;
    });
  const header = split(lines[0] ?? "", "TÜİK file header");
  const column = Object.fromEntries(
    Object.entries(TUIK_COLUMNS).map(([key, name]) => {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`TÜİK file: column "${name}" not found`);
      return [key, i];
    }),
  ) as Record<keyof typeof TUIK_COLUMNS, number>;

  const index = new Map<YearMonth, string>();
  const change = new Map<YearMonth, Fraction>();
  let baseYear: string | null = null;
  for (const [i, line] of lines.entries()) {
    if (i === 0) continue;
    const where = `TÜİK file line ${i + 1}`;
    const f = split(line, where);
    if (f.length !== header.length) throw new Error(`${where}: expected ${header.length} fields, got ${f.length}`);
    const at = (key: keyof typeof TUIK_COLUMNS) => f[column[key]] as string;
    if (at("area") !== "Türkiye" || at("frequency") !== "Aylık" || at("level") !== "TÜFE") continue;
    const month = at("month");
    if (!MONTH_RE.test(month)) throw new Error(`${where}: month "${month}" is not YYYY-MM`);
    if (at("measure") === TUIK_INDEX) {
      const value = at("value").replace(",", ".");
      if (parseIndex(value) === null) throw new Error(`${where}: index "${at("value")}" is not a positive number`);
      if (index.has(month)) throw new Error(`${where}: index for ${month} is listed twice`);
      if (baseYear !== null && at("baseYear") !== baseYear) {
        throw new Error(`${where}: base year ${at("baseYear")} differs from ${baseYear}`);
      }
      baseYear = at("baseYear");
      index.set(month, value);
    } else if (at("measure") === TUIK_MONTHLY_CHANGE) {
      const value = tuikNumber(at("value"));
      if (value === null) throw new Error(`${where}: monthly change "${at("value")}" is not a number`);
      if (change.has(month)) throw new Error(`${where}: monthly change for ${month} is listed twice`);
      change.set(month, value);
    }
  }
  if (baseYear === null || !/^\d{4}$/.test(baseYear)) throw new Error("TÜİK file: no index rows with a base year");

  const months = [...index.keys()].sort();
  const orphans = [...change.keys()].filter((m) => !index.has(m)).sort();
  if (orphans.length > 0) {
    throw new Error(`TÜİK file: monthly change without an index for ${orphans.join(", ")}; the file may be cut off`);
  }
  const first = months[0] as YearMonth;
  const last = months[months.length - 1] as YearMonth;
  let largestGap: Fraction = { numerator: 0n, denominator: 1n };
  let checked = 0;
  for (let prev = first, month = nextMonth(first); month <= last; prev = month, month = nextMonth(month)) {
    if (!index.has(month)) throw new Error(`TÜİK file: no index for ${month} (series runs ${first} to ${last})`);
    const published = change.get(month);
    if (published === undefined) throw new Error(`TÜİK file: no monthly change for ${month}; the file may be cut off`);
    const a = parseIndex(index.get(month) as string) as Fraction;
    const b = parseIndex(index.get(prev) as string) as Fraction;
    // (a / b - 1) * 100 - published, as one fraction.
    const computed = reduce(
      (a.numerator * b.denominator - a.denominator * b.numerator) * 100n,
      a.denominator * b.numerator,
    );
    const gap = reduce(
      abs(computed.numerator * published.denominator - published.numerator * computed.denominator),
      computed.denominator * published.denominator,
    );
    if (gap.numerator * CHAIN_TOLERANCE.denominator > CHAIN_TOLERANCE.numerator * gap.denominator) {
      throw new Error(
        `TÜİK file: the index changes by ${fractionToDecimal(computed, 4)}% from ${prev} to ${month}, ` +
          `but the published monthly change is ${fractionToDecimal(published, 2)}%; the series is not one chain`,
      );
    }
    if (gap.numerator * largestGap.denominator > largestGap.numerator * gap.denominator) largestGap = gap;
    checked += 1;
  }

  const base = `${baseYear}=100`;
  const values = new Map<YearMonth, CpiValue>(
    months.map((month) => [
      month,
      {
        month,
        index: index.get(month) as string,
        base,
        source: "TÜİK",
        series_code: TUIK_CPI_DATASET,
        retrieved_at: retrievedAt,
      },
    ]),
  );
  return { series: { base, values }, checked_months: checked, largest_gap: largestGap };
}

export interface CpiUpdate {
  /** The new series. A month whose index is unchanged keeps its earlier `retrieved_at`. */
  series: CpiSeries;
  /** Months in the new series that the previous one did not have. */
  added: YearMonth[];
  /** Months whose index differs from the previous series (all months when the base year changed). */
  revised: YearMonth[];
  /** Months of the previous series that the new one lacks. */
  missing: YearMonth[];
}

/**
 * Compare a newly imported series with the previous one. Unchanged months keep the time they were first retrieved,
 * so a monthly refresh adds one line instead of rewriting every line. The caller decides what to do with `missing`
 * (a new export should never drop a month).
 */
export function updateCpiSeries(previous: CpiSeries, next: CpiSeries): CpiUpdate {
  const sameBase = previous.base === next.base;
  const values = new Map<YearMonth, CpiValue>();
  const added: YearMonth[] = [];
  const revised: YearMonth[] = [];
  for (const [month, value] of [...next.values].sort(([a], [b]) => a.localeCompare(b))) {
    const before = previous.values.get(month);
    if (before === undefined) added.push(month);
    else if (!sameBase || before.index !== value.index) revised.push(month);
    const keep = sameBase && before !== undefined && before.index === value.index;
    values.set(month, keep ? { ...value, retrieved_at: before.retrieved_at } : value);
  }
  const missing = [...previous.values.keys()].filter((m) => !next.values.has(m)).sort();
  return { series: { base: next.base, values }, added, revised, missing };
}
