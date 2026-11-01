# 0017. Company type from KAP sectors

- **Status:** accepted
- **Date:** 2026-11-01
- **Decided by:** @BerkeDurdu
- **Discussion:** #37

## Context

Real-sector findings (gross margin, profit vs. cash) must not run on brokerages, investment trusts or investment holdings. `packages/core/src/signals.ts` decides this with a hard-coded list of 34 tickers, a multi-ticker rule with a KRDMA exception, a GYO suffix rule and a check of financial-sector revenue. New or renamed companies break the list, and the template family cannot replace it: many of these companies file the general template.

KAP's Sektörler page classifies 626 listed companies into main sectors and sub-sectors, keyed by `mkkMemberOid` (`docs/kap.md`). Compared with the current rule on 778 filings of 2026/2:

| | Filings |
|---|---:|
| Eligible today | 531 |
| Eligible under this decision | 439 + the companies in the reviewed list below |
| Holding and investment companies (`HOLDİNGLER VE YATIRIM ŞİRKETLERİ`) eligible today | 32 |
| Securities investment trusts (`MENKUL KIYMET YATIRIM ORTAKLIKLARI`) eligible today | 8 |
| Venture capital trusts eligible today | 3 |
| Real estate investment trust eligible today (BASGZ, no GYO suffix) | 1 |
| Excluded today, real estate company under KAP (IHLGM) | 1 |
| General-template filings with no KAP sector | 49 |

The 49 filings without a sector come from companies whose shares are not listed but which file statements because they issue debt: 22 lease certificate (sukuk) issuers (`VARLIK KİRALAMA`), operating companies such as OPET, EKER and KORTS, and one holding (QYHOL). KRDMA is not one of them: Kardemir is on the page under KRDMD, and matching by `mkkMemberOid` instead of the ticker finds it.

## Options considered

1. **Template family only.** Cannot tell brokerages and investment holdings apart from industrial companies.
2. **KAP sector classification**, plus a reviewed list for companies KAP does not classify.
3. **Our own list of tickers** (today). Breaks with every new listing.

## Decision

Option 2. A filing is eligible for real-sector findings when all of these hold:

1. Template family is `general`.
2. The company's KAP main sector is not `MALİ KURULUŞLAR`. This excludes banks, insurers, brokerages, investment trusts, real estate investment trusts and **all holding and investment companies**, including industrial holdings such as KCHOL, SAHOL, ALARK and TAVHL, until the holding methodology (#95) exists.
3. Financial-sector revenue (income statement row 6) and cost (row 17) are each at most 5% of commercial revenue. This check uses the filing's own numbers and stays.

Companies are matched to KAP sectors by `mkkMemberOid`, never by ticker.

**Companies without a KAP sector** get their type from a reviewed data file, `packages/core/data/company-types.json`, kept like the known filing errors ([0006](0006-known-filing-errors-and-single-value-tolerance.md)):

- One entry per company: `mkkMemberOid`, ticker, title, type (`real_sector` or `financial`), and the reason with its source (the company's activity on its KAP general information page or its annual report).
- Lease certificate issuers (`Varlık Kiralama`) are `financial`.
- An entry is added only after someone has read the source; every addition goes through review like code.
- A company with no KAP sector and no entry gets no findings. Its statements are still shown, and the finding page says "company type not classified".

The ticker list, the multi-ticker rule, the KRDMA exception and the GYO suffix rule are removed.

## Consequences

- The collector reads KAP's sector classification and stores it with the date it was read. It is embedded in the Sektörler page, not served by a documented API; if KAP changes the page, the collector must fail loudly, not classify every company as unknown.
- Holdings produce no findings in the first release; their statements and ratios are still shown.
- Eight securities investment trusts, three venture capital trusts and BASGZ stop producing findings; IHLGM starts.
- The reviewed list starts with the companies that have no KAP sector in the archive; each new debt issuer needs an entry before it gets findings.
- Sector comparison groups ([0016](0016-sector-comparison-groups.md)) use the same classification.
