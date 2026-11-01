# 0014. Annualisation and averages

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #55

## Context

Ratios that compare a stock (balance sheet) with a flow (income or cash flow statement), such as day counts, returns and net debt / EBITDA, need an annual flow. A 6-month report has only 6 months of flows.

Multiplying (6M × 2, 3M × 4) assumes the quarters are alike. Measured on 270 general-template filings of 2026/2 with revenue above 100 mn TL in both quarters (Q1 = 6M cumulative − Q2 three-month, both from the same report):

| | |
|---|---:|
| Median Q2 / Q1 revenue | 1.04 |
| Filings where Q2 differs from Q1 by more than 20% | 36% |
| Filings where Q2 differs from Q1 by more than 50% | 17% |

Under IAS 29 (TMS 29) every report is in its own period-end prices, so flows from different reports cannot be added without a price adjustment.

## Options considered

1. **Multiply** the cumulative flow (× 12 / months). Always computable, wrong for seasonal companies.
2. **Trailing twelve months (TTM)** with CPI adjustment. Correct for seasonality; needs the previous year-end report and a CPI series.

## Decision

Option 2. Flows are never multiplied.

- **TTM flow** = current year-to-date (current report) + previous full year (previous year-end report, adjusted with CPI to the current report's period end) − previous year-to-date (the restated comparative column of the current report, already in current prices).
- In a year-end report TTM is the reported full year.
- CPI is the TÜİK series ingested in #47. The adjustment factor is CPI(current period end) / CPI(previous year end), and it is shown with the result.
- If the previous year-end report or the CPI value is missing, the ratio is "not computable" with the missing input named.
- **Averages** of balance sheet items = (current period end + previous year end) / 2, both taken from the current report, so both are in the same prices. Ratios that use a balance are shown with both the period-end and the average balance, labelled.
- **Day counts** use 365 days and TTM flows.

## Consequences

- Day counts and returns need the previous year-end report: the archive (#43) must include it, and the first-run download covers it.
- The day counts in the KATMR worked example (`docs/VIGIL.md` §7, e.g. 1,577 inventory days) are recomputed with this method.
- Three-month values derived from cumulative figures (#48) follow the same price rule: values from different reports are CPI-adjusted before subtraction.
