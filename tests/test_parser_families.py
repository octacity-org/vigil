"""Template families: `par-banks` is read (#124), an unknown family fails loudly.

Synthetic fixture with the layout of ALBRK 2026/2 (participation bank, TP / YP / Toplam balance sheet).
"""

import glob
import os

import pytest

from vigil.parser import parse_kap_xls
from vigil.signals import detect_restatement_tripwire


def filing(family):
    cells = "".join(
        f'<td class="taxonomy-context-value col-order-class-{c}"><div><div title="{v}">{v}</div></div></td>'
        for c, v in zip(range(4, 10), (301992, 239721, 541713, 246018, 224981, 470999))
    )
    headers = "".join(
        f'<td class="context-header"><div>{h}</div></td>'
        for h in (
            "Cari Dönem <br>30.06.2026",
            "Önceki Dönem <br>31.12.2025",
            "TP",
            "YP",
            "Toplam",
            "TP",
            "YP",
            "Toplam",
        )
    )
    return (
        "<html><body><table><tr><td>Sunum Para Birimi</td><td>1.000.000 TL</td></tr></table>"
        f'<table class="financial-table tbl_{family}_role_210013" border="1"><tr>{headers}</tr>'
        f'<tr class="{family}_role_210013-row-49 data-input-row presentation-enabled">'
        f'<td><div class="gwt-Label multi-language-content content-tr">VARLIKLAR TOPLAMI</div></td>{cells}</tr>'
        "</table></body></html>"
    )


def parse(tmp_path, family):
    path = tmp_path / "ALBRK-ALK_1644748_2026_2.xls"
    path.write_text(filing(family), encoding="utf-8")
    return parse_kap_xls(str(path))


def test_par_banks_is_read_like_banks(tmp_path):
    f = parse(tmp_path, "par-banks")
    assert f.template_family == "par-banks"
    assert {x.row_id for x in f.facts} == {"par-banks_role_210013-row-49"}
    by_column = {x.column_class[-1]: (x.period_type, x.raw_value) for x in f.facts}
    assert by_column == {
        "4": ("POINT_IN_TIME_TP", 301992),
        "5": ("POINT_IN_TIME_YP", 239721),
        "6": ("POINT_IN_TIME", 541713),
        "7": ("POINT_IN_TIME_TP", 246018),
        "8": ("POINT_IN_TIME_YP", 224981),
        "9": ("POINT_IN_TIME", 470999),
    }
    assert f.facts[0].normalized_value_tl == 301992 * 1_000_000


def test_par_banks_total_column_is_not_a_restatement(tmp_path):
    # Column 6 is the current total in a TP / YP / Toplam balance sheet, not a third period.
    assert detect_restatement_tripwire(parse(tmp_path, "par-banks")) is None


@pytest.mark.parametrize("family", ["new-family", "leasing"])
def test_unknown_family_fails_loudly(tmp_path, family):
    with pytest.raises(ValueError, match=f"Unknown template family {family}"):
        parse(tmp_path, family)


RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
ALBRK = sorted(glob.glob(os.path.join(RAW, "2026_*", "ALBRK-ALK_*.xls")))


@pytest.mark.skipif(not ALBRK, reason="raw ALBRK files missing: data/raw/2026_*/ALBRK-ALK_*.xls")
@pytest.mark.parametrize("path", ALBRK)
def test_albrk_key_totals(path):
    f = parse_kap_xls(path)

    def value(role, label, col):
        (v,) = [x.raw_value for x in f.facts if x.role_code == role and x.label_tr == label and x.column_class == col]
        return v

    for col in ("col-order-class-6", "col-order-class-9"):
        assert value("210013", "VARLIKLAR TOPLAMI", col) == value("210013", "YÜKÜMLÜLÜKLER TOPLAMI", col)
    assert value("310019", "DÖNEM NET KARI VEYA ZARARI", "col-order-class-4") == value(
        "210013", "Dönem Net Kâr veya Zararı", "col-order-class-6"
    )
