/**
 * `GET` and `PUT /v1/settings` (#226, #389), tested apart from their author (CONTRIBUTING rule 5). Expected values are
 * written by hand from docs/API.md and `@vigil/api-types` (`Settings`, `SettingsUpdate`): the API key is write-only,
 * `ollama` defaults to http://127.0.0.1:11434, `openai_compatible` needs a `base_url`, quarters are `YYYY-Q`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorResponse, Settings } from "@vigil/api-types";
import { createApp } from "../src/api/app.ts";
import { settingsRoutes } from "../src/api/settings.ts";

const KEY = "sk-test-0123456789abcdef";

let dir: string;
let path: string;
let app: ReturnType<typeof createApp>;
let internal: unknown[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-settings-api-"));
  path = join(dir, "vigil.settings.json");
  internal = [];
  app = createApp({ routes: [settingsRoutes(path)], onInternalError: (e) => internal.push(e) });
});
afterEach(() => {
  expect(internal).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

async function get(): Promise<Settings> {
  const r = await app.request("/v1/settings");
  expect(r.status).toBe(200);
  return (await r.json()) as Settings;
}

async function put(body: unknown) {
  const r = await app.request("/v1/settings", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as Settings & ErrorResponse };
}

async function ok(body: unknown): Promise<Settings> {
  const r = await put(body);
  expect(r.status).toBe(200);
  return r.body;
}

async function refused(body: unknown, parameter: string) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const r = await put(body);
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe("invalid_request");
  expect(r.body.error.details.parameter).toBe(parameter);
  // A refused update leaves the file as it was.
  expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
}

const stored = () => JSON.parse(readFileSync(path, "utf8")) as { llm: { api_key: string | null } | null };

describe("GET", () => {
  test("no settings file: no quarters, LLM features off", async () => {
    const s = await get();
    expect(s.quarters).toEqual([]);
    expect(s.llm).toBeNull();
    expect(typeof s.data_dir).toBe("string");
    expect(existsSync(path)).toBe(false);
  });

  test("reads the file, and never returns the key in it", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        data_dir: "/data",
        quarters: ["2026-2"],
        llm: { provider: "anthropic", model: "m", base_url: null, api_key: KEY },
      }),
    );
    const r = await app.request("/v1/settings");
    const text = await r.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({
      data_dir: "/data",
      quarters: ["2026-2"],
      llm: { provider: "anthropic", model: "m", base_url: null, api_key_set: true },
    });
  });
});

describe("PUT", () => {
  test("quarters are saved and read back", async () => {
    expect((await ok({ quarters: ["2026-1", "2026-2"] })).quarters).toEqual(["2026-1", "2026-2"]);
    expect((await get()).quarters).toEqual(["2026-1", "2026-2"]);
    expect((await ok({ quarters: [] })).quarters).toEqual([]);
  });

  test("an empty update changes nothing", async () => {
    await ok({ quarters: ["2026-2"], llm: { provider: "gemini", model: "g", api_key: KEY } });
    const before = await get();
    expect(await ok({})).toEqual(before);
    expect(stored().llm?.api_key).toBe(KEY);
  });

  test("updating one field keeps the other", async () => {
    await ok({ quarters: ["2026-2"] });
    expect((await ok({ llm: { provider: "ollama", model: "llama3" } })).quarters).toEqual(["2026-2"]);
    expect((await ok({ quarters: ["2026-1"] })).llm?.provider).toBe("ollama");
  });

  test("ollama defaults to the local address; openai_compatible needs one", async () => {
    expect((await ok({ llm: { provider: "ollama", model: "llama3" } })).llm).toEqual({
      provider: "ollama",
      model: "llama3",
      base_url: "http://127.0.0.1:11434",
      api_key_set: false,
    });
    await refused({ llm: { provider: "openai_compatible", model: "m" } }, "body");
    expect(
      (await ok({ llm: { provider: "openai_compatible", model: "m", base_url: "http://127.0.0.1:1234/v1" } })).llm
        ?.base_url,
    ).toBe("http://127.0.0.1:1234/v1");
  });

  test("llm: null turns LLM features off and removes the key", async () => {
    await ok({ llm: { provider: "anthropic", model: "m", api_key: KEY } });
    expect((await ok({ llm: null })).llm).toBeNull();
    expect(readFileSync(path, "utf8")).not.toContain(KEY);
  });
});

describe("the API key is write-only", () => {
  test("set: saved on disk, never in a response", async () => {
    const r = await put({ llm: { provider: "anthropic", model: "m", api_key: KEY } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(KEY);
    expect(r.body.llm?.api_key_set).toBe(true);
    expect(stored().llm?.api_key).toBe(KEY);
    const g = await app.request("/v1/settings");
    expect(await g.text()).not.toContain(KEY);
  });

  test("omitted for the same provider: kept, even when the model changes", async () => {
    await ok({ llm: { provider: "anthropic", model: "m", api_key: KEY } });
    expect((await ok({ llm: { provider: "anthropic", model: "m2" } })).llm).toMatchObject({
      model: "m2",
      api_key_set: true,
    });
    expect(stored().llm?.api_key).toBe(KEY);
  });

  test("omitted with another provider: dropped, so a key never goes to a provider it was not given for", async () => {
    await ok({ llm: { provider: "anthropic", model: "m", api_key: KEY } });
    expect((await ok({ llm: { provider: "gemini", model: "g" } })).llm?.api_key_set).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain(KEY);
  });

  test("api_key: null removes it; a new key replaces it", async () => {
    await ok({ llm: { provider: "anthropic", model: "m", api_key: KEY } });
    expect((await ok({ llm: { provider: "anthropic", model: "m", api_key: null } })).llm?.api_key_set).toBe(false);
    expect(stored().llm?.api_key).toBeNull();
    await ok({ llm: { provider: "anthropic", model: "m", api_key: "sk-other" } });
    expect(stored().llm?.api_key).toBe("sk-other");
  });
});

describe("refused updates", () => {
  test("a body that is not a JSON object", async () => {
    for (const body of ["{", "[]", "null", "42"]) await refused(body, "body");
  });

  test("keys that cannot be changed through the API", async () => {
    await refused({ data_dir: "/elsewhere" }, "body");
    await refused({ quarters: ["2026-2"], theme: "dark" }, "body");
  });

  test("bad quarters", async () => {
    for (const quarters of [["2026-5"], ["2026-Q2"], ["26-2"], "2026-2", [2026]]) await refused({ quarters }, "body");
  });

  test("bad llm values", async () => {
    await refused({ llm: "anthropic" }, "llm");
    await refused({ llm: ["anthropic"] }, "llm");
    await refused({ llm: { provider: "anthropic", model: "m", api_key: 123 } }, "llm.api_key");
    await refused({ llm: { provider: "openai", model: "m" } }, "body");
    await refused({ llm: { provider: "anthropic", model: "" } }, "body");
    await refused({ llm: { provider: "anthropic", model: "m", temperature: 0 } }, "body");
  });

  test("a refused update after a saved one keeps the saved settings and key", async () => {
    await ok({ quarters: ["2026-2"], llm: { provider: "anthropic", model: "m", api_key: KEY } });
    await refused({ quarters: ["2026-5"] }, "body");
    await refused({ llm: { provider: "anthropic", model: "" } }, "body");
    expect(await get()).toMatchObject({ quarters: ["2026-2"], llm: { model: "m", api_key_set: true } });
    expect(stored().llm?.api_key).toBe(KEY);
  });
});
