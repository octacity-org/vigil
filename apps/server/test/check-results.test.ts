/**
 * The `check_results` table (#183): written with the report, replaced with it, and added to older databases by
 * migration 4. The filing is KATMR 2026/2 from its hand-checked golden file; expected values are golden numbers and
 * `docs/SCHEMA.md`, not the loader's output.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { checkFiling, type ParsedFiling } from "@vigil/core";
import { katmrFromGolden } from "../../../packages/core/test/helpers.ts";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { CURRENT_VERSION, migrate, schemaVersion } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";

const KATMR = 1651411;
const AKTVK = 1647085;

let db: Database;
beforeEach(async () => {
  db = await connect(":memory:");
});
afterEach(() => close(db));

const q = (sql: string) => rows(db, sql);
const count = async (where = "") => Number((await q(`SELECT count(*) AS n FROM check_results ${where}`))[0]?.n);

function asDisclosure(f: ParsedFiling, id: number): ParsedFiling {
  return { ...f, disclosure_id: id, facts: f.facts.map((x) => ({ ...x, disclosure_id: id })) };
}
function withValue(f: ParsedFiling, rowId: string, column: string, value: bigint): ParsedFiling {
  return {
    ...f,
    facts: f.facts.map((x) =>
      x.row_id === rowId && x.column_class === column ? { ...x, raw_value: value, normalized_value_tl: value } : x,
    ),
  };
}

describe("loading a report writes its check results", () => {
  test("one row per check, positions 0..n-1 in run order", async () => {
    const katmr = katmrFromGolden();
    await loadFiling(db, katmr);
    const n = checkFiling(katmr).length;
    expect(await count()).toBe(n);
    const positions = (await q("SELECT position FROM check_results ORDER BY position")).map((r) => r.position);
    expect(positions).toEqual(Array.from({ length: n }, (_, i) => i));
    const groups = (await q("SELECT check_group FROM check_results ORDER BY position")).map((r) => r.check_group);
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([
      "reconciliation",
      "income_statement",
      "balance_sheet",
      "cash_flow",
    ]);
  });

  test("a single-value check is stored with its values, sources and tolerance", async () => {
    await loadFiling(db, katmrFromGolden());
    const [r] = await q("SELECT * FROM check_results WHERE name = 'total_assets_equal_liabilities_and_equity_current'");
    expect(r).toEqual({
      disclosure_id: BigInt(KATMR),
      position: 0,
      check_group: "reconciliation",
      name: "total_assets_equal_liabilities_and_equity_current",
      severity: "blocking",
      status: "pass",
      left_value: 14795418421n,
      right_value: 14795418421n,
      left_source: "general_role_210015-row-129 col-order-class-4",
      right_source: "general_role_210015-row-297 col-order-class-4",
      tolerance: 5n,
      reason: null,
      known_error: null,
    });
  });

  test("a subtotal is stored with its components and one unit of tolerance per formula component", async () => {
    await loadFiling(db, katmrFromGolden());
    const [r] = await q(
      `SELECT left_value, right_value, right_source, tolerance FROM check_results
       WHERE left_source = 'general_role_310003-row-5 col-order-class-4'`,
    );
    expect(r).toEqual({
      left_value: 518267459n,
      right_value: 518267459n,
      right_source: "general_role_310003-row-3, general_role_310003-row-4",
      tolerance: 2n,
    });
  });

  test("a not checked row has its reason and no values or tolerance", async () => {
    await loadFiling(db, katmrFromGolden());
    const bad = await q(
      `SELECT count(*) AS n FROM check_results WHERE status = 'not_checked'
       AND (reason IS NULL OR tolerance IS NOT NULL OR left_value IS NOT NULL)`,
    );
    expect(bad).toEqual([{ n: 0n }]);
    expect(await count("WHERE status = 'not_checked'")).toBeGreaterThan(0);
  });

  test("a known filing error is stored with its reason; the status stays fail", async () => {
    const aktvk = asDisclosure(
      withValue(katmrFromGolden(), "general_role_210015-row-294", "col-order-class-4", 318919663n + 1000n),
      AKTVK,
    );
    await loadFiling(db, aktvk);
    const known = await q("SELECT name, status, known_error FROM check_results WHERE known_error IS NOT NULL");
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ name: "balance_sheet_profit_equals_parent_profit", status: "fail" });
    expect(String(known[0]?.known_error)).toContain("AKTVK 2026/2");
    // The blocked-reports query in docs/SCHEMA.md still lists it.
    const blocked = await q(
      `SELECT DISTINCT disclosure_id FROM check_results WHERE severity = 'blocking' AND status = 'fail'`,
    );
    expect(blocked).toEqual([{ disclosure_id: BigInt(AKTVK) }]);
  });
});

describe("reloading", () => {
  test("loading the same report again replaces its rows, never duplicates them", async () => {
    const katmr = katmrFromGolden();
    await loadFiling(db, katmr);
    const before = await q("SELECT * FROM check_results ORDER BY position");
    await loadFiling(db, katmr);
    expect(await q("SELECT * FROM check_results ORDER BY position")).toEqual(before);
  });

  test("a changed report replaces every row; other reports are left alone", async () => {
    const katmr = katmrFromGolden();
    const other = asDisclosure(katmr, 9_000_123);
    await loadFiling(db, katmr);
    await loadFiling(db, other);
    const otherRows = await q("SELECT * FROM check_results WHERE disclosure_id = 9000123 ORDER BY position");

    // Only the balance sheet is left: the income statement and cash flow checks become not checked.
    const smaller = { ...katmr, facts: katmr.facts.filter((f) => f.role_code === "210015") };
    await loadFiling(db, smaller);
    expect(await count(`WHERE disclosure_id = ${KATMR}`)).toBe(checkFiling(smaller).length);
    expect(
      await count(`WHERE disclosure_id = ${KATMR} AND check_group = 'income_statement' AND status <> 'not_checked'`),
    ).toBe(0);
    expect(await q("SELECT * FROM check_results WHERE disclosure_id = 9000123 ORDER BY position")).toEqual(otherRows);
  });

  test("a value out of BIGINT range fails the load with the check named, and the previous load stays", async () => {
    const katmr = katmrFromGolden();
    await loadFiling(db, katmr);
    const before = await q("SELECT * FROM check_results ORDER BY position");
    const facts = await q("SELECT count(*) AS n FROM facts");
    // Rows 3 and 4 each fit in BIGINT; their sum (the subtotal check's right value) does not.
    const big = 5_000_000_000_000_000_000n;
    let huge = withValue(katmr, "general_role_310003-row-3", "col-order-class-4", big);
    huge = withValue(huge, "general_role_310003-row-4", "col-order-class-4", big);
    await expect(loadFiling(db, huge)).rejects.toThrow(/income_statement_row_5_equals_rows_3\+4.*out of BIGINT range/);
    expect(await q("SELECT * FROM check_results ORDER BY position")).toEqual(before);
    expect(await q("SELECT count(*) AS n FROM facts")).toEqual(facts);
  });
});

describe("migration 4", () => {
  test("a version 3 database gets an empty check_results table and keeps its reports", async () => {
    const con = await (await DuckDBInstance.create(":memory:")).connect();
    await migrate(
      con,
      MIGRATIONS.filter((m) => m.version <= 3),
    );
    await con.run(
      `INSERT INTO companies VALUES ('KATMR');
       INSERT INTO reports (disclosure_id, company_code, raw_ticker_group, year, quarter, consolidation_type,
         template_family, scale_unit, scale_multiplier, has_tms29_monetary_item, filepath, fact_count, loaded_at)
       VALUES (1651411, 'KATMR', 'KATMR', 2026, 2, 'consolidated', 'general', 'TL', 1, true, 'x.xls', 10, now()::TIMESTAMP)`,
    );
    expect(await schemaVersion(con)).toBe(3);
    expect(await migrate(con)).toEqual(MIGRATIONS.filter((m) => m.version > 3).map((m) => m.version));
    expect(await schemaVersion(con)).toBe(CURRENT_VERSION);
    const read = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJS();
    expect(await read("SELECT count(*) AS n FROM check_results")).toEqual([{ n: 0n }]);
    expect(await read("SELECT count(*) AS n FROM reports")).toEqual([{ n: 1n }]);
  });

  test("the key is (disclosure_id, position): one report can repeat a check name", async () => {
    await loadFiling(db, katmrFromGolden());
    const [r] = await q(
      `SELECT count(*) AS n, count(DISTINCT name) AS names, count(DISTINCT position) AS positions
       FROM check_results`,
    );
    expect(Number(r?.positions)).toBe(Number(r?.n));
    expect(Number(r?.names)).toBeLessThan(Number(r?.n));
  });
});
