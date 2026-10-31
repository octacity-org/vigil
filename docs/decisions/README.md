# Decisions

Every methodology or project choice that changes results or how people work is recorded here, one file per decision. Copy [`0000-template.md`](0000-template.md), use the next number, and link the discussion.

| # | Decision | Status |
|---|---|---|
| [0001](0001-license.md) | License: Apache-2.0 for code, no redistribution of KAP data | accepted |
| [0002](0002-bitemporal-schema.md) | Bitemporal storage schema | proposed |
| [0003](0003-reconciliation-severity.md) | Which reconciliation checks block a filing | proposed |
| [0004](0004-visible-text-values.md) | Reading a value cell that has no `title` | superseded by 0005 |
| [0005](0005-visible-text-is-the-value.md) | The number shown in a cell is its value, not the `title` | proposed |
| [0006](0006-known-filing-errors-and-single-value-tolerance.md) | Tolerance for single-value checks and known filing errors | accepted |
| [0007](0007-golden-tests-in-ci.md) | Run golden tests in CI by downloading the raw files | accepted |

## Open decisions

These are tracked as issues with the [`decision`](https://github.com/octacity-org/vigil/labels/decision) label:

- Default EBITDA definition
- Net debt scope
- Working capital scope
- Annualisation method
- Materiality denominator and thresholds X, Z
- Sector comparison groups
