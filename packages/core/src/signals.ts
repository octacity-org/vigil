/**
 * Rule-based findings (prototype, docs/VIGIL.md §9). Code names S1-S3; user-facing text calls them findings
 * ("bulgu"), never signals (docs/legal.md). Thresholds are prototype values pending the Phase 2 decisions.
 */
import type { ParsedFiling, ParsedFinancialFact } from "./parser.ts";
import { pyRound } from "./text.ts";

/** Brokerages, investment holdings and similar issuers that file the general template (#37 tracks replacing this). */
export const KNOWN_NON_REAL_SECTOR_TICKERS: ReadonlySet<string> = new Set([
  "A1CAP",
  "AKM",
  "AKYHO",
  "ATA",
  "AVHOL",
  "BLS",
  "BRYAT",
  "GEDIK",
  "GLBMD",
  "GLRYH",
  "GOZDE",
  "GRM",
  "GRTHO",
  "GSDHO",
  "HEDEF",
  "HUBVC",
  "IHLAS",
  "IHLGM",
  "INFO",
  "INVEO",
  "ISGSY",
  "ISMEN",
  "KLRHO",
  "MEKMD",
  "MZHLD",
  "NTHOL",
  "OMD",
  "OSMEN",
  "PRDGS",
  "RALYH",
  "TERA",
  "UNLU",
  "VERTU",
  "YKR",
]);

export interface EvidenceItem {
  metric: string;
  label_tr: string;
  row_id: string;
  disclosure_id: number;
  column_class: string;
  period_label: string;
  raw_value: bigint;
  scale_unit: string;
  normalized_value_tl: bigint;
}

export interface SignalObject {
  signal_id: string;
  company_code: string;
  raw_ticker_group: string;
  period: string;
  disclosure_id: number;
  signal_type: "GROSS_MARGIN_DEVIATION" | "CASH_PROFIT_QUALITY_DIVERGENCE" | "RETROSPECTIVE_RESTATEMENT_TRIPWIRE";
  neutral_title: string;
  severity_rank_score: number;
  summary_metrics: Record<string, number | bigint | boolean | string>;
  evidence_chain: EvidenceItem[];
  formula: string;
  llm_constraints: { allow_price_commentary: boolean; allow_external_causal_claims: boolean };
}

const LLM_CONSTRAINTS = { allow_price_commentary: false, allow_external_causal_claims: false } as const;
const INCOME_ROLES = ["310003", "310000", "310002"] as const;

