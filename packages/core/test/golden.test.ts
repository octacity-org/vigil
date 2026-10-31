/**
 * Parser output against hand-copied golden values (tests/golden/README.md). Runs when the raw files listed in
 * tests/raw_files.txt are in data/raw (CI downloads them, decision 0007).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ParsedFiling, parseKapXls } from "../src/index.ts";
import { goldenFiles, rawFile } from "./helpers.ts";

/** Golden rows the parser is known to get wrong: `${filing}|${row_id}` -> reason. Remove an entry once fixed. */
const KNOWN_BUGS = new Map<string, string>();

const parsed = new Map<string, ParsedFiling>();
function parse(path: string, name: string): ParsedFiling {
  let f = parsed.get(path);
  if (f === undefined) {
    f = parseKapXls(readFileSync(path), name);
    parsed.set(path, f);
  }
  return f;
}

for (const [, csvName, lines] of goldenFiles()) {
  const filingName = csvName.replace(/\.csv$/, "");
  const groups = new Map<string, Record<string, string>[]>();
  for (const line of lines) groups.set(line.row_id as string, [...(groups.get(line.row_id as string) ?? []), line]);

  const first = lines[0] as Record<string, string>;
  const rawName = `${first.company}_${first.disclosure_id}_${first.year}_${first.quarter}.xls`;
  const path = rawFile(`${first.year}_${first.quarter}`, rawName);

  describe.skipIf(path === null)(`${filingName} (data/raw/${first.year}_${first.quarter}/${rawName})`, () => {
    for (const [rowId, rows] of groups) {
      const known = KNOWN_BUGS.get(`${filingName}|${rowId}`);
      const run = known ? test.failing : test;
      run(rowId, () => {
        const f = parse(path as string, rawName);
        const facts = new Map(f.facts.filter((x) => x.row_id === rowId).map((x) => [x.column_class, x]));
        for (const line of rows) {
          const fact = facts.get(line.column as string);
          if (line.raw_value === "") {
            expect(fact, `${rowId} ${line.column}: expected an empty cell`).toBeUndefined();
            continue;
          }
          expect(fact, `${rowId} ${line.column}: expected ${line.raw_value}`).toBeDefined();
          expect(fact?.raw_value).toBe(BigInt(line.raw_value as string));
          expect(fact?.normalized_value_tl).toBe(BigInt(line.value_tl as string));
          expect(fact?.scale_unit).toBe(line.scale_unit as string);
          expect(fact?.period_label).toBe(line.period_label as string);
          expect(fact?.label_tr).toBe(line.row_label as string);
        }
      });
    }
  });
}
