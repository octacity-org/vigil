# 0011. Default EBITDA definition

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #52

## Context

Two definitions are common, and they can give very different results:

- **A (core operations):** gross profit − operating expenses + depreciation and amortisation
- **B (operating profit):** operating profit + depreciation and amortisation. Operating profit includes "other income/expense from main operations" (`Esas Faaliyetlerden Diğer Gelirler / Giderler`), which holds items such as FX gains and maturity differences. Their content is only in the footnotes.

Measured on 333 general-template filings of 2026/2 with an income statement and a cash flow statement:

| | |
|---|---:|
| Median difference between B and A, relative to A | 15% |
| Filings where the difference is more than 25% | 38% |
| Filings where A and B have opposite signs | 27 |
| KATMR 6M 2026: A / B | 277.0 / 495.8 mn TL (B is 79% higher) |

## Options considered

1. **A as default, B shown next to it.** A measures what the company earns from selling its products; it does not depend on items whose content is unknown without footnotes.
2. **B as default.** Closer to the operating profit line in the filing, but mixes in FX and financing-like items.
3. **Only one definition.** Simpler, but hides a difference that changes the sign of EBITDA in 27 filings.

## Decision

Option 1.

- **Default (A):** `BRÜT KAR (ZARAR)` (row 31) + `Genel Yönetim Giderleri` (32) + `Pazarlama Giderleri` (33) + `Araştırma ve Geliştirme Giderleri` (34) + depreciation and amortisation. Expenses are filed as negative numbers, so they are added.
- **Second definition (B):** `ESAS FAALİYET KARI (ZARARI)` (row 38) + depreciation and amortisation.
- **Depreciation and amortisation:** `Amortisman ve İtfa Gideri İle İlgili Düzeltmeler` from the cash flow statement (role 520003, row 7). It is only reported cumulatively.
- Wherever EBITDA is shown, both definitions are shown, labelled "A" and "B", with the difference between them. Findings and ratios use A.
- If the depreciation row is missing, EBITDA is "not computable" with that reason; it is never computed with zero depreciation.

Row numbers refer to the general template roles 310003 (income statement) and 520003 (cash flow statement).

## Consequences

- Three-month EBITDA is not computable from one report, because depreciation is only cumulative; it needs the previous report (see [0014](0014-annualisation-and-averages.md)).
- Net debt / EBITDA uses trailing-twelve-month EBITDA A ([0014](0014-annualisation-and-averages.md)).
- Revisit if the footnote extraction (Phase 5, #92) makes the content of other operating income available.
