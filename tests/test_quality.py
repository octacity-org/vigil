"""Per-file data quality report (#19)."""

import csv
import os

import pytest

import vigil.quality as quality
from vigil.checks import CheckResult

NO_TITLES = """<html><body>
<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
<td class="taxonomy-context-value col-order-class-4"><div>120.759.073</div></td>
</tr></table></body></html>"""


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return str(path)


def fake_groups(monkeypatch, *results):
    monkeypatch.setattr(quality, "GROUPS", {"checks": lambda filing: list(results)})


def test_parse_error_is_reported(tmp_path):
    row = quality.file_quality(write(tmp_path, "TEST_1_2026_2.xls", "<html>no tables</html>"))
    assert row.status == "parse_error"
    assert "ValueError" in row.error


def test_file_without_values_is_reported(tmp_path):
    empty = NO_TITLES.replace("<div>120.759.073</div>", "<div></div>")
    row = quality.file_quality(write(tmp_path, "TEST_2_2026_2.xls", empty))
    assert (row.status, row.facts) == ("no_values", 0)


def test_values_come_from_text_and_title_problems_are_counted(tmp_path):
    # Values shown only as text, without `title` (YONGA 2026/2, #137).
    row = quality.file_quality(write(tmp_path, "TEST_6_2026_2.xls", NO_TITLES))
    assert (row.facts, row.title_disagreements, row.titles_without_text) == (1, 0, 0)
    # A `title` with another number than the text (AVHOL 2026/1, #148).
    other = NO_TITLES.replace("<div>120.759.073</div>", '<div title="123759073">120.759.073</div>')
    row = quality.file_quality(write(tmp_path, "TEST_7_2026_2.xls", other))
    assert (row.facts, row.title_disagreements, row.titles_without_text) == (1, 1, 0)


def test_known_filing_error_is_reported_with_its_reason(tmp_path, monkeypatch):
    fake_groups(monkeypatch, CheckResult("profit", "blocking", "fail", left=-682616, right=0))
    monkeypatch.setattr(quality, "KNOWN_FILING_ERRORS", {(8, "profit"): "row 62 is filed as 0"})
    path = write(tmp_path, "TEST_8_2026_2.xls", NO_TITLES.replace("<div>120.759.073</div>", '<div title="1">1</div>'))
    row = quality.file_quality(path)
    assert (row.status, row.failed, row.known_errors, row.error) == ("known_error", 0, 1, "row 62 is filed as 0")
    summary = quality.markdown_summary([row], "2026_2")
    assert "| known_error | 1 |" in summary
    assert "| TEST_8_2026_2.xls | known_error | row 62 is filed as 0 |" in summary


def test_blocking_failure_fails_the_file(tmp_path, monkeypatch):
    fake_groups(
        monkeypatch,
        CheckResult("a", "blocking", "pass", left=1, right=1),
        CheckResult("b", "blocking", "fail", left=5, right=3, left_source="row-9 col-order-class-4"),
    )
    path = write(tmp_path, "TEST_3_2026_2.xls", NO_TITLES.replace("<div>120.759.073</div>", '<div title="1">1</div>'))
    row = quality.file_quality(path)
    assert (row.status, row.passed, row.failed) == ("fail", 1, 1)
    assert row.first_failure == "b at row-9 col-order-class-4: 5 vs 3 (difference 2)"


def test_informational_difference_does_not_fail_the_file(tmp_path, monkeypatch):
    fake_groups(
        monkeypatch,
        CheckResult("balance", "blocking", "pass", left=1, right=1),
        CheckResult("cash", "informational", "fail", left=5, right=3),
    )
    path = write(tmp_path, "TEST_4_2026_2.xls", NO_TITLES.replace("<div>120.759.073</div>", '<div title="1">1</div>'))
    row = quality.file_quality(path)
    assert (row.status, row.failed, row.informational_differences) == ("pass", 0, 1)
    assert row.counts["checks"] == {"pass": 1, "difference": 1}


def test_nothing_checkable_is_not_checked(tmp_path, monkeypatch):
    fake_groups(monkeypatch, CheckResult("x", "blocking", "not_checked", reason="template 'banks'"))
    path = write(tmp_path, "TEST_5_2026_2.xls", NO_TITLES.replace("<div>120.759.073</div>", '<div title="1">1</div>'))
    assert quality.file_quality(path).status == "not_checked"


def test_csv_and_summary(tmp_path):
    rows = [
        quality.FileQuality(file="A_1_2026_2.xls", status="pass", passed=3, counts={"cash_flow": {"pass": 3}}),
        quality.FileQuality(file="B_2_2026_2.xls", status="no_values", error="the parser found no values"),
    ]
    out = tmp_path / "q.csv"
    quality.write_csv(rows, str(out))
    with open(out, encoding="utf-8", newline="") as f:
        lines = list(csv.DictReader(f))
    assert [(r["file"], r["status"]) for r in lines] == [("A_1_2026_2.xls", "pass"), ("B_2_2026_2.xls", "no_values")]
    rows[0].period_start, rows[0].period_end, rows[0].company = "2026-02-01", "2026-07-31", "MAVI"
    summary = quality.markdown_summary(rows, "2026_2")
    assert "Fiscal year not starting on 1 January: MAVI (2026-02-01 to 2026-07-31)." in summary
    assert "B_2_2026_2.xls (no header dates)" in summary
    assert "| pass | 1 |" in summary
    assert "| cash_flow | 3 | 0 | 0 | 0 |" in summary
    assert "| B_2_2026_2.xls | no_values | the parser found no values |" in summary


KATMR = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "2026_2", "KATMR_1651411_2026_2.xls")


@pytest.mark.skipif(not os.path.exists(KATMR), reason="raw KAP file missing: data/raw/2026_2/KATMR_1651411_2026_2.xls")
def test_katmr_passes():
    row = quality.file_quality(KATMR)
    assert (row.status, row.failed, row.informational_differences) == ("pass", 0, 0)
