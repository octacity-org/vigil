"""Value cells are read one by one: an empty cell must stay empty (#14).

Synthetic fixture with the same row and cell structure as a KAP income statement (docs/kap.md),
modelled on KATMR 2026/2 row 42, where the 2026 cells are empty and the 2025 cells hold a value.
"""

from vigil.parser import parse_kap_xls

FILING = """<html><body>
<table><tr><td>Sunum Para Birimi</td><td>TL</td><td>Finansal Tablo Niteliği</td><td>Konsolide</td></tr></table>
<table class="financial-table tbl_general_role_310003" border="1">
<tr>
<td class="context-header"><div>Cari Dönem <br>01.01.2026 - 30.06.2026</div></td>
<td class="context-header"><div>Önceki Dönem <br>01.01.2025 - 30.06.2025</div></td>
<td class="context-header"><div>Cari Dönem 3 Aylık <br>01.04.2026 - 30.06.2026</div></td>
<td class="context-header"><div>Önceki Dönem 3 Aylık <br>01.04.2025 - 30.06.2025</div></td>
</tr>
<tr class="general_role_310003-row-42 data-input-row presentation-enabled">
<td><table><tr><td>
<div class="gwt-Label multi-language-content content-tr">Yatırım Faaliyetlerinden Giderler</div>
</td></tr></table></td>
<td class="taxonomy-context-value col-order-class-4"><div><div class="gwt-Label"></div></div></td>
<td class="taxonomy-context-value col-order-class-5">
<div><div class="gwt-Label" title="-36464628">-36.464.628</div></div></td>
<td class="taxonomy-context-value col-order-class-6"><div><div class="gwt-Label"></div></div></td>
<td class="taxonomy-context-value col-order-class-7">
<div><div class="gwt-Label" title="-36464628">-36.464.628</div></div></td>
</tr>
</table></body></html>"""


def test_empty_cells_stay_empty(tmp_path):
    path = tmp_path / "TEST_1000002_2026_2.xls"
    path.write_text(FILING, encoding="utf-8")
    facts = {f.column_class: f.raw_value for f in parse_kap_xls(str(path)).facts}
    assert facts == {"col-order-class-5": -36464628, "col-order-class-7": -36464628}