/** Facts indexed by `${role_code}|${row number}|${column_class}`. */
function indexFacts(filing: ParsedFiling): Map<string, ParsedFinancialFact> {
  const out = new Map<string, ParsedFinancialFact>();
  for (const f of filing.facts) out.set(`${f.role_code}|${f.row_id.split("-").pop()}|${f.column_class}`, f);
  return out;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Whether a filing comes from a real-sector (industrial, commercial, service) company rather than a financial
 * company, real estate investment trust or holding.
 */
export function isRealSectorFiling(filing: ParsedFiling): [boolean, string] {
  if (filing.template_family !== "general") return [false, `template_family=${filing.template_family}`];
  if (KNOWN_NON_REAL_SECTOR_TICKERS.has(filing.company_code))
    return [false, "known_financial_or_investment_holding_ticker"];
  if (filing.raw_ticker_group.includes("-") && filing.raw_ticker_group !== "KRDMA-KRDMB-KRDMD") {
    return [false, `multi_ticker_financial_issuer=${filing.raw_ticker_group}`];
  }
  if (filing.company_code.endsWith("GYO") || filing.company_code.endsWith("GY")) return [false, "gyo_ticker_suffix"];

  // Financial-sector revenue or cost above 5% of commercial revenue.
  const idx = indexFacts(filing);
  for (const role of INCOME_ROLES) {
    const rev = idx.get(`${role}|3|col-order-class-4`);
    const finRev = idx.get(`${role}|6|col-order-class-4`);
    const finCost = idx.get(`${role}|17|col-order-class-4`);
    // As in the original implementation: the threshold 0.05 * revenue is a double; values stay below 2^53.
    const revVal = rev ? Number(abs(rev.normalized_value_tl)) : 0;
    const material = (f: ParsedFinancialFact) => revVal === 0 || Number(abs(f.normalized_value_tl)) > 0.05 * revVal;
    if (finRev && abs(finRev.normalized_value_tl) > 0n && material(finRev)) {
      return [false, "material_financial_sector_revenue_row_6"];
    }
    if (finCost && abs(finCost.normalized_value_tl) > 0n && material(finCost)) {
      return [false, "material_financial_sector_cost_row_17"];
    }
  }
  return [true, "real_sector"];
}

function evidence(metric: string, f: ParsedFinancialFact): EvidenceItem {
  return {
    metric,
    label_tr: f.label_tr,
    row_id: f.row_id,
    disclosure_id: f.disclosure_id,
    column_class: f.column_class,
    period_label: f.period_label,
    raw_value: f.raw_value,
    scale_unit: f.scale_unit,
    normalized_value_tl: f.normalized_value_tl,
  };
}

/**
 * S1: 3-month commercial gross margin (row 5 / row 3) against the same quarter of the prior year, restated
 * (col-order-class-6 vs col-order-class-7).
 */
export function detectGrossMarginDeviation(
  filing: ParsedFiling,
  minRevenueTl = 100_000_000n,
  minAbsDeltaBps = 1_000,
): SignalObject | null {
  if (!isRealSectorFiling(filing)[0]) return null;
  const idx = indexFacts(filing);
  for (const role of INCOME_ROLES) {
    const get = (row: string, col: string) => idx.get(`${role}|${row}|${col}`);
    const revC = get("3", "col-order-class-6");
    const revP = get("3", "col-order-class-7");
    const cogsC = get("4", "col-order-class-6");
    const cogsP = get("4", "col-order-class-7");
    const gpC = get("5", "col-order-class-6");
    const gpP = get("5", "col-order-class-7");
    if (!(revC && revP && cogsC && cogsP && gpC && gpP)) continue;
    if (cogsC.normalized_value_tl === 0n || cogsP.normalized_value_tl === 0n) continue;
    if (revC.normalized_value_tl < minRevenueTl || revP.normalized_value_tl < minRevenueTl) continue;

    const marginC = Number(gpC.normalized_value_tl) / Number(revC.normalized_value_tl);
    const marginP = Number(gpP.normalized_value_tl) / Number(revP.normalized_value_tl);
    if (!(marginC >= -1 && marginC <= 1 && marginP >= -1 && marginP <= 1)) continue;

    const deltaBps = pyRound((marginC - marginP) * 10_000);
    if (Math.abs(deltaBps) < minAbsDeltaBps) return null;

    return {
      signal_id: `sig_${filing.year}_${filing.quarter}_${filing.company_code}_gross_margin_deviation`,
      company_code: filing.company_code,
      raw_ticker_group: filing.raw_ticker_group,
      period: `${filing.year}-Q${filing.quarter}`,
      disclosure_id: filing.disclosure_id,
      signal_type: "GROSS_MARGIN_DEVIATION",
      neutral_title: "Ticari Brüt Marj YoY Solo Çeyrek Sapması",
      severity_rank_score: pyRound(Math.abs(deltaBps) / 1000, 2),
      summary_metrics: {
        current_q_standalone_margin: pyRound(marginC, 6),
        prior_year_q_standalone_restated_margin: pyRound(marginP, 6),
        delta_bps: deltaBps,
        current_q_revenue_tl: revC.normalized_value_tl,
        prior_year_q_revenue_restated_tl: revP.normalized_value_tl,
      },
      evidence_chain: [
        evidence("commercial_gross_profit_current_q", gpC),
        evidence("revenue_current_q", revC),
        evidence("commercial_gross_profit_prior_year_q_restated", gpP),
        evidence("revenue_prior_year_q_restated", revP),
      ],
      formula: "commercial_gross_profit (row-5) / revenue (row-3) [col-6 vs col-7]",
      llm_constraints: { ...LLM_CONSTRAINTS },
    };
  }
  return null;
}

/**
 * S2: year-to-date net profit at least 100 million TL while operating cash flow is at most -100 million TL, with the
 * IAS 29 net monetary position (row 52) shown separately.
 */
export function detectCashProfitQualityDivergence(
  filing: ParsedFiling,
  minNetProfitTl = 100_000_000n,
  maxOperatingCfTl = -100_000_000n,
): SignalObject | null {
  if (!isRealSectorFiling(filing)[0]) return null;
  const idx = indexFacts(filing);
  const incRole = INCOME_ROLES.find((r) => filing.role_codes.includes(r));
  const cfRole = (["520003", "510011"] as const).find((r) => filing.role_codes.includes(r));
  if (!incRole || !cfRole) return null;

  const netProfit = idx.get(`${incRole}|59|col-order-class-4`);
  const monetaryPos = idx.get(`${incRole}|52|col-order-class-4`);
  const opCf = idx.get(`${cfRole}|2|col-order-class-4`);
  if (!netProfit || !opCf) return null;

  const np = netProfit.normalized_value_tl;
  const ocf = opCf.normalized_value_tl;
  const mon = monetaryPos ? monetaryPos.normalized_value_tl : 0n;
  if (np < minNetProfitTl || ocf > maxOperatingCfTl) return null;

  const gap = np - ocf;
  const preMonetary = np - mon;
  const chain = [evidence("net_profit_ytd", netProfit), evidence("operating_cash_flow_ytd", opCf)];
  if (monetaryPos) chain.push(evidence("tms29_net_monetary_position_ytd", monetaryPos));

  return {
    signal_id: `sig_${filing.year}_${filing.quarter}_${filing.company_code}_cash_profit_divergence`,
    company_code: filing.company_code,
    raw_ticker_group: filing.raw_ticker_group,
    period: `${filing.year}-Q${filing.quarter}`,
    disclosure_id: filing.disclosure_id,
    signal_type: "CASH_PROFIT_QUALITY_DIVERGENCE",
    neutral_title: "Net Kâr ve İşletme Nakit Akışı Ayrışması (TMS 29 Parasal Pozisyon İzoleli)",
    severity_rank_score: pyRound(Number(gap) / 1_000_000_000, 2),
    summary_metrics: {
      net_profit_ytd_tl: np,
      operating_cash_flow_ytd_tl: ocf,
      profit_minus_ocf_gap_tl: gap,
      tms29_net_monetary_position_ytd_tl: mon,
      profit_excluding_monetary_gain_tl: preMonetary,
      profit_driven_by_non_cash_monetary_gain: mon > 0n && preMonetary <= 0n,
    },
    evidence_chain: chain,
    formula: "net_profit_ytd (row-59) - operating_cash_flow_ytd (row-2); isolated tms29_monetary_gain (row-52)",
    llm_constraints: { ...LLM_CONSTRAINTS },
  };
}

/** S3: a balance sheet with a filled third column (col-order-class-6, "Bir Önceki Dönem": restated comparatives). */
export function detectRestatementTripwire(filing: ParsedFiling): SignalObject | null {
  // Banks, participation banks and finance companies have six-column TP / YP / Toplam balance sheets.
  if (["banks", "par-banks", "finance"].includes(filing.template_family)) return null;
  const col6 = filing.facts.filter(
    (f) => f.statement_type === "BALANCE_SHEET" && f.column_class === "col-order-class-6" && f.raw_value !== 0n,
  );
  const first = col6[0];
  if (first === undefined) return null;

  const assetsC6 = col6.find((f) => f.row_id.endsWith("-row-129")) ?? first;
  const assetsC5 = filing.facts.find((f) => f.row_id === assetsC6.row_id && f.column_class === "col-order-class-5");
  const chain = [evidence("restated_opening_balance_sheet_col6", assetsC6)];
  if (assetsC5) chain.push(evidence("restated_prior_period_balance_sheet_col5", assetsC5));

  return {
    signal_id: `sig_${filing.year}_${filing.quarter}_${filing.company_code}_restatement_tripwire`,
    company_code: filing.company_code,
    raw_ticker_group: filing.raw_ticker_group,
    period: `${filing.year}-Q${filing.quarter}`,
    disclosure_id: filing.disclosure_id,
    signal_type: "RETROSPECTIVE_RESTATEMENT_TRIPWIRE",
    neutral_title: "Geçmiş Dönem Finansal Tablolarda Yeniden Düzenleme / Sınıflandırma (3. Bilanço Kolonu)",
    severity_rank_score: col6.length,
    summary_metrics: {
      restated_balance_sheet_line_count: col6.length,
      third_column_period_label: assetsC6.period_label,
    },
    evidence_chain: chain,
    formula: "count(BALANCE_SHEET.col-order-class-6 != 0) > 0 [TMS 1.40A]",
    llm_constraints: { ...LLM_CONSTRAINTS },
  };
}
