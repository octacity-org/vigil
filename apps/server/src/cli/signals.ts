/**
 * Prototype findings report for a quarter (S1-S3, docs/VIGIL.md §9).
 *
 *   bun run signals data/raw/2026_2
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
import { kapFiles } from "../db.ts";

const rawDir = process.argv[2] ?? join("data", "raw", "2026_2");
const files = kapFiles(rawDir);
let realSector = 0;
const excluded = new Map<string, number>();
const s1: SignalObject[] = [];
const s2: SignalObject[] = [];
const s3: SignalObject[] = [];

for (const path of files) {
  const pf = parseKapXls(readFileSync(path), basename(path));
  const [ok, reason] = isRealSectorFiling(pf);
  if (ok) realSector += 1;
  else excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  const a = detectGrossMarginDeviation(pf);
  if (a) s1.push(a);
  const b = detectCashProfitQualityDivergence(pf);
  if (b) s2.push(b);
  const c = detectRestatementTripwire(pf);
  if (c) s3.push(c);
}
for (const list of [s1, s2, s3]) list.sort((x, y) => y.severity_rank_score - x.severity_rank_score);

const pct = (v: unknown) => `${(Number(v) * 100).toFixed(2).padStart(6)}%`;
const millions = (v: unknown, width: number) => (Number(v) / 1e6).toFixed(1).padStart(width);

console.log(`Total files: ${files.length} | Real-sector filings: ${realSector}`);
console.log("Excluded breakdown:", Object.fromEntries(excluded));

console.log(`\n=== S1: GROSS MARGIN YoY DEVIATION (|delta| >= 1000 bps) -> ${s1.length} companies ===`);
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
