/**
 * Polling the disclosure list for new financial reports (#201). KAP answers are synthetic, in the recorded shape of
 * `docs/kap.md` ("Disclosure list"); no KAP content is committed. Expected behaviour: the issue's tasks (a fixed
 * interval, the last covered day in Zova, the 90-day limit) and "a new disclosure is picked up once".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KapClient } from "../src/kap.ts";
import {
  COVERED_THROUGH,
  coveredThrough,
  POLL_INTERVAL_MS,
  pendingDisclosures,
  pollOnce,
  startPolling,
} from "../src/poller.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";

/** One answer entry; `published` is `DD.MM.YYYY HH:MM:SS` as KAP writes it. */
function entry(index: number, published: string, basic: Record<string, unknown> = {}) {
  return {
    disclosureBasic: {
      title: "Finansal Rapor",
      mkkMemberOid: `oid-company-${index}`,
      companyTitle: "TEST A.Ş.",
      stockCode: `TS${index}`,
      disclosureClass: "FR",
      publishDate: published,
      disclosureId: `oid-disclosure-${index}`,
      disclosureIndex: index,
      year: 2026,
      donem: 2,
      isChanged: null,
      relatedDisclosureOid: null,
      isLate: false,
      ...basic,
    },
    disclosureDetail: {},
  };
}

/** A fake KAP: `answer(body)` gives each answer; every request body is kept. */
function fakeKap(answer: (body: Record<string, unknown>) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const client = new KapClient({
    transport: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(JSON.stringify(answer(body)));
    },
    sleep: async () => {},
  });
  return { client, bodies };
}

let store: Store;
beforeEach(() => {
  store = memoryStore();
  migrateStore(store);
});
afterEach(() => store.close());

const at = (iso: string) => () => new Date(iso);
const seen = () =>
  store.query("SELECT disclosure_id FROM seen_disclosures ORDER BY disclosure_id").map((r) => Number(r.disclosure_id));

describe("pollOnce", () => {
  test("records each new financial report once, oldest first, with what the next steps need", async () => {
    const { client } = fakeKap(() => [
      entry(12, "17.08.2026 19:05:18", { stockCode: "TEB, TEBNK" }),
      entry(11, "17.08.2026 09:00:00"),
    ]);
    const r = await pollOnce(store, { kap: client, now: at("2026-08-17T17:00:00Z"), since: "2026-08-17" });
    expect(r.new.map((d) => d.disclosure_id)).toEqual([11, 12]);
    expect([r.from, r.to, r.known]).toEqual(["2026-08-17", "2026-08-17", 0]);
    expect(
      pendingDisclosures(store).map((d) => [d.disclosure_id, d.mkk_member_oid, d.stock_codes, d.year, d.quarter]),
    ).toEqual([
      [11, "oid-company-11", ["TS11"], 2026, 2],
      [12, "oid-company-12", ["TEB", "TEBNK"], 2026, 2],
    ]);

    // The same answer again: nothing new.
    const again = await pollOnce(store, { kap: client, now: at("2026-08-17T17:05:00Z") });
    expect([again.new, again.known]).toEqual([[], 2]);
    expect(seen()).toEqual([11, 12]);
  });

  test("only statements with a period are recorded", async () => {
    const { client } = fakeKap(() => [
      entry(1, "17.08.2026 10:00:00"),
      entry(2, "17.08.2026 10:00:00", { title: "Sorumluluk Beyanı" }),
      entry(3, "17.08.2026 10:00:00", { title: "Faaliyet Raporu" }),
      entry(4, "17.08.2026 10:00:00", { year: null, donem: null }),
    ]);
    await pollOnce(store, { kap: client, now: at("2026-08-17T17:00:00Z") });
    expect(seen()).toEqual([1]);
  });

  test("a correction keeps its link to the corrected disclosure", async () => {
    const { client } = fakeKap(() => [
      entry(2, "17.08.2026 20:12:56", { isChanged: "DUZENLENEN", relatedDisclosureOid: "oid-disclosure-1" }),
    ]);
    await pollOnce(store, { kap: client, now: at("2026-08-17T18:00:00Z") });
    expect(pendingDisclosures(store)[0]).toMatchObject({
      is_changed: "DUZENLENEN",
      related_disclosure_oid: "oid-disclosure-1",
    });
  });

  test("asks for financial reports from the day before the last covered day to today, Istanbul time", async () => {
    const { client, bodies } = fakeKap(() => []);
    await pollOnce(store, { kap: client, now: at("2026-08-17T20:59:00Z"), since: "2026-08-15" });
    expect(coveredThrough(store)).toBe("2026-08-17");
    // 21:00 UTC is midnight in Istanbul: the next day.
    await pollOnce(store, { kap: client, now: at("2026-08-17T21:00:00Z") });
    expect(bodies.map((b) => [b.fromDate, b.toDate, b.disclosureTypes])).toEqual([
      ["15.08.2026", "17.08.2026", ["FR"]],
      ["16.08.2026", "18.08.2026", ["FR"]],
    ]);
    expect(coveredThrough(store)).toBe("2026-08-18");
  });

  test("a report published after a poll on the same day is found by the next poll", async () => {
    let answer = [entry(1, "17.08.2026 09:00:00")];
    const { client } = fakeKap(() => answer);
    await pollOnce(store, { kap: client, now: at("2026-08-17T07:00:00Z") });
    answer = [entry(2, "17.08.2026 23:55:00"), ...answer];
    // The first poll of the next day still asks for the 17th.
    const r = await pollOnce(store, { kap: client, now: at("2026-08-17T21:10:00Z") });
    expect(r.new.map((d) => d.disclosure_id)).toEqual([2]);
  });

  test("after days offline, the missed days are asked for in windows of at most 90 days", async () => {
    const { client, bodies } = fakeKap((b) => (b.fromDate === "29.08.2026" ? [entry(5, "01.10.2026 10:00:00")] : []));
    await pollOnce(store, { kap: client, now: at("2026-06-01T08:00:00Z") });
    const r = await pollOnce(store, { kap: client, now: at("2026-10-15T08:00:00Z") });
    expect(bodies.slice(1).map((b) => [b.fromDate, b.toDate])).toEqual([
      ["31.05.2026", "28.08.2026"],
      ["29.08.2026", "15.10.2026"],
    ]);
    expect(r.new.map((d) => d.disclosure_id)).toEqual([5]);
    expect(coveredThrough(store)).toBe("2026-10-15");
  });

  test("a restart continues from the day kept in Zova", async () => {
    const { client, bodies } = fakeKap(() => []);
    await pollOnce(store, { kap: client, now: at("2026-08-10T08:00:00Z") });
    expect(store.query("SELECT name, value FROM collector_state")).toEqual([
      { name: COVERED_THROUGH, value: "2026-08-10" },
    ]);
    // A new process: `since` no longer matters.
    await pollOnce(store, { kap: client, now: at("2026-08-12T08:00:00Z"), since: "2026-01-01" });
    expect(bodies[1]).toMatchObject({ fromDate: "09.08.2026", toDate: "12.08.2026" });
  });

  test("a failed request records nothing and keeps the covered day", async () => {
    const { client } = fakeKap(() => []);
    await pollOnce(store, { kap: client, now: at("2026-08-10T08:00:00Z") });
    const failing = new KapClient({
      transport: async () => new Response("{}", { status: 503 }),
      sleep: async () => {},
    });
    await expect(pollOnce(store, { kap: failing, now: at("2026-08-12T08:00:00Z") })).rejects.toThrow("HTTP 503");
    expect(coveredThrough(store)).toBe("2026-08-10");
  });

  test("a store error records nothing and keeps the covered day", async () => {
    let answer: unknown[] = [];
    const { client } = fakeKap(() => answer);
    await pollOnce(store, { kap: client, now: at("2026-08-10T08:00:00Z") });
    answer = [entry(1, "12.08.2026 10:00:00"), entry(2, "12.08.2026 09:00:00")];
    const broken: Store = {
      ...store,
      transaction: (fn) =>
        store.transaction((s) =>
          fn({
            ...s,
            run: (sql, params) => {
              if (sql.includes("collector_state")) throw new Error("disk full");
              return s.run(sql, params);
            },
          }),
        ),
    };
    await expect(pollOnce(broken, { kap: client, now: at("2026-08-12T08:00:00Z") })).rejects.toThrow("disk full");
    expect([seen(), coveredThrough(store)]).toEqual([[], "2026-08-10"]);
  });
});

