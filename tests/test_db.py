"""Bitemporal schema and DuckDB loader (#121, #122, tests in #123).

Filings are built by hand and loaded into an in-memory database, so the tests run in CI without KAP data.
Expected values are written in the tests, not taken from the loader's output.
"""

import dataclasses
import datetime
import os

import pytest

duckdb = pytest.importorskip("duckdb")

from vigil import db  # noqa: E402
from vigil.parser import ParsedFiling, ParsedFinancialFact  # noqa: E402

D = datetime.date
BS_ROW = "general_role_210015-row-4"


def fact(
    disclosure_id,
    raw_value,
    column="col-order-class-5",
    row_id=BS_ROW,
    period_type="POINT_IN_TIME",
    start=None,
    end=D(2025, 12, 31),
):
    return ParsedFinancialFact(
        company_code="TEST",
        raw_ticker_group="TEST",
        disclosure_id=disclosure_id,
        year=2026,
        quarter=2,
        consolidation_type="Konsolide",
        template_family="general",
        role_code=row_id.split("_role_")[1][:6],
        statement_type="BALANCE_SHEET",
        row_id=row_id,
        label_tr="Nakit ve Nakit Benzerleri",
        footnote_ref=None,
        column_class=column,
        period_type=period_type,
        period_label="Önceki Dönem 31.12.2025",
        is_restated_comparative=True,
        raw_value=raw_value,
        scale_unit="TL",
        scale_multiplier=1,
        normalized_value_tl=raw_value,
        period_start=start,
        period_end=end,
    )


def filing(disclosure_id, year, quarter, facts, consolidation="Konsolide"):
    facts = [
        dataclasses.replace(
            f, disclosure_id=disclosure_id, year=year, quarter=quarter, consolidation_type=consolidation
        )
        for f in facts
    ]
    return ParsedFiling(
        filepath=f"TEST_{disclosure_id}_{year}_{quarter}.xls",
        company_code="TEST",
        raw_ticker_group="TEST",
        disclosure_id=disclosure_id,
        year=year,
        quarter=quarter,
        scale_unit="TL",
        scale_multiplier=1,
        consolidation_type=consolidation,
        template_family="general",
        role_codes=["210015"],
        has_tms29_monetary_item=False,
        facts=facts,
    )


@pytest.fixture
def con():
    c = db.connect(":memory:")
    yield c
    c.close()


def rows(con, sql):
    return con.execute(sql).fetchall()


def count(con, table):
    return rows(con, f"SELECT count(*) FROM {table}")[0][0]


# --- versions ---------------------------------------------------------------------------------------------


def test_same_fact_in_two_reports_gets_versions_1_and_2(con):
    # 31.12.2025 cash: 100 as first reported in 2026/1, restated to 110 in 2026/2.
    db.load_filing(con, filing(2, 2026, 2, [fact(0, 110)]))
    db.load_filing(con, filing(1, 2026, 1, [fact(0, 100)]))

    assert rows(con, "SELECT disclosure_id, version_no, version_count FROM fact_versions ORDER BY 1") == [
        (1, 1, 2),
        (2, 2, 2),
    ]
    assert rows(con, "SELECT disclosure_id, raw_value FROM facts_first_reported") == [(1, 100)]
    assert rows(con, "SELECT disclosure_id, raw_value FROM facts_latest") == [(2, 110)]


def test_versions_follow_report_period_not_load_order(con):
    # Loaded newest first: 2025/4 must still be version 1.
    db.load_filing(con, filing(3, 2026, 2, [fact(0, 120)]))
    db.load_filing(con, filing(2, 2026, 1, [fact(0, 110)]))
    db.load_filing(con, filing(1, 2025, 4, [fact(0, 100)]))

    assert rows(con, "SELECT reported_year, reported_quarter, version_no FROM fact_versions ORDER BY 3") == [
        (2025, 4, 1),
        (2026, 1, 2),
        (2026, 2, 3),
    ]


