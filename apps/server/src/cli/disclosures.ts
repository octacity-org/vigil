/**
 * List a report period's financial reports from KAP's disclosure list (#163).
 *
 *   bun run disclosures 2026 2
 *
 * Asks for financial-report disclosures (class `FR`) from the first day after the quarter to today, at most 270 days,
 * and prints how many `Finansal Rapor` disclosures there are for the period, how many were corrected later and how
 * many are corrections. `--list` prints one line per report. Exits 1 if KAP cannot be read, 2 for wrong arguments.
 */
import { isoDate, nextDay } from "@vigil/core";
import { financialReports, istanbulToday, listDisclosures } from "../disclosures.ts";

const args = process.argv.slice(2);
const list = args.includes("--list");
const [y, q, ...extra] = args.filter((a) => a !== "--list");
const year = Number(y);
const quarter = Number(q);
if (extra.length > 0 || !Number.isInteger(year) || year < 2009 || ![1, 2, 3, 4].includes(quarter)) {
  console.error("usage: bun run disclosures <year> <quarter> [--list]");
  process.exit(2);
}
const quarterEnd = isoDate(year, quarter * 3, [31, 30, 30, 31][quarter - 1] as number) as string;
const from = nextDay(quarterEnd);
const today = istanbulToday(new Date());
let to = from;
for (let i = 1; i < 270 && to < today; i++) to = nextDay(to);
if (from > today) {
  console.error(`${year}/${quarter} has not ended yet`);
  process.exit(2);
}

try {
  const reports = financialReports(await listDisclosures({ from, to, classes: ["FR"] }), year, quarter);
  if (list) {
    for (const d of reports) {
      const changed = d.is_changed ? ` ${d.is_changed}` : "";
      console.log(`${d.disclosure_id} ${d.published_at} ${d.stock_codes.join(",")}${changed}`);
    }
  }
  const count = (c: string) => reports.filter((d) => d.is_changed === c).length;
  console.log(
    `${year}/${quarter}: ${reports.length} financial reports published ${from} to ${to}; ` +
      `${count("DUZELTILEN")} corrected later, ${count("DUZENLENEN")} corrections`,
  );
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
