/** The shared fixtures (#194) parse to the values they declare and load into DuckDB. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, parseDirectory, rows } from "../src/db.ts";
import {
  BANK,
  expectedTl,
  FIXTURES,
  fileName,
  GENERAL,
  HOLDING,
  loadedDatabase,
  parseFixture,
  writeRawFiles,
} from "./fixtures/index.ts";

for (const f of FIXTURES) {
  describe(f.ticker, () => {
    const pf = parseFixture(f);

    test("header fields", () => {
      expect([pf.company_code, pf.disclosure_id, pf.year, pf.quarter]).toEqual([
        f.ticker,
        f.disclosureId,
        f.year,
        f.quarter,
      ]);
      expect([pf.template_family, pf.scale_unit, pf.scale_multiplier, pf.consolidation_type]).toEqual([
        f.family,
        f.unit,
        f.multiplier,
        f.consolidation,
      ]);
    });

    test("every declared value is parsed, scaled to TL", () => {
      const declared = f.tables.flatMap((t) =>
        t.rows.flatMap((r) => Object.keys(r.values).map((c) => [t.role, r.row, Number(c)] as const)),
      );
      expect(pf.facts).toHaveLength(declared.length);
      for (const [role, row, col] of declared) {
        const fact = pf.facts.find(
          (x) => x.row_id === `${f.family}_role_${role}-row-${row}` && x.column_class === `col-order-class-${col}`,
        );
        expect(fact?.normalized_value_tl).toBe(expectedTl(f, role, row, col));
      }
    });
  });
}

test("periods come from the headers", () => {
  const revenue = parseFixture(GENERAL).facts.filter((x) => x.row_id === "general_role_310003-row-3");
  expect(revenue.map((x) => [x.period_start, x.period_end])).toEqual([
    ["2026-01-01", "2026-06-30"],
    ["2025-01-01", "2025-06-30"],
  ]);
});

test("a negative value", () => {
  const cost = parseFixture(GENERAL).facts.find(
    (x) => x.row_id === "general_role_310003-row-4" && x.column_class === "col-order-class-4",
  );
  expect(cost?.raw_value).toBe(-700_000n);
});

test("loadedDatabase has one report per fixture", async () => {
  const db = await loadedDatabase();
  try {
    expect(await rows(db, "SELECT company_code, scale_multiplier FROM reports ORDER BY disclosure_id")).toEqual([
      { company_code: GENERAL.ticker, scale_multiplier: 1n },
      { company_code: BANK.ticker, scale_multiplier: 1_000_000n },
      { company_code: HOLDING.ticker, scale_multiplier: 1_000n },
    ]);
    const cash = await rows(
      db,
      "SELECT normalized_value_tl AS v FROM facts WHERE disclosure_id = $1 AND row_id = 'banks_role_210011-row-4' AND column_class = 'col-order-class-4'",
      [BANK.disclosureId],
    );
    expect(cash).toEqual([{ v: expectedTl(BANK, "210011", 4, 4) }]);
  } finally {
    close(db);
  }
});

test("writeRawFiles makes a quarter folder that parseDirectory reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-fixtures-"));
  try {
    writeRawFiles(dir);
    const [filings, report] = parseDirectory(join(dir, "2026_2"));
    expect(report.files.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    expect(filings.map((x) => x.file_name).sort()).toEqual(FIXTURES.map(fileName).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
