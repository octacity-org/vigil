/**
 * Page frame shared by every route (#230): header with navigation, main content, footer with the disclaimer (#85).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Disclaimer } from "./Disclaimer.tsx";

/** Top-level sections, in menu order. Paths are Turkish, like the rest of the UI. */
export const NAV = [
  { href: "/bulgular", label: "Bulgular" },
  { href: "/sirketler", label: "Şirketler" },
  { href: "/kalite", label: "Veri kalitesi" },
  { href: "/ayarlar", label: "Ayarlar" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#icerik" className="skip-link">
        İçeriğe geç
      </a>
      <header className="site-header">
        <Link href="/" className="brand">
          Vigil
        </Link>
        <nav aria-label="Ana menü">
          <ul>
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {/* biome-ignore lint/correctness/useUniqueElementIds: the skip link needs a fixed target; Shell renders once per page */}
      <main id="icerik">{children}</main>
      <footer className="site-footer">
        <Disclaimer />
      </footer>
    </>
  );
}
