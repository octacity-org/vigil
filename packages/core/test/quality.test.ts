/** Per-file data quality report (#19). */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckResult,
  type FileQuality,
  fileQuality,
  GROUPS,
  KNOWN_FILING_ERRORS,
  markdownSummary,
  result,
  toCsv,
} from "../src/index.ts";
import { PUBLISHED, rawFile, readCsv } from "./helpers.ts";

const NO_TITLES = `<html><body>${PUBLISHED}
<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
<td class="taxonomy-context-value col-order-class-4"><div>120.759.073</div></td>
</tr></table></body></html>`;
const ONE = NO_TITLES.replace("<div>120.759.073</div>", '<div title="1">1</div>');

// Replace the check groups for one test, as the original tests did with monkeypatch.
const savedGroups = { ...GROUPS };
function fakeGroups(...results: CheckResult[]) {
  for (const k of Object.keys(GROUPS)) delete GROUPS[k];
  GROUPS.checks = () => results;
}
afterEach(() => {
  for (const k of Object.keys(GROUPS)) delete GROUPS[k];
  Object.assign(GROUPS, savedGroups);
});

test("a parse error is reported", () => {
  const row = fileQuality("TEST_1_2026_2.xls", "<html>no tables</html>");
  expect(row.status).toBe("parse_error");
  expect(row.error).toContain("ParseError");
});

test("a file without values is reported", () => {
  const row = fileQuality("TEST_2_2026_2.xls", NO_TITLES.replace("<div>120.759.073</div>", "<div></div>"));
  expect([row.status, row.facts]).toEqual(["no_values", 0]);
});

test("values come from the text and title problems are counted", () => {
  // Shown only as text, without `title` (YONGA 2026/2, #137).
  let row = fileQuality("TEST_6_2026_2.xls", NO_TITLES);
  expect([row.facts, row.title_disagreements, row.titles_without_text]).toEqual([1, 0, 0]);
  // A `title` with another number than the text (AVHOL 2026/1, #148).
  row = fileQuality(
    "TEST_7_2026_2.xls",
    NO_TITLES.replace("<div>120.759.073</div>", '<div title="123759073">120.759.073</div>'),
  );
  expect([row.facts, row.title_disagreements, row.titles_without_text]).toEqual([1, 1, 0]);
});

test("a known filing error is reported with its reason", () => {
  fakeGroups(result("profit", "blocking", "fail", { left: -682616n, right: 0n }));
  const key = "8|profit";
  (KNOWN_FILING_ERRORS as Map<string, string>).set(key, "row 62 is filed as 0");
  try {
    const row = fileQuality("TEST_8_2026_2.xls", ONE);
    expect([row.status, row.failed, row.known_errors, row.error]).toEqual([
      "known_error",
      0,
      1,
      "row 62 is filed as 0",
    ]);
    const summary = markdownSummary([row], "2026_2");
    expect(summary).toContain("| known_error | 1 |");
    expect(summary).toContain("| TEST_8_2026_2.xls | known_error | row 62 is filed as 0 |");
  } finally {
    (KNOWN_FILING_ERRORS as Map<string, string>).delete(key);
  }
});

test("a blocking failure fails the file", () => {
  fakeGroups(
    result("a", "blocking", "pass", { left: 1n, right: 1n }),
    result("b", "blocking", "fail", { left: 5n, right: 3n, left_source: "row-9 col-order-class-4" }),
  );
  const row = fileQuality("TEST_3_2026_2.xls", ONE);
  expect([row.status, row.passed, row.failed]).toEqual(["fail", 1, 1]);
  expect(row.first_failure).toBe("b at row-9 col-order-class-4: 5 vs 3 (difference 2)");
});

test("an informational difference does not fail the file", () => {
  fakeGroups(
    result("balance", "blocking", "pass", { left: 1n, right: 1n }),
    result("cash", "informational", "fail", { left: 5n, right: 3n }),
  );
  const row = fileQuality("TEST_4_2026_2.xls", ONE);
  expect([row.status, row.failed, row.informational_differences]).toEqual(["pass", 0, 1]);
  expect(row.counts.checks).toEqual({ pass: 1, difference: 1 });
});

test("nothing checkable is not checked", () => {
  fakeGroups(result("x", "blocking", "not_checked", { reason: "template 'banks'" }));
  expect(fileQuality("TEST_5_2026_2.xls", ONE).status).toBe("not_checked");
});

describe("CSV and summary", () => {
  const base = fileQuality("A_1_2026_2.xls", ONE);
  const rows: FileQuality[] = [
    {
      ...base,
      file: "A_1_2026_2.xls",
      status: "pass",
      passed: 3,
      counts: { cash_flow: { pass: 3 } },
      period_start: "2026-02-01",
      period_end: "2026-07-31",
      company: "MAVI",
    },
    {
      ...base,
      file: "B_2_2026_2.xls",
      status: "no_values",
      error: "the parser found no values",
      counts: {},
      period_start: null,
      period_end: null,
    },
  ];

  test("the CSV has one row per file", () => {
    const csv = toCsv(rows);
    const path = join(tmpdir(), `vigil-quality-${process.pid}.csv`);
    writeFileSync(path, csv);
    expect(readCsv(path).map((r) => [r.file, r.status])).toEqual([
      ["A_1_2026_2.xls", "pass"],
      ["B_2_2026_2.xls", "no_values"],
    ]);
  });

  test("the summary", () => {
    const summary = markdownSummary(rows, "2026_2");
    expect(summary).toContain("| pass | 1 |");
    expect(summary).toContain("| cash_flow | 3 | 0 | 0 | 0 |");
    expect(summary).toContain("| B_2_2026_2.xls | no_values | the parser found no values |");
    expect(summary).toContain("Fiscal year not starting on 1 January: MAVI (2026-02-01 to 2026-07-31).");
    expect(summary).toContain("B_2_2026_2.xls (no header dates)");
  });
});

const katmr = rawFile("2026_2", "KATMR_1651411_2026_2.xls");

test.skipIf(katmr === null)("KATMR passes (raw file)", () => {
  const row = fileQuality("KATMR_1651411_2026_2.xls", readFileSync(katmr as string));
  expect([row.status, row.failed, row.informational_differences]).toEqual(["pass", 0, 0]);
});
