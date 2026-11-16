/**
 * Prototype findings report for a quarter (S1-S3, docs/VIGIL.md §9).
 *
 *   bun run signals data/raw/2026_2
 *   bun run signals data/raw/2026_2 --db data/vigil.duckdb   # also store the findings (#185)
 *
 * Thresholds come from the configuration file (`config/vigil.json`, or `VIGIL_CONFIG`; #69); an invalid file exits 2.
 * With `--db`, the findings of every file in the folder are stored under its `version`: a rerun replaces
 * them and never adds duplicates; a finding no longer found is removed. Exits 1 if the database cannot be written.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  isRealSectorFiling,
  parseKapXls,
  type SignalObject,
} from "@vigil/core";
import { loadConfig } from "../config.ts";
import { close, connect, kapFiles } from "../db.ts";
import { writeFindings } from "../findings-store.ts";

const argv = process.argv.slice(2);
const dbAt = argv.indexOf("--db");
const dbPath = dbAt === -1 ? null : argv[dbAt + 1];
if (dbAt !== -1 && (dbPath == null || dbPath.startsWith("--"))) {
  console.error("Usage: bun run signals [raw_dir] [--db <path>]");
  process.exit(2);
}
const positional = argv.filter((_, i) => i !== dbAt && i !== dbAt + 1);
const rawDir = positional[0] ?? join("data", "raw", "2026_2");
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(2);
}
const files = kapFiles(rawDir);
let realSector = 0;
const excluded = new Map<string, number>();
const s1: SignalObject[] = [];
const s2: SignalObject[] = [];
const s3: SignalObject[] = [];

const disclosures: number[] = [];
for (const path of files) {
  const pf = parseKapXls(readFileSync(path), basename(path));
  disclosures.push(pf.disclosure_id);
  const [ok, reason] = isRealSectorFiling(pf, config);
  if (ok) realSector += 1;
  else excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  const a = detectGrossMarginDeviation(pf, config);
  if (a) s1.push(a);
  const b = detectCashProfitQualityDivergence(pf, config);
  if (b) s2.push(b);
  const c = detectRestatementTripwire(pf, config);
  if (c) s3.push(c);
}
for (const list of [s1, s2, s3]) list.sort((x, y) => y.severity_rank_score - x.severity_rank_score);

const pct = (v: unknown) => `${(Number(v) * 100).toFixed(2).padStart(6)}%`;
const millions = (v: unknown, width: number) => (Number(v) / 1e6).toFixed(1).padStart(width);

console.log(`Config: ${config.version}`);
console.log(`Total files: ${files.length} | Real-sector filings: ${realSector}`);
console.log("Excluded breakdown:", Object.fromEntries(excluded));

console.log(
  `\n=== S1: GROSS MARGIN YoY DEVIATION (|delta| >= ${config.s1_gross_margin.x_min_abs_delta_bps} bps) -> ${s1.length} companies ===`,
);
for (const item of s1.slice(0, 10)) {
  const m = item.summary_metrics;
  const delta = Number(m.delta_bps);
  console.log(
    `  ${item.company_code.padEnd(6)} (#${item.disclosure_id}) | prior: ${pct(m.prior_year_q_standalone_restated_margin)} -> ` +
      `current: ${pct(m.current_q_standalone_margin)} | Delta: ${(delta > 0 ? "+" : "") + delta} bps | ` +
      `Revenue: ${millions(m.current_q_revenue_tl, 9)}M TL`,
  );
}

console.log(`\n=== S2: CASH / PROFIT QUALITY DIVERGENCE -> ${s2.length} companies ===`);
for (const item of s2.slice(0, 10)) {
  const m = item.summary_metrics;
  console.log(
    `  ${item.company_code.padEnd(6)} (#${item.disclosure_id}) | NetProfit: ${millions(m.net_profit_ytd_tl, 8)}M | ` +
      `OpCF: ${millions(m.operating_cash_flow_ytd_tl, 9)}M | TMS29 MonPos: ${millions(m.tms29_net_monetary_position_ytd_tl, 8)}M | ` +
      `ExMonProfit: ${millions(m.profit_excluding_monetary_gain_tl, 9)}M | MonDriven: ${m.profit_driven_by_non_cash_monetary_gain}`,
  );
}

console.log(`\n=== S3: 3-COLUMN BALANCE SHEET RESTATEMENT -> ${s3.length} companies ===`);
for (const item of s3) {
  const m = item.summary_metrics;
  console.log(
    `  ${item.company_code.padEnd(6)} (#${item.disclosure_id}) | Restated BS rows: ${String(m.restated_balance_sheet_line_count).padStart(3)} | ` +
      `Col-6 header: ${m.third_column_period_label}`,
  );
}

if (dbPath) {
  const db = await connect(dbPath);
  try {
    const w = await writeFindings(db, disclosures, [...s1, ...s2, ...s3], { configVersion: config.version });
    console.log(`
Findings in ${dbPath}: ${w.added} new, ${w.kept} found again, ${w.removed} no longer found`);
  } catch (e) {
    console.error(`${(e as Error).name}: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    close(db);
  }
}
