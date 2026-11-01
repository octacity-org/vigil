/** Layout and routes (#230): every route renders inside the frame with the menu and the disclaimer. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout from "../src/app/layout.tsx";
import { NAV } from "../src/components/Shell.tsx";

const APP = join(import.meta.dir, "..", "src", "app");

/** Route path → page module path and sample params. */
const ROUTES: [string, string, Record<string, string>][] = [
  ["/bulgular", "bulgular/page.tsx", {}],
  ["/bulgular/[id]", "bulgular/[id]/page.tsx", { id: "2026-2-KATMR-gross_margin_change" }],
  ["/sirketler", "sirketler/page.tsx", {}],
  ["/sirketler/[code]", "sirketler/[code]/page.tsx", { code: "katmr" }],
  ["/kalite", "kalite/page.tsx", {}],
  ["/ayarlar", "ayarlar/page.tsx", {}],
  ["/kurulum", "kurulum/page.tsx", {}],
];

async function render(file: string, params: Record<string, string>): Promise<string> {
  const mod = (await import(join(APP, file))) as {
    default: (p: { params: Promise<Record<string, string>> }) => ReactElement | Promise<ReactElement>;
  };
  const page = await mod.default({ params: Promise.resolve(params) });
  return renderToStaticMarkup(RootLayout({ children: page }));
}

test("every menu item has a route", () => {
  for (const item of NAV) expect(existsSync(join(APP, item.href.slice(1), "page.tsx"))).toBe(true);
});

for (const [route, file, params] of [...ROUTES, ["not found", "not-found.tsx", {}] as const]) {
  test(`${route} renders inside the layout`, async () => {
    const html = await render(file, params as Record<string, string>);
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain('aria-label="Ana menü"');
    for (const item of NAV) expect(html).toContain(`href="${item.href}"`);
    expect(html).toContain('<main id="icerik">');
    expect(html).toContain('aria-label="Yasal uyarı"');
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
  });
}

test("route parameters reach the page", async () => {
  expect(await render("sirketler/[code]/page.tsx", { code: "katmr" })).toContain("<h1>KATMR</h1>");
});
