"""Income statement subtotals recomputed from their components (#15)."""

import dataclasses
import os

import pytest

from vigil.checks import INCOME_STATEMENT_SUBTOTALS, income_statement_subtotals
from vigil.parser import ParsedFiling, ParsedFinancialFact, parse_kap_xls

LABELS = {row: label for row, label, _ in INCOME_STATEMENT_SUBTOTALS}
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


def make_filing(values, family="general", role="310003"):
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
            label_tr=LABELS.get(row, f"row {row}"),
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


KATMR = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "2026_2", "KATMR_1651411_2026_2.xls")


@pytest.mark.skipif(not os.path.exists(KATMR), reason="raw KAP file missing: data/raw/2026_2/KATMR_1651411_2026_2.xls")
def test_katmr_subtotals_pass():
    results = income_statement_subtotals(parse_kap_xls(KATMR))
    assert len(results) == 36
    assert {r.status for r in results} == {"pass"}
