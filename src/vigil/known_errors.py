"""Blocking check failures confirmed to be errors in the filing itself, not in Vigil (#148, decision 0006).

A filing listed here is still blocked from signals (`checks.blocking_failures` keeps returning the failure);
the data quality report shows it as `known_error` with the reason instead of `fail`.
Add an entry only after reading the raw file. Key: (disclosure_id, check name).
"""

from typing import Dict, Tuple

KNOWN_FILING_ERRORS: Dict[Tuple[int, str], str] = {
    (1647085, "balance_sheet_profit_equals_parent_profit"): (
        "AKTVK 2026/2: income statement row 62 (Ana Ortaklık Payları) is filed as 0 in both title and text; "
        "the profit (-682,616) is in row 59 and in row 151 (comprehensive income, parent share)."
    ),
}
