# Decisions

Every methodology or project choice that changes results or how people work is recorded here, one file per decision. Copy [`0000-template.md`](0000-template.md), use the next number, and link the discussion.

| # | Decision | Status |
|---|---|---|
| [0001](0001-license.md) | License: Apache-2.0 for code, no redistribution of KAP data | accepted |
| [0002](0002-bitemporal-schema.md) | Bitemporal storage schema | accepted |
| [0003](0003-reconciliation-severity.md) | Which reconciliation checks block a filing | accepted |
| [0004](0004-visible-text-values.md) | Reading a value cell that has no `title` | superseded by 0005 |
| [0005](0005-visible-text-is-the-value.md) | The number shown in a cell is its value, not the `title` | accepted |
| [0006](0006-known-filing-errors-and-single-value-tolerance.md) | Tolerance for single-value checks and known filing errors | accepted |
| [0007](0007-golden-tests-in-ci.md) | Run golden tests in CI by downloading the raw files | accepted |
| [0008](0008-local-first-release.md) | The first release runs locally, with Docker | accepted |
| [0009](0009-zova-and-duckdb.md) | Zova for raw data and state, DuckDB for analysis | accepted |
| [0010](0010-typescript-and-bun.md) | Move the whole project to TypeScript on Bun | accepted |
| [0011](0011-ebitda-definition.md) | Default EBITDA definition: A (core operations), B shown next to it | accepted |
| [0012](0012-net-debt-scope.md) | Net debt: borrowings including leases − cash; financial investments not subtracted | accepted |
| [0013](0013-working-capital-scope.md) | Working capital: core items plus contract and prepayment items, by component | accepted |
| [0014](0014-annualisation-and-averages.md) | Annualisation: trailing twelve months with CPI, never multiplied | accepted |
| [0015](0015-materiality-thresholds.md) | Materiality: total assets, X = 1,000 bps, Z = 1% | accepted |
| [0016](0016-sector-comparison-groups.md) | Sector comparison: KAP sub-sector, at least 5 companies | accepted |
| [0017](0017-company-type-from-kap-sectors.md) | Company type from KAP sectors instead of a ticker list | accepted |

## Open decisions

Open decisions are tracked as issues with the [`decision`](https://github.com/octacity-org/vigil/labels/decision) label.
