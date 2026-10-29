# KAP financial statement files

What a quarterly KAP file looks like, for anyone touching the downloader, the parser or the golden dataset. Counts below come from 246 files of 2026/2 (a partial download); the full quarter has more files and may contain cases not listed here (see #124, #125).

## Download

```
GET https://www.kap.org.tr/tr/api/financialTable/download/{year}/{quarter}
```

- Returns one zip per quarter with one file per filing: 778 files (28.6 MB, about 1 GB unpacked) for 2026/2 and 672 for 2026/1, measured on 2026-10-29.
- The response has no `Content-Length` and **ignores `Range`** (it answers `200` from the first byte), so a cut-off download cannot be resumed; it has to start again.
- Every member is deflated and written with a data descriptor: the local header has no sizes or CRC, they follow the data.
- Downloads are often cut off (between 3.7 and 15 MB in earlier tests; two complete downloads in about 10 seconds on 2026-10-29). Complete members can still be recovered from a partial zip: read each local header (`PK\x03\x04`), inflate with `zlib.decompressobj(-15)` until the stream ends, then check the CRC from the data descriptor. Do not find a member's end by searching for the next `PK` signature; it can occur inside compressed data.
- `python -m vigil.downloader {year} {quarter} data/raw` does all of this: it retries from the start with backoff, keeps the longest attempt, and reports recovered and lost files (#38).
- `checkFileExist` gave unreliable answers during prototyping; do not depend on it (#39).
- Raw files are never committed (decision [0001](decisions/0001-license.md)).

## File name

```
{TICKER-GROUP}_{disclosure_id}_{year}_{quarter}.xls
KATMR_1651411_2026_2.xls
ADB-ADBNK_1652729_2026_2.xls
```

`TICKER-GROUP` is one ticker or several joined by `-` (24 of 246 files). The first part is used as the company code. `disclosure_id` is the KAP disclosure number and identifies the filing.

## Encoding

Despite the `.xls` extension, files are **UTF-8 HTML** (Excel-flavoured, `Generator: Microsoft Excel 11`). The charset is declared in an unusual way (`<meta http-equiv="Content-Type" content="text/html;" charset="utf-8">`); browsers still pick it up, so a copy renamed to `.html` opens fine.

## File header

Before the tables, the file states:

| Field | Example | Notes |
|---|---|---|
| Company name | `KATMERCİLER ARAÇ ÜSTÜ EKİPMAN SANAYİ VE TİCARET A.Ş.` | |
| `Finansal Rapor Gönderim Tarihi` | `17.08.2026 19:05:18` | Submission timestamp. Decision 0002 orders versions by disclosure id because no publication time was known; this field could replace that assumption. |
| `Bildirim Tipi` | `FR` | |
| `Yıl` | `2026` | Report year |
| `Periyot` | `2` | Report quarter. Does not tell the period for special fiscal years; use column header dates. |
| `Sunum Para Birimi` | `TL`, `1.000 TL`, `1.000.000 TL` | Reporting unit: 187, 44 and 15 files |
| `Finansal Tablo Niteliği` | `Konsolide` | All 246 files in the sample |

## Tables

Each statement is a `<table>` whose class contains `tbl_{family}_role_{code}`, e.g. `tbl_general_role_310003`.

### Template families

| Family | Tables in sample | Used by |
|---|---|---|
| `general` | 928 | Industrial, trade and service companies |
| `banks` | 84 | Banks |
| `finance` | 48 | Leasing, factoring and other finance companies |
| `holding` | 25 | Holding companies |
| `insurance` | 20 | Insurers |

`par-banks` (participation banks, ALBRK) exists in the full quarter but is not handled yet (#124). Row meanings differ between families: row 58 is discontinued operations in `general`, deferred tax in `holding`, and a life technical expense in `insurance`.

### Role codes

The first two digits of the six-digit role code give the statement:

| Prefix | Statement | Tables in sample |
|---|---|---|
| `21` | Balance sheet | 268 (banks have two) |
| `31` | Income statement | 246 |
| `41` | Other comprehensive income (one holding filing, SAHOL) | 1 |
| `42` | Other comprehensive income | 98 |
| `51` | Cash flow, direct method | 28 |
| `52` | Cash flow, indirect method | 218 |
| `61` | Statement of changes in equity | 246 |

Within a family the code can differ by filing: the general income statement appears as `310003`, `310000` or `310002`, and a company can switch codes between quarters (MSY: `banks_role_310016` → `310017`, see #31).

## Rows

- A row is `<tr class="{family}_role_{code}-row-{n} ...">`, e.g. `general_role_310003-row-42`.
- The Turkish label sits in a nested table inside the first cells, in a `div` with class `content-tr`. A row's cells therefore span a nested `</tr>`; split rows on the next `<tr class="..._role_...-row-...">`, not on the first `</tr>`.
- Row numbers are stable within one role code, not across families or codes.

## Value cells

- A value cell is `<td class="taxonomy-context-value col-order-class-N ...">`.
- The value is the cell's `title` attribute, **unscaled**: multiply by the reporting unit (`1`, `1,000`, `1,000,000`) to get TL. The visible text is the same number with thousands separators (`39.369`).
- **Some cells have visible text but no `title`** (all of YONGA 2026/2, a few cells in six other files). Read the text only then, and only in the format `-?\d{1,3}(\.\d{3})*`; fail on anything else (decision [0004](decisions/0004-visible-text-values.md)).
- `title` and visible text can disagree: 84 cells in 2026/2, 9 of them outside the equity statement (MNDTR, three-month income statement column). Use `title` and count the disagreement.
- **An empty cell has neither `title` nor text.** Read `title` only inside its own `<td>...</td>`; searching forward from the cell start picks up the next cell's value (this is the column-shift bug, #14).
- No decimal values were found in the 2026/2 sample.

### Columns

Value columns start at `col-order-class-4` and follow the headers from left to right. Headers are `<td class="context-header">` cells; a header shown on two lines is one cell split by `<br>` (e.g. `Önceki Dönem<br>01.01.2025 - 30.06.2025`).

| Table | Columns | Meaning |
|---|---|---|
| General balance sheet | 4, 5 (6) | current period end, prior year end; a 6th column means restated comparatives (3 files in sample) |
| General income statement | 4–7 | current cumulative, prior cumulative, current 3-month, prior 3-month (3-month columns only in Q2/Q3) |
| General cash flow | 4, 5 | current cumulative, prior cumulative (always cumulative) |
| Bank / finance balance sheet | 4–9 | current TP, YP, Total; prior TP, YP, Total. Two header rows: period over `TP` / `YP` / `Toplam` |
| Bank / finance income statement | 4–7 | as general |
| Statement of changes in equity | up to 52 | one column per equity component |

Columns beyond these exist in some filings of the full quarter (EXIMB, VDFAS balance sheets use 10–12, #125).

## Periods

Read periods from the header dates (`01.01.2026 - 30.06.2026`, or a single date for balance sheets), never from `Periyot` or the quarter in the file name. Special fiscal periods exist: MAVI's 2026/2 covers `01.02.2026 - 31.07.2026`, its balance sheet is at `31.07.2026` against `31.01.2026`, and its three-month columns are May–July.

The parser (#36):

- gives every column and every value `period_start` and `period_end` from its header; a balance sheet column has only `period_end`;
- sets the period type from the dates: one date is `POINT_IN_TIME` (`_TP` / `_YP` for currency parts), a span of at most 100 days is `Q_STANDALONE`, a longer one `YTD_CUMULATIVE`. A first-quarter cumulative column is therefore `Q_STANDALONE`;
- records the filing's reporting period (the earliest-starting current-period span) and whether it covers as many quarters as the file name says. The data quality report lists filings where it does not, filings without header dates and fiscal years that do not start on 1 January.

In 2026/2 every value has header dates and every filing's period matches its file name; MAVI is the only special fiscal period.

Under IAS 29 (TMS 29), every report restates its comparative columns in the purchasing power of its own period end, so the same period appears with different values in different reports (see `docs/SCHEMA.md`).
