# Golden dataset

Values copied **by hand** from raw KAP files. Tests compare parser output against these values, so a parser bug cannot hide behind its own output (see #20).

## Rules

1. **Never use parser output.** Open the raw file and read the cell yourself.
2. **Do not prepare golden data for code you wrote.** Whoever wrote the parser does not extract or check its golden data.
3. **Every file is checked by a second person** before it is used by tests. The checker fills `checked_by`.
4. **Empty cells are data.** If a cell has no value, record it with an empty `raw_value`. Empty cells are where the column-shift bug (#14) happens.
5. **Copy numbers exactly.** No rounding, no thousand separators, keep the minus sign.
6. **Only real filings.** No invented rows or values.

## Layout

One CSV per filing, grouped by quarter:

```
tests/golden/
├── README.md
├── _template.csv
└── 2026_2/
    ├── KATMR_1651411.csv
    └── MOGAN_1645679.csv
```

The file name is `{company}_{disclosure_id}.csv`, taken from the raw file name `{company}_{disclosure_id}_{year}_{quarter}.xls`. Some companies publish more than one filing per quarter (for example consolidated and solo), so the disclosure id is part of the name.

Files are UTF-8, comma-separated, with a header row. Quote a field if it contains a comma.

**Add the raw file to [`tests/raw_files.txt`](../raw_files.txt)** (`2026_2/KATMR_1651411_2026_2.xls`) in the same pull request. CI downloads the listed files from KAP and runs the golden tests on them; a golden CSV without its listed raw file fails `tests/test_raw_files.py` (#128).

## Columns

| Column | Example | Meaning |
|---|---|---|
| `company` | `KATMR` | Ticker as in the raw file name |
| `disclosure_id` | `1651411` | KAP disclosure id from the raw file name |
| `year` | `2026` | `Yıl` in the file header |
| `quarter` | `2` | `Periyot` in the file header |
| `template` | `general` | One of `general`, `banks`, `finance`, `holding`, `insurance` (prefix of the table id) |
| `consolidation` | `Konsolide` | `Finansal Tablo Niteliği` in the file header, copied as written |
| `table_id` | `general_role_310003` | Table id, from `tbl_...` in the table's class |
| `statement` | `income_statement` | One of `balance_sheet`, `income_statement`, `oci`, `cash_flow`, `equity_changes`, as in `docs/glossary.md` |
| `row_id` | `general_role_310003-row-42` | Row class in the raw HTML |
| `row_label` | `Yatırım Faaliyetlerinden Giderler` | Turkish row title as written |
| `column` | `col-order-class-5` | Value cell class in the raw HTML |
| `period_label` | `Önceki Dönem 01.01.2025 - 30.06.2025` | Column header text as written; see step 5 below for two-line headers |
| `raw_value` | `-36464628` | The number shown in the cell, without thousands separators (`-36.464.628` → `-36464628`). Empty if the cell shows nothing. Not the `title` attribute (decision 0005) |
| `scale_unit` | `TL` | `Sunum Para Birimi` in the file header: `TL`, `1.000 TL` or `1.000.000 TL` |
| `value_tl` | `-36464628` | `raw_value` × scale (1, 1,000 or 1,000,000). Empty if `raw_value` is empty |
| `extracted_by` | `your-github-handle` | Who copied the value |
| `checked_by` | `another-handle` | Who checked it. Empty until checked |
| `note` | `shifted by #14` | Optional. Why this row matters |

`raw_value` and `value_tl` are both kept so that a scale error is visible on its own (#35).

## Which rows to extract

For each filing, at least:

- **Balance sheet:** total current assets, total non-current assets, total assets, short-term and long-term liabilities, total equity, total liabilities and equity, cash and cash equivalents.
- **Income statement:** revenue, cost of sales, gross profit, operating profit, profit before tax, net profit, parent-company net profit. All columns, including the 3-month ones.
- **Cash flow:** operating, investing and financing totals, net change in cash, cash at the beginning and end of the period.
- **Rows with empty cells** next to filled ones, and any row named in the filing's issue.

The issue for each filing may ask for more.

## How to extract a value

The `.xls` files from KAP are HTML pages.

1. Copy the raw file and change the extension to `.html`, then open it in a browser.
2. Find the row by its Turkish title (`Ctrl+F`).
3. Right-click the value and choose **Inspect**. The surrounding `<tr class="...">` gives `row_id`. The cell's `<td class="taxonomy-context-value col-order-class-N">` gives `column`. The number shown in the cell is `raw_value`: drop the `.` thousands separators and keep a leading `-`.
4. Read `column` and the number **inside that one cell only.** Do not use the cell's `title` attribute: in some filings it holds another number or sits on the neighbouring row (#148). If the `title` differs from the shown number, write both in `note`.
5. Match the column to its header. Value cells start at `col-order-class-4` and follow the headers from left to right. Write `period_label` like this:
   - A header shown on two lines, such as `Önceki Dönem` over `01.01.2025 - 30.06.2025`, is one cell. Join the lines with a single space: `Önceki Dönem 01.01.2025 - 30.06.2025`.
   - Bank tables have a second header row (`TP` / `YP` / `Toplam`) under each period. Add it after ` · `: `Cari Dönem 30.06.2026 · TP`.
6. Read `Sunum Para Birimi` at the top of the page for `scale_unit`.

## Checking a file

The checker opens the same raw file and verifies every row: value, column, period label, scale and sign. If everything matches, they fill `checked_by` and approve the pull request. If something is wrong, they comment on the row in the pull request.
