"""Cross-statement reconciliation checks (#18).

Facts are built from the hand-checked golden file, not from parser output, so the tests run in CI without
KAP data.
"""

import csv
import dataclasses
import os

from vigil.checks import blocking_failures, reconcile
from vigil.parser import ParsedFiling, ParsedFinancialFact

GOLDEN = os.path.join(os.path.dirname(__file__), "golden", "2026_2", "KATMR_1651411.csv")


def katmr_filing():
    facts = []
    with open(GOLDEN, encoding="utf-8", newline="") as f:
        for line in csv.DictReader(f):
            if line["raw_value"] == "":
                continue
            facts.append(
                ParsedFinancialFact(
                    company_code=line["company"],
                    raw_ticker_group=line["company"],
                    disclosure_id=int(line["disclosure_id"]),
                    year=int(line["year"]),
                    quarter=int(line["quarter"]),
                    consolidation_type=line["consolidation"],
                    template_family=line["template"],
                    role_code=line["table_id"].rsplit("_", 1)[1],
                    statement_type=line["statement"],
                    row_id=line["row_id"],
                    label_tr=line["row_label"],
                    footnote_ref=None,
                    column_class=line["column"],
                    period_type="",
                    period_label=line["period_label"],
                    is_restated_comparative=False,
                    raw_value=int(line["raw_value"]),
                    scale_unit=line["scale_unit"],
                    scale_multiplier=1,
                    normalized_value_tl=int(line["value_tl"]),
                )
            )
    return ParsedFiling(
        filepath=GOLDEN,
        company_code="KATMR",
        raw_ticker_group="KATMR",
        disclosure_id=1651411,
        year=2026,
        quarter=2,
        scale_unit="TL",
        scale_multiplier=1,
        consolidation_type="Konsolide",
        template_family="general",
        role_codes=["210015", "310003", "520003"],
        has_tms29_monetary_item=True,
        facts=facts,
    )


def with_value(filing, row_id, column, value):
    facts = [
        dataclasses.replace(f, raw_value=value) if (f.row_id, f.column_class) == (row_id, column) else f
        for f in filing.facts
    ]
    return dataclasses.replace(filing, facts=facts)


def by_name(results):
    return {r.name: r for r in results}


def test_katmr_passes_all_checks():
    results = reconcile(katmr_filing())
    assert [r.status for r in results] == ["pass"] * 5
    assert blocking_failures(results) == []
    profit = by_name(results)["balance_sheet_profit_equals_parent_profit"]
    assert (profit.left, profit.right) == (318919663, 318919663)


def test_unbalanced_balance_sheet_is_a_blocking_failure():
    filing = with_value(katmr_filing(), "general_role_210015-row-297", "col-order-class-4", 14795418421 + 1000)
    results = reconcile(filing)
    check = by_name(results)["total_assets_equal_liabilities_and_equity_current"]
    assert (check.status, check.severity, check.difference) == ("fail", "blocking", -1000)
    assert [r.name for r in blocking_failures(results)] == ["total_assets_equal_liabilities_and_equity_current"]


def test_cash_difference_is_informational():
    filing = with_value(katmr_filing(), "general_role_210015-row-4", "col-order-class-4", 120759073 + 53000)
    results = reconcile(filing)
    check = by_name(results)["cash_flow_end_cash_equals_balance_sheet_cash"]
    assert (check.status, check.severity) == ("fail", "informational")
    assert blocking_failures(results) == []


def test_one_unit_difference_is_rounding():
    filing = with_value(katmr_filing(), "general_role_210015-row-4", "col-order-class-5", 450940942 + 1)
    check = by_name(reconcile(filing))["cash_flow_begin_cash_equals_prior_balance_sheet_cash"]
    assert check.status == "pass"
    assert check.difference == -1


def test_unsupported_template_is_not_checked():
    filing = dataclasses.replace(katmr_filing(), template_family="banks")
    results = reconcile(filing)
    assert {r.status for r in results} == {"not_checked"}
    assert "banks" in results[0].reason


def test_unexpected_label_is_not_checked():
    filing = katmr_filing()
    facts = [
        dataclasses.replace(f, label_tr="Başka Bir Kalem") if f.row_id == "general_role_210015-row-129" else f
        for f in filing.facts
    ]
    check = by_name(reconcile(dataclasses.replace(filing, facts=facts)))[
        "total_assets_equal_liabilities_and_equity_current"
    ]
    assert check.status == "not_checked"
    assert "Başka Bir Kalem" in check.reason
