# Legal notes: KAP data and the investment advice boundary

> **This is not legal advice.** It is a first-pass summary by contributors, with sources, to guide wording and design. Before any public launch (Phase 4), a person with legal training should review it.

Last reviewed: 2026-10-23 · Issue: #12

## Summary

| Question | Short answer | Confidence |
|---|---|---|
| Can Vigil present information from financial statements? | Yes, as long as it stays *financial information* and does not become *directive* (yönlendirici) recommendation | Medium — based on SPK's guide, not on a ruling about a tool like Vigil |
| Does Vigil need an SPK investment advice licence? | Not if it never gives person-specific or directive recommendations. Investment advice is a licensed activity | Medium |
| Is calling outputs "signals" a problem? | Possibly in Turkish user-facing text. "Al-sat sinyali" services have been treated as investment advice | Medium |
| What are KAP's terms for automated bulk download and reuse? | **Not found.** No public terms of use page was located on kap.org.tr | Open |
| Can KAP files be redistributed in this repository? | We do not do it (decision 0001), so the question does not arise | — |

## 1. The investment advice boundary (SPK)

### What the rules say

- **Investment advice is a licensed activity.** Under the Capital Markets Law No. 6362, investment advice (*yatırım danışmanlığı*) is an investment service. SPK's 2022 announcement on the III-37.1 amendment states it can only be carried out by investment firms and portfolio management companies authorised by the Board. [SPK, 2022]
- **Financial information is not investment advice.** SPK's guide on investment services (i-SPK.37.1) treats presenting information such as past performance, risk level or content as *"finansal bilgi sunumu"* (presenting financial information), not as a directive recommendation, and not within investment advice. [SPK guide]
- **General investment recommendations** (*genel yatırım tavsiyesi*) are directive research or comments not aimed at a specific person. They are also outside investment advice, but subject to rules in the III-37.1 communiqué. [SPK guide]
- **"Buy/sell signal" services** presented as general recommendations can be considered investment advice; at least one brokerage ended such a service in 2016, citing SPK regulation. [QNB Invest]

### Where Vigil sits

Vigil should stay in the **financial information** category, which is the safest of the three:

| Vigil does | Vigil does not |
|---|---|
| Report what changed in published statements | Say whether to buy, sell or hold |
| Show calculations and sources | Give price targets or return forecasts |
| Rank changes by size relative to the company | Rank companies as investments |
| Use neutral wording ("margin fell 26 points") | Use directive wording ("risky", "avoid", "opportunity") |
| Treat every user the same | Tailor anything to a user's portfolio or risk profile |

### Design consequences

