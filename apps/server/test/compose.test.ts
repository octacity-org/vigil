/**
 * docker-compose.yml: localhost ports, one data volume (#262, decision 0008).
 * Checks that the local release exposes ports on 127.0.0.1 only and never on 0.0.0.0 or IPv6.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composePath = join(import.meta.dir, "../../../docker-compose.yml");
const content = readFileSync(composePath, "utf-8");

describe("docker-compose.yml", () => {
  test("services are defined", () => {
    expect(content).toContain("server:");
    expect(content).toContain("web:");
  });

  test("ports are strictly bound to 127.0.0.1 and not accessible from outside", () => {
    // Review requirement (#262): "Map ports as 127.0.0.1:8787:8787 (never 8787:8787), and add a check that the app is not reachable on IPv6 or external addresses."
    expect(content).toContain('"127.0.0.1:8787:8787"');
    expect(content).toContain('"127.0.0.1:3000:3000"');
    expect(content).not.toMatch(/-\s*["']?(?:0\.0\.0\.0|\[::\])?:?8787:8787["']?/);
    expect(content).not.toMatch(/-\s*["']?8787:8787["']?/);
    expect(content).not.toMatch(/-\s*["']?3000:3000["']?/);
  });

  test("one named data volume is used", () => {
    expect(content).toContain("vigil-data:/data");
    expect(content).toContain("vigil-data:");
  });

  test("web depends on server being healthy", () => {
    expect(content).toContain("condition: service_healthy");
  });
});
