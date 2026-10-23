# Glossary: Turkish–English financial statement terms

KAP labels are Turkish; code, issues and variable names are English. Use these names consistently.

## Statements

| Turkish | English | Code name | Meaning |
|---|---|---|---|
| Bilanço / Finansal durum tablosu | Balance sheet / statement of financial position | `balance_sheet` | Assets, liabilities and equity at one point in time |
| Kâr veya zarar tablosu / Gelir tablosu | Income statement | `income_statement` | Revenue, expenses and profit over a period |
| Diğer kapsamlı gelir tablosu | Statement of other comprehensive income | `oci` | Gains and losses recognised outside profit or loss |
| Nakit akış tablosu | Cash flow statement | `cash_flow` | Cash generated and used; always cumulative on KAP |
| Özkaynak değişim tablosu | Statement of changes in equity | `equity_changes` | Movements in equity accounts |
| Dipnot | Footnote / note | `footnote` | Detail behind a statement line; PDF only |

## Balance sheet

| Turkish | English | Code name | Meaning |
|---|---|---|---|
| Dönen varlıklar | Current assets | `current_assets` | Assets expected to be realised within a year |
| Duran varlıklar | Non-current assets | `non_current_assets` | Long-term assets |
| Nakit ve nakit benzerleri | Cash and cash equivalents | `cash` | Cash and very short-term liquid investments |
| Ticari alacaklar | Trade receivables | `trade_receivables` | Amounts owed by customers |
| Stoklar | Inventories | `inventories` | Raw materials, work in progress, finished goods |
| Peşin ödenmiş giderler | Prepaid expenses | `prepaid_expenses` | Payments made for future goods or services (short + long term) |
| Kısa vadeli yükümlülükler | Current liabilities | `current_liabilities` | Obligations due within a year |
| Uzun vadeli yükümlülükler | Non-current liabilities | `non_current_liabilities` | Obligations due after a year |
| Finansal borçlar / Borçlanmalar | Financial debt / borrowings | `financial_debt` | Bank loans, bonds and similar |
| Kiralama yükümlülükleri | Lease liabilities | `lease_liabilities` | Liabilities under IFRS 16 leases |
| Ticari borçlar | Trade payables | `trade_payables` | Amounts owed to suppliers |
| Müşteri avansları / Sözleşme yükümlülükleri | Customer advances / contract liabilities | `customer_advances` | Cash received before delivery |
| Özkaynaklar | Equity | `equity` | Total equity |
| Ana ortaklığa ait özkaynaklar | Equity attributable to owners of the parent | `equity_parent` | Equity excluding non-controlling interests |
| Kontrol gücü olmayan paylar | Non-controlling interests | `nci` | Minority shareholders' share in subsidiaries |
| Net borç | Net debt | `net_debt` | Financial debt − cash (scope: see decisions) |

## Income statement

| Turkish | English | Code name | Meaning |
|---|---|---|---|
| Hasılat | Revenue | `revenue` | Sales of goods and services |
| Satışların maliyeti | Cost of sales | `cost_of_sales` | Direct cost of what was sold |
| Brüt kâr (zarar) | Gross profit | `gross_profit` | Revenue − cost of sales |
| Ticari faaliyetlerden brüt kâr | Gross profit from commercial operations | `gross_profit_commercial` | Gross profit before finance-sector lines; used by S1 |
| Genel yönetim giderleri | General and administrative expenses | `g_and_a` | Operating expense |
| Pazarlama giderleri | Marketing / selling expenses | `selling_expenses` | Operating expense |
| Araştırma ve geliştirme giderleri | R&D expenses | `r_and_d` | Operating expense |
| Esas faaliyetlerden diğer gelirler / giderler | Other operating income / expenses | `other_operating` | FX differences, maturity differences on trade items, etc. (content in footnotes) |
| Esas faaliyet kârı (zararı) | Operating profit | `operating_profit` | Gross profit − operating expenses + other operating (net) |
| Yatırım faaliyetlerinden gelirler / giderler | Income / expenses from investing activities | `investing_income` | Gains and losses on investments |
| Değer düşüklüğü (TFRS 9) | Impairment (IFRS 9) | `impairment` | Expected credit losses etc. |
| Finansman gelirleri / giderleri | Finance income / expenses | `finance_income`, `finance_expense` | Interest and FX on financing |
| Net parasal pozisyon kazançları (kayıpları) | Net monetary position gain (loss) | `net_monetary_position` | IAS 29 gain/loss on monetary items; pre-tax, read with finance expense |
| Vergi öncesi kâr (zarar) | Profit before tax | `profit_before_tax` | |
| Vergi gideri (geliri) | Tax expense (income) | `tax` | Current and deferred tax |
| Durdurulan faaliyetler | Discontinued operations | `discontinued_ops` | Result of operations being sold or closed |
| Dönem kârı (zararı) | Profit for the period | `net_profit` | |
| Ana ortaklık payları | Attributable to owners of the parent | `net_profit_parent` | Profit excluding non-controlling interests |
| Amortisman ve itfa payları | Depreciation and amortisation (D&A) | `d_and_a` | Taken from the cash flow statement (cumulative) |
| FAVÖK | EBITDA | `ebitda_a`, `ebitda_b` | Two definitions; see decisions |

## Cash flow

| Turkish | English | Code name | Meaning |
|---|---|---|---|
| İşletme faaliyetlerinden nakit akışları | Cash flow from operating activities (CFO) | `cfo` | |
| Nakit dışı kalemlere ilişkin düzeltmeler | Adjustments for non-cash items | `non_cash_adjustments` | D&A, impairment, monetary position, etc. |
| İşletme sermayesinde gerçekleşen değişimler | Changes in working capital | `working_capital_change` | Source of truth for working capital change |
| Yatırım faaliyetlerinden nakit akışları | Cash flow from investing activities | `cfi` | |
| Maddi ve maddi olmayan duran varlık alımları | Purchase of PP&E and intangibles (capex) | `capex` | |
| Finansman faaliyetlerinden nakit akışları | Cash flow from financing activities | `cff` | |
| Serbest nakit akışı | Free cash flow (FCF) | `fcf` | CFO − capex |
| Tahakkuk oranı | Accrual ratio | `accrual_ratio` | (Net profit − CFO) / average total assets |

## Reporting

| Turkish | English | Code name | Meaning |
|---|---|---|---|
| Cari dönem / Önceki dönem | Current period / prior period | `current`, `prior` | |
| Kümülatif / 3 aylık | Cumulative (year-to-date) / 3-month | `ytd`, `q` | |
| Sunum para birimi | Presentation unit | `scale_unit` | TL, thousand TL or million TL |
| Yeniden düzenleme / Yeniden ifade | Restatement | `restated` | Prior-period figures changed in a later report |
| Yüksek enflasyonlu ekonomilerde finansal raporlama (TMS 29) | Financial reporting in hyperinflationary economies (IAS 29) | `ias29` | Applied from 2023 year-end |
| TÜFE | Consumer price index (CPI) | `cpi` | Used to compare amounts across reports |
| Konsolide / Solo | Consolidated / separate | `consolidated`, `separate` | |
| Bildirim | Disclosure | `disclosure_id` | KAP announcement number (e.g. 1651411) |
