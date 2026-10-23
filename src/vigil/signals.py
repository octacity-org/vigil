from __future__ import annotations

import dataclasses
from typing import Any, Dict, List, Optional, Tuple

from vigil.parser import ParsedFiling, ParsedFinancialFact

KNOWN_NON_REAL_SECTOR_TICKERS = {
    "A1CAP",
    "AKM",
    "ATA",
    "BLS",
    "GRM",
    "ISMEN",
    "MEKMD",
    "OMD",
    "TERA",
    "YKR",
    "UNLU",
    "GEDIK",
    "INFO",
    "GLBMD",
    "OSMEN",
    "INVEO",
    "HEDEF",
    "GLRYH",
    "GSDHO",
    "AKYHO",
    "KLRHO",
    "RALYH",
    "AVHOL",
    "MZHLD",
    "NTHOL",
    "IHLAS",
    "IHLGM",
    "BRYAT",
    "GOZDE",
    "ISGSY",
    "HUBVC",
    "VERTU",
    "PRDGS",
    "GRTHO",
}


@dataclasses.dataclass
class EvidenceItem:
    metric: str
    label_tr: str
    row_id: str
    disclosure_id: int
    column_class: str
    period_label: str
    raw_value: int
    scale_unit: str
    normalized_value_tl: int


@dataclasses.dataclass
class SignalObject:
    signal_id: str
    company_code: str
    raw_ticker_group: str
    period: str
    disclosure_id: int
    signal_type: str
    neutral_title: str
    severity_rank_score: float
    summary_metrics: Dict[str, Any]
    evidence_chain: List[EvidenceItem]
    formula: str
    llm_constraints: Dict[str, bool] = dataclasses.field(
        default_factory=lambda: {
            "allow_price_commentary": False,
            "allow_external_causal_claims": False,
        }
    )


def _index_facts(
    filing: ParsedFiling,
) -> Dict[Tuple[str, str, str], ParsedFinancialFact]:
    """Index facts by (role_code, row_number_str, column_class)."""
    out: Dict[Tuple[str, str, str], ParsedFinancialFact] = {}
    for f in filing.facts:
        row_num = f.row_id.split("-")[-1]
        out[(f.role_code, row_num, f.column_class)] = f
    return out


def is_real_sector_filing(filing: ParsedFiling) -> Tuple[bool, str]:
    """
    Deterministically check whether a filing belongs to a real-sector
    (industrial, commercial, service) company rather than financial/GYO/holding.
    """
    if filing.template_family != "general":
        return False, f"template_family={filing.template_family}"

    if filing.company_code in KNOWN_NON_REAL_SECTOR_TICKERS:
        return False, "known_financial_or_investment_holding_ticker"

    if "-" in filing.raw_ticker_group and filing.raw_ticker_group != "KRDMA-KRDMB-KRDMD":
        return False, f"multi_ticker_financial_issuer={filing.raw_ticker_group}"

    if filing.company_code.endswith(("GYO", "GY")):
        return False, "gyo_ticker_suffix"

    # Check if financial sector revenue or receivables are material (> 5% of commercial revenue)
    idx = _index_facts(filing)
    for rcode in ("310003", "310000", "310002"):
        rev = idx.get((rcode, "3", "col-order-class-4"))
        fin_rev = idx.get((rcode, "6", "col-order-class-4"))
        fin_cost = idx.get((rcode, "17", "col-order-class-4"))
        if fin_rev and abs(fin_rev.normalized_value_tl) > 0:
            rev_val = abs(rev.normalized_value_tl) if rev else 0
            if rev_val == 0 or abs(fin_rev.normalized_value_tl) > 0.05 * rev_val:
                return False, "material_financial_sector_revenue_row_6"
        if fin_cost and abs(fin_cost.normalized_value_tl) > 0:
            rev_val = abs(rev.normalized_value_tl) if rev else 0
            if rev_val == 0 or abs(fin_cost.normalized_value_tl) > 0.05 * rev_val:
                return False, "material_financial_sector_cost_row_17"

    return True, "real_sector"


def _to_evidence(metric: str, fact: ParsedFinancialFact) -> EvidenceItem:
    return EvidenceItem(
        metric=metric,
        label_tr=fact.label_tr,
        row_id=fact.row_id,
        disclosure_id=fact.disclosure_id,
        column_class=fact.column_class,
        period_label=fact.period_label,
        raw_value=fact.raw_value,
        scale_unit=fact.scale_unit,
        normalized_value_tl=fact.normalized_value_tl,
    )


