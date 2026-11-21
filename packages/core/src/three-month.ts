/**
 * Three-month values from cumulative figures (#48). Income statement and cash flow figures are reported for the
 * year to date; only the 1st to 3rd quarter reports have 3-month income statement columns, and the cash flow
 * statement never has them.
 *
 * In order of preference:
 * 1. **Reported:** the report's own 3-month column for the quarter, or the cumulative figure when the report covers
 *    three months (the 1st quarter).
 * 2. **Derived within the report:** the months before the last quarter are the year to date minus its own 3-month
 *    column; both are in the report's prices. In a 6-month report this is the 1st quarter (KATMR: 6M − Q2).
 * 3. **Derived across reports:** the last quarter is the year to date minus the previous report's year to date,
 *    brought to this report's prices with CPI (decision 0014; IAS 29 puts every report in its own period-end prices):
 *
 *        3 months = year to date − previous year to date × CPI(period end) / CPI(previous period end)
 *
 *    In a year-end report: Q4 = 12M − 9M × CPI ratio (`docs/VIGIL.md`, TMS 29).
 *
 * Checked on the archive: Q2 and Q3 2024 revenue derived this way from the previous report matched the 6- and 9-month
 * reports' own 3-month columns within 1% for 400 of 488 and 421 of 503 general-template companies (KATMR to the TL).
 * The rest are mostly companies whose functional currency is not TL (EREGL, ENKAI, BRSAN): they translate each period
 * at its own exchange rates instead of restating with CPI, so a CPI-derived quarter is not their reported quarter.
 * That is why a reported 3-month column always wins and a derived value is always marked.
 *
 * Every derived value says so (`source`), with the CPI factor and the adjusted amount, so the step can be shown.
 * Amounts are whole TL (`bigint`); the adjusted amount is rounded half away from zero (`applyFactor`).
 */
import { type CpiSeries, cpiFactor, type Fraction } from "./cpi.ts";
import { type IsoDate, isoDate, nextDay } from "./dates.ts";
import { collect, type Input, notComputable, ok, type Result } from "./result.ts";
import { applyFactor } from "./ttm.ts";

export type ThreeMonthSource = "reported" | "derived_within_report" | "derived_with_cpi";

export interface FlowPeriod {
  start: IsoDate;
  end: IsoDate;
}

export interface ThreeMonth {
  value: bigint;
  /** The months the value covers. */
  period: FlowPeriod;
  source: ThreeMonthSource;
  /** True unless the report gave the value. */
  derived: boolean;
  /** CPI(period end) / CPI(previous period end); only for `derived_with_cpi`. */
  cpi_factor: Fraction | null;
  /** The previous year to date in this report's prices, rounded to whole TL; only for `derived_with_cpi`. */
  previous_adjusted: bigint | null;
}

/** The last day of the month `months` months before the month of `end` (a month end). */
export function monthEndBefore(end: IsoDate, months: number): IsoDate {
  const [y, m] = end.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  for (let day = 31; day >= 28; day--) {
    const d = isoDate(year, month, day);
    if (d !== null) return d;
  }
  throw new RangeError(`no month end before ${end}`);
}

/** Whole months from `start` to `end` (a period from a month start to a month end), or null. */
export function monthsCovered(period: FlowPeriod): number | null {
  const [sy, sm, sd] = period.start.split("-").map(Number) as [number, number, number];
  const [ey, em] = period.end.split("-").map(Number) as [number, number];
  if (sd !== 1 || nextDay(period.end).slice(8) !== "01") return null;
  return (ey - sy) * 12 + (em - sm) + 1;
}

export interface ThreeMonthInputs {
  /** Glossary code of the flow, used in reasons, e.g. `revenue`. */
  name: string;
  /** The report's cumulative period: fiscal year start to period end. */
  period: FlowPeriod;
  /** Year to date in this report. */
  current: Input<bigint>;
  /**
   * The report's own 3-month column for the last quarter. `undefined` when the report has no such column (a year-end
   * report, or the cash flow statement); `null` or not reported when the column exists but the cell is empty.
   */
  reported?: Input<bigint>;
  /** The previous report's year to date (cumulative to `previousEnd`), in that report's prices. */
  previous?: Input<bigint>;
  /** Period end of the previous report; null or undefined when it is not available. */
  previousEnd?: IsoDate | null;
  /** Needed only to derive across reports. */
  cpi?: CpiSeries;
}

