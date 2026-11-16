/**
 * Rule-based findings (prototype, docs/VIGIL.md §9). Code names S1-S3; user-facing text calls them findings
 * ("bulgu"), never signals (docs/legal.md). Thresholds are prototype values pending the Phase 2 decisions.
 */
import type { VigilConfig } from "./config.ts";
import type { ParsedFiling, ParsedFinancialFact } from "./parser.ts";
import { type Calculation, readValue } from "./provenance.ts";
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
  /** Every value the finding uses with its source, and the steps from them to the result (#72, `docs/API.md`). */
  calculation: Calculation;
  llm_constraints: { allow_price_commentary: boolean; allow_external_causal_claims: boolean };
}

/** A rule's definition: its methodology page and the configuration version it ran under (#69). */
function definition(id: string, config: VigilConfig): Calculation["definition"] {
  return { id, version: config.version, url: `/methodology/${id}` };
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
export function isRealSectorFiling(filing: ParsedFiling, config: VigilConfig): [boolean, string] {
  if (filing.template_family !== "general") return [false, `template_family=${filing.template_family}`];
  if (KNOWN_NON_REAL_SECTOR_TICKERS.has(filing.company_code))
    return [false, "known_financial_or_investment_holding_ticker"];
  if (filing.raw_ticker_group.includes("-") && filing.raw_ticker_group !== "KRDMA-KRDMB-KRDMD") {
    return [false, `multi_ticker_financial_issuer=${filing.raw_ticker_group}`];
  }
  if (filing.company_code.endsWith("GYO") || filing.company_code.endsWith("GY")) return [false, "gyo_ticker_suffix"];

  // Financial-sector revenue or cost above the configured share of commercial revenue.
  const maxShare = config.real_sector.max_financial_row_share_of_revenue;
  const idx = indexFacts(filing);
  for (const role of INCOME_ROLES) {
    const rev = idx.get(`${role}|3|col-order-class-4`);
    const finRev = idx.get(`${role}|6|col-order-class-4`);
    const finCost = idx.get(`${role}|17|col-order-class-4`);
    // As in the original implementation: the threshold share * revenue is a double; values stay below 2^53.
    const revVal = rev ? Number(abs(rev.normalized_value_tl)) : 0;
    const material = (f: ParsedFinancialFact) => revVal === 0 || Number(abs(f.normalized_value_tl)) > maxShare * revVal;
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
 * (col-order-class-6 vs col-order-class-7). Thresholds: X and the revenue floor from the configuration (#69).
 */
export function detectGrossMarginDeviation(filing: ParsedFiling, config: VigilConfig): SignalObject | null {
  if (!isRealSectorFiling(filing, config)[0]) return null;
  const { min_three_month_revenue_tl: minRevenueTl, x_min_abs_delta_bps: minAbsDeltaBps } = config.s1_gross_margin;
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
      calculation: {
        formula: "(gross_profit_q / revenue_q - gross_profit_q_prior / revenue_q_prior) * 10000",
        definition: definition("gross_margin_change", config),
        steps: [
          { id: "gross_profit_q", label: `Brüt kâr, 3 aylık, ${filing.year}`, value: readValue(filing, gpC) },
          { id: "revenue_q", label: `Hasılat, 3 aylık, ${filing.year}`, value: readValue(filing, revC) },
          {
            id: "gross_profit_q_prior",
            label: `Brüt kâr, 3 aylık, ${filing.year - 1} (yeniden düzenlenmiş)`,
            value: readValue(filing, gpP),
          },
          {
            id: "revenue_q_prior",
            label: `Hasılat, 3 aylık, ${filing.year - 1} (yeniden düzenlenmiş)`,
            value: readValue(filing, revP),
          },
          {
            id: "margin_q",
            label: `Brüt marj, ${filing.year} Ç${filing.quarter}`,
            formula: "gross_profit_q / revenue_q",
            result: pyRound(marginC, 6).toFixed(6),
          },
          {
            id: "margin_q_prior",
            label: `Brüt marj, ${filing.year - 1} Ç${filing.quarter}`,
            formula: "gross_profit_q_prior / revenue_q_prior",
            result: pyRound(marginP, 6).toFixed(6),
          },
          {
            id: "change_bps",
            label: "Değişim (baz puan)",
            formula: "(margin_q - margin_q_prior) * 10000",
            result: String(deltaBps),
          },
        ],
      },
      llm_constraints: { ...LLM_CONSTRAINTS },
    };
  }
  return null;
}

/**
 * S2: year-to-date net profit at least `min_net_profit_ytd_tl` while operating cash flow is at most
 * `max_operating_cash_flow_ytd_tl` (the configuration, #69), with the
 * IAS 29 net monetary position (row 52) shown separately.
 */
export function detectCashProfitQualityDivergence(filing: ParsedFiling, config: VigilConfig): SignalObject | null {
  if (!isRealSectorFiling(filing, config)[0]) return null;
  const { min_net_profit_ytd_tl: minNetProfitTl, max_operating_cash_flow_ytd_tl: maxOperatingCfTl } =
    config.s2_profit_cash;
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
  const steps: Calculation["steps"] = [
    { id: "net_profit_ytd", label: "Dönem kârı, yılbaşından itibaren", value: readValue(filing, netProfit) },
    {
      id: "operating_cash_flow_ytd",
      label: "İşletme faaliyetlerinden nakit akışı, yılbaşından itibaren",
      value: readValue(filing, opCf),
    },
    {
      id: "profit_minus_ocf",
      label: "Kâr ile işletme nakit akışı farkı",
      formula: "net_profit_ytd - operating_cash_flow_ytd",
      result: gap.toString(),
    },
  ];
  // The IAS 29 net monetary gain is not cash; a filing without the row shows no step for it.
  if (monetaryPos) {
    steps.push(
      {
        id: "net_monetary_position_ytd",
        label: "Net parasal pozisyon kazancı (TMS 29), yılbaşından itibaren",
        value: readValue(filing, monetaryPos),
      },
      {
        id: "profit_excluding_monetary_gain",
        label: "Parasal kazanç hariç dönem kârı",
        formula: "net_profit_ytd - net_monetary_position_ytd",
        result: preMonetary.toString(),
      },
    );
  }

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
    calculation: {
      formula: "net_profit_ytd - operating_cash_flow_ytd",
      definition: definition("profit_cash_divergence", config),
      steps,
    },
    llm_constraints: { ...LLM_CONSTRAINTS },
  };
}

/** S3: a balance sheet with a filled third column (col-order-class-6, "Bir Önceki Dönem": restated comparatives). */
export function detectRestatementTripwire(filing: ParsedFiling, config: VigilConfig): SignalObject | null {
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
    calculation: {
      formula: "count(restated balance sheet lines)",
      definition: definition("restated_comparatives", config),
      steps: [
        // Every line with a value in the third column is an input; the count is the size of the finding.
        ...col6.map((f) => ({
          id: `restated_${f.row_id.split("-").pop()}`,
          label: `${f.label_tr} (yeniden düzenlenmiş açılış)`,
          value: readValue(filing, f),
        })),
        ...(assetsC5
          ? [
              {
                id: "total_assets_prior_period",
                label: `${assetsC5.label_tr} (önceki dönem)`,
                value: readValue(filing, assetsC5),
              },
            ]
          : []),
        {
          id: "restated_line_count",
          label: "Yeniden düzenlenmiş bilanço kalemi sayısı",
          formula: "count(restated_*)",
          result: String(col6.length),
        },
      ],
    },
    llm_constraints: { ...LLM_CONSTRAINTS },
  };
}
