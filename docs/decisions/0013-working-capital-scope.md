# 0013. Working capital scope

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #54

## Context

The change in working capital is taken from the cash flow statement, not from balance sheet differences (`docs/VIGIL.md` §6). The question is which items count. At KATMR in 6M 2026 the largest item was customer advances (−1,057.0 mn TL), larger than receivables, inventories and payables together: the core items gave +250.1 mn TL, the other items −688.1 mn TL.

Measured on 531 general-template filings of 2026/2 (cash flow statement, role 520003, current cumulative column):

| | |
|---|---:|
| Filings with at least one item outside receivables, inventories and payables | 424 |
| Filings where those items are larger than the core items | 25% |
| Filings where they change the sign of the total | 66 |
| Filings where advances and contract liabilities on the balance sheet exceed trade payables | 14% |

## Options considered

1. **Core only:** trade receivables, inventories, trade payables. Standard, but misses the largest item for a quarter of companies.
2. **Core plus contract and prepayment items**, shown by component.
3. **The filing's whole working capital section.** Includes "other" items whose content is unknown.

## Decision

Option 2.

- **Change in working capital** = the sum of these cash flow rows (role 520003):
  - core: `Ticari Alacaklardaki Azalış (Artış)` (68), `Stoklardaki Azalışlar (Artışlar)` (81), `Ticari Borçlardaki Artış (Azalış)` (84)
  - contract and prepayment items: `Müşteri Sözleşmelerinden Doğan Varlıklardaki Azalış (Artış)` (75), `Peşin Ödenmiş Giderlerdeki Azalış (Artış)` (83), `Müşteri Sözleşmelerinden Doğan Yükümlülüklerdeki Artış (Azalış)` (89), `Ertelenmiş Gelirlerdeki Artış (Azalış)` (98, customer advances)
- Every component is shown with its own value and source, core items first. A missing row is shown as "not reported", not as zero.
- **Day counts** (receivable, inventory and payable days) keep their standard definitions and use only receivables, inventories and payables. Customer advances are shown as their own line, not folded into payable days.
- Other working capital rows (`Diğer`) are shown as "other", without being interpreted.

## Consequences

- KATMR's −1,057.0 mn TL advance movement is part of the working capital change and is visible as its own component.
- Day counts stay comparable with other sources.
- The balance-sheet-difference vs. cash-flow reconciliation (#63) uses the same list of items.