1. **Turkish UI should avoid the word "sinyal".** Use *bulgu* (finding) or *değişim* (change) in user-facing Turkish text. "Signal" can stay as an internal/code term (S1, S2, S3).
2. **No personalisation.** No watchlists that produce recommendations, no portfolio input, no "suitable for you".
3. **Neutral headings.** No "warning", "danger", "red flag" labels on companies.
4. **No price data next to findings** in a way that implies a trading conclusion.
5. **LLM explanations** must pass the advice-language filter (#88) and must not invent causes or outlooks.

## 2. KAP data

### What we know

- Companies listed on Borsa Istanbul publish financial statements on KAP as a legal disclosure obligation; disclosures are freely accessible on kap.org.tr.
- KAP is operated by MKK (Merkezi Kayıt Kuruluşu). The KAP membership directive found on the site covers obligations of disclosing members, not readers or reusers of the data. [KAP directive]
- **No public terms of use or legal notice for readers was found on kap.org.tr.** Searches and the site footer returned only regulatory and membership documents.
- Third-party KAP services publish their own terms that forbid bots and scrapers on *their* platforms; those terms bind their users, not KAP. [KAP Analiz]
- Commercial redistribution of market data in Turkey is typically licensed (for example, authorised data distributors for Borsa Istanbul data). No public licence for redistributing KAP disclosures was found. [MKK, search results]

### What Vigil does

- **No redistribution:** raw KAP files are never committed (decision [0001](decisions/0001-license.md)). Each user downloads from the source.
- **Polite access:** one sequential download per quarter, retries with backoff, no parallel bulk requests, no repeated downloads of unchanged files.
- **Attribution:** every finding links to its KAP disclosure id.
- **Non-commercial:** the project is open source and free. A commercial service would need a separate review of MKK / Borsa Istanbul data licensing.

### Open questions

- Does KAP / MKK have written terms for automated bulk download through the `financialTable/download` endpoint? → #103 asks MKK in writing (kapdestek@mkk.com.tr is the support address shown on KAP's error pages).
- Are hand-extracted values from filings in `tests/golden/` acceptable as test fixtures? Likely yes (facts, small amounts, attributed), but confirm together with the question above.

## 3. Proposed disclaimer

**Turkish (README, every page footer, every generated report):**

> Vigil yatırım tavsiyesi vermez. Burada yer alan bilgiler, şirketlerin Kamuyu Aydınlatma Platformu'nda (KAP) yayımladığı finansal tablolardan hesaplanmıştır ve yatırım danışmanlığı kapsamında değildir. Alım, satım veya elde tutma önerisi, hedef fiyat ya da getiri tahmini içermez. Hesaplamalarda hata olabilir; her bulgu kaynağıyla birlikte gösterilir ve karar vermeden önce asıl bildirimle karşılaştırılmalıdır.

**English:**

> Vigil does not give investment advice. The information here is calculated from financial statements published by companies on the Public Disclosure Platform (KAP) and is not investment advice. It contains no buy, sell or hold recommendation, price target or return forecast. Calculations may contain errors; every finding is shown with its source and should be checked against the original disclosure.

## 4. Words and phrases to avoid in user-facing text

Used by the LLM advice-language filter (#88) and in UI review.

| Turkish | English |
|---|---|
| al, sat, tut, alım fırsatı, satış fırsatı | buy, sell, hold, buying opportunity |
| hedef fiyat, potansiyel getiri, prim yapar, düşer/yükselir (fiyat için) | target price, upside, will rise/fall |
| ucuz, pahalı, iskontolu, değerinin altında | cheap, expensive, undervalued, overvalued |
| tavsiye ederiz, öneririz, portföye ekleyin | we recommend, add to portfolio |
| riskli hisse, tehlike, kırmızı alarm, kaçının | risky stock, danger, red flag, avoid |
| sinyal (kullanıcıya dönük metinde) | trading signal |
| güvenli liman, kazandırır | safe haven, will make money |

## Sources

- [SPK — Announcement on the 2022 amendment to Communiqué III-37.1](https://spk.gov.tr/duyurular/basin-duyurulari/2022/yatirim-hizmetleri-ve-faaliyetleri-ile-yan-hizmetlere-iliskin-esaslar-hakkinda-teblig-iii-37-1de-degisiklik-yapilmasina-dair-teblig)
- [SPK — Guide on investment services and activities and investment firms (i-SPK.37.1), PDF](https://spk.gov.tr/data/61e206f81b41c61238835ef6/0c27ddbbf23420352f41b5550a4137e6.pdf)
- [Communiqué III-37.1, consolidated text (mevzuat.gov.tr)](https://mevzuat.gov.tr/File/GeneratePdf?mevzuatNo=18576&mevzuatTur=Teblig&mevzuatTertip=5)
- [QNB Invest — announcement ending its buy/sell signal service (2016)](https://www.qnbinvest.com.tr/forex/duyuru/spk-al-sat-sinyallerine-dair-tebligi)
- [KAP — Directive on KAP membership and sending disclosures](https://www.kap.org.tr/tr/api/about/content-file/402881cf91d6efd60191d6f08e900001)
- [KAP Analiz — terms of use (third-party service, for comparison)](https://www.kapanaliz.com.tr/kullanim-kosullari)
- [MKK — PUSULA data platform user agreement (example of MKK data terms)](https://www.mkk.com.tr/sites/default/files/2025-09/PUSULA_Araci_Kurumlar_MKK_Veri_Analiz_Platformu_Uygulamasi_Kullanici_Uyelik_Sozlesmesi_1.pdf)
