# 0006. Tolerance for single-value checks and known filing errors

- **Status:** accepted
- **Date:** 2026-10-31
- **Decided by:** @BerkeDurdu
- **Discussion:** #148 (amends the tolerance in [0003](0003-reconciliation-severity.md))

## Context

After decision 0005, five blocking failures remain in 2026/1–2:

- **Four rounding differences.** Balance sheet profit vs. parent-company profit differs by 2 to 4 units: GEREL and USAK in 2026/2, ARMGD and BVSAN in 2026/1. Decision 0003 allows one unit for a comparison of two single figures; each figure is itself a rounded result of several amounts.
- **AKTVK 2026/2.** Income statement row 62 (`Ana Ortaklık Payları`) is filed as 0, in both the `title` and the shown number. The profit (−682,616) is in row 59 and in the comprehensive income parent share (row 151).

The smallest difference seen that is not rounding is 1,248,245 units (ZOREN, before 0005).

## Decision

- **Single-value comparisons** (the reconciliation checks: balance sheet balance, balance sheet profit vs. parent-company profit, cash) pass within **5 units** of the reporting unit.
- **Subtotals** keep one unit per component.
- **Known filing errors.** A blocking failure confirmed by reading the raw file is listed in `src/vigil/known_errors.py` with its reason, keyed by (disclosure id, check name).
  - The filing **stays blocked**: `blocking_failures()` still returns the failure, so no signal is built on it.
  - The data quality report shows it as `known_error` with the reason, not as `fail`, and it does not make the report exit with an error.
- **No substitute values.** Vigil does not take the profit from another row (59 or 151) for a filing that filed row 62 as 0. That would be a guess about what the company meant.

## Consequences

- 2026/2: AKTVK is the only `known_error`. 2026/1 has none.
- Every new entry in `known_errors.py` needs the raw file to have been read; a parser problem must never be listed there.
