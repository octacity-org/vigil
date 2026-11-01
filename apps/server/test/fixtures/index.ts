/**
 * Shared synthetic data for server tests (#194): KAP-style files with known values, and an in-memory DuckDB
 * loaded with them. Synthetic only: CI runs without raw KAP files. Expected values live here, next to the files
 * they describe, and are never read back from the parser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedFiling, parseKapXls } from "@vigil/core";
import { close, connect, type Database, loadFiling } from "../../src/db.ts";

export interface FixtureRow {
  row: number;
  label: string;
  /** Shown value per column (`col-order-class-N`), before scaling. */
  values: Record<number, number>;
}

export interface FixtureTable {
  role: string;
  /** Header labels, one per value column, from column 4 on. */
  headers: string[];
  rows: FixtureRow[];
}

export interface FixtureFiling {
  ticker: string;
  disclosureId: number;
  year: number;
  quarter: number;
  family: "general" | "banks" | "holding";
  /** `Sunum Para Birimi`. */
  unit: "TL" | "1.000 TL" | "1.000.000 TL";
  multiplier: bigint;
  consolidation: "Konsolide" | "Konsolide Olmayan";
  published: string;
  tables: FixtureTable[];
}

export const fileName = (f: FixtureFiling) => `${f.ticker}_${f.disclosureId}_${f.year}_${f.quarter}.xls`;

/** KAP format: `.` thousands separator, leading `-` (docs/kap.md, decision 0005). */
function shown(n: number): string {
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return n < 0 ? `-${s}` : s;
}

/** The HTML that KAP serves as `.xls`, reduced to what the parser reads. */
export function kapHtml(f: FixtureFiling): string {
  const tables = f.tables.map((t) => {
    const cls = `${f.family}_role_${t.role}`;
    const header = `<tr><td></td>${t.headers.map((h) => `<td class="context-header"><div>${h}</div></td>`).join("")}</tr>`;
    const rows = t.rows.map((r) => {
      const cells = t.headers.map((_, i) => {
        const col = i + 4;
        const v = r.values[col];
        const inner = v === undefined ? '<div class="gwt-Label"></div>' : `<div title="${v}">${shown(v)}</div>`;
        return `<td class="taxonomy-context-value col-order-class-${col}"><div>${inner}</div></td>`;
      });
      return (
        `<tr class="${cls}-row-${r.row} data-input-row presentation-enabled">` +
        `<td><div class="gwt-Label multi-language-content content-tr">${r.label}</div></td>${cells.join("")}</tr>`
      );
    });
    return `<table class="financial-table tbl_${cls}" border="1">${header}${rows.join("")}</table>`;
  });
  return (
    `<html><head><meta charset="utf-8"></head><body><div> Gönderim Tarihi:${f.published} </div>` +
    `<table><tr><td>Sunum Para Birimi</td><td>${f.unit}</td><td>Finansal Tablo Niteliği</td><td>${f.consolidation}</td></tr></table>` +
    `${tables.join("")}</body></html>`
  );
}

const H1_2026 = ["Cari Dönem <br>01.01.2026 - 30.06.2026", "Önceki Dönem <br>01.01.2025 - 30.06.2025"];
const BALANCE_2026_2 = ["Cari Dönem <br>30.06.2026", "Önceki Dönem <br>31.12.2025"];

/** General template, TL: a balance sheet and an income statement. Gross margin 30% now, 25% a year ago. */
export const GENERAL: FixtureFiling = {
  ticker: "TSTGN",
  disclosureId: 9_000_001,
  year: 2026,
  quarter: 2,
  family: "general",
  unit: "TL",
  multiplier: 1n,
  consolidation: "Konsolide",
  published: "17.08.2026 19:05:18",
  tables: [
    {
      role: "210015",
      headers: BALANCE_2026_2,
      rows: [
        { row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 120_000, 5: 100_000 } },
        { row: 129, label: "TOPLAM VARLIKLAR", values: { 4: 1_000_000, 5: 900_000 } },
      ],
    },
    {
      role: "310003",
      headers: H1_2026,
      rows: [
        { row: 3, label: "Hasılat", values: { 4: 1_000_000, 5: 800_000 } },
        { row: 4, label: "Satışların Maliyeti", values: { 4: -700_000, 5: -600_000 } },
        { row: 5, label: "BRÜT KAR (ZARAR)", values: { 4: 300_000, 5: 200_000 } },
      ],
    },
  ],
};

/** Banks template, million TL. */
export const BANK: FixtureFiling = {
  ticker: "TSTBN",
  disclosureId: 9_000_002,
  year: 2026,
  quarter: 2,
  family: "banks",
  unit: "1.000.000 TL",
  multiplier: 1_000_000n,
  consolidation: "Konsolide Olmayan",
  published: "18.08.2026 10:00:00",
  tables: [
    {
      role: "210011",
      headers: BALANCE_2026_2,
      rows: [{ row: 4, label: "Nakit Değerler", values: { 4: 1_234, 5: 1_000 } }],
    },
  ],
};

/** Holding template, thousand TL. */
export const HOLDING: FixtureFiling = {
  ticker: "TSTHD",
  disclosureId: 9_000_003,
  year: 2026,
  quarter: 2,
  family: "holding",
  unit: "1.000 TL",
  multiplier: 1_000n,
  consolidation: "Konsolide",
  published: "19.08.2026 09:30:00",
  tables: [
    {
      role: "210015",
      headers: BALANCE_2026_2,
      rows: [{ row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 55_500, 5: 40_000 } }],
    },
  ],
};

export const FIXTURES: readonly FixtureFiling[] = [GENERAL, BANK, HOLDING];

/** Value in TL of one cell, from the fixture definition. */
export function expectedTl(f: FixtureFiling, role: string, row: number, col: number): bigint {
  const v = f.tables.find((t) => t.role === role)?.rows.find((r) => r.row === row)?.values[col];
  if (v === undefined) throw new Error(`no fixture value for ${f.ticker} ${role} row ${row} col ${col}`);
  return BigInt(v) * f.multiplier;
}

export const parseFixture = (f: FixtureFiling): ParsedFiling => parseKapXls(kapHtml(f), fileName(f));

/** Write fixtures as a raw quarter folder (`{rawDir}/2026_2/…xls`), like `bun run download` does. Returns the paths. */
export function writeRawFiles(rawDir: string, filings: readonly FixtureFiling[] = FIXTURES): string[] {
  return filings.map((f) => {
    const dir = join(rawDir, `${f.year}_${f.quarter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fileName(f));
    writeFileSync(path, kapHtml(f));
    return path;
  });
}

/** An in-memory DuckDB at the current schema with the fixtures loaded. Close it with `close`. */
export async function loadedDatabase(filings: readonly FixtureFiling[] = FIXTURES): Promise<Database> {
  const db = await connect(":memory:");
  try {
    for (const f of filings) await loadFiling(db, parseFixture(f));
    return db;
  } catch (e) {
    close(db);
    throw e;
  }
}
