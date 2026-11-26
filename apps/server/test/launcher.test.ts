/**
 * macOS, Linux and Windows launchers (#264, #263, decision 0008).
 * Checks that launcher scripts exist, verify Docker requirements, start compose, and open the browser.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "../../..");
const startShPath = join(rootDir, "scripts/start.sh");
const runShPath = join(rootDir, "scripts/run.sh");
const startBatPath = join(rootDir, "scripts/start.bat");
const runBatPath = join(rootDir, "scripts/run.bat");
const vigilBatPath = join(rootDir, "vigil.bat");

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
  });
});

describe("Windows launcher (#263)", () => {
  test("Windows launcher scripts exist", () => {
    expect(existsSync(startBatPath)).toBe(true);
    expect(existsSync(runBatPath)).toBe(true);
    expect(existsSync(vigilBatPath)).toBe(true);
  });

  test("checks Docker installation and daemon status in batch script", () => {
    const script = readFileSync(startBatPath, "utf-8");
    expect(script).toContain("where docker");
    expect(script).toContain("docker info");
    expect(script).toContain("docker compose version");
  });

  test("starts compose and launches browser", () => {
    const script = readFileSync(startBatPath, "utf-8");
    expect(script).toContain("docker compose up");
    expect(script).toContain("start http://127.0.0.1:3000");
    expect(script).toContain("if ($ready) { exit 0 } else { exit 1 }");
  });
});
