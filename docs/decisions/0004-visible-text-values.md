# 0004. Reading a value cell that has no `title`

- **Status:** proposed
- **Date:** 2026-10-29
- **Decided by:** pending review by the methodology owner
- **Discussion:** #137

## Context

The parser reads every value from the cell's `title` attribute, and `docs/kap.md` said never to read the visible text. In 2026/2, `YONGA_1647531_2026_2.xls` has no `title` attributes at all, so the parser returned zero facts for it without an error. Six more files have a few cells with visible text and no `title`; in INTEK this includes balance sheet rows 199 and 201 (5,467,245 and 6,438,223 TL).

Measured on all 246 files of 2026/2:

| Value cells | Count |
|---|---|
| `title` and visible text, same number | 165,905 |
| `title` and visible text, different numbers | 84 |
| Visible text only (no `title`) | 364 (331 in YONGA) |
| `title` only | 6 |

- Every visible text (166,353 cells) has the same format: `.` as thousands separator, a leading `-` for negatives, no decimals, no parentheses. It is unscaled, like the `title`.
- 75 of the 84 differences are in the statement of changes in equity (61xxxx), which the parser skips. The other 9 are in MNDTR's income statement, column `col-order-class-6` (current three months), rows 52–62 and 148–151. Both sets of numbers are internally consistent: MNDTR passes every subtotal and reconciliation check with either. Which one KAP intends cannot be told from the file alone.

## Options considered

1. **Keep `title` only** and report files like YONGA as having no values. Loses one whole filing and individual cells in others.
2. **Read the visible text only when the cell has no `title`**, with a strict format; any other format is a parse error.
3. **Always read the visible text.** Would change the 9 MNDTR cells without evidence that the text is the correct one.

## Decision

Option 2.

- `title` stays the source when present.
- Without `title`, the visible text is read only if it matches `-?\d{1,3}(\.\d{3})*`; anything else raises an error that names the row and column.
- Every filing records how many values came from text (`text_values`) and how many cells had a `title` that disagrees with the text (`text_disagreements`). The data quality report shows both.

## Reasoning

The two sources agree on 99.95% of the cells that have both, and the format of the text is uniform in the whole sample, so reading it is low-risk when it is the only source. With it, YONGA parses to 279 values and passes all 120 checks that apply to it, including both cash reconciliations. That is independent evidence that the text is read correctly. INTEK gains 7 values and 4 more checks pass. No other file changes.

## Consequences

- Quality report for 2026/2: 219 pass, 0 fail, 27 not checked, 0 without values (was 218 / 0 / 27 / 1).
- MNDTR's three-month column keeps the `title` values and is flagged with 9 disagreements. Revisit when the Q1 filing can be used to derive the three-month figures (Q2 YTD − Q1), or when KAP's rendered statement can be compared.
- Other quarters have not been checked yet; the strict format makes a different layout fail loudly instead of being misread.
