# 0010. Move the whole project to TypeScript on Bun

- **Status:** accepted
- **Date:** 2026-10-31
- **Decided by:** @BerkeDurdu
- **Discussion:** to be linked

## Context

The parser, checks, quality report, downloader, loader and tests are in Python (`src/vigil/`); the planned API was FastAPI and the frontend Next.js. With a local application (0008), the server runs the collector, the processing and the API, and DuckDB allows only one writing process per file (0009). One language and one process for all of it is simpler for the team and for users.

The move is cheapest now. Phase 2 (metrics and findings) has not started, and the hardest part of Phase 0 is captured in language-independent form:

- the golden dataset (`tests/golden/`, CSV);
- the quality report on the full 2026/1 and 2026/2 quarters: 1,450 reports, 0 failing, 1 known filing error (AKTVK);
- the rules in `docs/kap.md` and decisions 0001–0007.

## Options considered

1. **Stay in Python**: FastAPI for the API. Two languages with the frontend.
2. **Python for data, TypeScript for the API and frontend.** Two languages, and two processes sharing a DuckDB file.
3. **Everything in TypeScript.**

## Decision

Option 3.

- **Runtime: Bun.** Backend framework: Hono. Frontend: Next.js.
- The collector, the processing (parser, checks, metrics, findings) and the API run in **one Bun process**.
- **Numbers:** raw and TL values are integers held as `bigint` (or a decimal library where fractions are needed). A JavaScript `number` cannot hold integers above 2^53 exactly, and the checks work to one unit of the reporting unit (decision 0006).
- **One migration, not a gradual one.** The Python code is frozen while the port is under way (critical fixes only). The TypeScript version is built on a branch and merged once it matches Python; Python is then removed in one pull request.
- **Proof of equality** before Python is removed:
  - the golden tests pass;
  - on 2026/1 and 2026/2, every parsed value of all 1,450 reports equals the Python output, and the quality report is the same.

  The Python outputs are recorded once as the reference. They are derived from KAP files, so they are kept by the team or in CI caches, not committed (decision 0001).
- Later tools whose best libraries are in Python (US XBRL with `arelle` / `edgartools`, footnote PDF extraction; Phase 5) may stay separate Python tools.

## Consequences

- One language across server and frontend; types are shared directly.
- No new features land during the port.
- Contributors who wrote Python (#20–#22, #121–#123, metrics) move to TypeScript; this is to be discussed with the team.
- CONTRIBUTING, README, CI and `pyproject.toml` change with the port.
- Supersedes the Python and FastAPI choices in `VIGIL.md` §11.
