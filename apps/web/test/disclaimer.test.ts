/** Disclaimer component (#85): the agreed text from docs/legal.md, rendered as a labelled note. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DISCLAIMER_TR, Disclaimer } from "../src/components/Disclaimer.tsx";

const LEGAL = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "legal.md"), "utf8").replaceAll(
  "\r\n",
  "\n",
);

test("the text is the Turkish disclaimer in docs/legal.md", () => {
  const section = LEGAL.slice(LEGAL.indexOf("## 3. Proposed disclaimer"));
  const quote = /\*\*Turkish[^\n]*\n\n> ([^\n]+)/.exec(section)?.[1];
  expect(quote).toBeDefined();
  expect(DISCLAIMER_TR).toBe(quote as string);
});

test("it renders as a labelled note with the full text", () => {
  const html = renderToStaticMarkup(createElement(Disclaimer));
  expect(html).toContain('role="note"');
  expect(html).toContain('aria-label="Yasal uyarı"');
  expect(html).toContain("Vigil yatırım tavsiyesi vermez.");
  expect(html).toContain("asıl bildirimle karşılaştırılmalıdır.");
});
