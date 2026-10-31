# Contributing to Vigil

Thanks for helping. Vigil is built by volunteers who come and go, so the rules are written down here instead of living in someone's head.

## Ways to contribute

| You know... | Good places to start |
|---|---|
| Financial statements, no code | Golden dataset entries, template row maps, methodology decisions, signal labeling — label [`no-code`](https://github.com/octacity-org/vigil/labels/no-code) |
| TypeScript | Parser, metrics, signals, data pipeline, API — labels `area: parser`, `area: metrics`, `area: data`, `area: api` |
| Frontend | Signal list, company page, signal card — label `area: frontend` |
| LLMs | Row mapping assistant, signal explanations, footnote extraction — label `area: llm` |

Issues are labeled `easy`, `medium` or `hard`, and grouped by phase in the [milestones](https://github.com/octacity-org/vigil/milestones).

## Setup

Contributions come through **your own fork**. You do not need write access to this repository, and `main` is protected, so nobody pushes to it directly.

```bash
gh repo fork octacity-org/vigil --clone
cd vigil
bun install
```

You need [Bun](https://bun.sh) 1.4 or later (decision 0010). Without the GitHub CLI: click **Fork** on GitHub, then `git clone https://github.com/<your-user>/vigil.git`.

If you already cloned `octacity-org/vigil` and have local commits, keep them and add your fork as a remote:

```bash
gh repo fork octacity-org/vigil --remote --remote-name fork
git push -u fork HEAD
```

| Command | What it does |
|---|---|
| `bun run lint` | Lint and format check (Biome) |
| `bun run format` | Format |
| `bun run typecheck` | TypeScript type check |
| `bun test` | Tests |

CI runs lint, type check and tests on every pull request.

Layout (`docs/ARCHITECTURE.md`): `packages/core` holds the parser, checks, quality report, metrics and findings, with no file or network access; `apps/server` holds the downloader, the DuckDB loader and the command-line tools. Raw and TL amounts are `bigint`, never `number`.

### Opening a pull request

1. Create a branch for the issue, e.g. `git checkout -b issue-21-golden-format`.
2. Commit, then push the branch to your fork.
3. Open a pull request against `octacity-org/vigil:main` (`gh pr create -R octacity-org/vigil --fill`) and write `Closes #N` in the description.
4. CI runs on the pull request; a maintainer reviews it and merges.

Before starting new work, update your fork with `gh repo sync <your-user>/vigil` (or GitHub's *Sync fork* button), then `git pull` locally.

### KAP data

KAP files are not committed. Download a quarter into `data/raw/{year}_{quarter}/` with `bun run download 2026 2 data/raw`. The bulk endpoint is:

```
GET https://www.kap.org.tr/tr/api/financialTable/download/{year}/{quarter}
```

Downloads often truncate; the downloader salvages complete files from partial archives. Please be polite to the server: no parallel bulk downloads.

For the tests, `bun run download --files tests/raw_files.txt data/raw` fetches only the raw files they use. CI runs the golden tests the same way (job `golden`, decision 0007). If you add a golden file or a test that needs another raw file, list it in `tests/raw_files.txt`.

## Core rules

These apply to code, docs, issues and pull requests.

1. **No approximate numbers.** If a value cannot be computed from the data, return *not computable* with the reason. Never fill with 0, NaN or a guess.
2. **Every number is traceable** to its file, disclosure id, statement, row and column.
3. **Reconciliation before ratios.** Subtotals and cross-statement checks run before any metric.
4. **Tests use independent expected values.** Expected values come from the golden dataset (hand-extracted from raw files), never from the parser's own output.
5. **The author of code does not write its tests.** AI-written code is welcome, but the person or tool that wrote the code does not also write the tests that check it.
6. **No made-up figures** in docs, examples or issues. Use real, verified numbers or none.
7. **No investment language.** No buy/sell, target price, or forecasts — in code, UI text or docs.

### The ten financial rules

1. Compare within the same report first; across reports use the CPI (TÜFE) series.
2. Margins are 3-month and year-on-year; cumulative margins hide the latest quarter.
3. Stock–flow ratios state their annualisation and averaging explicitly.
4. Scope is consistent: parent-company profit ↔ parent-company equity.
5. Net debt has one fixed, explicit definition: borrowings − cash.
6. EBITDA has one fixed definition: gross profit − operating expenses + D&A.
7. Working capital change comes from the cash flow statement.
8. Net monetary position is not removed; it is read together with finance expense.
9. Reconciliation and subtotals are checked before ratios.
10. No ratio is interpreted without sector context.

Details and a worked example are in [`docs/VIGIL.md`](docs/VIGIL.md).

## Decisions

Methodology choices change results by large factors (at KATMR, one EBITDA definition is 79% higher than the other). Every such choice is recorded in [`docs/decisions/`](docs/decisions/) using the template there. Discuss first in [Discussions](https://github.com/orgs/octacity-org/discussions), then record the outcome.

## Issues and pull requests

- **Claim an issue** by commenting on it. If an assigned issue has no activity for **two weeks**, it is politely unassigned so someone else can pick it up. No hard feelings — school comes first.
- **Pull requests come from forks.** You do not need write access to contribute (see [Setup](#setup)).
- **One issue per pull request** where possible. Use `Closes #N` in the description.
- **Reviews are crossed:** parser changes are reviewed by the data owner, signal and metric changes by the methodology owner (see `.github/CODEOWNERS`).
- `main` is protected: a pull request, a green CI run and an approving review are required.

## Questions

Ask in the issue itself or in [Discussion #11](https://github.com/orgs/octacity-org/discussions/11).
