/**
 * Loading a checked report from Zova into DuckDB (#208): the processor's `loadInto` handle and `bun run process`.
 * Files are the synthetic fixtures; the reference for what lands in DuckDB is `loadFiling` of the same parsed file
 * (`bun run load`), and the blocked-reports query of `docs/SCHEMA.md`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFiling } from "@vigil/core";
import { close, connect, type Database, loadFiling, removeReport, rows } from "../src/db.ts";
import { emit, getEvent, pending } from "../src/events.ts";
import { loadInto, processEvent, processPending } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, openStore, type Store } from "../src/zova.ts";
import { FIXTURES, type FixtureFiling, fileName, GENERAL, HOLDING, kapHtml, parseFixture } from "./fixtures/index.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const enc = (s: string) => new TextEncoder().encode(s);

let store: Store;
let queue: WriteQueue;
let db: Database;
beforeEach(async () => {
  store = memoryStore();
  migrateStore(store);
  queue = new WriteQueue();
  db = await connect(":memory:");
});
afterEach(async () => {
  await queue.close();
  store.close();
  close(db);
});

function put(s: Store, name: string, html: string, downloadedAt = new Date("2026-10-20T08:00:00Z")): void {
  storeRawFile(
    s,
    enc(html),
    { fileName: name, sourceUrl: `file:///raw/${name}`, downloadedAt },
    {
      onStored: (st, f) =>
        emit(st, "report_stored", f.object_id, { disclosure_id: f.disclosure_id, file_name: f.file_name }),
    },
  );
}
const putFixture = (f: FixtureFiling, at?: Date) => put(store, fileName(f), kapHtml(f), at);
const run = () => processPending(store, queue, { handle: loadInto(db) });

/** Every table a load writes, for one disclosure, in a fixed order; loaded_at differs by run and is left out. */
async function snapshot(d: Database, id: number) {
  const where = `WHERE disclosure_id = ${id}`;
  return {
    reports: await rows(d, `SELECT * EXCLUDE (loaded_at) FROM reports ${where}`),
    facts: await rows(d, `SELECT * FROM facts ${where} ORDER BY row_id, column_class`),
    checks: await rows(d, `SELECT * FROM check_results ${where} ORDER BY position`),
  };
}
const blockedIds = async () =>
  (
    await rows(
      db,
      `SELECT DISTINCT disclosure_id FROM check_results WHERE severity = 'blocking' AND status = 'fail' ORDER BY 1`,
    )
  ).map((r) => Number(r.disclosure_id));

