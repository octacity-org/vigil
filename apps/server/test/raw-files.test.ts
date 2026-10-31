/** `tests/raw_files.txt` lists every raw file the golden tests need, so CI downloads them (#128, decision 0007). */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenFiles, REPO } from "../../../packages/core/test/helpers.ts";
import { readFileList } from "../src/downloader.ts";

test("every golden file has its raw file listed", () => {
  const listed = new Set<string>();
  for (const [quarter, names] of readFileList(join(REPO, "tests", "raw_files.txt")))
    for (const n of names) listed.add(`${quarter}/${n}`);
  const needed = new Set<string>();
  for (const [, , rows] of goldenFiles()) {
    for (const line of rows) {
      const q = `${line.year}_${line.quarter}`;
      needed.add(`${q}/${line.company}_${line.disclosure_id}_${q}.xls`);
    }
  }
  expect(needed.size).toBeGreaterThan(0);
  expect([...needed].filter((n) => !listed.has(n))).toEqual([]);
});

test("readFileList", () => {
  const path = join(tmpdir(), `vigil-files-${process.pid}.txt`);
  writeFileSync(path, "# comment\n\n2026_2/A_1_2026_2.xls\n2026_1/B_2_2026_1.xls  # why\n2026_2/C_3_2026_2.xls\n");
  expect(Object.fromEntries(readFileList(path))).toEqual({
    "2026_2": ["A_1_2026_2.xls", "C_3_2026_2.xls"],
    "2026_1": ["B_2_2026_1.xls"],
  });
});
