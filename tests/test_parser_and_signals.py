import csv
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from vigil.parser import parse_kap_xls
from vigil.signals import (
    detect_cash_profit_quality_divergence,
    detect_gross_margin_deviation,
    detect_restatement_tripwire,
    is_real_sector_filing,
)

RAW_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "raw", "2026_2"))
GOLDEN_DIR = os.path.join(os.path.dirname(__file__), "golden", "2026_2")


def golden_value(filing, row_id, column):
    """value_tl of one hand-copied golden cell (tests/golden/README.md)."""
    with open(os.path.join(GOLDEN_DIR, f"{filing}.csv"), encoding="utf-8", newline="") as f:
        for line in csv.DictReader(f):
            if line["row_id"] == row_id and line["column"] == column:
                return int(line["value_tl"])
    raise KeyError((filing, row_id, column))


# KAP files are not in the repository (see README). These tests need a local download
# of 2026/2 and are skipped otherwise. Expected numbers come from tests/golden/, never
# from parser output (#20). Filings without a golden file only get structural checks.
@unittest.skipUnless(os.path.isdir(RAW_DIR), "KAP 2026/2 files not downloaded")
class TestKapParserAndSignals(unittest.TestCase):
    def test_general_310003_industrial_katmr(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "KATMR_1651411_2026_2.xls"))
        self.assertEqual(pf.company_code, "KATMR")
        self.assertEqual(pf.template_family, "general")
        self.assertEqual(pf.scale_unit, "TL")
        self.assertEqual(pf.scale_multiplier, 1)
        self.assertIn("310003", pf.role_codes)
        self.assertTrue(pf.has_tms29_monetary_item)
        self.assertTrue(is_real_sector_filing(pf)[0])

        def golden(row, col):
            return golden_value("KATMR_1651411", f"general_role_310003-row-{row}", f"col-order-class-{col}")

        revenue_c, revenue_p = golden(3, 6), golden(3, 7)
        gross_profit_c, gross_profit_p = golden(5, 6), golden(5, 7)
        expected_delta_bps = round((gross_profit_c / revenue_c - gross_profit_p / revenue_p) * 10_000)

        sig = detect_gross_margin_deviation(pf)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.summary_metrics["current_q_revenue_tl"], revenue_c)
        self.assertEqual(sig.summary_metrics["prior_year_q_revenue_restated_tl"], revenue_p)
        self.assertEqual(sig.summary_metrics["delta_bps"], expected_delta_bps)

    def test_general_310000_separate_income_statement_sanfm(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "SANFM_1650384_2026_2.xls"))
        self.assertEqual(pf.company_code, "SANFM")
        self.assertEqual(pf.template_family, "general")
        self.assertIn("310000", pf.role_codes)
        self.assertIn("420000", pf.role_codes)
        self.assertTrue(is_real_sector_filing(pf)[0])

        self.assertIsNotNone(detect_gross_margin_deviation(pf))

    def test_brokerage_a1cap_excluded_from_real_sector_margin(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "A1CAP-ACP_1645514_2026_2.xls"))
        self.assertEqual(pf.company_code, "A1CAP")
        self.assertEqual(pf.raw_ticker_group, "A1CAP-ACP")
        ok, _reason = is_real_sector_filing(pf)
        self.assertFalse(ok)
        self.assertIsNone(detect_gross_margin_deviation(pf))

    def test_banks_template_million_tl_scale_and_tp_yp_columns(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "AKBNK_1637884_2026_2.xls"))
        self.assertEqual(pf.company_code, "AKBNK")
        self.assertEqual(pf.template_family, "banks")
        self.assertEqual(pf.scale_unit, "1.000.000 TL")
        self.assertEqual(pf.scale_multiplier, 1_000_000)

        row4 = {f.column_class: f for f in pf.facts if f.row_id == "banks_role_210011-row-4"}
        self.assertEqual(row4["col-order-class-4"].period_type, "POINT_IN_TIME_TP")
        self.assertEqual(row4["col-order-class-5"].period_type, "POINT_IN_TIME_YP")
        self.assertEqual(row4["col-order-class-6"].period_type, "POINT_IN_TIME")
        # TP + YP == Toplam, and million TL normalization
        total = row4["col-order-class-6"]
        self.assertEqual(row4["col-order-class-4"].raw_value + row4["col-order-class-5"].raw_value, total.raw_value)
        self.assertEqual(total.normalized_value_tl, total.raw_value * 1_000_000)

    def test_holding_template_thousand_tl_scale_dohol(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "DOHOL_1648007_2026_2.xls"))
        self.assertEqual(pf.company_code, "DOHOL")
        self.assertEqual(pf.template_family, "holding")
        self.assertEqual(pf.scale_unit, "1.000 TL")
        self.assertEqual(pf.scale_multiplier, 1_000)
        cash = next(
            f for f in pf.facts if f.row_id == "holding_role_210015-row-4" and f.column_class == "col-order-class-4"
        )
        self.assertEqual(cash.normalized_value_tl, cash.raw_value * 1_000)

    def test_cash_profit_divergence_and_tms29_isolation_akenr(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "AKENR_1649474_2026_2.xls"))
        self.assertIsNotNone(detect_cash_profit_quality_divergence(pf))

    def test_restatement_third_balance_sheet_column_bioen(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "BIOEN_1652232_2026_2.xls"))
        sig = detect_restatement_tripwire(pf)
        self.assertIsNotNone(sig)
        self.assertIn("31.12.2024", sig.summary_metrics["third_column_period_label"])

        # Evidence: total assets in the restated column and the prior period, from the golden file (#25, #130).
        evidence = {(e.row_id, e.column_class): e.normalized_value_tl for e in sig.evidence_chain}
        for column in ("col-order-class-6", "col-order-class-5"):
            row_id = "general_role_210015-row-129"
            self.assertEqual(evidence[(row_id, column)], golden_value("BIOEN_1652232", row_id, column))


if __name__ == "__main__":
    unittest.main()
