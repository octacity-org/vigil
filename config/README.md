# Configuration

`vigil.json` holds the thresholds and definitions the rules run with (#69). They are analyst decisions, so they live here and not in the code. Set `VIGIL_CONFIG` to use another file.

The file is checked strictly when it is read. A missing key, an unknown key, a wrong type or a value out of range stops the run with the key's name. Nothing falls back to a built-in value.

| Key | Value | Source |
|---|---|---|
| `version` | Stored with every finding. Change it whenever a value changes, so findings under the old values stay traceable. | #185 |
| `ebitda_definition` | `A` (core operations) or `B` (operating profit + D&A). Findings and ratios use it; the other is shown next to it. | [0011](../docs/decisions/0011-ebitda-definition.md) |
| `real_sector.max_financial_row_share_of_revenue` | A general-template filing whose financial-sector revenue (row 6) or cost (row 17) is above this share of revenue (row 3) is not real-sector. | prototype |
| `s1_gross_margin.x_min_abs_delta_bps` | X: three-month gross margin change, in basis points, year on year. | [0015](../docs/decisions/0015-materiality-thresholds.md) |
| `s1_gross_margin.z_min_share_of_denominator` | Z: \|Δmargin\| × revenue as a share of the denominator. Applied by #66. | 0015 |
| `s1_gross_margin.denominator` | The denominator of Z: `total_assets`. | 0015 |
| `s1_gross_margin.min_three_month_revenue_tl` | Both three-month revenues are at least this, in TL. | prototype |
| `s2_profit_cash.min_net_profit_ytd_tl` | Year-to-date net profit is at least this, in TL. | prototype; #67 replaces S2 with [0018](../docs/decisions/0018-profit-cash-divergence-trigger.md) |
| `s2_profit_cash.max_operating_cash_flow_ytd_tl` | Year-to-date operating cash flow is at most this, in TL. | prototype; #67 |

Amounts are whole TL; shares are numbers between 0 and 1 (`0.01` is 1%).
