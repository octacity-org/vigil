# 0005. The number shown in a cell is its value, not the `title`

- **Status:** accepted
- **Date:** 2026-10-31
- **Decided by:** @BerkeDurdu
- **Discussion:** #148 (supersedes [0004](0004-visible-text-values.md), #137)

## Context

Decision 0004 kept the cell's `title` attribute as the value and read the visible text only when there was no `title`. It noted that MNDTR 2026/2 shows different numbers than its `title` in nine cells, and that the file alone could not tell which was right.

The full quarters 2026/1 and 2026/2 (#38) had 11 files failing blocking checks (#148). Reading the raw HTML of the subtotal failures showed the `title` was wrong, not the filing:

| File | What the raw file shows |
|---|---|
| ZOREN 2026/2 | Row 140 has `title="1248245"` and no text; row 141 shows `1.248.245` and has no `title`. The `title` sits one row too high. |
| ARDYZ 2026/1 | The same shift in rows 144/149 and 148/153. |
| SVGYO 2026/1 | The same shift in rows 203/205 of the cash flow statement. |
| AVHOL 2026/1 | Row 246 has `title="468518587"` but shows `465.518.587`. The shown number adds up to the total; the `title` is 3,000,000 too high. |

Counted over every value cell of 2026/1–2026/3 (1,450 files plus the in-progress 2026/3):

| Cells | Count |
|---|---|
| `title` and text show the same number | 959,753 |
| Different numbers | 166 |
| Text only (no `title`) | 1,626 |
| `title` only (no text) | 46 |

Every text has the format `-?\d{1,3}(\.\d{3})*`.

All checks were run twice on 2026/1–2, once reading only `title` and once reading only the text:

| Source | Blocking checks failed | Files |
|---|---|---|
| `title` | 14 | 11 |
| Visible text | 5 | 5 |

The text fixes six files: ZOREN, ARDYZ, SVGYO and AVHOL, plus TTRAK and MMCAS, whose parent-company profit `title` was 0. It introduces no new failure. The five that remain are four 2–4 unit rounding differences and AKTVK, whose row 62 is 0 in both (decision 0006).

The MNDTR question from 0004 points the same way. The three-month figure derived from the Q1 filing (Q2 year to date − Q1) is close to the shown number and far from the `title`: row 54 is −203.7 m derived, −204.1 m shown and −284.2 m in the `title`. It cannot match exactly, because Q1 figures are in March purchasing power (IAS 29).

## Options considered

1. **Keep `title` first (0004).** Leaves six filings failing for errors that are not in the filing.
2. **Visible text first; `title` only where there is no text.** This would take the misplaced `title`s of ZOREN, ARDYZ and SVGYO into rows that show nothing.
3. **Visible text only.** A cell that shows nothing is empty, whatever its `title`.

## Decision

Option 3.

- The value of a cell is the number it shows. Any other format raises an error naming the row and column.
- `title` is not used as a value. Each filing counts:
  - `title_disagreements`: cells whose `title` is another number;
  - `titles_without_text`: cells with a `title` but no shown number.
  The data quality report lists both.
- Golden files are extracted from the shown number (`tests/golden/README.md`).

## Reasoning

What KAP displays is what the company filed and what readers see. The `title` appears to be a copy that can drift: it can sit on the wrong row, keep another number, or be missing altogether. On two full quarters the text is consistent wherever `title` and text disagree, and never the other way round.

## Consequences

- Quality report, 2026/2: 662 pass, 0 fail, 1 known error (AKTVK, decision 0006), 115 not checked. 2026/1: 601 pass, 0 fail, 71 not checked.
- The golden files (KATMR, BIOEN) are unchanged: in them the shown number and the `title` agree everywhere.
- Revisit if a filing is found where the shown number is wrong and the `title` right.
