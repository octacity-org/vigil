# 0012. Net debt scope

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #53

## Context

The working definition is financial borrowings − cash and cash equivalents. The open questions were lease liabilities and financial investments. At KATMR 2026/2, financial debt fell 6% while net debt rose 9%, because cash fell 73%: the definition decides what the number says.

In the KAP general template (role 210015), the borrowing subtotals already include lease liabilities: `Kiralama İşlemlerinden Borçlar` is a child of `Kısa Vadeli Borçlanmalar` (row 132), `Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları` (143) and `Uzun Vadeli Borçlanmalar` (193). The lease rows (135, 140, 146, 151, 196, 201) are filled only when a company breaks its borrowings down.

Measured on 531 general-template filings of 2026/2:

| | |
|---|---:|
| Filings with borrowings | 484 |
| Filings that report lease liabilities separately | 292 (55%) |
| Lease liabilities as a share of borrowings, median (those 292) | 7% |
| Of those, leases are more than half of borrowings | 18% |
| Filings with short-term financial investments (row 6) | 266 |
| Short-term financial investments relative to cash, median | 34% |
| Filings where subtracting them would change the sign of net debt | 32 |

## Options considered

1. **Borrowings (including leases) − cash.** Matches the filing's own subtotals and IFRS 16.
2. **Borrowings excluding leases − cash.** Only computable for the 55% that report leases separately; the rest would be inconsistent.
3. **Also subtract financial investments.** The filing does not say whether they are deposits, bonds or shares, or whether they are restricted; subtracting them assumes they are as good as cash.

## Decision

- **Net debt** = rows 132 + 143 + 193 − row 4 (`Nakit ve Nakit Benzerleri`), from the same balance sheet column. Leases are included because KAP includes them in borrowings.
- **Excluding leases** is shown as a second line when the company reports its lease rows; otherwise it is "not computable: lease liabilities are not reported separately".
- **Financial investments are not subtracted.** Short-term financial investments (row 6) are shown next to net debt, labelled, so a reader can subtract them if they choose.
- A missing borrowing row counts as zero borrowings only when the balance sheet is complete (it passed the reconciliation checks); a missing cash row makes net debt not computable.

## Consequences

- Net debt is the same number for every company and can be traced to three rows plus cash.
- Companies with large deposits classified as financial investments show a higher net debt than some other sources. The shown financial investments line makes this visible.
- Revisit when footnotes (Phase 5) can tell the type of financial investments.
