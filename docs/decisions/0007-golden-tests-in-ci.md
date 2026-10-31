# 0007. Run golden tests in CI by downloading the raw files

- **Status:** accepted
- **Date:** 2026-10-31
- **Decided by:** @BerkeDurdu
- **Discussion:** #128

## Context

Golden tests (#20) compare the parser's output on a raw KAP file with a hand-checked CSV. Raw files are not committed (decision 0001), so CI skipped these tests and could not catch a regression like the column shift in #14. Since #38 the downloader is reliable: a quarter's zip (28.6 MB) downloads in about 10 seconds, and single files can be taken out of it.

## Options considered

1. Commit a few raw files. This changes decision 0001 and depends on KAP's reuse terms (#103).
2. Commit HTML fragments cut from raw files. It is still KAP content.
3. **Download in CI** the raw files the tests need, and cache them.
4. Keep golden tests local only.

## Decision

Option 3.

- `tests/raw_files.txt` lists every raw file the tests use, one `{year}_{quarter}/{file}` per line. `apps/server/test/raw-files.test.ts` fails if a golden CSV's raw file is not listed.
- `bun run download --files tests/raw_files.txt data/raw` downloads each listed quarter once and keeps only the listed files: 9 files, 11 MB, about 6 s. It exits 1 if any listed file is missing.
- The CI job `golden` runs it and then the whole test suite.
- `data/raw` is cached under a key made from the list's hash, so KAP is contacted only when the list changes or the cache expires.

## Consequences

- A parser change that breaks a golden value fails the `golden` job on its pull request.
- `golden` is not a required check. If KAP is down and the cache is cold, it fails without blocking unrelated work. Reviewers must look at it for parser changes.
- If KAP replaces a listed filing (a correction gets a new disclosure id), the download reports the file as missing and `golden` fails until the list and the golden file are updated. That is intended: the golden file describes a filing that is no longer published.
- No KAP content enters the repository.
