# 0016. Sector comparison groups

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #57

## Context

A ratio cannot be read without context. KATMR's inventory days (1,577 in `docs/VIGIL.md` §7) mean little on their own; they only say something next to similar companies.

KAP classifies listed companies into main sectors (e.g. `İMALAT`) and sub-sectors (e.g. `METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE ULAŞIM ARAÇLARI`) on its Sektörler page (`docs/kap.md`). In 2026/2, 439 general-template filings are eligible under [0017](0017-company-type-from-kap-sectors.md). By KAP sub-sector:

- 16 sub-sectors have 5 or more of these companies (the largest: chemicals 52, food 46, metal goods 45, electricity 41, IT 38) and hold about 90% of them.
- 21 sub-sectors have fewer than 5.

## Options considered

1. **KAP sub-sector**, falling back to the main sector for small groups. Official, maintained by KAP, no judgement by us.
2. **Our own grouping.** Could be more precise, but is a judgement that has to be maintained and defended.
3. **BIST sector indices.** Only cover index members.

## Decision

- **Group:** the company's KAP sub-sector.
- **Minimum group size:** 5 companies with a computable value for the ratio in the same period. If the sub-sector is smaller, the KAP main sector is used, and the page says so. If the main sector is also smaller than 5, no comparison is shown ("group too small").
- **Same basis:** only filings of the same template family and the same period end are compared; consolidated and solo filings are not mixed.
- **What is shown:** the group's median and quartiles (25th and 75th percentile), the group size, the group name and where the company's value falls. No "best" or "worst" labels and no scores.
- Companies without a KAP sector ([0017](0017-company-type-from-kap-sectors.md)) are not part of any group.

## Consequences

- The collector stores KAP's sector classification with the date it was read, so a comparison can be traced to the classification it used.
- A company that changes sector on KAP moves group from the next period on; earlier comparisons keep the classification they were made with.
- Revisit if analysts find KAP's groups too broad for a ratio (e.g. holding-like conglomerates); a custom grouping would need its own decision.
