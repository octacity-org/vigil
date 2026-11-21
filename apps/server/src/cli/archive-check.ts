/**
 * Check a downloaded quarter against KAP's disclosure list (#43).
 *
 *   bun run archive-check 2026 2                 # data/raw/2026_2
 *   bun run archive-check 2026 2 data/raw --list # one line per gap
 *
 * Asks KAP for the period's financial-report disclosures (as `bun run disclosures`), reads the quarter's folder from
 * `bun run download`, and prints how many reports are matched, missing (with the reason), not listed, and broken.
 * Exits 1 if KAP cannot be read or the folder is missing, 2 for wrong arguments.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isoDate, nextDay } from "@vigil/core";
import { checkArchive } from "../archive-check.ts";
import { parseDirectory } from "../db.ts";
import { financialReports, istanbulToday, listDisclosures } from "../disclosures.ts";

const args = process.argv.slice(2);
const list = args.includes("--list");
const [y, q, rawArg, ...extra] = args.filter((a) => a !== "--list");
const year = Number(y);
const quarter = Number(q);
if (extra.length > 0 || !Number.isInteger(year) || year < 2009 || ![1, 2, 3, 4].includes(quarter)) {
  console.error("usage: bun run archive-check <year> <quarter> [raw_dir=data/raw] [--list]");
  process.exit(2);
}
const dir = join(rawArg ?? join("data", "raw"), `${year}_${quarter}`);
if (!existsSync(dir)) {
  console.error(`${dir} does not exist; download the quarter first (bun run download ${year} ${quarter})`);
  process.exit(1);
}
const quarterEnd = isoDate(year, quarter * 3, [31, 30, 30, 31][quarter - 1] as number) as string;
const from = nextDay(quarterEnd);
const today = istanbulToday(new Date());
let to = from;
for (let i = 1; i < 270 && to < today; i++) to = nextDay(to);

try {
  const listed = financialReports(await listDisclosures({ from, to, classes: ["FR"] }), year, quarter);
  const [, report] = parseDirectory(dir);
  const c = checkArchive(year, quarter, listed, readdirSync(dir), report.files);
  const by = (r: string) => c.missing.filter((m) => m.reason === r).length;
  const gaps = c.missing.filter((m) => m.reason === "not_in_archive");
  const kinds = ["company", "finance", "bank", "broker", "portfolio_manager", "fund"]
    .map((k) => `${k} ${gaps.filter((m) => m.kind === k).length}`)
    .join(", ");
  console.log(
    `${year}/${quarter}: ${c.listed} listed (${from} to ${to}), ${c.files} files, ${c.matched} matched; ` +
      `missing ${c.missing.length} (corrected ${by("corrected")}, not in archive ${by("not_in_archive")}: ${kinds}); ` +
      `not listed ${c.not_listed.length}; broken ${c.broken.length}`,
  );
  if (list) {
    for (const m of c.missing) {
      console.log(
        `missing ${m.reason} ${m.kind} ${m.disclosure_id} ${m.stock_codes.join(",") || "-"} ${m.company_title}`,
      );
    }
    for (const n of c.not_listed) console.log(`not_listed ${n.disclosure_id} ${n.file_name}`);
    for (const b of c.broken) console.log(`broken ${b.status} ${b.file_name}: ${b.error}`);
  }
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
