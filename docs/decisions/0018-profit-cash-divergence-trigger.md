# 0018. Profit–cash divergence (S2) trigger

- **Status:** accepted
- **Date:** 2026-11-14
- **Decided by:** @BerkeDurdu
- **Discussion:** #67

## Context

S2 shows profit that does not turn into cash (`docs/VIGIL.md` §9). The measure is the accrual ratio:

```
accrual ratio = (net profit − operating cash flow) / average total assets
```

Three choices change the result: the flow window, the threshold, and whether loss-making companies are included. The prototype (`detectCashProfitQualityDivergence`) used none of these. It fired when year-to-date net profit was at least 100 mn TL and operating cash flow at most −100 mn TL, which gives 9 findings on 2026/2 and ignores company size.

Measured on 2026/2: 166 general-template filings eligible under the old company type rule, with year-to-date revenue of at least 100 mn TL. Of these, 161 also have a 2025 year-end report, so a trailing twelve month (TTM) value can be computed.

**CPI factor.** The TTM uses the previous year-end report, which is in December 2025 prices ([0014](0014-annualisation-and-averages.md)). The factor can be read from the filings themselves: the current report restates the 2025 year-end balance sheet in June 2026 prices. Restated total assets ÷ total assets in the 2025 year-end report gives 1.1776 for 179 of the 207 companies with both reports, all within 0.5 points of each other. The numbers below use this factor; the implementation uses the TÜİK CPI series (#47) as 0014 says, and this ratio serves as a cross-check.

| Window (all real-sector filings, no size floor) | Median | 90th percentile | 95th percentile |
|---|---:|---:|---:|
| Year to date (6 months) | −2.6% | 5.8% | 11.6% |
| TTM, CPI-adjusted | −5.2% | 7.8% | 12.6% |

| TTM threshold | Findings (of 161) | Net profit positive |
|---|---:|---:|
| 5% | 26 | 21 |
| **7.5%** | **17** | **14** |
| 10% | 12 | 9 |

The two windows pick different companies. At 5%, the year-to-date list has 23 companies and the TTM list has 26, but only 13 companies are on both.

**KATMR** is on the edge: its TTM accrual ratio is 7.49%, with profit 525.5 mn TL and operating cash flow −630.7 mn TL. Its 6-month ratio is 2.33% (`VIGIL.md` §7).

## Options considered

1. **Year to date, no CPI.** All values come from one report. But the window is 3, 6, 9 or 12 months depending on the quarter, so one threshold means something different each quarter. Multiplying the flows is not allowed ([0014](0014-annualisation-and-averages.md)).
2. **TTM with CPI.** Every quarter covers twelve months, and it follows 0014. It needs the previous year-end report.
3. **Profit-positive companies only.** This matches the name "profit–cash divergence" literally. But it drops companies whose cash outflow is much larger than their loss, such as PATEK, ERCB and BMSCH.
4. **Sign rule (profit > 0 and cash flow < 0) instead of a ratio.** This is the prototype. It ignores size: a 1 mn TL gap and a 1 bn TL gap count the same.

## Decision

- **Measure:** TTM accrual ratio = (TTM net profit − TTM operating cash flow) / average total assets.
  - **Net profit:** income statement `DÖNEM KARI (ZARARI)`, row 59.
  - **Operating cash flow:** cash flow statement row 2, `İŞLETME FAALİYETLERİNDEN NAKİT AKIŞLARI`.
  - **TTM:** built as in [0014](0014-annualisation-and-averages.md). In a year-end report it is the reported full year.
  - **Average total assets:** (current period end + previous year end) / 2, both from the current report (row 129).
- **Trigger:** accrual ratio ≥ **7.5%**, roughly the top tenth of companies. Loss-making companies are included, and the finding shows the sign of profit.
- **Size floor:** year-to-date revenue (income statement row 3) of at least 100 mn TL. This is the same amount as S1's floor, which applies to three-month revenue.
- **Eligibility:** real-sector filings under [0017](0017-company-type-from-kap-sectors.md).
- **Not computable:** if the previous year-end report or the CPI value is missing, the finding is "not computable" and names the missing input. It is never computed from year-to-date values instead.
- **Configuration:** the threshold and the size floor are read from the configuration file (#69), never hard-coded.

**Output.** Every finding shows the full bridge from profit to cash, for both the year to date and the TTM:

| Step | Source |
|---|---|
| Net profit | Income statement row 59 |
| Profit in the cash flow statement | Cash flow row 3; any difference from row 59 is shown as its own line |
| + Non-cash adjustments | Row 6, with depreciation and amortisation (row 7) shown separately |
| + Working capital changes | Row 65, by component as in [0013](0013-working-capital-scope.md) |
| = Cash from operations | Row 102 |
| + Dividends, interest, rent, tax, provision and other operating cash flows, discontinued operations | Rows 103–118, each non-zero row shown |
| + Inflation effect | Row 119 |
| = Operating cash flow | Row 2 |

- **IAS 29 net monetary gain:** income statement row 52 is shown next to the profit. It is not cash, so it adds to the accrual ratio. For 26 of 174 real-sector filings on 2026/2, year-to-date profit is positive only because of this gain.
- **Also shown:** the CPI factor, the threshold, and the computed ratio.

For KATMR's year to date the bridge closes exactly:

```
318.9 + 79.3 − 453.4 = −55.3
−55.3 + 12.3 + 2.0 = −40.9 mn TL
```

## Reasoning

- TTM is the only window that means the same thing every quarter, and 0014 already requires it for flows.
- 7.5% is close to the 90th percentile, so a finding marks an unusual gap, not a common one. At 5% about one company in six would get a finding.
- A ratio on average total assets scales with company size. That is why it replaces the prototype's fixed TL amounts.
- A company that loses money and burns much more cash than its loss has the same problem: reported results look better than cash. So losses are not excluded.

## Consequences

- `detectCashProfitQualityDivergence` is rewritten. The prototype's ±100 mn TL rule is removed.
- S2 needs the previous year-end report, like the day counts.
- KATMR, the worked example, gets no S2 finding at 7.5% (7.49%). Documentation that uses it as an S2 example must say so.
- These numbers use the old company type rule; they change slightly with 0017.
- **Revisit after Phase 3:** if precision on the labelled sample (#76, #77) is below 70%, or if the sensitivity report (#70) shows that the list depends strongly on the threshold.