def detect_gross_margin_deviation(
    filing: ParsedFiling,
    min_revenue_tl: int = 100_000_000,
    min_abs_delta_bps: int = 1_000,
) -> Optional[SignalObject]:
    """
    Signal 1: Real-sector commercial gross margin YoY standalone quarter deviation.
    Uses row-5 (TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)) / row-3 (Hasılat)
    on col-order-class-6 (Cari 3 Aylık) vs col-order-class-7 (Önceki Yıl 3 Aylık Endekslenmiş).
    """
    ok, _reason = is_real_sector_filing(filing)
    if not ok:
        return None

    idx = _index_facts(filing)
    for rcode in ("310003", "310000", "310002"):
        rev_c = idx.get((rcode, "3", "col-order-class-6"))
        rev_p = idx.get((rcode, "3", "col-order-class-7"))
        cogs_c = idx.get((rcode, "4", "col-order-class-6"))
        cogs_p = idx.get((rcode, "4", "col-order-class-7"))
        gp_c = idx.get((rcode, "5", "col-order-class-6"))
        gp_p = idx.get((rcode, "5", "col-order-class-7"))

        if not (rev_c and rev_p and cogs_c and cogs_p and gp_c and gp_p):
            continue
        if cogs_c.normalized_value_tl == 0 or cogs_p.normalized_value_tl == 0:
            continue
        if rev_c.normalized_value_tl < min_revenue_tl or rev_p.normalized_value_tl < min_revenue_tl:
            continue

        margin_c = gp_c.normalized_value_tl / rev_c.normalized_value_tl
        margin_p = gp_p.normalized_value_tl / rev_p.normalized_value_tl
        if not (-1.0 <= margin_c <= 1.0 and -1.0 <= margin_p <= 1.0):
            continue

        delta_bps = round((margin_c - margin_p) * 10_000)
        if abs(delta_bps) < min_abs_delta_bps:
            return None

        return SignalObject(
            signal_id=f"sig_{filing.year}_{filing.quarter}_{filing.company_code}_gross_margin_deviation",
            company_code=filing.company_code,
            raw_ticker_group=filing.raw_ticker_group,
            period=f"{filing.year}-Q{filing.quarter}",
            disclosure_id=filing.disclosure_id,
            signal_type="GROSS_MARGIN_DEVIATION",
            neutral_title="Ticari Brüt Marj YoY Solo Çeyrek Sapması",
            severity_rank_score=round(abs(delta_bps) / 1000.0, 2),
            summary_metrics={
                "current_q_standalone_margin": round(margin_c, 6),
                "prior_year_q_standalone_restated_margin": round(margin_p, 6),
                "delta_bps": delta_bps,
                "current_q_revenue_tl": rev_c.normalized_value_tl,
                "prior_year_q_revenue_restated_tl": rev_p.normalized_value_tl,
            },
            evidence_chain=[
                _to_evidence("commercial_gross_profit_current_q", gp_c),
                _to_evidence("revenue_current_q", rev_c),
                _to_evidence("commercial_gross_profit_prior_year_q_restated", gp_p),
                _to_evidence("revenue_prior_year_q_restated", rev_p),
            ],
            formula="commercial_gross_profit (row-5) / revenue (row-3) [col-6 vs col-7]",
        )
    return None


