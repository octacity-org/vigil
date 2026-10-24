# 0001. License: Apache-2.0 for code, no redistribution of KAP data

- **Status:** accepted
- **Date:** 2026-10-23
- **Decided by:** @BerkeDurdu
- **Discussion:** #3

## Context

Vigil is an open source project. The code needs a license, and the project uses data published by companies on KAP.

## Options considered

1. **MIT** — short and permissive; no explicit patent grant.
2. **Apache-2.0** — permissive; includes an explicit patent grant and a patent-retaliation clause; requires stating changes.

## Decision

- Code is licensed under **Apache-2.0**.
- **KAP files are not committed or redistributed.** The repository contains the download script; every user downloads the data from KAP.
- Small hand-extracted values in the golden dataset (`tests/golden/`) may be committed as test fixtures.

## Reasoning

Apache-2.0 is as permissive as MIT for contributors and users, and its patent clause gives clearer protection for a project with many casual contributors. Not redistributing KAP files keeps the repository small and avoids questions about data reuse terms (see #12).

## Consequences

- `LICENSE` contains the Apache-2.0 text; `pyproject.toml` declares it.
- `.gitignore` excludes `data/raw/` and `data/processed/`.
- Revisit if KAP's terms of use (#12) restrict the golden dataset fixtures.
