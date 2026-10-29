"""Periods come from the column header dates, not from the quarter in the file name (#36).

Synthetic fixtures with the header layout of KAP 2026/2 filings (docs/kap.md).
"""

import datetime

import pytest

from vigil.parser import parse_kap_xls, period_dates

D = datetime.date


def header(*labels):
    return "<tr>" + "".join(f'<td class="context-header"><div>{x}</div></td>' for x in labels) + "</tr>"


def table(role, headers, columns):
    cells = "".join(
        f'<td class="taxonomy-context-value col-order-class-{c}"><div><div title="{c}">{c}</div></div></td>'
        for c in columns
    )
    return (
        f'<table class="financial-table tbl_general_role_{role}" border="1">{headers}'
        f'<tr class="general_role_{role}-row-4 data-input-row presentation-enabled">'
        f'<td><div class="gwt-Label multi-language-content content-tr">Satır</div></td>{cells}</tr></table>'
    )


def parse(tmp_path, quarter, *tables):
    path = tmp_path / f"TEST_1000004_2026_{quarter}.xls"
    html = "<html><body><table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>" + "".join(tables)
    path.write_text(html + "</body></html>", encoding="utf-8")
    return parse_kap_xls(str(path))


def by_column(filing, role):
    return {
        f.column_class[-1]: (f.period_type, f.period_start, f.period_end) for f in filing.facts if f.role_code == role
    }


def test_mavi_special_fiscal_period(tmp_path):
    # MAVI 2026/2: the fiscal year starts on 1 February.
    filing = parse(
        tmp_path,
        2,
        table("210015", header("Cari Dönem <br>31.07.2026", "Önceki Dönem <br>31.01.2026"), [4, 5]),
        table(
            "310003",
            header(
                "Cari Dönem <br>01.02.2026 - 31.07.2026",
                "Önceki Dönem <br>01.02.2025 - 31.07.2025",
                "Cari Dönem 3 Aylık <br>01.05.2026 - 31.07.2026",
                "Önceki Dönem 3 Aylık <br>01.05.2025 - 31.07.2025",
            ),
            [4, 5, 6, 7],
        ),
    )
    assert by_column(filing, "210015") == {
        "4": ("POINT_IN_TIME", None, D(2026, 7, 31)),
        "5": ("POINT_IN_TIME", None, D(2026, 1, 31)),
    }
    assert by_column(filing, "310003") == {
        "4": ("YTD_CUMULATIVE", D(2026, 2, 1), D(2026, 7, 31)),
        "5": ("YTD_CUMULATIVE", D(2025, 2, 1), D(2025, 7, 31)),
        "6": ("Q_STANDALONE", D(2026, 5, 1), D(2026, 7, 31)),
        "7": ("Q_STANDALONE", D(2025, 5, 1), D(2025, 7, 31)),
    }
    assert (filing.period_start, filing.period_end) == (D(2026, 2, 1), D(2026, 7, 31))
    assert (filing.period_months, filing.special_fiscal_period, filing.period_matches_quarter) == (6, True, True)


def test_first_quarter_is_one_quarter(tmp_path):
    filing = parse(
        tmp_path,
        1,
        table(
            "520003",
            header("Cari Dönem <br>01.01.2026 - 31.03.2026", "Önceki Dönem <br>01.01.2025 - 31.03.2025"),
            [4, 5],
        ),
    )
    assert by_column(filing, "520003")["4"] == ("Q_STANDALONE", D(2026, 1, 1), D(2026, 3, 31))
    assert (filing.period_months, filing.special_fiscal_period, filing.period_matches_quarter) == (3, False, True)


def test_header_period_disagreeing_with_file_name_is_flagged(tmp_path):
    # Named as Q3, but the header covers six months.
    filing = parse(
        tmp_path,
        3,
        table(
            "520003",
            header("Cari Dönem <br>01.01.2026 - 30.06.2026", "Önceki Dönem <br>01.01.2025 - 30.06.2025"),
            [4, 5],
        ),
    )
    assert by_column(filing, "520003")["4"] == ("YTD_CUMULATIVE", D(2026, 1, 1), D(2026, 6, 30))
    assert filing.period_matches_quarter is False


def test_no_header_dates(tmp_path):
    filing = parse(tmp_path, 2, table("520003", "", [4]))
    assert by_column(filing, "520003")["4"] == ("YTD_CUMULATIVE", None, None)
    assert (filing.period_start, filing.period_end, filing.period_matches_quarter) == (None, None, None)


@pytest.mark.parametrize(
    "label, expected",
    [
        ("Cari Dönem 01.01.2026 - 30.06.2026", (D(2026, 1, 1), D(2026, 6, 30))),
        ("Önceki Dönem 31.12.2025", (None, D(2025, 12, 31))),
        ("Cari Dönem (TP) 30.06.2026", (None, D(2026, 6, 30))),
        ("col-order-class-10", (None, None)),
        ("30.06.2026 - 01.01.2026", (None, None)),
        ("31.02.2026", (None, None)),
    ],
)
def test_period_dates(label, expected):
    assert period_dates(label) == expected