def detect_cash_profit_quality_divergence(
    filing: ParsedFiling,
    min_net_profit_tl: int = 100_000_000,
    max_operating_cf_tl: int = -100_000_000,
) -> Optional[SignalObject]:
    """
    Signal 2: YTD Net Profit is strongly positive (>= 100M TL) while YTD Operating
    Cash Flow is strongly negative (<= -100M TL) in the same period (col-order-class-4),
    with explicit isolation of TMS 29 Net Monetary Position Gain/Loss (row-52).
    """
    ok, _reason = is_real_sector_filing(filing)
    if not ok:
        return None

    idx = _index_facts(filing)
    inc_role = next((r for r in ("310003", "310000", "310002") if r in filing.role_codes), None)
    cf_role = next((r for r in ("520003", "510011") if r in filing.role_codes), None)
    if not inc_role or not cf_role:
        return None

    net_profit = idx.get((inc_role, "59", "col-order-class-4"))
    monetary_pos = idx.get((inc_role, "52", "col-order-class-4"))
    op_cf = idx.get((cf_role, "2", "col-order-class-4"))

    if not net_profit or not op_cf:
        return None

    np_val = net_profit.normalized_value_tl
    ocf_val = op_cf.normalized_value_tl
    mon_val = monetary_pos.normalized_value_tl if monetary_pos else 0

    if np_val < min_net_profit_tl or ocf_val > max_operating_cf_tl:
        return None

    gap_tl = np_val - ocf_val
    pre_monetary_profit_tl = np_val - mon_val
    driven_by_tms29_monetary_gain = mon_val > 0 and pre_monetary_profit_tl <= 0

    evidence = [
        _to_evidence("net_profit_ytd", net_profit),
        _to_evidence("operating_cash_flow_ytd", op_cf),
    ]
    if monetary_pos:
        evidence.append(_to_evidence("tms29_net_monetary_position_ytd", monetary_pos))

    return SignalObject(
        signal_id=f"sig_{filing.year}_{filing.quarter}_{filing.company_code}_cash_profit_divergence",
        company_code=filing.company_code,
        raw_ticker_group=filing.raw_ticker_group,
        period=f"{filing.year}-Q{filing.quarter}",
        disclosure_id=filing.disclosure_id,
        signal_type="CASH_PROFIT_QUALITY_DIVERGENCE",
        neutral_title="Net Kâr ve İşletme Nakit Akışı Ayrışması (TMS 29 Parasal Pozisyon İzoleli)",
        severity_rank_score=round(gap_tl / 1_000_000_000.0, 2),
        summary_metrics={
            "net_profit_ytd_tl": np_val,
            "operating_cash_flow_ytd_tl": ocf_val,
            "profit_minus_ocf_gap_tl": gap_tl,
            "tms29_net_monetary_position_ytd_tl": mon_val,
            "profit_excluding_monetary_gain_tl": pre_monetary_profit_tl,
            "profit_driven_by_non_cash_monetary_gain": driven_by_tms29_monetary_gain,
        },
        evidence_chain=evidence,
        formula="net_profit_ytd (row-59) - operating_cash_flow_ytd (row-2); isolated tms29_monetary_gain (row-52)",
    )


def detect_restatement_tripwire(filing: ParsedFiling) -> Optional[SignalObject]:
    """
    Signal 3: TMS 1 Retrospective Restatement / Reclassification Tripwire.
    Triggers when a standard Balance Sheet (210015 / 210004) contains a populated
    3rd column (col-order-class-6: 'Bir Önceki Dönem').
    """
    if filing.template_family in ("banks", "finance"):
        # Banks and finance have 6-column TP/YP/Toplam balance sheets
        return None

    bs_col6_facts = [
        f
        for f in filing.facts
        if f.statement_type == "BALANCE_SHEET" and f.column_class == "col-order-class-6" and f.raw_value != 0
    ]
    if not bs_col6_facts:
        return None

    # Find Total Assets (row-129) or first major line item as evidence
    total_assets_c6 = next(
        (f for f in bs_col6_facts if f.row_id.endswith("-row-129")),
        bs_col6_facts[0],
    )
    total_assets_c5 = next(
        (f for f in filing.facts if f.row_id == total_assets_c6.row_id and f.column_class == "col-order-class-5"),
        None,
    )

    ev = [_to_evidence("restated_opening_balance_sheet_col6", total_assets_c6)]
    if total_assets_c5:
        ev.append(_to_evidence("restated_prior_period_balance_sheet_col5", total_assets_c5))

    return SignalObject(
        signal_id=f"sig_{filing.year}_{filing.quarter}_{filing.company_code}_restatement_tripwire",
        company_code=filing.company_code,
        raw_ticker_group=filing.raw_ticker_group,
        period=f"{filing.year}-Q{filing.quarter}",
        disclosure_id=filing.disclosure_id,
        signal_type="RETROSPECTIVE_RESTATEMENT_TRIPWIRE",
        neutral_title="Geçmiş Dönem Finansal Tablolarda Yeniden Düzenleme / Sınıflandırma (3. Bilanço Kolonu)",
        severity_rank_score=float(len(bs_col6_facts)),
        summary_metrics={
            "restated_balance_sheet_line_count": len(bs_col6_facts),
            "third_column_period_label": total_assets_c6.period_label,
        },
        evidence_chain=ev,
        formula="count(BALANCE_SHEET.col-order-class-6 != 0) > 0 [TMS 1.40A]",
    )


