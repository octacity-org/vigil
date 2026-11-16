/** Reading the configuration file (#69): `config/vigil.json` unless `VIGIL_CONFIG` names another; no fallback. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@vigil/core";
import { CONFIG } from "../../../packages/core/test/helpers.ts";
import { configPath, DEFAULT_CONFIG_PATH, loadConfig } from "../src/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the default is the repository's config/vigil.json; VIGIL_CONFIG names another file", () => {
  expect(DEFAULT_CONFIG_PATH.replaceAll("\\", "/")).toEndWith("/config/vigil.json");
  expect(configPath({})).toBe(DEFAULT_CONFIG_PATH);
  expect(configPath({ VIGIL_CONFIG: "" })).toBe(DEFAULT_CONFIG_PATH);
  expect(configPath({ VIGIL_CONFIG: "/etc/vigil.json" })).toBe("/etc/vigil.json");
  expect(loadConfig(DEFAULT_CONFIG_PATH)).toEqual(CONFIG);
});

test("another file is read and validated", () => {
  const path = join(dir, "strict.json");
  const raw = JSON.parse(JSON.stringify(CONFIG, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  writeFileSync(
    path,
    JSON.stringify({
      ...raw,
      version: "strict-1",
      s1_gross_margin: { ...raw.s1_gross_margin, x_min_abs_delta_bps: 3000 },
    }),
  );
  expect(loadConfig(path)).toMatchObject({ version: "strict-1", s1_gross_margin: { x_min_abs_delta_bps: 3000 } });
});

test("a missing or invalid file is an error naming the file, never the built-in values", () => {
  const missing = join(dir, "none.json");
  expect(() => loadConfig(missing)).toThrow(ConfigError);
  expect(() => loadConfig(missing)).toThrow(missing);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: "x" }));
  expect(() => loadConfig(bad)).toThrow(`${bad}: missing`);
});
