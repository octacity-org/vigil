/** The web API client (#232): typed calls, one error type, amounts read in one place. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Value } from "@vigil/api-types";
import { ApiClientError, createClient, type Fetch, toBigInt } from "../src/lib/api.ts";

function fake(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { client: createClient({ baseUrl: "http://127.0.0.1:8787/", fetch: f }), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("requests", () => {
  test("paths, encoded segments and query parameters", async () => {
    const { client, calls } = fake(() => json({}));
    await client.company("A1CAP");
    await client.factVersions("KATMR", "general_role_310003-row-3", { period_end: "2025-06-30" });
    await client.findings({ rule: "gross_margin_change", quarter: "2026-2", sort: "-size", company: undefined });
    await client.companies({ q: "işbank" });
    await client.finding("2026-2-KATMR/x");
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8787/v1/companies/A1CAP",
      "http://127.0.0.1:8787/v1/companies/KATMR/facts/general_role_310003-row-3/versions?period_end=2025-06-30",
      "http://127.0.0.1:8787/v1/findings?rule=gross_margin_change&quarter=2026-2&sort=-size",
      "http://127.0.0.1:8787/v1/companies?q=i%C5%9Fbank",
      "http://127.0.0.1:8787/v1/findings/2026-2-KATMR%2Fx",
    ]);
  });

  test("PUT sends JSON", async () => {
    const { client, calls } = fake(() => json({ data_dir: "/data", quarters: [], anthropic_api_key_set: true }));
    const s = await client.updateSettings({ anthropic_api_key: "sk-test" });
    expect(s.anthropic_api_key_set).toBe(true);
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ anthropic_api_key: "sk-test" });
  });
});

describe("errors", () => {
  const error = async (p: Promise<unknown>) => (await p.catch((e) => e)) as ApiClientError;

  test("an API error keeps its code, status and details", async () => {
    const { client } = fake(() =>
      json({ error: { code: "not_found", message: "Şirket bulunamadı: XYZ", details: { code: "XYZ" } } }, 404),
    );
    const e = await error(client.company("XYZ"));
    expect(e).toBeInstanceOf(ApiClientError);
    expect([e.code, e.status, e.message, e.details]).toEqual([
      "not_found",
      404,
      "Şirket bulunamadı: XYZ",
      { code: "XYZ" },
    ]);
  });

  test("a network failure", async () => {
    const { client } = fake(() => {
      throw new TypeError("fetch failed");
    });
    const e = await error(client.meta());
    expect([e.code, e.status]).toEqual(["network", null]);
  });

  test("a response that is not JSON, or an error without the common shape", async () => {
    let e = await error(fake(() => new Response("<html>proxy</html>", { status: 502 })).client.meta());
    expect([e.code, e.status]).toEqual(["bad_response", 502]);
    e = await error(fake(() => json({ message: "nope" }, 500)).client.meta());
    expect([e.code, e.status]).toEqual(["bad_response", 500]);
  });
});

test("amounts are read as bigint in one place, without precision loss", () => {
  const ok: Value = { status: "ok", value: "9007199254740993", unit: "TRY" };
  const missing: Value = { status: "not_reported", value: null, unit: "TRY" };
  expect(toBigInt(ok)).toBe(9_007_199_254_740_993n);
  expect(toBigInt(missing)).toBeNull();
});

test("nothing in src calls fetch except the API client", () => {
  const src = join(import.meta.dir, "..", "src");
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : [],
    );
  const offenders = walk(src)
    .filter((f) => relative(src, f).replaceAll("\\", "/") !== "lib/api.ts")
    .filter((f) => /\bfetch\s*\(/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});
