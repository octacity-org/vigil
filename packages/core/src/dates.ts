/** Calendar dates as ISO strings (`2026-06-30`), with the validation Python's `datetime.date` applies. */

export type IsoDate = string;

/** `YYYY-MM-DD` for a valid date (year 1-9999), otherwise null. */
export function isoDate(year: number, month: number, day: number): IsoDate | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toUtc(d: IsoDate): number {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(2000, m - 1, day));
  date.setUTCFullYear(y);
  return date.getTime();
}

/** Whole days from `start` to `end`. */
export function daysBetween(start: IsoDate, end: IsoDate): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86_400_000);
}

/** The day after `d`. */
export function nextDay(d: IsoDate): IsoDate {
  const date = new Date(toUtc(d) + 86_400_000);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) as IsoDate;
}