# --- fact identity ----------------------------------------------------------------------------------------


def test_tp_yp_and_total_are_separate_facts(con):
    facts = [
        fact(0, 60, column="col-order-class-4", period_type="POINT_IN_TIME_TP"),
        fact(0, 40, column="col-order-class-5", period_type="POINT_IN_TIME_YP"),
        fact(0, 100, column="col-order-class-6", period_type="POINT_IN_TIME"),
    ]
    db.load_filing(con, filing(1, 2026, 1, facts))
    # The next report carries only the total, so only the total gets a second version.
    db.load_filing(con, filing(2, 2026, 2, [fact(0, 100, column="col-order-class-6")]))

    assert rows(
        con,
        "SELECT currency_part, disclosure_id, raw_value, version_no, version_count FROM fact_versions ORDER BY 1, 2",
    ) == [
        ("TOTAL", 1, 100, 1, 2),
        ("TOTAL", 2, 100, 2, 2),
        ("TP", 1, 60, 1, 1),
        ("YP", 1, 40, 1, 1),
    ]
    assert count(con, "fact_conflicts") == 0


def test_consolidated_and_solo_are_separate_facts(con):
    db.load_filing(con, filing(1, 2026, 2, [fact(0, 100)], consolidation="Konsolide"))
    db.load_filing(con, filing(2, 2026, 2, [fact(0, 70)], consolidation="Konsolide Olmayan"))

    assert rows(con, "SELECT consolidation_type, raw_value, version_no FROM fact_versions ORDER BY 1") == [
        ("Konsolide", 100, 1),
        ("Konsolide Olmayan", 70, 1),
    ]


def test_null_period_end_is_kept_in_facts_but_not_versioned(con):
    facts = [fact(0, 100), fact(0, 5, column="col-order-class-10", end=None)]
    db.load_filing(con, filing(1, 2026, 2, facts))

    assert count(con, "facts") == 2
    assert rows(con, "SELECT column_class FROM fact_versions") == [("col-order-class-5",)]
    assert rows(con, "SELECT column_class FROM facts_first_reported") == [("col-order-class-5",)]
    assert rows(con, "SELECT column_class FROM facts_latest") == [("col-order-class-5",)]


# --- fact_conflicts ---------------------------------------------------------------------------------------


def q1_income_facts(cumulative, three_month):
    # In a Q1 report the cumulative and the 3-month column cover the same months.
    row = "general_role_310003-row-3"
    start, end = D(2026, 1, 1), D(2026, 3, 31)
    return [
        fact(0, cumulative, column="col-order-class-4", row_id=row, period_type="Q_STANDALONE", start=start, end=end),
        fact(0, three_month, column="col-order-class-6", row_id=row, period_type="Q_STANDALONE", start=start, end=end),
    ]


def test_conflict_listed_when_one_report_has_two_values(con):
    db.load_filing(con, filing(1, 2026, 1, q1_income_facts(500, 450)))

    assert rows(con, "SELECT disclosure_id, column_classes, raw_values FROM fact_conflicts") == [
        (1, ["col-order-class-4", "col-order-class-6"], [500, 450]),
    ]
    # Both rows belong to the same version.
    assert rows(con, "SELECT DISTINCT version_no, version_count FROM fact_versions") == [(1, 1)]


def test_no_conflict_when_values_are_equal(con):
    db.load_filing(con, filing(1, 2026, 1, q1_income_facts(500, 500)))

    assert count(con, "fact_conflicts") == 0


def test_restatement_across_reports_is_not_a_conflict(con):
    db.load_filing(con, filing(1, 2026, 1, [fact(0, 100)]))
    db.load_filing(con, filing(2, 2026, 2, [fact(0, 110)]))

    assert count(con, "fact_conflicts") == 0


# --- idempotency and rollback -----------------------------------------------------------------------------


