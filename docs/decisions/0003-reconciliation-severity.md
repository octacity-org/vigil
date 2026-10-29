# 0003. Which reconciliation checks block a filing

- **Status:** proposed
- **Date:** 2026-10-29
- **Decided by:** pending review by the methodology owner
- **Discussion:** #18

## Context

The project document and CONTRIBUTING say that ratios are computed only after the statements of a filing agree with each other. #18 added four cross-statement checks (`src/vigil/checks.py`). Run on the 218 `general` and `holding` filings of 2026/2 that have values (246 files in the sample; 27 use other templates, YONGA parses with no values):

| Check | Pass | Fail |
|---|---|---|
| Total assets = total liabilities and equity (current and prior) | 218 | 0 |
| Balance sheet net profit = parent-company profit | 218 | 0 |
| Cash flow end cash = balance sheet cash | 166 | 52 |
| Cash flow begin cash = prior balance sheet cash | 158 | 60 |

The cash flow statement is internally consistent in the failing filings (begin cash + net change = end cash). The difference is in the definition of cash: many companies present cash in the cash flow statement without interest accruals, blocked deposits or expected credit losses, as IAS 7 allows, and explain it in the notes. Example: AKSA 30.06.2026, balance sheet 5,339,528 vs cash flow 5,286,528 (thousand TL). Two filings differ by exactly one unit (CANTE, LYDHO), which is rounding.

## Options considered

1. **All four checks block.** About a quarter of real-sector filings would never produce signals, for a presentation choice rather than an error.
2. **Cash checks informational, the others block.** Differences are still reported with both values and their source rows.
3. **Explain cash differences from the notes** before deciding. Needs footnote extraction (Phase 5).

## Decision

Option 2, with a rounding tolerance:

- `blocking`: balance sheet balance (current and prior period end) and balance sheet profit = parent-company profit.
- `informational`: the two cash checks.
- A difference of one unit of the reporting unit counts as rounding for every check.

## Reasoning

The blocking checks catch parsing errors and inconsistent filings, which is what the rule is for: none failed in the sample, and the column-shift bug (#14) would have shown up in subtotals rather than here. Blocking on the cash definition would exclude many correct filings, and Vigil cannot yet read the notes that explain the difference.

## Consequences

- `reconcile()` returns a severity with every result; `blocking_failures()` lists the ones that should stop a filing.
- Cash-based metrics (cash ratio, net debt, FCF) should state which cash they use: the balance sheet cash. Revisit once footnotes are extracted (Phase 5).
- Revisit if a blocking check starts failing on real filings for reasons other than errors.
