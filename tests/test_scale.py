"""Scale detection: the cell `title` is unscaled and must be multiplied by `Sunum Para Birimi` (#35).

The fixtures are synthetic: a minimal file with the same header and table structure as a KAP file
(see docs/kap.md), so no KAP content is committed (#128). Real files are covered by tests/test_golden.py.
"""

import pytest

from vigil.parser import parse_kap_xls

TEMPLATE = """<html><head><meta http-equiv="Content-Type" content="text/html;" charset="utf-8"></head><body>
<table><tr>{unit_cells}<td>Finansal Tablo Niteliği</td><td>Konsolide</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
<td class="taxonomy-context-value col-order-class-4"><div title="39369">39.369</div></td>
</tr></table></body></html>"""


def write_filing(tmp_path, unit_cells):
    path = tmp_path / "TEST_1000001_2026_2.xls"
    path.write_text(TEMPLATE.format(unit_cells=unit_cells), encoding="utf-8")
    return str(path)


def unit_header(unit):
    return f"<td>Sunum Para Birimi</td><td>{unit}</td>"


@pytest.mark.parametrize(
    ("unit", "multiplier"),
    [("TL", 1), ("1.000 TL", 1_000), ("1.000.000 TL", 1_000_000)],
)
def test_known_units(tmp_path, unit, multiplier):
    filing = parse_kap_xls(write_filing(tmp_path, unit_header(unit)))
    assert filing.scale_unit == unit
    assert filing.scale_multiplier == multiplier
    (fact,) = filing.facts
    assert fact.raw_value == 39369
    assert fact.normalized_value_tl == 39369 * multiplier


def test_missing_unit_raises(tmp_path):
    with pytest.raises(ValueError, match="Sunum Para Birimi"):
        parse_kap_xls(write_filing(tmp_path, ""))


def test_unknown_unit_raises(tmp_path):
    with pytest.raises(ValueError, match="1.000 USD"):
        parse_kap_xls(write_filing(tmp_path, unit_header("1.000 USD")))
