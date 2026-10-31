"""`tests/raw_files.txt` lists every raw file the golden tests need, so CI downloads them (#128)."""

import csv
import glob
import os

from vigil.downloader import read_file_list

TESTS_DIR = os.path.dirname(__file__)


def listed():
    wanted = read_file_list(os.path.join(TESTS_DIR, "raw_files.txt"))
    return {f"{year}_{quarter}/{name}" for (year, quarter), names in wanted.items() for name in names}


def test_every_golden_file_has_its_raw_file_listed():
    needed = set()
    for path in glob.glob(os.path.join(TESTS_DIR, "golden", "*", "*.csv")):
        with open(path, encoding="utf-8", newline="") as f:
            for line in csv.DictReader(f):
                year, quarter = line["year"], line["quarter"]
                needed.add(f"{year}_{quarter}/{line['company']}_{line['disclosure_id']}_{year}_{quarter}.xls")
    assert needed, "no golden files found"
    assert needed - listed() == set()


def test_read_file_list(tmp_path):
    path = tmp_path / "files.txt"
    path.write_text(
        "# comment\n\n2026_2/A_1_2026_2.xls\n2026_1/B_2_2026_1.xls  # why\n2026_2/C_3_2026_2.xls\n", encoding="utf-8"
    )
    assert read_file_list(str(path)) == {(2026, 2): ["A_1_2026_2.xls", "C_3_2026_2.xls"], (2026, 1): ["B_2_2026_1.xls"]}
