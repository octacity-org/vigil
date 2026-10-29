"""Per-file data quality report (issue #19).

One row per raw file with the parse status, template, scale and the result of every check in vigil.checks.
Phase 0 exit criterion: every file either passes all blocking checks, or the reason it does not is recorded.

    python -m vigil.quality data/raw/2026_2 reports/quality_2026_2.csv
"""

from __future__ import annotations

import collections
import csv
import dataclasses
import glob
import os
from typing import Dict, List, Optional

from vigil.checks import (
    CheckResult,
    balance_sheet_subtotals,
    cash_flow_subtotals,
    income_statement_subtotals,
    reconcile,
)
from vigil.parser import parse_kap_xls

GROUPS = {
    "reconciliation": reconcile,
    "income_statement": income_statement_subtotals,
    "balance_sheet": balance_sheet_subtotals,
    "cash_flow": cash_flow_subtotals,
}


@dataclasses.dataclass
class FileQuality:
    file: str
    status: str  # "pass" | "fail" | "not_checked" | "no_values" | "parse_error"
    company: Optional[str] = None
    disclosure_id: Optional[int] = None
    year: Optional[int] = None
    quarter: Optional[int] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    # False when the header period does not cover `quarter` quarters (#36); None without header dates.
    period_matches_quarter: Optional[bool] = None
    template: Optional[str] = None
    scale_unit: Optional[str] = None
    facts: int = 0
    passed: int = 0
    failed: int = 0
    not_checked: int = 0
    informational_differences: int = 0
    text_values: int = 0
    text_disagreements: int = 0
    first_failure: str = ""
    error: str = ""
    counts: Dict[str, Dict[str, int]] = dataclasses.field(default_factory=dict)


def _describe(result: CheckResult) -> str:
    return f"{result.name} at {result.left_source}: {result.left} vs {result.right} (difference {result.difference})"


def file_quality(path: str) -> FileQuality:
    name = os.path.basename(path)
    try:
        filing = parse_kap_xls(path)
    except Exception as e:  # every failure is reported, never skipped
        return FileQuality(file=name, status="parse_error", error=f"{type(e).__name__}: {e}")

    row = FileQuality(
        file=name,
        status="not_checked",
        company=filing.company_code,
        disclosure_id=filing.disclosure_id,
        year=filing.year,
        quarter=filing.quarter,
        period_start=str(filing.period_start) if filing.period_start else None,
        period_end=str(filing.period_end) if filing.period_end else None,
        period_matches_quarter=filing.period_matches_quarter,
        template=filing.template_family,
        scale_unit=filing.scale_unit,
        facts=len(filing.facts),
        text_values=filing.text_values,
        text_disagreements=filing.text_disagreements,
    )
    if not filing.facts:
        row.status = "no_values"
        row.error = "the parser found no values in this file"
        return row

    for group, check in GROUPS.items():
        counts = collections.Counter()
        for result in check(filing):
            informational = result.severity == "informational" and result.status == "fail"
            counts["difference" if informational else result.status] += 1
            if result.status == "not_checked":
                row.not_checked += 1
            elif result.severity == "informational":
                if result.status == "fail":
                    row.informational_differences += 1
            elif result.status == "pass":
                row.passed += 1
            else:
                row.failed += 1
                if not row.first_failure:
                    row.first_failure = _describe(result)
        row.counts[group] = dict(counts)

    if row.failed:
        row.status = "fail"
    elif row.passed:
        row.status = "pass"
    return row


def quality_report(raw_dir: str) -> List[FileQuality]:
    return [file_quality(p) for p in sorted(glob.glob(os.path.join(raw_dir, "*.xls")))]


CSV_COLUMNS = (
    "file",
    "status",
    "company",
    "disclosure_id",
    "year",
    "quarter",
    "period_start",
    "period_end",
    "period_matches_quarter",
    "template",
    "scale_unit",
    "facts",
    "passed",
    "failed",
    "not_checked",
    "informational_differences",
    "text_values",
    "text_disagreements",
    "first_failure",
    "error",
)


def write_csv(rows: List[FileQuality], path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(CSV_COLUMNS)
        for r in rows:
            writer.writerow([getattr(r, c) if getattr(r, c) is not None else "" for c in CSV_COLUMNS])


def markdown_summary(rows: List[FileQuality], title: str) -> str:
    by_status = collections.Counter(r.status for r in rows)
    lines = [
        f"# Data quality: {title}",
        "",
        f"{len(rows)} files.",
        "",
        "| Status | Files | Meaning |",
        "|---|---|---|",
        f"| pass | {by_status['pass']} | every blocking check that could run passed |",
        f"| fail | {by_status['fail']} | at least one blocking check failed |",
        f"| not_checked | {by_status['not_checked']} | template not supported by the checks yet |",
        f"| no_values | {by_status['no_values']} | parsed, but no values found |",
        f"| parse_error | {by_status['parse_error']} | the parser raised an error |",
        "",
        "| Checks | Pass | Fail | Not checked | Informational difference |",
        "|---|---|---|---|---|",
    ]
    for group in GROUPS:
        c = collections.Counter()
        for r in rows:
            c.update(r.counts.get(group, {}))
        lines.append(f"| {group} | {c['pass']} | {c['fail']} | {c['not_checked']} | {c['difference']} |")
    informational = sum(r.informational_differences for r in rows)
    lines += [
        "",
        f"Cash differences between the cash flow statement and the balance sheet (informational, decision 0003): "
        f"{informational} in {sum(1 for r in rows if r.informational_differences)} files.",
        "",
        f"Values read from the visible text because the cell had no `title` (decision 0004): "
        f"{sum(r.text_values for r in rows)} in {sum(1 for r in rows if r.text_values)} files.",
        "",
        f"Cells whose `title` and visible text disagree (the `title` is used): "
        f"{sum(r.text_disagreements for r in rows)} in {sum(1 for r in rows if r.text_disagreements)} files.",
    ]
    special = [r for r in rows if r.period_start and not r.period_start.endswith("-01-01")]
    if special:
        lines += [
            "",
            "Fiscal year not starting on 1 January: "
            + ", ".join(f"{r.company} ({r.period_start} to {r.period_end})" for r in special)
            + ".",
        ]
    mismatched = [r for r in rows if r.period_matches_quarter is False]
    undated = [r for r in rows if r.status not in ("parse_error",) and r.period_end is None]
    if mismatched or undated:
        lines += [
            "",
            "Period to check by hand: "
            + ", ".join(
                [f"{r.file} (header {r.period_start} to {r.period_end}, file name Q{r.quarter})" for r in mismatched]
                + [f"{r.file} (no header dates)" for r in undated]
            )
            + ".",
        ]
    problems = [r for r in rows if r.status in ("fail", "no_values", "parse_error")]
    if problems:
        lines += ["", "| File | Status | Detail |", "|---|---|---|"]
        for r in problems:
            lines.append(f"| {r.file} | {r.status} | {r.first_failure or r.error} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    raw_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "raw", "2026_2")
    out_csv = sys.argv[2] if len(sys.argv) > 2 else os.path.join("reports", "quality.csv")
    rows = quality_report(raw_dir)
    write_csv(rows, out_csv)
    summary = markdown_summary(rows, os.path.basename(os.path.normpath(raw_dir)))
    with open(os.path.splitext(out_csv)[0] + ".md", "w", encoding="utf-8") as f:
        f.write(summary)
    print(summary)
    sys.exit(1 if any(r.status in ("fail", "parse_error") for r in rows) else 0)
