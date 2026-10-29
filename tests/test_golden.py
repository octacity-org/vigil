"""Compare parser output with hand-copied golden values (tests/golden/README.md)."""

import csv
import functools
import os
from collections import defaultdict

import pytest

from vigil.parser import parse_kap_xls

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.join(TESTS_DIR, "golden")
RAW_DIR = os.path.join(TESTS_DIR, "..", "data", "raw")

# Golden rows the parser is known to get wrong. strict=True turns the test into a
# failure once the bug is fixed, so the marker gets removed.
KNOWN_BUGS: dict = {}


def _golden_rows():
    """Group golden CSV lines by (filing, row_id)."""
    groups = defaultdict(list)
    for quarter_dir in sorted(os.listdir(GOLDEN_DIR)):
        path = os.path.join(GOLDEN_DIR, quarter_dir)
        if not os.path.isdir(path):
            continue
        for name in sorted(os.listdir(path)):
            if not name.endswith(".csv"):
                continue
            with open(os.path.join(path, name), encoding="utf-8", newline="") as f:
                for line in csv.DictReader(f):
                    groups[(name[:-4], line["row_id"])].append(line)
    return groups


def _params():
    params = []
    for (filing, row_id), lines in _golden_rows().items():
        marks = []
        if (filing, row_id) in KNOWN_BUGS:
            marks.append(pytest.mark.xfail(strict=True, reason=KNOWN_BUGS[(filing, row_id)]))
        params.append(pytest.param(lines, id=f"{filing}-{row_id}", marks=marks))
    return params


def _raw_path(line):
    year, quarter = line["year"], line["quarter"]
    name = f"{line['company']}_{line['disclosure_id']}_{year}_{quarter}.xls"
    return os.path.join(RAW_DIR, f"{year}_{quarter}", name)


@functools.lru_cache(maxsize=None)
def _parse(path):
    return parse_kap_xls(path)


@pytest.mark.parametrize("lines", _params())
def test_golden_row(lines):
    path = _raw_path(lines[0])
    if not os.path.exists(path):
        pytest.skip(f"raw KAP file missing: data/raw/{os.path.relpath(path, RAW_DIR).replace(os.sep, '/')}")

    filing = _parse(path)
    facts = {f.column_class: f for f in filing.facts if f.row_id == lines[0]["row_id"]}

    for line in lines:
        fact = facts.get(line["column"])
        where = f"{line['row_id']} {line['column']}"
        if line["raw_value"] == "":
            assert fact is None, f"{where}: expected empty cell, parser gave {fact.raw_value}"
            continue
        assert fact is not None, f"{where}: expected {line['raw_value']}, parser gave nothing"
        assert fact.raw_value == int(line["raw_value"]), where
        assert fact.normalized_value_tl == int(line["value_tl"]), where
        assert fact.scale_unit == line["scale_unit"], where
        assert fact.period_label == line["period_label"], where
        assert fact.label_tr == line["row_label"], where
