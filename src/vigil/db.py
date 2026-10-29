"""Load parsed KAP filings into the bitemporal DuckDB schema (issue #46; schema in vigil.schema, docs/SCHEMA.md).

`period_start` / `period_end` come from the column header dates, never from the quarter number
(special fiscal periods such as MAVI). If a header has no dates they are NULL.

Loading is idempotent: each filing is replaced as a whole, keyed by its disclosure id.
"""

from __future__ import annotations

import dataclasses
import datetime
import glob
import os
from typing import Dict, List, Optional, Tuple

from vigil.parser import ParsedFiling, parse_filename, parse_kap_xls
from vigil.schema import SCHEMA_SQL

try:
    import duckdb
except ImportError:  # pragma: no cover - optional dependency
    duckdb = None

FACT_COLUMNS = (
    "disclosure_id",
    "row_id",
    "column_class",
    "role_code",
    "statement_type",
    "label_tr",
    "footnote_ref",
    "period_type",
    "period_label",
    "period_start",
    "period_end",
    "is_comparative",
    "raw_value",
    "scale_unit",
    "scale_multiplier",
    "normalized_value_tl",
)


# Rows per INSERT statement. executemany sends one statement per row: loading 2026/2 took ~90 s with it and
# ~35 s with multi-row inserts. Larger batches did not help further.
INSERT_BATCH_ROWS = 500


@dataclasses.dataclass
class FileReport:
    filepath: str
    status: str  # "ok" | "parse_error" | "duplicate_facts" | "duplicate_disclosure" | "load_error"
    disclosure_id: Optional[int] = None
    fact_count: int = 0
    error: Optional[str] = None


@dataclasses.dataclass
class ParseReport:
    raw_dir: str
    files: List[FileReport]

    @property
    def ok_files(self) -> List[FileReport]:
        return [f for f in self.files if f.status == "ok"]

    @property
    def failed_files(self) -> List[FileReport]:
        return [f for f in self.files if f.status != "ok"]

    @property
    def total_facts(self) -> int:
        return sum(f.fact_count for f in self.ok_files)


def _duplicate_keys(filing: ParsedFiling) -> List[Tuple[str, str]]:
    seen: Dict[Tuple[str, str], int] = {}
    for f in filing.facts:
        key = (f.row_id, f.column_class)
        seen[key] = seen.get(key, 0) + 1
    return [k for k, n in seen.items() if n > 1]


def parse_directory(raw_dir: str) -> Tuple[List[ParsedFiling], ParseReport]:
    """Parse every .xls in raw_dir. Files that fail are listed in the report, never skipped silently."""
    filings: List[ParsedFiling] = []
    reports: List[FileReport] = []
    seen_ids: Dict[int, str] = {}
    for path in sorted(glob.glob(os.path.join(raw_dir, "*.xls"))):
        try:
            pf = parse_kap_xls(path)
        except Exception as e:
            reports.append(FileReport(filepath=path, status="parse_error", error=f"{type(e).__name__}: {e}"))
            continue

        if pf.disclosure_id in seen_ids:
            # The disclosure id is the report key; a second file would silently replace the first one.
            first = os.path.basename(seen_ids[pf.disclosure_id])
            reports.append(
                FileReport(
                    filepath=path,
                    status="duplicate_disclosure",
                    disclosure_id=pf.disclosure_id,
                    fact_count=len(pf.facts),
                    error=f"disclosure {pf.disclosure_id} already read from {first}",
                )
            )
            continue
        seen_ids[pf.disclosure_id] = path

        dups = _duplicate_keys(pf)
        if dups:
            # Two values for one cell cannot both be right; loading either one would be a guess.
            reports.append(
                FileReport(
                    filepath=path,
                    status="duplicate_facts",
                    disclosure_id=pf.disclosure_id,
                    fact_count=len(pf.facts),
                    error=f"{len(dups)} duplicate (row_id, column_class) keys, first: {dups[0]}",
                )
            )
            continue

        filings.append(pf)
        reports.append(FileReport(filepath=path, status="ok", disclosure_id=pf.disclosure_id, fact_count=len(pf.facts)))
    return filings, ParseReport(raw_dir=raw_dir, files=reports)


def connect(db_path: str):
    if duckdb is None:
        raise ImportError('DuckDB is not installed. Run: pip install -e ".[db]"')
    parent = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(parent, exist_ok=True)
    con = duckdb.connect(db_path)
    con.execute(SCHEMA_SQL)
    return con


def _fact_rows(filing: ParsedFiling) -> List[tuple]:
    rows = []
    for f in filing.facts:
        rows.append(
            (
                f.disclosure_id,
                f.row_id,
                f.column_class,
                f.role_code,
                f.statement_type,
                f.label_tr,
                f.footnote_ref,
                f.period_type,
                f.period_label,
                f.period_start,
                f.period_end,
                f.is_restated_comparative,
                f.raw_value,
                f.scale_unit,
                f.scale_multiplier,
                f.normalized_value_tl,
            )
        )
    return rows