describe("a stored report is loaded", () => {
  test("its report, facts and check results, the same as bun run load gives for the file", async () => {
    for (const f of FIXTURES) putFixture(f);
    expect(await run()).toEqual({ processed: FIXTURES.length, failed: 0, already_handled: 0, errors: [] });

    const ref = await connect(":memory:");
    try {
      for (const f of FIXTURES) {
        await loadFiling(ref, parseFixture(f));
        const got = await snapshot(db, f.disclosureId);
        expect(got.facts.length).toBeGreaterThan(0);
        expect(got.checks.length).toBe(checkFiling(parseFixture(f)).length);
        expect(got).toEqual(await snapshot(ref, f.disclosureId));
      }
    } finally {
      close(ref);
    }
    expect(pending(store, "report_stored", 100)).toEqual([]);
  });

  test("a report failing a blocking check is loaded, and marked blocked by its check rows", async () => {
    putFixture(GENERAL); // total assets 1,000,000, but only cash (120,000) of their components is in the file
    putFixture(HOLDING);
    await run();
    expect(await rows(db, "SELECT disclosure_id FROM reports ORDER BY 1")).toEqual([
      { disclosure_id: BigInt(GENERAL.disclosureId) },
      { disclosure_id: BigInt(HOLDING.disclosureId) },
    ]);
    expect(await blockedIds()).toEqual([GENERAL.disclosureId]);
    // The event's payload says the same.
    const payload = store
      .query("SELECT payload FROM events WHERE type = 'report_processed'")
      .map((r) => JSON.parse(String(r.payload)))
      .find((p) => p.disclosure_id === GENERAL.disclosureId);
    expect(payload.blocked).toBe(true);
  });

  test("processing the same event again changes nothing and never duplicates rows", async () => {
    putFixture(GENERAL);
    const [event] = pending(store, "report_stored", 10);
    await run();
    const before = await snapshot(db, GENERAL.disclosureId);
    // At least once: a job queued before the first one finished runs again.
    expect(await processEvent(store, event as never, loadInto(db))).toEqual({
      event: event?.id as number,
      outcome: "already_handled",
    });
    expect(await run()).toEqual({ processed: 0, failed: 0, already_handled: 0, errors: [] });
    expect(await snapshot(db, GENERAL.disclosureId)).toEqual(before);
  });

  test("the checks the processor ran are the ones stored, not run a second time", async () => {
    putFixture(HOLDING);
    const [event] = pending(store, "report_stored", 10);
    let stored = 0;
    await processEvent(store, event as never, async (report, context) => {
      if (report.status !== "checked") throw new Error("expected a checked report");
      // Keep only the first check: if the load ran the checks itself, every row would be there.
      await loadInto(db)({ ...report, checks: report.checks.slice(0, 1) }, context);
      stored = report.checks.length;
    });
    expect(stored).toBeGreaterThan(1);
    expect(await rows(db, "SELECT count(*) AS n FROM check_results")).toEqual([{ n: 1n }]);
  });
});

describe("versions", () => {
  test("a new version replaces the rows of the older one", async () => {
    putFixture(GENERAL);
    await run();
    const changed: FixtureFiling = {
      ...GENERAL,
      tables: GENERAL.tables.map((t) => ({
        ...t,
        rows: t.rows.map((r) =>
          r.row === 4 && t.role === "210015" ? { ...r, values: { 4: 125_000, 5: 100_000 } } : r,
        ),
      })),
    };
    putFixture(changed, new Date("2026-10-21T08:00:00Z"));
    expect(await run()).toMatchObject({ processed: 1, errors: [] });

    const ref = await connect(":memory:");
    try {
      await loadFiling(ref, parseFixture(changed));
      expect(await snapshot(db, GENERAL.disclosureId)).toEqual(await snapshot(ref, GENERAL.disclosureId));
    } finally {
      close(ref);
    }
    const [cash] = await rows(
      db,
      "SELECT raw_value FROM facts WHERE row_id LIKE '%row-4' AND role_code = '210015' AND column_class LIKE '%-4'",
    );
    expect(cash).toEqual({ raw_value: 125_000n });
  });

  test("a broken latest version removes the older version's rows; other reports stay", async () => {
    putFixture(GENERAL);
    putFixture(HOLDING);
    await run();
    const holding = await snapshot(db, HOLDING.disclosureId);
    put(store, fileName(GENERAL), "<html>broken</html>", new Date("2026-10-21T08:00:00Z"));
    expect(await run()).toMatchObject({ processed: 0, failed: 1, errors: [] });

    const empty = { reports: [], facts: [], checks: [] };
    expect(await snapshot(db, GENERAL.disclosureId)).toEqual(empty);
    expect(await snapshot(db, HOLDING.disclosureId)).toEqual(holding);
    const [failed] = store.query("SELECT payload FROM events WHERE type = 'report_failed'");
    expect(JSON.parse(String(failed?.payload)).reason).toContain("ParseError");
  });

  test("an event whose file is not stored changes nothing in DuckDB", async () => {
    putFixture(GENERAL);
    await run();
    const before = await snapshot(db, GENERAL.disclosureId);
    emit(store, "report_stored", "0".repeat(64), { disclosure_id: GENERAL.disclosureId, file_name: fileName(GENERAL) });
    expect(await run()).toMatchObject({ processed: 0, failed: 1, errors: [] });
    expect(await snapshot(db, GENERAL.disclosureId)).toEqual(before);
  });
});

