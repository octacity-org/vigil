/** Turkish UI wording rules from docs/legal.md: findings and changes, never "sinyal" or directive words. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const FORBIDDEN = [/sinyal/i, /\bal\s*-\s*sat\b/i, /hedef fiyat/i, /tavsiye ediyoruz/i];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|json)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

test("no forbidden wording in the web app", () => {
  const hits = files(SRC).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return FORBIDDEN.filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
  });
  expect(hits).toEqual([]);
});

test("the page language is Turkish", () => {
  expect(readFileSync(join(SRC, "app", "layout.tsx"), "utf8")).toContain('<html lang="tr">');
});
