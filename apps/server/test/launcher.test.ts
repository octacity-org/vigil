/**
 * macOS and Linux launcher (#264, decision 0008).
 * Checks that the shell script checks Docker, starts compose, and opens the browser.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "../../..");
const startShPath = join(rootDir, "scripts/start.sh");
const runShPath = join(rootDir, "scripts/run.sh");

describe("macOS and Linux launcher (#264)", () => {
  test("launcher scripts exist in scripts/", () => {
    expect(existsSync(startShPath)).toBe(true);
    expect(existsSync(runShPath)).toBe(true);
  });

  test("checks Docker installation, daemon status, and compose plugin", () => {
    const script = readFileSync(startShPath, "utf-8");
    expect(script).toContain("command -v docker");
    expect(script).toContain("docker info");
    expect(script).toContain("docker compose");
  });

  test("starts compose services and targets localhost:3000", () => {
    const script = readFileSync(startShPath, "utf-8");
    expect(script).toContain("docker compose up");
    expect(script).toContain("3000");
  });

  test("handles browser opening on macOS and Linux", () => {
    const script = readFileSync(startShPath, "utf-8");
    expect(script).toContain("Darwin");
    expect(script).toContain("xdg-open");
    expect(script).toContain("Service is not ready yet");
  });
});