def test_loading_the_same_filing_twice_gives_the_same_counts(con):
    f = filing(1, 2026, 2, [fact(0, 100), fact(0, 200, column="col-order-class-4", end=D(2026, 6, 30))])
    db.load_filing(con, f)
    db.load_filing(con, f)

    assert (count(con, "companies"), count(con, "reports"), count(con, "facts")) == (1, 1, 2)
    assert rows(con, "SELECT fact_count FROM reports") == [(2,)]


def test_failing_insert_keeps_the_previous_version(con):
    db.load_filing(con, filing(1, 2026, 2, [fact(0, 100)]))

    # Two facts with the same (row_id, column_class) break the facts primary key in the middle of the load.
    broken = filing(1, 2026, 2, [fact(0, 999), fact(0, 999)])
    with pytest.raises(duckdb.Error):
        db.load_filing(con, broken)

    assert rows(con, "SELECT disclosure_id, raw_value FROM facts") == [(1, 100)]
    assert rows(con, "SELECT disclosure_id, fact_count FROM reports") == [(1, 1)]


# --- parse report and stale reports -----------------------------------------------------------------------


def kap_html(rows_html, unit="TL"):
    head = f"<tr><td>Sunum Para Birimi</td><td>{unit}</td></tr>" if unit else ""
    return (
        f"<html><body><table>{head}</table>"
        '<table class="financial-table tbl_general_role_210015" border="1">'
        '<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>'
        f"{rows_html}</table></body></html>"
    )


def kap_row(n, value):
    return (
        f'<tr class="general_role_210015-row-{n} data-input-row presentation-enabled">'
        '<td><div class="gwt-Label multi-language-content content-tr">Satır</div></td>'
        f'<td class="taxonomy-context-value col-order-class-4"><div><div title="{value}">{value}</div></div></td></tr>'
    )


def write(path, html):
    path.write_text(html, encoding="utf-8")


def statuses(report):
    return sorted((os.path.basename(f.filepath), f.status) for f in report.files)


def test_duplicate_disclosure_and_duplicate_keys_are_reported_not_loaded(tmp_path, con):
    write(tmp_path / "AAA_1001_2026_2.xls", kap_html(kap_row(4, 100)))
    write(tmp_path / "BBB_1001_2026_2.xls", kap_html(kap_row(4, 200)))  # same disclosure id as AAA
    write(tmp_path / "CCC_1002_2026_2.xls", kap_html(kap_row(4, 300) + kap_row(4, 301)))  # same cell twice

    filings, report = db.parse_directory(str(tmp_path))
    db.load_filings(con, filings, report)

    assert statuses(report) == [
        ("AAA_1001_2026_2.xls", "ok"),
        ("BBB_1001_2026_2.xls", "duplicate_disclosure"),
        ("CCC_1002_2026_2.xls", "duplicate_facts"),
    ]
    assert [f.disclosure_id for f in report.failed_files] == [1001, 1002]
    assert rows(con, "SELECT disclosure_id, raw_value FROM facts") == [(1001, 100)]
    assert db.count_mismatches(con, report) == []


def test_file_that_fails_on_the_next_run_is_flagged_as_stale(tmp_path, con):
    path = tmp_path / "AAA_1001_2026_2.xls"
    write(path, kap_html(kap_row(4, 100)))
    filings, report = db.parse_directory(str(tmp_path))
    db.load_filings(con, filings, report)
    assert db.stale_reports(con, report) == []

    write(path, kap_html(kap_row(4, 100), unit=None))  # reporting unit removed: the parser now raises
    filings, report = db.parse_directory(str(tmp_path))
    db.load_filings(con, filings, report)

    assert statuses(report) == [("AAA_1001_2026_2.xls", "parse_error")]
    assert db.stale_reports(con, report) == [(str(path), 1001)]
    # The rows from the first run are still there; flagging them is the point.
    assert rows(con, "SELECT disclosure_id, raw_value FROM facts") == [(1001, 100)]
