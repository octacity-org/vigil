"""A cell without `title` is read from its visible text (#137, decision 0004).

Synthetic fixture modelled on YONGA 2026/2, whose value cells show the number only as text.
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


def test_value_without_title_is_read_from_text(tmp_path):
    filing = parse(
        tmp_path,
        [
            cell(4, '<div class="gwt-Label"> 1.432.817.618 </div>'),
            cell(5, '<div class="gwt-Label"> -27.026.098 </div>'),
            cell(6, '<div class="gwt-Label"> 0 </div>'),
        ],
    )
    values = {f.column_class: f.raw_value for f in filing.facts}
    assert values == {"col-order-class-4": 1432817618, "col-order-class-5": -27026098, "col-order-class-6": 0}
    assert (filing.text_values, filing.text_disagreements) == (3, 0)


def test_title_wins_and_disagreement_is_counted(tmp_path):
    # MNDTR 2026/2 shows a different number than its `title` in nine income statement cells.
    filing = parse(
        tmp_path,
        [
            cell(4, '<div class="gwt-Label" title="83028439"> 83.085.244 </div>'),
            cell(5, '<div class="gwt-Label" title="45507361"> 45.507.361 </div>'),
        ],
    )
    values = {f.column_class: f.raw_value for f in filing.facts}
    assert values == {"col-order-class-4": 83028439, "col-order-class-5": 45507361}
    assert (filing.text_values, filing.text_disagreements) == (0, 1)


def test_empty_cell_stays_empty(tmp_path):
    filing = parse(tmp_path, [cell(4, '<div class="gwt-Label"></div>'), cell(5, '<div class="gwt-Label"> 7 </div>')])
    assert [(f.column_class, f.raw_value) for f in filing.facts] == [("col-order-class-5", 7)]


@pytest.mark.parametrize("text", ["1,5", "(1.000)", "1.000,50", "12.34", "abc", "1 000"])
def test_unknown_text_format_fails_loudly(tmp_path, text):
    with pytest.raises(ValueError, match="Unexpected value text"):
        parse(tmp_path, [cell(4, f'<div class="gwt-Label"> {text} </div>')])


def test_unknown_text_next_to_a_title_only_counts_as_disagreement(tmp_path):
    filing = parse(tmp_path, [cell(4, '<div class="gwt-Label" title="1500"> 1.500,00 </div>')])
    assert [f.raw_value for f in filing.facts] == [1500]
    assert filing.text_disagreements == 1
