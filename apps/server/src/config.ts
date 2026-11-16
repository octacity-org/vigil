/**
 * The configuration file (#69): thresholds and definitions, validated by `parseConfig` in `packages/core`.
 * `config/vigil.json` at the repository root unless `VIGIL_CONFIG` names another file. A missing or invalid file is
 * an error: the rules never run on built-in values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, parseConfig, type VigilConfig } from "@vigil/core";

export const DEFAULT_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "config", "vigil.json");

/** The configuration file's path: `VIGIL_CONFIG` if set, otherwise `config/vigil.json`. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.VIGIL_CONFIG || DEFAULT_CONFIG_PATH;
}

/** Read and validate the configuration file. Throws `ConfigError` if it is missing or invalid. */
export function loadConfig(path = configPath()): VigilConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read the configuration file ${path}: ${(e as Error).message}`);
  }
  return parseConfig(text, path);
}
