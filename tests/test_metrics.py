import unittest

from vigil.metrics import (
    BalanceSheetRatios,
    calculate_balance_sheet_ratios,
    cash_ratio,
    current_ratio,
    liabilities_to_assets,
    net_debt,
    net_debt_to_equity,
    quick_ratio,
)


class TestBalanceSheetRatios(unittest.TestCase):
    """
    Test balance sheet ratios using KATMR reference numbers from docs/VIGIL.md (Section 7).
    All monetary values are in million TL at June 2026 purchasing power.
    """

    def setUp(self):
        # KATMR 2026/2 values (in million TL)
        self.katmr_2026 = {
            "cash": 120.8,
            "current_assets": 12903.6,
            "total_assets": 14795.4,
            "inventories": 8989.1,
            "borrowings": 2313.8,
            "current_liabilities": 3897.1,
            "equity": 10499.9,
            "total_liabilities": 14795.4 - 10499.9,  # 4295.5
        }

        # KATMR 31.12.2025 prior year-end comparative values (in million TL)
        self.katmr_2025_ye = {
            "cash": 450.9,
            "current_assets": 14263.3,
            "total_assets": 16069.1,
            "inventories": 9191.0,
            "borrowings": 2460.5,
            "current_liabilities": 5174.7,
            "equity": 10181.0,
            "total_liabilities": 16069.1 - 10181.0,  # 5888.1
        }

    def test_current_ratio_katmr(self):
        # 30.06.2026: 12903.6 / 3897.1 = 3.31
        cr_2026 = current_ratio(self.katmr_2026["current_assets"], self.katmr_2026["current_liabilities"])
        self.assertIsNotNone(cr_2026)
        self.assertEqual(round(cr_2026, 2), 3.31)

        # 31.12.2025 (prior year-end): 14263.3 / 5174.7 = 2.76
        cr_2025_ye = current_ratio(self.katmr_2025_ye["current_assets"], self.katmr_2025_ye["current_liabilities"])
        self.assertIsNotNone(cr_2025_ye)
        self.assertEqual(round(cr_2025_ye, 2), 2.76)

    def test_quick_ratio_katmr(self):
        # 30.06.2026: (12903.6 - 8989.1) / 3897.1 = 1.00
        qr_2026 = quick_ratio(
            self.katmr_2026["current_assets"],
            self.katmr_2026["inventories"],
            self.katmr_2026["current_liabilities"],
        )
        self.assertIsNotNone(qr_2026)
        self.assertEqual(round(qr_2026, 2), 1.00)

        # 31.12.2025 (prior year-end): (14263.3 - 9191.0) / 5174.7 = 0.98
        qr_2025_ye = quick_ratio(
            self.katmr_2025_ye["current_assets"],
            self.katmr_2025_ye["inventories"],
            self.katmr_2025_ye["current_liabilities"],
        )
        self.assertIsNotNone(qr_2025_ye)
        self.assertEqual(round(qr_2025_ye, 2), 0.98)

    def test_cash_ratio_katmr(self):
        # 30.06.2026: 120.8 / 3897.1 = 0.03
        cash_r_2026 = cash_ratio(self.katmr_2026["cash"], self.katmr_2026["current_liabilities"])
        self.assertIsNotNone(cash_r_2026)
        self.assertEqual(round(cash_r_2026, 2), 0.03)

        # 31.12.2025 (prior year-end): 450.9 / 5174.7 = 0.09
        cash_r_2025_ye = cash_ratio(self.katmr_2025_ye["cash"], self.katmr_2025_ye["current_liabilities"])
        self.assertIsNotNone(cash_r_2025_ye)
        self.assertEqual(round(cash_r_2025_ye, 2), 0.09)

    def test_net_debt_and_net_debt_to_equity_katmr(self):
        # 30.06.2026: borrowings 2313.8 - cash 120.8 = 2193.0
        nd_2026 = net_debt(self.katmr_2026["borrowings"], self.katmr_2026["cash"])
        self.assertIsNotNone(nd_2026)
        self.assertEqual(round(nd_2026, 1), 2193.0)

        # 30.06.2026: net debt 2193.0 / equity 10499.9 = 0.21
        nde_2026 = net_debt_to_equity(nd_2026, self.katmr_2026["equity"])
        self.assertIsNotNone(nde_2026)
        self.assertEqual(round(nde_2026, 2), 0.21)

        # 31.12.2025 (prior year-end): borrowings 2460.5 - cash 450.9 = 2009.6
        nd_2025_ye = net_debt(self.katmr_2025_ye["borrowings"], self.katmr_2025_ye["cash"])
        self.assertIsNotNone(nd_2025_ye)
        self.assertEqual(round(nd_2025_ye, 1), 2009.6)

        # 31.12.2025 (prior year-end): net debt 2009.6 / equity 10181.0 = 0.20
        nde_2025_ye = net_debt_to_equity(nd_2025_ye, self.katmr_2025_ye["equity"])
        self.assertIsNotNone(nde_2025_ye)
        self.assertEqual(round(nde_2025_ye, 2), 0.20)

    def test_liabilities_to_assets_katmr(self):
        # 30.06.2026: liabilities 4295.5 / assets 14795.4 = 0.29
        la_2026 = liabilities_to_assets(self.katmr_2026["total_liabilities"], self.katmr_2026["total_assets"])
        self.assertIsNotNone(la_2026)
        self.assertEqual(round(la_2026, 2), 0.29)

        # 31.12.2025 (prior year-end): liabilities 5888.1 / assets 16069.1 = 0.37
        la_2025_ye = liabilities_to_assets(self.katmr_2025_ye["total_liabilities"], self.katmr_2025_ye["total_assets"])
        self.assertIsNotNone(la_2025_ye)
        self.assertEqual(round(la_2025_ye, 2), 0.37)

    def test_zero_division_and_none_handling(self):
        # Missing inputs should return None (not 0, not NaN)
        self.assertIsNone(current_ratio(None, 100))
        self.assertIsNone(current_ratio(100, None))
        self.assertIsNone(quick_ratio(100, None, 50))
        self.assertIsNone(cash_ratio(None, 50))
        self.assertIsNone(net_debt(None, 50))
        self.assertIsNone(net_debt_to_equity(None, 100))
        self.assertIsNone(liabilities_to_assets(100, None))

        # Division by zero should return None
        self.assertIsNone(current_ratio(100, 0))
        self.assertIsNone(quick_ratio(100, 20, 0))
        self.assertIsNone(cash_ratio(10, 0))
        self.assertIsNone(net_debt_to_equity(50, 0))
        self.assertIsNone(liabilities_to_assets(50, 0))

    def test_calculate_balance_sheet_ratios_container(self):
        # 1. When total_liabilities is omitted, it is derived as assets - equity, and marked liabilities_derived=True
        ratios_2026_derived = calculate_balance_sheet_ratios(
            current_assets=self.katmr_2026["current_assets"],
            current_liabilities=self.katmr_2026["current_liabilities"],
            inventories=self.katmr_2026["inventories"],
            cash_and_equivalents=self.katmr_2026["cash"],
            borrowings=self.katmr_2026["borrowings"],
            equity=self.katmr_2026["equity"],
            total_assets=self.katmr_2026["total_assets"],
        )
        self.assertIsInstance(ratios_2026_derived, BalanceSheetRatios)
        self.assertEqual(round(ratios_2026_derived.current_ratio, 2), 3.31)
        self.assertEqual(round(ratios_2026_derived.quick_ratio, 2), 1.00)
        self.assertEqual(round(ratios_2026_derived.cash_ratio, 2), 0.03)
        self.assertEqual(round(ratios_2026_derived.net_debt, 1), 2193.0)
        self.assertEqual(round(ratios_2026_derived.net_debt_to_equity, 2), 0.21)
        self.assertEqual(round(ratios_2026_derived.liabilities_to_assets, 2), 0.29)
        self.assertTrue(ratios_2026_derived.liabilities_derived)

        # 2. When total_liabilities is explicitly supplied, liabilities_derived=False
        ratios_2026_explicit = calculate_balance_sheet_ratios(
            current_assets=self.katmr_2026["current_assets"],
            current_liabilities=self.katmr_2026["current_liabilities"],
            total_assets=self.katmr_2026["total_assets"],
            total_liabilities=self.katmr_2026["total_liabilities"],
        )
        self.assertEqual(round(ratios_2026_explicit.liabilities_to_assets, 2), 0.29)
        self.assertFalse(ratios_2026_explicit.liabilities_derived)


if __name__ == "__main__":
    unittest.main()