def load_filing(con, filing: ParsedFiling) -> int:
    """Replace one filing in the database inside a transaction. Returns the number of facts written."""
    rows = _fact_rows(filing)
    con.execute("BEGIN TRANSACTION")
    try:
        con.execute("DELETE FROM facts WHERE disclosure_id = ?", [filing.disclosure_id])
        con.execute("DELETE FROM reports WHERE disclosure_id = ?", [filing.disclosure_id])
        con.execute("INSERT INTO companies VALUES (?) ON CONFLICT DO NOTHING", [filing.company_code])
        con.execute(
            "INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                filing.disclosure_id,
                filing.company_code,
                filing.raw_ticker_group,
                filing.year,
                filing.quarter,
                filing.consolidation_type,
                filing.template_family,
                filing.scale_unit,
                filing.scale_multiplier,
                filing.has_tms29_monetary_item,
                filing.filepath,
                len(rows),
                datetime.datetime.now(),
            ],
        )
        row_placeholder = "(" + ", ".join("?" for _ in FACT_COLUMNS) + ")"
        for i in range(0, len(rows), INSERT_BATCH_ROWS):
            batch = rows[i : i + INSERT_BATCH_ROWS]
            con.execute(
                f"INSERT INTO facts ({', '.join(FACT_COLUMNS)}) VALUES {', '.join(row_placeholder for _ in batch)}",
                [v for row in batch for v in row],
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return len(rows)


def load_filings(con, filings: List[ParsedFiling], report: ParseReport) -> None:
    by_id = {r.disclosure_id: r for r in report.files if r.status == "ok"}
    for pf in filings:
        try:
            load_filing(con, pf)
        except Exception as e:
            r = by_id[pf.disclosure_id]
            r.status = "load_error"
            r.error = f"{type(e).__name__}: {e}"


def count_mismatches(con, report: ParseReport) -> List[Tuple[str, int, int]]:
    """Compare facts per filing in the database with the parse report. Returns (filepath, expected, loaded)."""
    loaded: Dict[int, int] = dict(con.execute("SELECT disclosure_id, count(*) FROM facts GROUP BY 1").fetchall())
    out: List[Tuple[str, int, int]] = []
    for r in report.ok_files:
        n = loaded.get(r.disclosure_id, 0)
        if n != r.fact_count:
            out.append((r.filepath, r.fact_count, n))
    return out


def stale_reports(con, report: ParseReport) -> List[Tuple[str, int]]:
    """
    Reports still in the database for files that failed in this run. Their rows come from an earlier load
    and no longer match what the parser produces. Returns (filepath, disclosure_id).
    """
    failed = {os.path.basename(r.filepath): r.filepath for r in report.failed_files}
    if not failed:
        return []
    out: List[Tuple[str, int]] = []
    for disclosure_id, path in con.execute("SELECT disclosure_id, filepath FROM reports").fetchall():
        name = os.path.basename(path)
        if name in failed:
            out.append((failed[name], disclosure_id))
    return out


def missing_reports(con, report: ParseReport) -> List[Tuple[str, int]]:
    """
    Reports still in the database for a report period (year, quarter) of this run whose file is no longer in
    raw_dir. Their rows come from a file that was removed. Returns (filepath, disclosure_id).
    """
    names = {os.path.basename(r.filepath) for r in report.files}
    periods = set()
    for name in names:
        try:
            _, _, _, year, quarter = parse_filename(name)
        except ValueError:
            continue
        periods.add((year, quarter))
    out: List[Tuple[str, int]] = []
    for disclosure_id, path, year, quarter in con.execute(
        "SELECT disclosure_id, filepath, year, quarter FROM reports ORDER BY filepath"
    ).fetchall():
        if (year, quarter) in periods and os.path.basename(path) not in names:
            out.append((path, disclosure_id))
    return out


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "raw", "2026_2")
    db_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join("data", "vigil.duckdb")

    parsed, rep = parse_directory(target_dir)
    conn = connect(db_path)
    load_filings(conn, parsed, rep)
    mismatches = count_mismatches(conn, rep)
    stale = stale_reports(conn, rep)
    missing = missing_reports(conn, rep)

    print(f"Files: {len(rep.files)} | ok: {len(rep.ok_files)} | failed: {len(rep.failed_files)}")
    print(f"Facts in parse report: {rep.total_facts}")
    for r in rep.failed_files:
        print(f"  {r.status:16s} {os.path.basename(r.filepath)}: {r.error}")
    load_errors = [r for r in rep.failed_files if r.status == "load_error"]
    if load_errors:
        print(f"Load errors: {len(load_errors)}")
        sys.exit(1)
    if mismatches:
        print(f"Row count mismatches: {len(mismatches)}")
        for path, expected, got in mismatches:
            print(f"  {os.path.basename(path)}: parse report {expected}, database {got}")
        sys.exit(1)
    if stale:
        print(f"Stale reports (failed now, rows from an earlier load still in the database): {len(stale)}")
        for path, disclosure_id in stale:
            print(f"  {os.path.basename(path)} (disclosure {disclosure_id})")
        sys.exit(1)
    if missing:
        print(f"Missing files (removed from {target_dir}, rows still in the database): {len(missing)}")
        for path, disclosure_id in missing:
            print(f"  {os.path.basename(path)} (disclosure {disclosure_id})")
        sys.exit(1)
    print(f"Row counts match the parse report for all {len(rep.ok_files)} loaded files -> {db_path}")
