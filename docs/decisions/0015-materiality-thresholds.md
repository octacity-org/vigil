# 0015. Materiality denominator and thresholds X, Z

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #56

## Context

A gross margin finding (S1) needs both conditions (`docs/VIGIL.md` §9):

```
|Δmargin| ≥ X
|Δmargin| × revenue / denominator ≥ Z
```

The second condition measures the TL effect of the margin change. For KATMR Q2 2026 the effect is 228.3 mn TL, which is 1.54% of total assets, 2.17% of equity or 81.9% of prior-year Q2 operating profit: the denominator changes the result by more than 50 times.

Measured on 2026/2: 267 general-template filings with three-month revenue of at least 100 mn TL in both years and margins between −100% and 100%. Of these, 76 have |Δmargin| ≥ 1,000 basis points.

| Denominator, among the 76 | |
|---|---:|
| Total assets: median / 90th percentile of effect ÷ denominator | 1.6% / 3.8% |
| Equity zero or negative | 2 filings |
| Prior-year Q2 operating profit below 1% of total assets | 23 filings |
| Largest effect ÷ prior-year operating profit | 87.8 times |

| Z (share of total assets), with X = 1,000 bps | Findings |
|---|---:|
| 0.25% | 75 |
| 0.5% | 69 |
| **1%** | **53** |
| 2% | 26 |

| X (Δmargin), without Z | Candidates |
|---|---:|
| 500 bps | 128 |
| 1,000 bps | 76 |
| 1,500 bps | 38 |

## Options considered

1. **Total assets.** Always positive, changes slowly, available in every balance sheet.
2. **Equity.** Can be zero or negative.
3. **Prior-year operating profit.** Close to zero for 23 of 76 candidates, which makes the ratio explode.
4. **Revenue.** Makes the second condition equal to the first (tautological, already rejected in `VIGIL.md`).

## Decision

- **Denominator:** total assets (`TOPLAM VARLIKLAR`, row 129) at the current period end, from the same report.
- **X = 1,000 basis points** (10 percentage points) in three-month gross margin, current quarter vs. the same quarter a year earlier.
- **Z = 1%** of total assets.
- Both thresholds and the denominator are read from the configuration file (#69), never hard-coded. Every finding shows X, Z and the computed values, so a reader can see how far above the thresholds it is.
- Ranking is separate from triggering and does not change these thresholds.

## Consequences

- With these values 2026/2 gives 53 gross margin findings out of 267 eligible filings, before the company type rule of [0017](0017-company-type-from-kap-sectors.md) is applied. KATMR (1.54%) is one of them.
- The numbers above use the old company type rule; they change slightly with 0017.
- **Revisit after Phase 3:** if precision on the labelled sample (#76, #77) is below 70%, or the sensitivity report (#70) shows that findings depend strongly on small changes in X or Z.