/** The last quarter (3 months to the period end) of a cumulative flow. */
export function threeMonthFlow(i: ThreeMonthInputs): Result<ThreeMonth> {
  const months = monthsCovered(i.period);
  if (months === null || months < 3 || months % 3 !== 0) {
    return notComputable(
      "period_mismatch",
      `3 aylık değer çeyrek sonlarında hesaplanır; ${i.period.start}–${i.period.end} dönemi uygun değil.`,
      [i.name],
    );
  }
  const quarter: FlowPeriod = { start: nextDay(monthEndBefore(i.period.end, 3)), end: i.period.end };
  const reported = (value: Input<bigint>, name: string): Result<ThreeMonth> => {
    const c = collect({ [name]: value } as Record<string, Input<bigint>>);
    if (!("values" in c)) return c;
    return ok({
      value: c.values[name] as bigint,
      period: quarter,
      source: "reported",
      derived: false,
      cpi_factor: null,
      previous_adjusted: null,
    });
  };
  if (months === 3) return reported(i.current, i.name);
  if (i.reported !== undefined) return reported(i.reported, `${i.name}:three_month`);

  const previousName = `${i.name}:previous_year_to_date`;
  const expectedEnd = monthEndBefore(i.period.end, 3);
  const c = collect({
    [i.name]: i.current,
    [previousName]: i.previousEnd == null ? null : i.previous,
  } as Record<string, Input<bigint>>);
  if (!("values" in c)) {
    return notComputable(
      c.reason.code,
      `3 aylık değer türetilemez: ${i.previousEnd == null ? `${expectedEnd} tarihli önceki rapor yok veya ` : ""}gerekli değerler eksik.`,
      c.reason.needs,
    );
  }
  if (i.previousEnd !== expectedEnd) {
    return notComputable(
      "period_mismatch",
      `3 aylık değer türetilemez: önceki rapor ${expectedEnd} tarihli olmalı, ${i.previousEnd} tarihli.`,
      [previousName],
    );
  }
  if (i.cpi === undefined) {
    return notComputable("missing_input", "3 aylık değer türetilemez: TÜFE serisi yok.", [
      `cpi:${i.period.end.slice(0, 7)}`,
      `cpi:${expectedEnd.slice(0, 7)}`,
    ]);
  }
  const f = cpiFactor(i.cpi, i.period.end, expectedEnd);
  if (f.status !== "ok") return { status: "not_computable", reason: f.reason };
  const adjusted = applyFactor(c.values[previousName] as bigint, f.factor);
  return ok({
    value: (c.values[i.name] as bigint) - adjusted,
    period: quarter,
    source: "derived_with_cpi",
    derived: true,
    cpi_factor: f.factor,
    previous_adjusted: adjusted,
  });
}

/**
 * The months before the last quarter, from the same report: year to date − its 3-month column. In a 6-month report
 * this is the 1st quarter, in a 9-month report the first half. Both are in the report's prices, so no CPI is needed.
 */
export function earlierMonthsWithinReport(i: {
  name: string;
  period: FlowPeriod;
  current: Input<bigint>;
  threeMonth: Input<bigint>;
}): Result<ThreeMonth> {
  const months = monthsCovered(i.period);
  if (months === null || months < 6 || months % 3 !== 0) {
    return notComputable(
      "period_mismatch",
      `Önceki aylar yalnızca 6, 9 veya 12 aylık bir rapordan türetilir; ${i.period.start}–${i.period.end} uygun değil.`,
      [i.name],
    );
  }
  const threeMonthName = `${i.name}:three_month`;
  const c = collect({ [i.name]: i.current, [threeMonthName]: i.threeMonth } as Record<string, Input<bigint>>);
  if (!("values" in c)) return c;
  return ok({
    value: (c.values[i.name] as bigint) - (c.values[threeMonthName] as bigint),
    period: { start: i.period.start, end: monthEndBefore(i.period.end, 3) },
    source: "derived_within_report",
    derived: true,
    cpi_factor: null,
    previous_adjusted: null,
  });
}
