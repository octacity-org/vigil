"""
Financial metrics and ratios computed from KAP statement facts.

All formulas follow the definitions in docs/VIGIL.md and docs/DATA_CONTRACT.md.
No approximate figures or arbitrary fallbacks (Rule 1): missing inputs or
division-by-zero return None.
"""

from __future__ import annotations

import dataclasses
from typing import Optional, Union

__all__ = [
    "BalanceSheetRatios",
    "calculate_balance_sheet_ratios",
    "cash_ratio",
    "current_ratio",
    "liabilities_to_assets",
    "net_debt",
    "net_debt_to_equity",
    "quick_ratio",
]

Number = Union[int, float]


def current_ratio(
    current_assets: Optional[Number],
    current_liabilities: Optional[Number],
) -> Optional[float]:
    """
    Current ratio (Cari oran): Dönen varlıklar / Kısa vadeli yükümlülükler.

    Measures short-term debt paying ability.
    """
    if current_assets is None or current_liabilities is None or current_liabilities == 0:
        return None
    return float(current_assets / current_liabilities)


def quick_ratio(
    current_assets: Optional[Number],
    inventories: Optional[Number],
    current_liabilities: Optional[Number],
) -> Optional[float]:
    """
    Quick / Acid-test ratio (Likidite oranı): (Dönen varlıklar - Stoklar) / Kısa vadeli yükümlülükler.

    Measures liquid short-term coverage excluding inventory.
    """
    if current_assets is None or inventories is None or current_liabilities is None or current_liabilities == 0:
        return None
    return float((current_assets - inventories) / current_liabilities)


def cash_ratio(
    cash_and_equivalents: Optional[Number],
    current_liabilities: Optional[Number],
) -> Optional[float]:
    """
    Cash ratio (Nakit oranı): Nakit ve nakit benzerleri / Kısa vadeli yükümlülükler.

    Measures immediate cash liquidity against short-term obligations.
    """
    if cash_and_equivalents is None or current_liabilities is None or current_liabilities == 0:
        return None
    return float(cash_and_equivalents / current_liabilities)


def net_debt(
    borrowings: Optional[Number],
    cash_and_equivalents: Optional[Number],
) -> Optional[float]:
    """
    Net debt (Net borç): Finansal borçlar - Nakit ve nakit benzerleri.

    Financial Rule 5: Net debt has one fixed, explicit definition: borrowings - cash.
    """
    if borrowings is None or cash_and_equivalents is None:
        return None
    return float(borrowings - cash_and_equivalents)


def net_debt_to_equity(
    net_debt_val: Optional[Number],
    equity: Optional[Number],
) -> Optional[float]:
    """
    Net debt to equity (Net borç / Özkaynak): Net borç / Toplam özkaynak.

    Measures financial leverage against equity base.
    """
    if net_debt_val is None or equity is None or equity == 0:
        return None
    return float(net_debt_val / equity)


def liabilities_to_assets(
    total_liabilities: Optional[Number],
    total_assets: Optional[Number],
) -> Optional[float]:
    """
    Liabilities to assets (Yükümlülük / Varlık): Toplam yükümlülükler / Toplam varlıklar.

    Measures total leverage / indebtedness of the asset base.
    """
    if total_liabilities is None or total_assets is None or total_assets == 0:
        return None
    return float(total_liabilities / total_assets)


@dataclasses.dataclass(frozen=True)
class BalanceSheetRatios:
    """Summary of standard balance sheet ratios for a single period."""

    current_ratio: Optional[float]
    quick_ratio: Optional[float]
    cash_ratio: Optional[float]
    net_debt: Optional[float]
    net_debt_to_equity: Optional[float]
    liabilities_to_assets: Optional[float]
    liabilities_derived: bool = False


def calculate_balance_sheet_ratios(
    *,
    current_assets: Optional[Number] = None,
    current_liabilities: Optional[Number] = None,
    inventories: Optional[Number] = None,
    cash_and_equivalents: Optional[Number] = None,
    borrowings: Optional[Number] = None,
    equity: Optional[Number] = None,
    total_assets: Optional[Number] = None,
    total_liabilities: Optional[Number] = None,
) -> BalanceSheetRatios:
    """
    Calculate all standard balance sheet ratios from available inputs.

    If total_liabilities is not provided but total_assets and equity are present,
    total_liabilities is derived as (total_assets - equity) and marked with
    liabilities_derived=True.
    """
    cr = current_ratio(current_assets, current_liabilities)
    qr = quick_ratio(current_assets, inventories, current_liabilities)
    cash_r = cash_ratio(cash_and_equivalents, current_liabilities)
    nd = net_debt(borrowings, cash_and_equivalents)
    nde = net_debt_to_equity(nd, equity)

    resolved_liabilities = total_liabilities
    liabilities_derived = False
    if resolved_liabilities is None and total_assets is not None and equity is not None:
        resolved_liabilities = total_assets - equity
        liabilities_derived = True

    la = liabilities_to_assets(resolved_liabilities, total_assets)

    return BalanceSheetRatios(
        current_ratio=cr,
        quick_ratio=qr,
        cash_ratio=cash_r,
        net_debt=nd,
        net_debt_to_equity=nde,
        liabilities_to_assets=la,
        liabilities_derived=liabilities_derived,
    )
