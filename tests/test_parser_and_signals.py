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


# KAP files are not in the repository (see README). These tests need a local download
# of 2026/2 and are skipped otherwise. Their expected values are circular; see issue #20.
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

        sig = detect_gross_margin_deviation(pf)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.summary_metrics["current_q_revenue_tl"], 879_599_263)
        self.assertEqual(sig.summary_metrics["prior_year_q_revenue_restated_tl"], 694_991_758)
        self.assertEqual(sig.summary_metrics["delta_bps"], -2596)

    def test_general_310000_separate_income_statement_sanfm(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "SANFM_1650384_2026_2.xls"))
        self.assertEqual(pf.company_code, "SANFM")
        self.assertEqual(pf.template_family, "general")
        self.assertIn("310000", pf.role_codes)
        self.assertIn("420000", pf.role_codes)
        self.assertTrue(is_real_sector_filing(pf)[0])

        sig = detect_gross_margin_deviation(pf)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.summary_metrics["delta_bps"], -3130)

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
        # Verify TP + YP == Toplam and million TL normalization
        self.assertEqual(
            row4["col-order-class-4"].raw_value + row4["col-order-class-5"].raw_value,
            row4["col-order-class-6"].raw_value,
        )
        self.assertEqual(row4["col-order-class-6"].normalized_value_tl, 1_351_403_000_000)

    def test_holding_template_thousand_tl_scale_dohol(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "DOHOL_1648007_2026_2.xls"))
        self.assertEqual(pf.company_code, "DOHOL")
        self.assertEqual(pf.template_family, "holding")
        self.assertEqual(pf.scale_unit, "1.000 TL")
        self.assertEqual(pf.scale_multiplier, 1_000)
        cash = next(
            f for f in pf.facts if f.row_id == "holding_role_210015-row-4" and f.column_class == "col-order-class-4"
        )
        self.assertEqual(cash.raw_value, 4_073_175)
        self.assertEqual(cash.normalized_value_tl, 4_073_175_000)

    def test_cash_profit_divergence_and_tms29_isolation_akenr(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "AKENR_1649474_2026_2.xls"))
        sig = detect_cash_profit_quality_divergence(pf)
        self.assertIsNotNone(sig)
        m = sig.summary_metrics
        self.assertGreater(m["net_profit_ytd_tl"], 600_000_000)
        self.assertLess(m["operating_cash_flow_ytd_tl"], -700_000_000)
        self.assertGreater(m["tms29_net_monetary_position_ytd_tl"], 4_000_000_000)
        self.assertTrue(m["profit_driven_by_non_cash_monetary_gain"])

    def test_restatement_third_balance_sheet_column_bioen(self):
        pf = parse_kap_xls(os.path.join(RAW_DIR, "BIOEN_1652232_2026_2.xls"))
        sig = detect_restatement_tripwire(pf)
        self.assertIsNotNone(sig)
        self.assertEqual(sig.summary_metrics["restated_balance_sheet_line_count"], 71)
        self.assertIn("31.12.2024", sig.summary_metrics["third_column_period_label"])


if __name__ == "__main__":
    unittest.main()
