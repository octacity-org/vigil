"""Publication time from the file header orders report versions (#157, decision 0002).

`Gönderim Tarihi` in a KAP file header equals `publishDate` in the disclosure list (all 778 files of 2026/2).
"""

import datetime

import pytest

from vigil.parser import ParsedFiling, ParsedFinancialFact, parse_kap_xls

T = datetime.datetime

BODY = (
    "<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>"
    '<table class="financial-table tbl_general_role_210015" border="1">'
    '<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>'
    '<tr class="general_role_210015-row-4 data-input-row presentation-enabled">'
    '<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>'
    '<td class="taxonomy-context-value col-order-class-4"><div><div title="7">7</div></div></td></tr></table>'
)


def parse(tmp_path, header):
    path = tmp_path / "KATMR_1651411_2026_2.xls"
    # Layout of the KAP header: company and "Finansal Rapor" titles, then one <div> per field.
    path.write_text(
        '<html><body><h1 style="font-size: medium">Finansal Rapor</h1>'
        f"{header}<div> Bildirim Tipi:FR </div>{BODY}</body></html>",
        encoding="utf-8",
    )
    return parse_kap_xls(str(path))


def test_publication_time_is_read_from_the_header(tmp_path):
    filing = parse(tmp_path, "<div> Gönderim Tarihi:17.08.2026 19:05:18 </div>")
    assert filing.published_at == T(2026, 8, 17, 19, 5, 18)


def test_missing_publication_time_fails_loudly(tmp_path):
    with pytest.raises(ValueError, match="Gönderim Tarihi"):
        parse(tmp_path, "")


@pytest.mark.parametrize("value", ["17.08.2026", "2026-08-17 19:05:18", "17.08.2026 19:05", ""])
def test_unexpected_publication_time_fails_loudly(tmp_path, value):
    with pytest.raises(ValueError, match="publication time"):
        parse(tmp_path, f"<div> Gönderim Tarihi:{value} </div>")


# --- versions ---------------------------------------------------------------------------------------------

duckdb = pytest.importorskip("duckdb")

from vigil import db  # noqa: E402


def filing(disclosure_id, value, published_at, year=2026, quarter=2):
    fact = ParsedFinancialFact(
        company_code="TEST",
        raw_ticker_group="TEST",
        disclosure_id=disclosure_id,
        year=year,
        quarter=quarter,
        consolidation_type="Konsolide",
        template_family="general",
        role_code="210015",
        statement_type="BALANCE_SHEET",
        row_id="general_role_210015-row-4",
        label_tr="Nakit ve Nakit Benzerleri",
        footnote_ref=None,
        column_class="col-order-class-4",
        period_type="POINT_IN_TIME",
        period_label="Cari Dönem 30.06.2026",
        is_restated_comparative=False,
        raw_value=value,
        scale_unit="TL",
        scale_multiplier=1,
        normalized_value_tl=value,
        period_start=None,
        period_end=datetime.date(2026, 6, 30),
    )
    return ParsedFiling(
        filepath=f"TEST_{disclosure_id}_{year}_{quarter}.xls",
        company_code="TEST",
        raw_ticker_group="TEST",
        disclosure_id=disclosure_id,
        year=year,
        quarter=quarter,
        scale_unit="TL",
        scale_multiplier=1,
        consolidation_type="Konsolide",
        template_family="general",
        role_codes=["210015"],
        has_tms29_monetary_item=False,
        facts=[fact],
        published_at=published_at,
    )


@pytest.fixture
def con():
    c = db.connect(":memory:")
    yield c
    c.close()


def versions(con):
    return con.execute(
        "SELECT disclosure_id, published_at, version_no FROM fact_versions ORDER BY version_no"
    ).fetchall()


def test_versions_in_one_period_follow_publication_not_disclosure_id(con):
    # Disclosure 10 was published before disclosure 9: publication order wins.
    db.load_filing(con, filing(9, 100, T(2026, 8, 18, 10, 0, 0)))
    db.load_filing(con, filing(10, 110, T(2026, 8, 17, 19, 0, 0)))

    assert versions(con) == [(10, T(2026, 8, 17, 19, 0, 0), 1), (9, T(2026, 8, 18, 10, 0, 0), 2)]
    assert con.execute("SELECT disclosure_id, raw_value FROM facts_latest").fetchall() == [(9, 100)]


def test_report_period_still_comes_first(con):
    # A 2026/1 report published after the 2026/2 one stays the earlier version.
    db.load_filing(con, filing(2, 120, T(2026, 8, 17, 19, 0, 0), quarter=2))
    db.load_filing(con, filing(1, 110, T(2026, 9, 1, 12, 0, 0), quarter=1))

    assert [(d, v) for d, _, v in versions(con)] == [(1, 1), (2, 2)]


def test_disclosure_id_breaks_ties_and_unknown_times_come_last(con):
    same = T(2026, 8, 17, 19, 0, 0)
    db.load_filing(con, filing(8, 100, None))
    db.load_filing(con, filing(7, 100, same))
    db.load_filing(con, filing(6, 100, same))

    assert [(d, v) for d, _, v in versions(con)] == [(6, 1), (7, 2), (8, 3)]


def test_database_from_before_157_gets_the_column(tmp_path):
    path = str(tmp_path / "old.duckdb")
    old = duckdb.connect(path)
    old.execute(
        "CREATE TABLE reports (disclosure_id BIGINT PRIMARY KEY, company_code VARCHAR NOT NULL, "
        "raw_ticker_group VARCHAR NOT NULL, year INTEGER NOT NULL, quarter INTEGER NOT NULL, "
        "consolidation_type VARCHAR NOT NULL, template_family VARCHAR NOT NULL, scale_unit VARCHAR NOT NULL, "
        "scale_multiplier BIGINT NOT NULL, has_tms29_monetary_item BOOLEAN NOT NULL, filepath VARCHAR NOT NULL, "
        "fact_count INTEGER NOT NULL, loaded_at TIMESTAMP NOT NULL)"
    )
    old.close()

    con = db.connect(path)
    db.load_filing(con, filing(1, 100, T(2026, 8, 17, 19, 5, 18)))
    assert con.execute("SELECT published_at FROM reports").fetchall() == [(T(2026, 8, 17, 19, 5, 18),)]
    con.close()
