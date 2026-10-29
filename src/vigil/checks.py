"""Cross-statement reconciliation checks (issue #18).

Ratios are computed only after the statements of a filing agree with each other. Every check compares two
values from the same filing, so both are in the same reporting unit and purchasing power, and must be equal.

Supported templates: `general` and `holding`, which share the balance sheet and cash flow layout. Other
templates are reported as `not_checked` with the reason; nothing is guessed.

Severity (decision 0003, proposed):
- `blocking`: the balance sheet balances, and its profit equals the income statement's parent-company profit.
  A filing that fails one of these should not produce signals.
- `informational`: cash in the cash flow statement versus cash in the balance sheet. Many filings define cash
  in the cash flow statement without interest accruals, blocked deposits or expected credit losses (IAS 7,
  explained in the notes), so a difference is reported but does not block the filing.

Values are compared in the filing's reporting unit; a difference of one unit is treated as rounding.
"""

from __future__ import annotations

import dataclasses
from typing import Dict, List, Optional, Sequence, Tuple

from vigil.parser import ParsedFiling, ParsedFinancialFact

SUPPORTED_FAMILIES = ("general", "holding")

CURRENT = "col-order-class-4"
PRIOR = "col-order-class-5"

ROUNDING_TOLERANCE = 1  # one unit of the reporting unit (1 TL, 1,000 TL or 1,000,000 TL)

# (role code, row number) candidates and the label that must be on that row. The label guards against a
# template that renumbers its rows: a different label gives `not_checked` instead of a wrong comparison.
TOTAL_ASSETS = ([("210015", 129)], "TOPLAM VARLIKLAR")
TOTAL_LIABILITIES_AND_EQUITY = ([("210015", 297)], "TOPLAM KAYNAKLAR")
BS_NET_PROFIT = ([("210015", 294)], "Net Dönem Karı veya Zararı")
BS_CASH = ([("210015", 4)], "Nakit ve Nakit Benzerleri")
PARENT_PROFIT = ([("310003", 62), ("310000", 62), ("310002", 62), ("310004", 64)], "Ana Ortaklık Payları")
CF_CASH_END = ([("520003", 209), ("510011", 121)], "DÖNEM SONU NAKİT VE NAKİT BENZERLERİ")
CF_CASH_BEGIN = ([("520003", 207), ("510011", 119)], "DÖNEM BAŞI NAKİT VE NAKİT BENZERLERİ")

RowSpec = Tuple[List[Tuple[str, int]], str]


@dataclasses.dataclass(frozen=True)
class CheckResult:
    name: str
    severity: str  # "blocking" | "informational"
    status: str  # "pass" | "fail" | "not_checked"
    left: Optional[int] = None  # raw values, in the filing's reporting unit
    right: Optional[int] = None
    left_source: Optional[str] = None  # "row_id column"
    right_source: Optional[str] = None
    reason: Optional[str] = None

    @property
    def difference(self) -> Optional[int]:
        if self.left is None or self.right is None:
            return None
        return self.left - self.right


def _find(
    facts: Dict[Tuple[str, str], ParsedFinancialFact], family: str, spec: RowSpec, column: str
) -> Tuple[Optional[ParsedFinancialFact], Optional[str]]:
    candidates, label = spec
    for role, row in candidates:
        fact = facts.get((f"{family}_role_{role}-row-{row}", column))
        if fact is None:
            continue
        if fact.label_tr != label:
            return None, f"{fact.row_id} is {fact.label_tr!r}, expected {label!r}"
        return fact, None
    rows = ", ".join(f"{role}-row-{row}" for role, row in candidates)
    return None, f"no value for {label!r} ({rows}) in {column}"


def _compare(
    name: str,
    severity: str,
    facts: Dict[Tuple[str, str], ParsedFinancialFact],
    family: str,
    left: RowSpec,
    left_column: str,
    right: RowSpec,
    right_column: str,
) -> CheckResult:
    lf, l_reason = _find(facts, family, left, left_column)
    rf, r_reason = _find(facts, family, right, right_column)
    if lf is None or rf is None:
        return CheckResult(name, severity, "not_checked", reason="; ".join(r for r in (l_reason, r_reason) if r))
    return CheckResult(
        name,
        severity,
        "pass" if abs(lf.raw_value - rf.raw_value) <= ROUNDING_TOLERANCE else "fail",
        left=lf.raw_value,
        right=rf.raw_value,
        left_source=f"{lf.row_id} {left_column}",
        right_source=f"{rf.row_id} {right_column}",
    )


CHECKS: Sequence[Tuple[str, str, RowSpec, str, RowSpec, str]] = (
    (
        "total_assets_equal_liabilities_and_equity_current",
        "blocking",
        TOTAL_ASSETS,
        CURRENT,
        TOTAL_LIABILITIES_AND_EQUITY,
        CURRENT,
    ),
    (
        "total_assets_equal_liabilities_and_equity_prior",
        "blocking",
        TOTAL_ASSETS,
        PRIOR,
        TOTAL_LIABILITIES_AND_EQUITY,
        PRIOR,
    ),
    ("balance_sheet_profit_equals_parent_profit", "blocking", BS_NET_PROFIT, CURRENT, PARENT_PROFIT, CURRENT),
    ("cash_flow_end_cash_equals_balance_sheet_cash", "informational", CF_CASH_END, CURRENT, BS_CASH, CURRENT),
    ("cash_flow_begin_cash_equals_prior_balance_sheet_cash", "informational", CF_CASH_BEGIN, CURRENT, BS_CASH, PRIOR),
)


def reconcile(filing: ParsedFiling) -> List[CheckResult]:
    """Run the cross-statement checks on one filing. Unsupported templates give `not_checked`."""
    if filing.template_family not in SUPPORTED_FAMILIES:
        reason = f"template {filing.template_family!r} is not supported yet"
        return [CheckResult(name, severity, "not_checked", reason=reason) for name, severity, *_ in CHECKS]
    facts = {(f.row_id, f.column_class): f for f in filing.facts}
    return [_compare(name, severity, facts, filing.template_family, *spec) for name, severity, *spec in CHECKS]


def blocking_failures(results: Sequence[CheckResult]) -> List[CheckResult]:
    """Blocking checks that failed. A filing with any of these should not produce signals."""
    return [r for r in results if r.severity == "blocking" and r.status == "fail"]
