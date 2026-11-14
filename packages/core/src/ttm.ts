/**
 * Trailing-twelve-month (TTM) flows (#93, decision 0014). Flows are never multiplied (6M × 2, 3M × 4).
 *
 *   TTM = current year to date
 *       + previous full year × CPI(current period end) / CPI(previous year end)
 *       − previous year to date
 *
 * The previous year to date is the restated comparative column of the current report, already in current prices.
 * The previous full year comes from the previous year-end report, in that year end's prices, so it is brought to
 * current prices with the CPI factor (#47). In a year-end report the TTM is the reported full year.
 *
 * Amounts are whole TL (`bigint`). The adjusted full year is rounded to whole TL, half away from zero; the factor
 * and the unrounded product are kept with the result so the step can be shown.
 */
import { type CpiSeries, cpiFactor, type Fraction } from "./cpi.ts";
import { type IsoDate, isoDate, nextDay, previousDay } from "./dates.ts";
import { collect, type Input, notComputable, ok, type Result } from "./result.ts";

export interface TtmInputs {
  /** Glossary code of the flow, used in reasons, e.g. `ebitda_a`. */
  name: string;
  /** Year to date in the current report. */
  current: Input<bigint>;
  /** The current report's period: fiscal year start to period end. */
  period: { start: IsoDate; end: IsoDate };
  /** The same months a year earlier: the restated comparative column of the current report. */
  priorYearToDate: Input<bigint>;
  /** The full previous fiscal year, from the previous year-end report. */
  priorFullYear: Input<bigint>;
  /** Period end of the previous year-end report; null if that report is not available. */
  priorFullYearEnd: IsoDate | null;
  cpi: CpiSeries;
}

export interface Ttm {
  value: bigint;
  /** True when the current report covers a full fiscal year, so the TTM is the reported value. */
  from_full_year_report: boolean;
  /** CPI(current period end) / CPI(previous year end); null for a full-year report. */
  cpi_factor: Fraction | null;
  /** The previous full year in current prices, rounded to whole TL; null for a full-year report. */
  prior_full_year_adjusted: bigint | null;
}

/** True when `start`..`end` is exactly one year (e.g. 2025-01-01..2025-12-31, or 2025-07-01..2026-06-30). */
export function isFullYear(start: IsoDate, end: IsoDate): boolean {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const yearLater = isoDate(y + 1, m, d);
  return yearLater !== null && nextDay(end) === yearLater;
}

/** amount × factor, rounded to a whole number half away from zero. */
export function applyFactor(amount: bigint, factor: Fraction): bigint {
  const num = amount * factor.numerator;
  const den = factor.denominator;
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return negative ? -q : q;
}

/** The TTM value of a flow, or "not computable" naming the missing report, value or CPI month. */
export function ttmFlow(i: TtmInputs): Result<Ttm> {
  if (isFullYear(i.period.start, i.period.end)) {
    const c = collect({ [i.name]: i.current } as Record<string, Input<bigint>>);
    if (!("values" in c)) return c;
    return ok({
      value: c.values[i.name] as bigint,
      from_full_year_report: true,
      cpi_factor: null,
      prior_full_year_adjusted: null,
    });
  }

  const priorYearToDate = `${i.name}:prior_year_to_date`;
  const priorFullYear = `${i.name}:prior_full_year`;
  const c = collect({
    [i.name]: i.current,
    [priorYearToDate]: i.priorYearToDate,
    [priorFullYear]: i.priorFullYearEnd === null ? null : i.priorFullYear,
  } as Record<string, Input<bigint>>);
  if (!("values" in c)) {
    return notComputable(
      c.reason.code,
      `Son 12 ay hesaplanamaz: ${i.priorFullYearEnd === null ? "önceki yıl sonu raporu yok veya " : ""}gerekli değerler eksik.`,
      c.reason.needs,
    );
  }

  const expectedEnd = previousDay(i.period.start);
  if (i.priorFullYearEnd !== expectedEnd) {
    return notComputable(
      "period_mismatch",
      `Son 12 ay hesaplanamaz: önceki yıl sonu ${expectedEnd} olmalı, rapor ${i.priorFullYearEnd} tarihli.`,
      [priorFullYear],
    );
  }

  const f = cpiFactor(i.cpi, i.period.end, i.priorFullYearEnd);
  if (f.status !== "ok") return { status: "not_computable", reason: f.reason };

  const adjusted = applyFactor(c.values[priorFullYear] as bigint, f.factor);
  return ok({
    value: (c.values[i.name] as bigint) + adjusted - (c.values[priorYearToDate] as bigint),
    from_full_year_report: false,
    cpi_factor: f.factor,
    prior_full_year_adjusted: adjusted,
  });
}
