/** KAP polite access (#199): one request at a time, a second apart, limited retries. Fake transport and clock. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KAP_ORIGIN,
  KapClient,
  KapError,
  MAX_ATTEMPTS,
  MIN_INTERVAL_MS,
  RETRY_BASE_MS,
  type Transport,
} from "../src/kap.ts";

/** A fake clock: `sleep` moves time forward instantly. Every request is logged with its start time. */
function harness(answers: ((url: string) => Response | Promise<Response>)[]) {
  let time = 0;
  const sleeps: number[] = [];
  const log: { url: string; method: string; at: number; body?: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const transport: Transport = async (url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    log.push({ url, method: init.method ?? "GET", at: time, body: init.body as string | undefined });
    try {
      const answer = answers.shift();
      if (!answer) throw new Error("no more answers");
      const resp = await answer(url);
      time += 100; // each request takes 100 ms
      return resp;
    } finally {
      active--;
    }
  };
  const client = new KapClient({
    transport,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  });
  return { client, log, sleeps, maxActive: () => maxActive };
}

const ok =
  (body = "{}") =>
  () =>
    new Response(body, { status: 200 });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response("", { status: code, headers });
const networkError = () => () => {
  throw new TypeError("fetch failed");
};

describe("KapClient", () => {
  test("requests go to KAP, one at a time, at least a second apart", async () => {
    const h = harness([ok('{"a":1}'), ok('{"b":2}'), ok('{"c":3}')]);
    const results = await Promise.all([
      h.client.json("/tr/api/a"),
      h.client.json("/tr/api/b"),
      h.client.json("/tr/api/c"),
    ]);
    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(h.log.map((r) => r.url)).toEqual(["a", "b", "c"].map((p) => `${KAP_ORIGIN}/tr/api/${p}`));
    expect(h.maxActive()).toBe(1);
    for (let i = 1; i < h.log.length; i++) {
      expect((h.log[i]?.at ?? 0) - (h.log[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    }
  });

  test("the next request waits until the previous body has been read", async () => {
    const h = harness([ok("x"), ok("y")]);
    const order: string[] = [];
    const first = h.client.request("/tr/api/slow", async (resp) => {
      order.push("first start");
      await new Promise((r) => setTimeout(r, 20));
      order.push(`first ${await resp.text()}`);
    });
    const second = h.client.request("/tr/api/fast", async (resp) => void order.push(`second ${await resp.text()}`));
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first x", "second y"]);
  });

  test("POST sends JSON", async () => {
    const h = harness([ok("[]")]);
    await h.client.json("/tr/api/disclosure/list/main", { json: { fromDate: "2026-10-01" } });
    expect(h.log[0]?.method).toBe("POST");
    expect(JSON.parse(h.log[0]?.body ?? "")).toEqual({ fromDate: "2026-10-01" });
  });

  test("network errors, 429 and 5xx are retried with growing waits", async () => {
    const h = harness([networkError(), status(503), ok('"done"')]);
    expect(await h.client.json<string>("/tr/api/x")).toBe("done");
    expect(h.log).toHaveLength(3);
    expect(h.sleeps.filter((s) => s >= RETRY_BASE_MS)).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2]);
  });

  test("a longer Retry-After is respected", async () => {
    const h = harness([status(429, { "retry-after": "30" }), ok()]);
    await h.client.json("/tr/api/x");
    expect(h.sleeps).toContain(30_000);
  });

  test("it gives up after MAX_ATTEMPTS and the queue keeps working", async () => {
    const h = harness([...Array.from({ length: MAX_ATTEMPTS }, () => status(500)), ok('"next"')]);
    await expect(h.client.json("/tr/api/x")).rejects.toBeInstanceOf(KapError);
    expect(h.log).toHaveLength(MAX_ATTEMPTS);
    expect(await h.client.json<string>("/tr/api/y")).toBe("next");
  });

  test("4xx other than 429 is not retried", async () => {
    const h = harness([status(404)]);
    const error = (await h.client.json("/tr/api/x").catch((e) => e)) as KapError;
    expect([error.name, error.status]).toEqual(["KapError", 404]);
    expect(h.log).toHaveLength(1);
  });

  test("a caller can ask for fewer attempts, never more", async () => {
    const h = harness([status(500), ok()]);
    await expect(h.client.json("/tr/api/x", { attempts: 1 })).rejects.toBeInstanceOf(KapError);
    expect(h.log).toHaveLength(1);
    const g = harness(Array.from({ length: MAX_ATTEMPTS + 2 }, () => status(500)));
    await expect(g.client.json("/tr/api/x", { attempts: 99 })).rejects.toBeInstanceOf(KapError);
    expect(g.log).toHaveLength(MAX_ATTEMPTS);
  });

  test("only KAP paths are accepted", () => {
    const h = harness([]);
    expect(() => h.client.request("https://example.com/", async () => {})).toThrow(KapError);
  });
});

test("no server code calls fetch outside kap.ts", () => {
  const dir = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && entry.name !== "kap.ts" && /\bfetch\s*\(/.test(readFileSync(path, "utf8")))
        offenders.push(entry.name);
    }
  };
  walk(dir);
  expect(offenders).toEqual([]);
});
