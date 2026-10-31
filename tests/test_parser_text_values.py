"""Values come from the visible text of a cell, not from its `title` (#137, #148, decision 0005).

Synthetic fixtures modelled on YONGA 2026/2 (no `title` at all), AVHOL 2026/1 (a `title` with another number)
and ZOREN 2026/2 (a `title` on a cell whose number is shown in the next row).
"""

import pytest

from vigil.parser import parse_kap_xls

HEAD = """<html><body>
<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
"""
TAIL = "</tr></table></body></html>"


def cell(col, inner):
    return f'<td class="taxonomy-context-value col-order-class-{col}"><div>{inner}</div></td>\n'


def parse(tmp_path, cells):
    path = tmp_path / "TEST_1000003_2026_2.xls"
    path.write_text(HEAD + "".join(cells) + TAIL, encoding="utf-8")
    return parse_kap_xls(str(path))


def values(filing):
    return {f.column_class: f.raw_value for f in filing.facts}


def test_value_without_title_is_read_from_text(tmp_path):
    filing = parse(
        tmp_path,
        [
            cell(4, '<div class="gwt-Label"> 1.432.817.618 </div>'),
            cell(5, '<div class="gwt-Label"> -27.026.098 </div>'),
            cell(6, '<div class="gwt-Label"> 0 </div>'),
        ],
    )
    assert values(filing) == {"col-order-class-4": 1432817618, "col-order-class-5": -27026098, "col-order-class-6": 0}
    assert (filing.title_disagreements, filing.titles_without_text) == (0, 0)


def test_text_wins_over_a_different_title(tmp_path):
    # AVHOL 2026/1, row 246 of the balance sheet: the text adds up to its total, the `title` is 3,000,000 more.
    filing = parse(
        tmp_path,
        [
            cell(4, '<div class="gwt-Label" title="468518587"> 465.518.587 </div>'),
            cell(5, '<div class="gwt-Label" title="45507361"> 45.507.361 </div>'),
        ],
    )
    assert values(filing) == {"col-order-class-4": 465518587, "col-order-class-5": 45507361}
    assert (filing.title_disagreements, filing.titles_without_text) == (1, 0)


def test_title_without_text_is_empty(tmp_path):
    # ZOREN 2026/2: the `title` of row 140 holds the number that row 141 shows.
    filing = parse(
        tmp_path,
        [cell(4, '<div class="gwt-Label" title="1248245"></div>'), cell(5, '<div class="gwt-Label"> 7 </div>')],
    )
    assert values(filing) == {"col-order-class-5": 7}
    assert (filing.title_disagreements, filing.titles_without_text) == (0, 1)


def test_empty_cell_stays_empty(tmp_path):
    filing = parse(tmp_path, [cell(4, '<div class="gwt-Label"></div>'), cell(5, '<div class="gwt-Label"> 7 </div>')])
    assert [(f.column_class, f.raw_value) for f in filing.facts] == [("col-order-class-5", 7)]


@pytest.mark.parametrize("text", ["1,5", "(1.000)", "1.000,50", "12.34", "abc", "1 000"])
@pytest.mark.parametrize("title", ["", ' title="1000"'])
def test_unknown_text_format_fails_loudly(tmp_path, text, title):
    with pytest.raises(ValueError, match="Unexpected value text"):
        parse(tmp_path, [cell(4, f'<div class="gwt-Label"{title}> {text} </div>')])
