# Vigil

> ⚠️ **Not investment advice.** Vigil does not give buy/sell recommendations, price targets or return forecasts. It only reports what changed in the financial statements that Borsa Istanbul companies publish on KAP.

Vigil scans the quarterly financial statements of Borsa Istanbul companies on [KAP](https://www.kap.org.tr), flags material changes with explicit financial rules, and shows how every number was calculated and where it came from.

**Status:** early, Phase 0 (data correctness). See the [milestones](https://github.com/octacity-org/vigil/milestones) for the roadmap.

## How it works

1. **Download** the quarterly bulk archive of financial statements from KAP.
2. **Parse** the five KAP templates (general, bank, finance, holding, insurance) into a common data model.
3. **Check** subtotals and cross-statement reconciliation before computing anything.
4. **Signal** material changes with rule-based checks:
   - **S1 – Gross margin break:** 3-month gross margin against the same quarter last year.
   - **S2 – Profit–cash divergence:** profit and cash components side by side, accrual ratio.
   - **S3 – Restated comparatives:** prior-period figures changed in the balance sheet.

Every signal carries its inputs, its calculation steps and its source (file, statement, row, column).

## Principles

- **Rule-based:** every result can be recomputed by hand.
- **No approximations:** if a metric cannot be computed from the available data, Vigil says *not computable* and why.
- **Consistency first:** a filing that fails reconciliation or subtotal checks produces no signal.
- **No price talk:** Vigil describes statements; it never comments on share prices.

## Quick start

```bash
git clone https://github.com/octacity-org/vigil.git
cd vigil
pip install -e ".[dev]"
pytest
```

KAP files are **not** part of this repository. Download them locally into `data/raw/{year}_{quarter}/` with `src/vigil/downloader.py`. Tests that need them are skipped when they are missing.

Load a parsed quarter into DuckDB (re-running replaces each filing, it never duplicates rows):

```bash
python -m vigil.db data/raw/2026_2 data/vigil.duckdb
```

It prints the parse report (failed files and why) and checks that the row count of every filing in the database matches it.

## Documentation

| Document | Content |
|---|---|
| [`docs/VIGIL.md`](docs/VIGIL.md) | Full project document (Turkish): methodology, worked KATMR example, roles, roadmap, known issues |
| [`docs/DATA_CONTRACT.md`](docs/DATA_CONTRACT.md) | Data contract draft (Turkish) |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Bitemporal storage schema and example queries |
| [`docs/kap.md`](docs/kap.md) | KAP file format: download, encoding, header, tables, rows, value cells, columns |
| [`docs/glossary.md`](docs/glossary.md) | Turkish–English glossary of financial statement terms |
| [`docs/decisions/`](docs/decisions/) | Recorded methodology and project decisions |

## Contributing

Contributions with and without code are welcome: golden dataset entries, template row maps and methodology discussions need financial knowledge, not programming. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [`good first issue`](https://github.com/octacity-org/vigil/labels/good%20first%20issue) and [`no-code`](https://github.com/octacity-org/vigil/labels/no-code) labels.

Background and discussion: [Discussion #11](https://github.com/orgs/octacity-org/discussions/11).

## License

Code is licensed under [Apache-2.0](LICENSE). KAP data is not redistributed; it is downloaded from the source by each user.
