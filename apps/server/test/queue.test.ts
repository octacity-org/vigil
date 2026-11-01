/** Single-writer job queue (#197). */
import { describe, expect, test } from "bun:test";
import { close, connect, rows } from "../src/db.ts";
import { type JobInfo, QueueClosedError, WriteQueue } from "../src/queue.ts";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe("WriteQueue", () => {
  test("jobs run one at a time, in order, and return their results", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const job = (name: string, ms: number) =>
      q.add(name, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(`start ${name}`);
        await tick(ms);
        log.push(`end ${name}`);
        active--;
        return name.toUpperCase();
      });
    const results = await Promise.all([job("a", 15), job("b", 1), job("c", 5)]);
    expect(results).toEqual(["A", "B", "C"]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(q.stats()).toEqual({ pending: 0, running: null, done: 3, failed: 0 });
  });

  test("a failed job is reported and the next ones still run", async () => {
    const errors: [JobInfo, unknown][] = [];
    const q = new WriteQueue((job, e) => errors.push([job, e]));
    const bad = q.add("bad", () => {
      throw new Error("boom");
    });
    const good = q.add("good", () => 1);
    await expect(bad).rejects.toThrow("boom");
    expect(await good).toBe(1);
    expect(errors.map(([j, e]) => [j.name, (e as Error).message])).toEqual([["bad", "boom"]]);
    expect(q.stats()).toMatchObject({ done: 1, failed: 1 });
  });

  test("a throwing error handler does not stop the queue", async () => {
    const q = new WriteQueue(() => {
      throw new Error("handler");
    });
    await expect(q.add("bad", () => Promise.reject(new Error("job")))).rejects.toThrow("job");
    expect(await q.add("next", () => "ok")).toBe("ok");
  });

  test("a job added by a running job waits its turn", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    let inner: Promise<void> | undefined;
    await q.add("outer", () => {
      inner = q.add("inner", () => void log.push("inner"));
      log.push("outer");
    });
    await inner;
    expect(log).toEqual(["outer", "inner"]);
  });

  test("stats show the running job", async () => {
    const q = new WriteQueue();
    let release = () => {};
    const blocked = q.add(
      "load KATMR",
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    q.add("load SANFM", () => {});
    await tick();
    expect(q.stats()).toMatchObject({ pending: 1, running: { id: 1, name: "load KATMR" } });
    release();
    await blocked;
    await q.idle();
    expect(q.stats()).toMatchObject({ pending: 0, running: null, done: 2 });
  });

  test("close finishes added jobs and refuses new ones", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    q.add("a", async () => {
      await tick(5);
      log.push("a");
    });
    q.add("b", () => void log.push("b"));
    const closing = q.close();
    await expect(q.add("late", () => {})).rejects.toBeInstanceOf(QueueClosedError);
    await closing;
    expect(log).toEqual(["a", "b"]);
    expect(q.closed).toBe(true);
  });

  test("idle resolves at once on an empty queue", async () => {
    await new WriteQueue().idle();
  });
});

test("concurrent DuckDB transactions on one connection succeed through the queue", async () => {
  const db = await connect(":memory:");
  try {
    await db.con.run("CREATE TABLE t (id INTEGER, step INTEGER)");
    const write = async (id: number) => {
      await db.con.run("BEGIN TRANSACTION");
      for (let step = 0; step < 3; step++) {
        await db.con.run("INSERT INTO t VALUES ($1, $2)", [id, step]);
        await tick();
      }
      await db.con.run("COMMIT");
    };
    // Without the queue the second BEGIN fails inside the first transaction.
    const unqueued = await Promise.allSettled([write(100), write(101)]);
    expect(unqueued.some((r) => r.status === "rejected")).toBe(true);
    await db.con.run("ROLLBACK").catch(() => {});
    await db.con.run("DELETE FROM t");

    const q = new WriteQueue();
    await Promise.all(Array.from({ length: 10 }, (_, i) => q.add(`write ${i}`, () => write(i))));
    expect(await rows(db, "SELECT count(*) AS n, count(DISTINCT id) AS ids FROM t")).toEqual([{ n: 30n, ids: 10n }]);
  } finally {
    close(db);
  }
});