describe("a load that fails", () => {
  test("leaves the event pending and records no outcome", async () => {
    putFixture(GENERAL);
    const [event] = pending(store, "report_stored", 10);
    const gone = await connect(":memory:");
    close(gone);
    const s = await processPending(store, queue, { handle: loadInto(gone) });
    expect(s.processed).toBe(0);
    expect(s.errors.map((e) => e.event)).toEqual([event?.id as number]);
    expect(getEvent(store, event?.id as number)?.handled_at).toBeNull();
    expect(store.query("SELECT count(*) AS n FROM events WHERE type <> 'report_stored'")).toEqual([{ n: 0n }]);
    // The next run loads it.
    expect(await run()).toMatchObject({ processed: 1, errors: [] });
    expect((await snapshot(db, GENERAL.disclosureId)).reports).toHaveLength(1);
  });

  test("a value out of range rolls back: the earlier version stays loaded", async () => {
    putFixture(HOLDING);
    await run();
    const before = await snapshot(db, HOLDING.disclosureId);
    const filing = parseFixture(HOLDING);
    const huge = filing.facts.map((f) => ({ ...f, raw_value: 2n ** 70n, normalized_value_tl: 2n ** 70n }));
    await expect(loadFiling(db, { ...filing, facts: huge })).rejects.toThrow();
    expect(await snapshot(db, HOLDING.disclosureId)).toEqual(before);
  });
});

describe("removeReport", () => {
  test("removes one disclosure's rows and says whether it was there", async () => {
    await loadFiling(db, parseFixture(GENERAL));
    await loadFiling(db, parseFixture(HOLDING));
    const holding = await snapshot(db, HOLDING.disclosureId);
    expect(await removeReport(db, GENERAL.disclosureId)).toBe(true);
    expect(await snapshot(db, GENERAL.disclosureId)).toEqual({ reports: [], facts: [], checks: [] });
    expect(await snapshot(db, HOLDING.disclosureId)).toEqual(holding);
    expect(await removeReport(db, GENERAL.disclosureId)).toBe(false);
  });
});

describe("bun run process", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vigil-process-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args: string[]) =>
    Bun.spawnSync(["bun", join(REPO, "apps", "server", "src", "cli", "process.ts"), ...args], { cwd: dir });
  function stage(html: (f: FixtureFiling) => string = kapHtml) {
    const s = openStore(dir);
    try {
      migrateStore(s);
      for (const f of FIXTURES) put(s, fileName(f), html(f));
    } finally {
      s.close();
    }
  }

  test("loads every pending report, prints the counts, and a second run does nothing", async () => {
    stage();
    const first = cli(dir);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain(`Processed: ${FIXTURES.length} | failed: 0`);
    expect(first.stdout.toString()).toContain("blocked by a failing check");
    const second = cli(dir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("Processed: 0 | failed: 0");

    const d = await connect(join(dir, "vigil.duckdb"));
    try {
      expect(await rows(d, "SELECT count(*) AS n FROM reports")).toEqual([{ n: BigInt(FIXTURES.length) }]);
    } finally {
      close(d);
    }
  });

  test("exits 1 when a report failed", () => {
    stage((f) => (f === GENERAL ? "<html>broken</html>" : kapHtml(f)));
    const r = cli(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain(`Processed: ${FIXTURES.length - 1} | failed: 1`);
  });

  test("exits 1 while another process holds the store", () => {
    stage();
    const held = openStore(dir);
    try {
      expect(cli(dir).exitCode).toBe(1);
    } finally {
      held.close();
    }
  });

  test("wrong arguments exit 2", () => {
    expect(cli(dir, "x.duckdb", "extra").exitCode).toBe(2);
    expect(cli("--help").exitCode).toBe(2);
  });
});
