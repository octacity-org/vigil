"""Income statement (#15), balance sheet (#16) and cash flow (#17) subtotals recomputed from their components."""

import dataclasses
import os

import pytest

from vigil.checks import (
    BALANCE_SHEET_SUBTOTALS,
    CASH_FLOW_SUBTOTALS,
    INCOME_STATEMENT_SUBTOTALS,
    balance_sheet_subtotals,
    cash_flow_subtotals,
    income_statement_subtotals,
)
from vigil.parser import ParsedFiling, ParsedFinancialFact, parse_kap_xls

LABELS = {row: label for row, label, _ in INCOME_STATEMENT_SUBTOTALS}
BS_LABELS = {row: label for row, label, _ in BALANCE_SHEET_SUBTOTALS}
CF_LABELS = {row: label for row, label, _ in CASH_FLOW_SUBTOTALS}
COL = "col-order-class-4"

# A consistent income statement (values in TL, costs negative). Rows not listed are unreported.
CONSISTENT = {
    3: 1000,  # revenue
    4: -600,  # cost of sales
    5: 400,  # commercial gross profit
    31: 400,  # gross profit
    32: -100,  # general administrative expenses
    33: -50,  # marketing expenses
    35: 30,  # other operating income
    38: 280,  # operating profit
    41: 20,  # income from investing activities
    42: -36,  # expenses from investing activities (KATMR row 42 in miniature)
    49: 264,  # operating profit before finance
    51: -64,  # finance expenses
    52: 10,  # net monetary position
    53: 210,  # profit before tax
    55: -40,  # current tax
    56: 5,  # deferred tax
    54: -35,  # tax
    57: 175,  # profit from continuing operations
    59: 175,  # profit
    61: 5,  # non-controlling interests
    62: 170,  # parent
}


def make_filing(values, family="general", role="310003", labels=LABELS):
    facts = [
        ParsedFinancialFact(
            company_code="TEST",
            raw_ticker_group="TEST",
            disclosure_id=1,
            year=2026,
            quarter=2,
            consolidation_type="Konsolide",
            template_family=family,
            role_code=role,
            statement_type="INCOME_STATEMENT",
            row_id=f"{family}_role_{role}-row-{row}",
            label_tr=labels.get(row, f"row {row}"),
            footnote_ref=None,
            column_class=COL,
            period_type="YTD_CUMULATIVE",
            period_label="",
            is_restated_comparative=False,
            raw_value=value,
            scale_unit="TL",
            scale_multiplier=1,
            normalized_value_tl=value,
        )
        for row, value in values.items()
    ]
    return ParsedFiling(
        filepath="",
        company_code="TEST",
        raw_ticker_group="TEST",
        disclosure_id=1,
        year=2026,
        quarter=2,
        scale_unit="TL",
        scale_multiplier=1,
        consolidation_type="Konsolide",
        template_family=family,
        role_codes=[role],
        has_tms29_monetary_item=True,
        facts=facts,
    )


def statuses(results):
    return {r.name: r.status for r in results}


def test_consistent_statement_passes():
    results = income_statement_subtotals(make_filing(CONSISTENT))
    assert results
    assert {r.status for r in results} == {"pass"}


def test_moved_value_breaks_the_subtotal():
    # #14 in miniature: row 42's value lands in another row.
    values = dict(CONSISTENT)
    del values[42]
    values[43] = -36
    assert {r.status for r in income_statement_subtotals(make_filing(values))} == {"pass"}
    del values[43]
    failed = [r for r in income_statement_subtotals(make_filing(values)) if r.status == "fail"]
    assert [r.name for r in failed] == ["income_statement_row_49_equals_rows_38+39+40+41+42+43+44+45+46+47+48"]
    assert failed[0].difference == -36


def test_rounding_within_number_of_components():
    values = {**CONSISTENT, 5: 401}  # 3 + 4 = 400, two components allow a difference of 2
    results = income_statement_subtotals(make_filing(values))
    assert statuses(results)["income_statement_row_5_equals_rows_3+4"] == "pass"
    values[5] = 403
    results = income_statement_subtotals(make_filing(values))
    assert statuses(results)["income_statement_row_5_equals_rows_3+4"] == "fail"


def test_total_without_components_is_not_checked():
    # Finance sector revenue and cost reported without their breakdown (rows 7-16 and 18-28 empty).
    values = {**CONSISTENT, 6: 50, 17: -50, 29: 0}
    results = income_statement_subtotals(make_filing(values))
    results = [r for r in results if r.name.startswith("income_statement_row_6_")]
    assert [r.status for r in results] == ["not_checked"]
    assert "components not reported" in results[0].reason


def test_unexpected_label_is_not_checked():
    filing = make_filing(CONSISTENT)
    facts = [
        dataclasses.replace(f, label_tr="Başka Bir Kalem") if f.row_id.endswith("-row-38") else f for f in filing.facts
    ]
    results = income_statement_subtotals(dataclasses.replace(filing, facts=facts))
    assert statuses(results)["income_statement_row_38_equals_rows_31+32+33+34+35+36+37"] == "not_checked"