describe("startPolling", () => {
  /** A fake timer: scheduled calls are listed and run by hand. */
  function timer() {
    const queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      queue,
      schedule: (fn: () => void, ms: number) => {
        const item = { fn, ms, cancelled: false };
        queue.push(item);
        return () => {
          item.cancelled = true;
        };
      },
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("polls now, then every interval after the previous poll ended; a disclosure is reported once", async () => {
    let answer = [entry(1, "17.08.2026 09:00:00")];
    const { client, bodies } = fakeKap(() => answer);
    const t = timer();
    const found: number[][] = [];
    const poller = startPolling(store, {
      kap: client,
      now: at("2026-08-17T08:00:00Z"),
      schedule: t.schedule,
      onPoll: (r) => found.push(r.new.map((d) => d.disclosure_id)),
    });
    await settle();
    expect(bodies).toHaveLength(1);
    expect(t.queue.map((q) => q.ms)).toEqual([POLL_INTERVAL_MS]);

    answer = [entry(2, "17.08.2026 10:00:00"), ...answer];
    t.queue[0]?.fn();
    await settle();
    t.queue[1]?.fn();
    await settle();
    expect(found).toEqual([[1], [2], []]);
    await poller.stop();
    expect(t.queue.at(-1)?.cancelled).toBe(true);
  });

  test("an error is reported and polling goes on", async () => {
    let fail = true;
    const client = new KapClient({
      transport: async () => (fail ? new Response("{}", { status: 404 }) : new Response("[]")),
      sleep: async () => {},
    });
    const t = timer();
    const errors: unknown[] = [];
    const polls: unknown[] = [];
    const poller = startPolling(store, {
      kap: client,
      now: at("2026-08-17T08:00:00Z"),
      schedule: t.schedule,
      onError: (e) => errors.push(e),
      onPoll: (r) => polls.push(r),
    });
    await settle();
    expect([errors.length, polls.length, t.queue.length]).toEqual([1, 0, 1]);
    fail = false;
    t.queue[0]?.fn();
    await settle();
    expect([errors.length, polls.length]).toEqual([1, 1]);
    await poller.stop();
  });

  test("stop waits for the poll in progress and schedules nothing more", async () => {
    let release: () => void = () => {};
    const client = new KapClient({
      transport: () =>
        new Promise((r) => {
          release = () => r(new Response("[]"));
        }),
      sleep: async () => {},
    });
    const t = timer();
    const poller = startPolling(store, { kap: client, now: at("2026-08-17T08:00:00Z"), schedule: t.schedule });
    await settle();
    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect([stopped, t.queue.length]).toEqual([true, 0]);
  });
});
