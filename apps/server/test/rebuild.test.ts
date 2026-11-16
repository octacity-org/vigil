/**
 * Rebuild DuckDB from the Zova archive (#162). Files are the synthetic fixtures. Expected behaviour: the issue's tasks
 * (a fresh database from every stored report, swapped in only when complete, a parse and quality summary) and
 * "rebuilding gives the same database as loading the same files directly".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { loadInto, processPending } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { rebuildDatabase, rebuildPath } from "../src/rebuild.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { BANK, FIXTURES, fileName, GENERAL, HOLDING, kapHtml, parseFixture } from "./fixtures/index.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-rebuild-"));
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, html: string, downloadedAt = new Date("2026-10-20T08:00:00Z")): void {
  storeRawFile(
    store,
    new TextEncoder().encode(html),
    { fileName: name, sourceUrl: `file:///raw/${name}`, downloadedAt },
    {
      onStored: (s, f) =>
        emit(s, "report_stored", f.object_id, { disclosure_id: f.disclosure_id, file_name: f.file_name }),
    },
  );
}
const BROKEN = "TSTBR_9000099_2026_2.xls";
function putAll() {
  for (const f of FIXTURES) put(fileName(f), kapHtml(f));
  put(BROKEN, "<html>broken</html>");
}

/** The derived tables, without the time each row was loaded. */
async function contents(db: Database) {
  return {
    reports: await rows(db, "SELECT * EXCLUDE (loaded_at) FROM reports ORDER BY disclosure_id"),
    facts: await rows(db, "SELECT * FROM facts ORDER BY ALL"),
    checks: await rows(db, "SELECT * FROM check_results ORDER BY disclosure_id, position"),
    companies: await rows(db, "SELECT company_code FROM companies ORDER BY ALL"),
  };
}

describe("done when: the same database as loading the same files directly", () => {
  test("reports, facts, check results and companies are equal to processing every stored file", async () => {
    putAll();
    const direct = await connect(join(dir, "direct.duckdb"));
    const queue = new WriteQueue();
    await processPending(store, queue, { handle: loadInto(direct) });
    await queue.close();

    const path = join(dir, "vigil.duckdb");
    const s = await rebuildDatabase(store, path);
    const rebuilt = await connect(path);
    const [a, b] = [await contents(direct), await contents(rebuilt)];
    expect(b.facts.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    close(direct);
    close(rebuilt);

    expect(s).toMatchObject({
      disclosures: FIXTURES.length + 1,
      loaded: FIXTURES.length,
      cpi_months: expect.any(Number),
    });
    expect(s.facts).toBe(b.facts.length);
    expect(s.failed).toEqual([
      { disclosure_id: 9000099, file_name: BROKEN, reason: expect.stringContaining("ParseError") },
    ]);
    expect(b.checks.length).toBeGreaterThan(0);
    expect(s.checks.passed + s.checks.not_checked).toBeGreaterThan(0);
  });

  test("the latest stored version of a disclosure is the one rebuilt", async () => {
    put(fileName(GENERAL), kapHtml(GENERAL), new Date("2026-10-20T08:00:00Z"));
    put(fileName(GENERAL), "<html>a broken correction</html>", new Date("2026-10-21T08:00:00Z"));
    put(fileName(HOLDING), kapHtml(HOLDING));
    const path = join(dir, "vigil.duckdb");
    const s = await rebuildDatabase(store, path);
    expect(s.failed.map((f) => f.disclosure_id)).toEqual([GENERAL.disclosureId]);
    const db = await connect(path);
    expect((await rows(db, "SELECT disclosure_id FROM reports")).map((r) => Number(r.disclosure_id))).toEqual([
      HOLDING.disclosureId,
    ]);
    close(db);
  });
});

describe("the swap", () => {
  test("the new file replaces the old one: reports no longer stored go; company metadata stays", async () => {
    const path = join(dir, "vigil.duckdb");
    const old = await connect(path);
    await old.con.run("INSERT INTO companies (company_code) VALUES ('TSTGN'), ('GONE')");
    await old.con.run(
      `UPDATE companies SET mkk_member_oid = '4028e4a14184e9cf01419c001e945a74', stock_codes = ['TSTGN'],
         title = 'TEST GENEL A.Ş.', sector_name = 'Test sektörü', search_key = 'tstgn test genel'
       WHERE company_code IN ('TSTGN', 'GONE')`,
    );
    await loadFiling(old, parseFixture(BANK)); // a report no longer in the archive
    close(old);

    put(fileName(GENERAL), kapHtml(GENERAL));
    const s = await rebuildDatabase(store, path);
    expect(s.companies_copied).toBe(1);
    const db = await connect(path);
    expect((await rows(db, "SELECT disclosure_id FROM reports")).map((r) => Number(r.disclosure_id))).toEqual([
      GENERAL.disclosureId,
    ]);
    expect(await rows(db, "SELECT company_code, title, sector_name, stock_codes FROM companies ORDER BY ALL")).toEqual([
      { company_code: "TSTGN", title: "TEST GENEL A.Ş.", sector_name: "Test sektörü", stock_codes: ["TSTGN"] },
    ]);
    expect(Number((await rows(db, "SELECT count(*) AS n FROM cpi_monthly"))[0]?.n)).toBe(s.cpi_months);
    close(db);
    expect(existsSync(rebuildPath(path))).toBe(false);
  });

  test("a rebuild that fails leaves the old database as it was and removes the partial file", async () => {
    const path = join(dir, "vigil.duckdb");
    const old = await connect(path);
    await old.con.run("INSERT INTO companies (company_code) VALUES ('OLD')");
    close(old);
    putAll();
    let reads = 0;
    const failing: Store = {
      ...store,
      getObject: (id: string) => {
        reads += 1;
        if (reads === 2) throw new Error("disk read error");
        return store.getObject(id);
      },
    };
    await expect(rebuildDatabase(failing, path)).rejects.toThrow("disk read error");
    expect(existsSync(rebuildPath(path))).toBe(false);
    const db = await connect(path);
    expect(await rows(db, "SELECT company_code FROM companies")).toEqual([{ company_code: "OLD" }]);
    expect(await rows(db, "SELECT count(*) AS n FROM reports")).toEqual([{ n: 0n }]);
    close(db);
  });

  test("a partial file left by a rebuild that stopped is replaced", async () => {
    const path = join(dir, "vigil.duckdb");
    writeFileSync(rebuildPath(path), "not a database");
    put(fileName(GENERAL), kapHtml(GENERAL));
    const s = await rebuildDatabase(store, path);
    expect(s.loaded).toBe(1);
  });

  test("progress after each report", async () => {
    putAll();
    const seen: [number, number][] = [];
    await rebuildDatabase(store, join(dir, "vigil.duckdb"), { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.at(-1)).toEqual([FIXTURES.length + 1, FIXTURES.length + 1]);
    expect(seen).toHaveLength(FIXTURES.length + 1);
  });
});