def evaluate_directory(raw_dir: str) -> Dict[str, Any]:
    import glob
    import os

    from vigil.parser import parse_kap_xls

    files = sorted(glob.glob(os.path.join(raw_dir, "*.xls")))
    real_sector_count = 0
    excluded_reasons: Dict[str, int] = {}
    s1_list: List[SignalObject] = []
    s2_list: List[SignalObject] = []
    s3_list: List[SignalObject] = []

    for f in files:
        pf = parse_kap_xls(f)
        ok, reason = is_real_sector_filing(pf)
        if ok:
            real_sector_count += 1
        else:
            excluded_reasons[reason] = excluded_reasons.get(reason, 0) + 1

        s1 = detect_gross_margin_deviation(pf)
        if s1:
            s1_list.append(s1)
        s2 = detect_cash_profit_quality_divergence(pf)
        if s2:
            s2_list.append(s2)
        s3 = detect_restatement_tripwire(pf)
        if s3:
            s3_list.append(s3)

    s1_list.sort(key=lambda x: x.severity_rank_score, reverse=True)
    s2_list.sort(key=lambda x: x.severity_rank_score, reverse=True)
    s3_list.sort(key=lambda x: x.severity_rank_score, reverse=True)

    return {
        "total_files": len(files),
        "real_sector_count": real_sector_count,
        "excluded_reasons": excluded_reasons,
        "gross_margin_signals": s1_list,
        "cash_profit_signals": s2_list,
        "restatement_signals": s3_list,
    }


if __name__ == "__main__":
    import os
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "raw", "2026_2")
    res = evaluate_directory(target_dir)
    print(f"Total files: {res['total_files']} | Real-sector filings: {res['real_sector_count']}")
    print("Excluded breakdown:", res["excluded_reasons"])

    s1 = res["gross_margin_signals"]
    print(f"\n=== SIGNAL 1: GROSS MARGIN YoY DEVIATION (|delta| >= 1000 bps) -> {len(s1)} companies ===")
    for item in s1[:10]:
        m = item.summary_metrics
        print(
            f"  {item.company_code:6s} (#{item.disclosure_id}) | "
            f"2025Q2: {m['prior_year_q_standalone_restated_margin'] * 100:6.2f}% -> "
            f"2026Q2: {m['current_q_standalone_margin'] * 100:6.2f}% | "
            f"Delta: {m['delta_bps']:+5d} bps | "
            f"Rev26Q2: {m['current_q_revenue_tl'] / 1e6:9.1f}M TL"
        )

    s2 = res["cash_profit_signals"]
    print(f"\n=== SIGNAL 2: CASH / PROFIT QUALITY DIVERGENCE -> {len(s2)} companies ===")
    for item in s2[:10]:
        m = item.summary_metrics
        print(
            f"  {item.company_code:6s} (#{item.disclosure_id}) | "
            f"NetProfit: {m['net_profit_ytd_tl'] / 1e6:8.1f}M | "
            f"OpCF: {m['operating_cash_flow_ytd_tl'] / 1e6:9.1f}M | "
            f"TMS29 MonPos: {m['tms29_net_monetary_position_ytd_tl'] / 1e6:8.1f}M | "
            f"ExMonProfit: {m['profit_excluding_monetary_gain_tl'] / 1e6:9.1f}M | "
            f"MonDriven: {m['profit_driven_by_non_cash_monetary_gain']}"
        )

    s3 = res["restatement_signals"]
    print(f"\n=== SIGNAL 3: 3-COLUMN BALANCE SHEET RESTATEMENT TRIPWIRE -> {len(s3)} companies ===")
    for item in s3:
        m = item.summary_metrics
        print(
            f"  {item.company_code:6s} (#{item.disclosure_id}) | "
            f"Restated BS rows: {m['restated_balance_sheet_line_count']:3d} | "
            f"Col-6 header: {m['third_column_period_label']}"
        )