def test_other_templates_and_empty_filings_are_not_checked():
    (bank,) = income_statement_subtotals(make_filing(CONSISTENT, family="banks", role="310017"))
    assert bank.status == "not_checked"
    (empty,) = income_statement_subtotals(make_filing({}))
    assert empty.status == "not_checked"
    assert "no income statement values" in empty.reason


# A consistent balance sheet: cash 100, trade receivables 50, PP&E 300; trade payables 80, deferred tax 20;
# paid-in capital 300 and profit 50.
BALANCE_SHEET = {
    4: 100,
    24: 50,
    22: 50,
    52: 150,
    55: 150,
    95: 300,
    128: 300,
    129: 450,
    160: 80,
    158: 80,
    188: 80,
    191: 80,
    237: 20,
    241: 20,
    242: 100,
    245: 300,
    294: 50,
    244: 350,
    296: 350,
    297: 450,
}


def balance_sheet(values, family="general"):
    return make_filing(values, family=family, role="210015", labels=BS_LABELS)


def test_consistent_balance_sheet_passes():
    for family in ("general", "holding"):
        results = balance_sheet_subtotals(balance_sheet(BALANCE_SHEET, family))
        assert {r.status for r in results} == {"pass", "not_checked"}
        assert not [r for r in results if r.status == "fail"]
    names = {r.name for r in balance_sheet_subtotals(balance_sheet(BALANCE_SHEET)) if r.status == "pass"}
    assert "balance_sheet_row_297_equals_rows_242+296" in names
    assert "balance_sheet_row_129_equals_rows_55+128" in names


def test_balance_sheet_component_mismatch_fails_only_its_group():
    values = {**BALANCE_SHEET, 24: 60}  # receivables breakdown no longer adds up to row 22
    failed = [r for r in balance_sheet_subtotals(balance_sheet(values)) if r.status == "fail"]
    assert [(r.name, r.difference) for r in failed] == [("balance_sheet_row_22_equals_rows_23+24", -10)]


def test_balance_sheet_other_templates_are_not_checked():
    (bank,) = balance_sheet_subtotals(make_filing(BALANCE_SHEET, family="banks", role="210011", labels=BS_LABELS))
    assert bank.status == "not_checked"


# A consistent cash flow statement. Row 60 (disposal of associates) sits directly under row 6, and row 53
# (disposal of non-current assets) is left empty, as in ODAS and CANTE 2026/2.
CASH_FLOW = {
    4: 100,
    3: 100,
    7: 20,
    60: -10,
    6: 10,
    81: 30,
    65: 30,
    102: 140,
    2: 140,
    134: -50,
    133: -50,
    120: -50,
    179: 40,
    178: 40,
    184: -60,
    183: -60,
    195: -10,
    162: -30,
    204: 60,
    205: -5,
    206: 55,
    207: 100,
    209: 155,
}


def cash_flow(values):
    return make_filing(values, role="520003", labels=CF_LABELS)


def test_consistent_cash_flow_passes():
    results = cash_flow_subtotals(cash_flow(CASH_FLOW))
    assert not [r for r in results if r.status == "fail"]
    names = {r.name for r in results if r.status == "pass"}
    assert "cash_flow_row_102_equals_rows_3+6+65" in names
    assert "cash_flow_row_209_equals_rows_206+207+208" in names
    assert not [r for r in results if r.name.startswith("cash_flow_row_53_")]


def test_unreported_group_total_counts_through_its_components():
    values = dict(CASH_FLOW)
    del values[133]  # capex reported only in its breakdown (row 134)
    results = cash_flow_subtotals(cash_flow(values))
    by_name = {r.name: r for r in results}
    assert by_name["cash_flow_row_133_equals_rows_134+135"].status == "not_checked"
    assert "total not reported" in by_name["cash_flow_row_133_equals_rows_134+135"].reason
    assert not [r for r in results if r.status == "fail"]


def test_cash_flow_mismatch_fails():
    values = {**CASH_FLOW, 209: 160}
    failed = [r for r in cash_flow_subtotals(cash_flow(values)) if r.status == "fail"]
    assert [(r.name, r.difference) for r in failed] == [("cash_flow_row_209_equals_rows_206+207+208", 5)]


KATMR = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "2026_2", "KATMR_1651411_2026_2.xls")


@pytest.mark.skipif(not os.path.exists(KATMR), reason="raw KAP file missing: data/raw/2026_2/KATMR_1651411_2026_2.xls")
def test_katmr_subtotals_pass():
    filing = parse_kap_xls(KATMR)
    results = income_statement_subtotals(filing)
    assert len(results) == 36
    assert {r.status for r in results} == {"pass"}
    assert not [r for r in balance_sheet_subtotals(filing) if r.status == "fail"]
    assert not [r for r in cash_flow_subtotals(filing) if r.status == "fail"]
